import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { files: string[] };

describe('packaging uniformity (U8)', () => {
  it('files is exactly ["dist"]', () => {
    expect(pkg.files).toEqual(['dist']);
  });
});
