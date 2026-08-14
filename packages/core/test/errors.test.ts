import { describe, it, expect } from 'vitest';
import {
  AgentMeshError,
  AuthError,
  QuotaExceededError,
  AdapterExecError,
  NoRouteError,
} from '../src/index.js';

describe('AgentMeshError', () => {
  it('has the right name and is an Error', () => {
    const e = new AgentMeshError('base', 'claude');
    expect(e.name).toBe('AgentMeshError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('base');
    expect(e.vendor).toBe('claude');
  });

  it('leaves vendor undefined when not supplied', () => {
    expect(new AgentMeshError('base').vendor).toBeUndefined();
  });
});

describe('AuthError', () => {
  it('has name AuthError and the full instanceof chain', () => {
    const e = new AuthError('nope', 'codex');
    expect(e.name).toBe('AuthError');
    expect(e).toBeInstanceOf(AuthError);
    expect(e).toBeInstanceOf(AgentMeshError);
    expect(e).toBeInstanceOf(Error);
    expect(e.vendor).toBe('codex');
  });
});

describe('QuotaExceededError', () => {
  it('has name QuotaExceededError and the full instanceof chain', () => {
    const e = new QuotaExceededError('over', 'gemini');
    expect(e.name).toBe('QuotaExceededError');
    expect(e).toBeInstanceOf(QuotaExceededError);
    expect(e).toBeInstanceOf(AgentMeshError);
    expect(e).toBeInstanceOf(Error);
    expect(e.vendor).toBe('gemini');
  });
});

describe('AdapterExecError', () => {
  it('has name AdapterExecError, the instanceof chain, and carries exitCode/stderr/vendor', () => {
    const e = new AdapterExecError('crash', 'cursor', { exitCode: 137, stderr: 'killed' });
    expect(e.name).toBe('AdapterExecError');
    expect(e).toBeInstanceOf(AdapterExecError);
    expect(e).toBeInstanceOf(AgentMeshError);
    expect(e).toBeInstanceOf(Error);
    expect(e.vendor).toBe('cursor');
    expect(e.exitCode).toBe(137);
    expect(e.stderr).toBe('killed');
  });

  it('leaves exitCode/stderr undefined when no opts are given', () => {
    const e = new AdapterExecError('crash', 'claude');
    expect(e.exitCode).toBeUndefined();
    expect(e.stderr).toBeUndefined();
    expect(e.vendor).toBe('claude');
  });
});

describe('NoRouteError', () => {
  it('has name NoRouteError, the instanceof chain, and no vendor', () => {
    const e = new NoRouteError('nothing matched');
    expect(e.name).toBe('NoRouteError');
    expect(e).toBeInstanceOf(NoRouteError);
    expect(e).toBeInstanceOf(AgentMeshError);
    expect(e).toBeInstanceOf(Error);
    expect(e.vendor).toBeUndefined();
  });
});
