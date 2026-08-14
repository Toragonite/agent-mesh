import type { Vendor } from './types.js';

/** Base class for every error this library throws. Carries the vendor when known. */
export class AgentMeshError extends Error {
  readonly vendor?: Vendor;
  constructor(message: string, vendor?: Vendor) {
    super(message);
    this.name = 'AgentMeshError';
    this.vendor = vendor;
  }
}

/** The account is not logged in, or its login expired. */
export class AuthError extends AgentMeshError {
  constructor(message: string, vendor?: Vendor) {
    super(message, vendor);
    this.name = 'AuthError';
  }
}

/** The vendor refused the run because the account is over its rate limit. */
export class QuotaExceededError extends AgentMeshError {
  constructor(message: string, vendor?: Vendor) {
    super(message, vendor);
    this.name = 'QuotaExceededError';
  }
}

/** The adapter's underlying CLI process failed (non-zero exit, crash, timeout). */
export class AdapterExecError extends AgentMeshError {
  readonly exitCode?: number;
  readonly stderr?: string;
  constructor(message: string, vendor: Vendor, opts: { exitCode?: number; stderr?: string } = {}) {
    super(message, vendor);
    this.name = 'AdapterExecError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/** The Fleet could not select any adapter for a task under the given policy. */
export class NoRouteError extends AgentMeshError {
  constructor(message: string) {
    super(message);
    this.name = 'NoRouteError';
  }
}
