import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------- *
 * Packaging uniformity (U8) — `files` must be exactly ["dist"].
 *
 * npm always ships package.json, README.md and LICENSE regardless of `files`, so listing
 * LICENSE/CHANGELOG.md is redundant; CHANGELOG.md in particular must not be published.
 * ------------------------------------------------------------------------- */

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

describe('package.json files (U8)', () => {
  it('publishes exactly ["dist"]', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { files?: unknown };
    expect(pkg.files).toEqual(['dist']);
  });

  it('does not list CHANGELOG.md in files', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { files?: string[] };
    expect(pkg.files ?? []).not.toContain('CHANGELOG.md');
  });
});
