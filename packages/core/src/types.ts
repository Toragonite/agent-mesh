/**
 * agent-mesh core data contract.
 *
 * These types are the frozen wire between the Fleet orchestrator and every
 * vendor adapter. They encode the shape empirically verified across four
 * headless coding agents (Claude Code, Codex, Antigravity/Gemini, Cursor):
 * each exposes `-p`/JSON one-shot runs, resume-by-conversation-id, token
 * usage, a reverse-engineered quota endpoint, auth-mode-gated model lists,
 * and an observable latency class.
 *
 * An adapter that satisfies this contract is drivable by the Fleet without
 * the Fleet knowing anything vendor-specific.
 */

/**
 * A supported agent vendor. Kept as an open union: the four names get
 * autocomplete, but `(string & {})` lets third-party adapters register any
 * vendor id without a core release.
 */
export type Vendor = 'claude' | 'codex' | 'gemini' | 'cursor' | (string & {});

/** Observed responsiveness of a model. 'fast' ~ interactive; 'slow' ~ deep reasoning. */
export type LatencyClass = 'fast' | 'slow';

/** How a vendor accepts guidance after a run has started. */
export type SteerMode =
  /** Inject while the agent is actively working (Claude peer-wake; Codex app-server turn/steer). */
  | 'mid-run'
  /** Only between turns, via resume(conversationId, message). */
  | 'turn'
  /** No post-start guidance; the run is atomic. */
  | 'none';

/**
 * A login/identity for one vendor. Adapters resolve credentials from
 * `configDir` (an isolated home such as CLAUDE_CONFIG_DIR / CODEX_HOME) or,
 * when omitted, from the ambient CLI login on the machine.
 */
export interface Account {
  vendor: Vendor;
  /** Opaque human label ("work", "personal"). */
  label?: string;
  /** Isolated config/home dir for this login. Omit to use the ambient CLI login. */
  configDir?: string;
}

/** What an adapter can do beyond the mandatory run/resume/quota surface. */
export interface AdapterCapabilities {
  /** Can revise an existing conversation by id. Nearly universal; false only for one-shot vendors. */
  resume: boolean;
  /** How mid-conversation guidance is accepted. */
  steer: SteerMode;
  /** Native peer-to-peer session messaging (Claude mesh only, today). */
  peerMesh: boolean;
  /** quota() can return a usable snapshot for this vendor. */
  quota: boolean;
  /** stream() yields incremental events. */
  stream: boolean;
}

export interface AuthStatus {
  loggedIn: boolean;
  /** Vendor-specific auth mode: 'subscription' | 'api-key' | 'chatgpt' | ... */
  mode?: string;
  /** Account label / email / detail if resolvable. MUST NEVER contain a token or secret. */
  detail?: string;
}

export interface ModelInfo {
  id: string;
  /** Human label if distinct from id. */
  label?: string;
  latencyClass: LatencyClass;
  /**
   * Auth modes under which this model is selectable. Codex is the live
   * example: chatgpt-login exposes gpt-5.6-sol/terra/luna, while
   * -codex-max variants are api-key-only. Omit = available under any login.
   */
  authModes?: string[];
  /** True for the adapter's default pick when a task names no model. */
  default?: boolean;
}

export interface QuotaWindow {
  /** Rolling-window label: "5h", "weekly", "primary", ... */
  label: string;
  /** 0..100. Percentage of the window already consumed. */
  usedPercent: number;
  /** ISO 8601 instant when this window resets, if the vendor reports it. */
  resetAt?: string;
}

export interface QuotaSnapshot {
  vendor: Vendor;
  windows: QuotaWindow[];
  /** Whether the vendor currently permits new work (the rate-limit gate). */
  allowed: boolean;
  /** ISO 8601 capture time. Stamped by the caller — core has no clock. */
  capturedAt?: string;
  /** Raw vendor payload for debugging. Shape is vendor-specific and unstable. */
  raw?: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cached-input tokens if the vendor reports them separately. */
  cachedInputTokens?: number;
}

export type RunStatus =
  /** Completed normally. */
  | 'ok'
  /** The adapter/agent reported a failure. */
  | 'error'
  /** Externally stopped via stop(). */
  | 'stopped'
  /** Ended without a final answer (timeout, truncation, permission wall). */
  | 'incomplete';

export interface RunTask {
  prompt: string;
  /** Model id; omit to use the adapter default. Adapters validate against availableModels(). */
  model?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /** Account override; omit = adapter default account. */
  account?: Account;
  /** Vendor permission mode passthrough (e.g. 'acceptEdits'); adapters map to their CLI flag. */
  permissionMode?: string;
  /** Tool allow-list if the vendor supports one. */
  allowedTools?: string[];
  /** Hard wall-clock cap in milliseconds. */
  timeoutMs?: number;
  /** Escape hatch for vendor-specific args the contract does not model. */
  extra?: Record<string, unknown>;
}

export interface RunResult {
  vendor: Vendor;
  /**
   * Conversation/session id to feed resume(). Empty string ONLY when the
   * vendor genuinely returned none — callers must treat '' as "not resumable".
   */
  conversationId: string;
  /** Final assistant text. */
  text: string;
  status: RunStatus;
  /** The model that actually ran (may differ from the request if the vendor remapped it). */
  model?: string;
  usage?: TokenUsage;
  /** Non-fatal note surfaced to the operator, e.g. "permission downgraded to acceptEdits". */
  note?: string;
  /** Raw final vendor event/payload for debugging. */
  raw?: unknown;
}

export interface ResumeOptions {
  model?: string;
  timeoutMs?: number;
  account?: Account;
  extra?: Record<string, unknown>;
}

/** Incremental event from an adapter's optional stream(). */
export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail?: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; message: string };
