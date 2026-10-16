import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from '../src/version.js';

describe('packaging uniformity (U8)', () => {
  it('publishes exactly the dist directory', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: unknown };
    expect(pkg.files).toEqual(['dist']);
  });

  it('sends the package version as app-server clientInfo.version (kept equal to package.json)', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: unknown };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
