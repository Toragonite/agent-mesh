/**
 * @toragonite/agent-mesh — the vendor-neutral core.
 *
 * Exports the data contract (`types`), the error hierarchy, the `Adapter`
 * interface every vendor package implements, and the `Fleet` that routes tasks
 * across registered adapters. No vendor code lives here.
 */
export * from './types.js';
export * from './errors.js';
export * from './adapter.js';
export * from './fleet.js';
