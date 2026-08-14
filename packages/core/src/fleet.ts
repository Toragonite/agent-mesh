import type { Adapter } from './adapter.js';
import { NoRouteError } from './errors.js';
import type {
  LatencyClass,
  QuotaSnapshot,
  ResumeOptions,
  RunResult,
  RunTask,
  Vendor,
} from './types.js';

/** How the Fleet picks among eligible adapters. */
export type RouteStrategy =
  /** Walk `prefer` order; first adapter past the gates wins. (default) */
  | 'prefer-order'
  /** Pick the adapter with the most remaining headroom right now. */
  | 'most-quota'
  /** Prefer adapters offering a `fast` model (or `policy.latency`'s class), then prefer-order. */
  | 'lowest-latency';

export interface RoutePolicy {
  /** Preferred vendor order by strength; also the candidate set when present. */
  prefer?: Vendor[];
  /** Skip an adapter whose worst quota window exceeds this percent (0..100). */
  quotaCeiling?: number;
  /** Selection strategy. Default `'prefer-order'`. */
  strategy?: RouteStrategy;
  /**
   * Preferred latency class. Restricts routing to adapters offering a model of this
   * class (soft — ignored when none qualify). Applies to every strategy;
   * `'lowest-latency'` defaults it to `'fast'`.
   */
  latency?: LatencyClass;
}

export interface FleetRunOptions {
  policy?: RoutePolicy;
}

export interface RouteDecision {
  adapter: Adapter;
  /** Non-fatal note, e.g. a best-effort fallback when every candidate is gated. */
  note?: string;
}

interface Candidate {
  adapter: Adapter;
  snapshot: QuotaSnapshot | null;
}

const DEFAULT_CEILING = 100;

/**
 * Registers adapters and routes tasks across them by quota / strength / latency.
 * The Fleet holds no vendor knowledge — only what the `Adapter` contract exposes.
 */
export class Fleet {
  private readonly adapters = new Map<Vendor, Adapter>();

  register(adapter: Adapter): this {
    this.adapters.set(adapter.vendor, adapter);
    return this;
  }

  get(vendor: Vendor): Adapter | undefined {
    return this.adapters.get(vendor);
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }

  /** Quota snapshot for every registered adapter (null where unreadable). */
  async quotas(): Promise<Array<{ vendor: Vendor; snapshot: QuotaSnapshot | null }>> {
    return Promise.all(
      this.list().map(async (a) => ({ vendor: a.vendor, snapshot: await safeQuota(a) })),
    );
  }

  /** Choose an adapter for a task under a policy, without running it. */
  async route(task: RunTask, policy: RoutePolicy = {}): Promise<RouteDecision> {
    const strategy = policy.strategy ?? 'prefer-order';
    const ceiling = policy.quotaCeiling ?? DEFAULT_CEILING;

    const ordered = this.candidates(policy);
    if (ordered.length === 0) {
      throw new NoRouteError('no registered adapter matches the routing policy');
    }

    const withQuota: Candidate[] = await Promise.all(
      ordered.map(async (adapter) => ({ adapter, snapshot: await safeQuota(adapter, task) })),
    );

    const withinCeiling = withQuota.filter((c) => passesCeiling(c.snapshot, ceiling));
    const gated = withinCeiling.length === 0;
    let pool = gated ? withQuota : withinCeiling;

    // Latency preference. An explicit `policy.latency` applies to every strategy; the
    // 'lowest-latency' strategy defaults it to 'fast'. Soft: when no candidate offers the
    // class, the preference is ignored rather than emptying the pool.
    const targetClass: LatencyClass | undefined =
      policy.latency ?? (strategy === 'lowest-latency' ? 'fast' : undefined);
    if (targetClass) {
      const preferred = await filterByLatencyClass(pool, targetClass, task);
      if (preferred.length > 0) {
        pool = preferred;
      }
    }

    const first = pool[0];
    if (!first) throw new NoRouteError('no eligible adapter after filtering');

    // 'most-quota' scans for the most headroom; 'prefer-order' and 'lowest-latency' both
    // take the first of the (possibly latency-filtered) pool.
    const chosen: Candidate =
      strategy === 'most-quota'
        ? pool.reduce((best, cur) => (usageKey(cur.snapshot) < usageKey(best.snapshot) ? cur : best))
        : first;

    const note = gated
      ? `all candidates gated (quota ceiling ${ceiling}% / rate-limit); best-effort fallback to ${chosen.adapter.vendor}`
      : undefined;
    return { adapter: chosen.adapter, note };
  }

  /** Route (unless the task pins an account) and run. */
  async run(task: RunTask, opts: FleetRunOptions = {}): Promise<RunResult> {
    const adapter = task.account
      ? this.require(task.account.vendor)
      : (await this.route(task, opts.policy)).adapter;
    return adapter.run(task);
  }

  /** Continue a conversation on a specific vendor. */
  resume(
    vendor: Vendor,
    conversationId: string,
    message: string,
    opts?: ResumeOptions,
  ): Promise<RunResult> {
    return this.require(vendor).resume(conversationId, message, opts);
  }

  private require(vendor: Vendor): Adapter {
    const a = this.adapters.get(vendor);
    if (!a) throw new NoRouteError(`no adapter registered for vendor '${vendor}'`);
    return a;
  }

  private candidates(policy: RoutePolicy): Adapter[] {
    const prefer = policy.prefer;
    if (prefer && prefer.length > 0) {
      return prefer
        .map((v) => this.adapters.get(v))
        .filter((a): a is Adapter => Boolean(a));
    }
    return this.list();
  }
}

async function safeQuota(a: Adapter, task?: RunTask): Promise<QuotaSnapshot | null> {
  try {
    return await a.quota(task?.account);
  } catch {
    return null;
  }
}

function worstWindow(snapshot: QuotaSnapshot | null): number {
  if (!snapshot || snapshot.windows.length === 0) return 0;
  return Math.max(...snapshot.windows.map((w) => w.usedPercent));
}

/**
 * A candidate passes when its headroom is acceptable. A null snapshot (unknown headroom)
 * passes; an explicit `allowed:false` is a HARD rate-limit gate that always disqualifies,
 * independent of the ceiling; otherwise the worst window must be within the ceiling.
 */
function passesCeiling(snapshot: QuotaSnapshot | null, ceiling: number): boolean {
  if (!snapshot) return true;
  if (snapshot.allowed === false) return false;
  if (ceiling >= 100) return true;
  return worstWindow(snapshot) <= ceiling;
}

/** Sort key for "most quota": lower worst-window usage first; unknown sorts last. */
function usageKey(s: QuotaSnapshot | null): number {
  return s ? worstWindow(s) : Number.POSITIVE_INFINITY;
}

/** Keep only candidates that offer at least one model of the given latency class. */
async function filterByLatencyClass(
  pool: Candidate[],
  cls: LatencyClass,
  task: RunTask,
): Promise<Candidate[]> {
  const offersClass = await Promise.all(
    pool.map(async (entry) => {
      const models = await entry.adapter.availableModels(task.account).catch(() => []);
      return models.some((m) => m.latencyClass === cls);
    }),
  );
  return pool.filter((_, i) => offersClass[i]);
}
