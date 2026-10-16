import type {
  Account,
  AdapterCapabilities,
  AuthStatus,
  InteractiveResumeSpec,
  ModelInfo,
  QuotaSnapshot,
  ResumeOptions,
  RunEvent,
  RunOptions,
  RunResult,
  RunTask,
  Vendor,
} from './types.js';

/**
 * The single contract every vendor adapter implements. The Fleet drives adapters
 * only through this surface — it never learns anything vendor-specific.
 *
 * Mandatory surface: introspection (`authStatus`/`availableModels`/`quota`) and
 * the worker lifecycle (`run`/`resume`). Optional surface (`stream`/`steer`/`stop`)
 * is present only when `capabilities` advertises it.
 */
export interface Adapter {
  readonly vendor: Vendor;
  readonly capabilities: AdapterCapabilities;

  /** Whether the account is logged in, and under which auth mode. Never returns a token. */
  authStatus(account?: Account): Promise<AuthStatus>;

  /** Models selectable under the current login (auth-mode-aware). */
  availableModels(account?: Account): Promise<ModelInfo[]>;

  /**
   * Remaining-quota snapshot, or `null` when genuinely unknown (not logged in,
   * endpoint unavailable). MUST NOT throw for "unknown" — the router treats null
   * as "headroom unconfirmed", not as a failure.
   */
  quota(account?: Account): Promise<QuotaSnapshot | null>;

  /**
   * Start a headless run; resolves with the final text + a resumable conversation id. With
   * `task.resumeId` (since 0.1.3) it continues that conversation instead. `opts` (since 0.1.3)
   * carries the per-call spawn seam and environment; an adapter written against 0.1.2 that
   * takes only `task` still satisfies this interface.
   */
  run(task: RunTask, opts?: RunOptions): Promise<RunResult>;

  /** Continue/revise an existing conversation by id. */
  resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult>;

  /**
   * Incremental events for a run. Present only when `capabilities.stream`. Honours
   * `task.resumeId` and `opts` exactly as {@link run} does (since 0.1.3), and ends with exactly
   * one `done` or `error` event.
   */
  stream?(task: RunTask, opts?: RunOptions): AsyncIterable<RunEvent>;

  /**
   * Since 0.1.3. The command line that opens the vendor's INTERACTIVE terminal UI on
   * `conversationId` (a person taking over a headless conversation), or `undefined` when this
   * adapter does not provide one. Nothing is spawned.
   */
  interactiveResume?(conversationId: string, account?: Account): InteractiveResumeSpec | undefined;

  /**
   * Inject guidance while a run is active. Present only when
   * `capabilities.steer === 'mid-run'` (Claude peer wake, Codex app-server).
   */
  steer?(conversationId: string, message: string): Promise<void>;

  /** Stop an in-flight run. Present only for adapters that can. */
  stop?(conversationId: string): Promise<void>;
}

/** An adapter statically known to support mid-run steering. */
export type SteerableAdapter = Adapter & Required<Pick<Adapter, 'steer'>>;

/** An adapter statically known to support streaming. */
export type StreamingAdapter = Adapter & Required<Pick<Adapter, 'stream'>>;

/** Type guard: this adapter can be steered mid-run. */
export function canSteer(a: Adapter): a is SteerableAdapter {
  return a.capabilities.steer === 'mid-run' && typeof a.steer === 'function';
}

/** Type guard: this adapter can stream incremental events. */
export function canStream(a: Adapter): a is StreamingAdapter {
  return a.capabilities.stream && typeof a.stream === 'function';
}
