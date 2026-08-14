/**
 * Hand-rolled fakes for exercising the frozen core. No mocking library — every
 * fake is a plain object literal satisfying the `Adapter` interface, with each
 * seam (quota / availableModels / run / resume / steer / stream) individually
 * overridable and its calls recorded.
 */
import type {
  Account,
  Adapter,
  AdapterCapabilities,
  AuthStatus,
  ModelInfo,
  QuotaSnapshot,
  QuotaWindow,
  ResumeOptions,
  RunResult,
  RunTask,
  Vendor,
} from '../src/index.js';

/** Per-adapter call recorder — lets a test assert what the Fleet touched. */
export interface CallLog {
  authStatus: Array<Account | undefined>;
  availableModels: Array<Account | undefined>;
  quota: Array<Account | undefined>;
  run: RunTask[];
  resume: Array<{ conversationId: string; message: string; opts?: ResumeOptions }>;
  steer: Array<{ conversationId: string; message: string }>;
}

export interface FakeAdapter extends Adapter {
  readonly calls: CallLog;
}

export interface FakeOptions {
  capabilities?: Partial<AdapterCapabilities>;
  authStatus?: (account?: Account) => Promise<AuthStatus>;
  availableModels?: (account?: Account) => Promise<ModelInfo[]>;
  quota?: (account?: Account) => Promise<QuotaSnapshot | null>;
  run?: (task: RunTask) => Promise<RunResult>;
  resume?: (conversationId: string, message: string, opts?: ResumeOptions) => Promise<RunResult>;
  /** Set to attach a steer method (absence means the adapter has none). */
  steer?: (conversationId: string, message: string) => Promise<void>;
  /** Set to attach a stream method (absence means the adapter has none). */
  stream?: (task: RunTask) => AsyncIterable<RunResult>;
}

const DEFAULT_CAPS: AdapterCapabilities = {
  resume: true,
  steer: 'none',
  peerMesh: false,
  quota: true,
  stream: false,
};

/** A canned successful run result stamped with the given vendor. */
export function okResult(vendor: Vendor, over: Partial<RunResult> = {}): RunResult {
  return {
    vendor,
    conversationId: `conv-${vendor}`,
    text: 'ok',
    status: 'ok',
    ...over,
  };
}

/** Build a QuotaSnapshot with a single window at `usedPercent` (or none). */
export function snapshot(
  vendor: Vendor,
  opts: { allowed?: boolean; windows?: QuotaWindow[]; usedPercent?: number } = {},
): QuotaSnapshot {
  const windows =
    opts.windows ??
    (opts.usedPercent === undefined
      ? []
      : [{ label: 'primary', usedPercent: opts.usedPercent }]);
  return { vendor, windows, allowed: opts.allowed ?? true };
}

/** A model info builder, defaulting to a slow-class model. */
export function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return { id, latencyClass: 'slow', ...over };
}

/**
 * Construct a fake adapter. Every method has a sensible default and records its
 * invocation; pass overrides to control behavior for the case under test.
 */
export function makeAdapter(vendor: Vendor, opts: FakeOptions = {}): FakeAdapter {
  const calls: CallLog = {
    authStatus: [],
    availableModels: [],
    quota: [],
    run: [],
    resume: [],
    steer: [],
  };

  const adapter: FakeAdapter = {
    vendor,
    capabilities: { ...DEFAULT_CAPS, ...opts.capabilities },
    calls,
    async authStatus(account) {
      calls.authStatus.push(account);
      return opts.authStatus ? opts.authStatus(account) : { loggedIn: true };
    },
    async availableModels(account) {
      calls.availableModels.push(account);
      return opts.availableModels ? opts.availableModels(account) : [];
    },
    async quota(account) {
      calls.quota.push(account);
      return opts.quota ? opts.quota(account) : snapshot(vendor, { usedPercent: 0 });
    },
    async run(task) {
      calls.run.push(task);
      return opts.run ? opts.run(task) : okResult(vendor);
    },
    async resume(conversationId, message, resumeOpts) {
      calls.resume.push({ conversationId, message, opts: resumeOpts });
      return opts.resume
        ? opts.resume(conversationId, message, resumeOpts)
        : okResult(vendor, { conversationId });
    },
  };

  if (opts.steer) {
    const fn = opts.steer;
    adapter.steer = async (conversationId, message) => {
      calls.steer.push({ conversationId, message });
      return fn(conversationId, message);
    };
  }
  if (opts.stream) {
    adapter.stream = opts.stream as Adapter['stream'];
  }

  return adapter;
}
