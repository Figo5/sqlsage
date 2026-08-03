import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from './catalog.ts';
import { bundledCatalogPath } from './paths.ts';

test('the bundled catalog resolves to a real filesystem path', async () => {
  const path = bundledCatalogPath();
  assert.ok(isAbsolute(path), `${path} is not absolute`);
  // A URL pathname is percent-encoded, so a path derived from one fails to open
  // under any install directory containing a space -- on every platform, not just
  // Windows.
  assert.ok(!path.includes('%'), `${path} still carries percent-encoding`);
  assert.ok((await loadCatalog(path)).tables.length > 0);
});

/**
 * Static guard for the Windows `C:\C:\...` bug.
 *
 * `new URL(...).pathname` keeps the leading slash on a drive-letter path, so `fs`
 * resolves `/C:/Users/...` against the current drive root and produces
 * `C:\C:\Users\...`. POSIX has no drive letter, so the expression works on Linux
 * and macOS and the defect is invisible to this project's CI. A behavioural test
 * therefore cannot catch a regression; only reading the source can.
 */
test('no source file derives a filesystem path from a URL pathname', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const offenders: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mts|mjs)$/.test(entry.name)) continue;
      // Split on CRLF too. On a Windows checkout each line keeps a trailing \r,
      // which is a line terminator in JavaScript -- so `.` will not match it and the
      // comment-stripping regex below silently fails, tripping this guard on its own
      // explanatory comment.
      for (const [index, line] of readFileSync(full, 'utf8').split(/\r?\n/).entries()) {
        // Comments describe this bug deliberately, including in this file. Only
        // executable code counts, or the guard trips on its own explanation.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/new URL\([^)]*\)\.pathname/.test(code)) offenders.push(`${full}:${index + 1}`);
      }
    }
  }

  for (const dir of ['src', 'eval', 'corpus']) walk(join(root, dir));
  assert.deepEqual(offenders, [], `use fileURLToPath(new URL(...)) instead:\n${offenders.join('\n')}`);
});
