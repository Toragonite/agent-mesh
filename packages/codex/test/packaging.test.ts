import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('packaging uniformity (U8)', () => {
  it('publishes exactly the dist directory', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: unknown };
    expect(pkg.files).toEqual(['dist']);
  });
});
