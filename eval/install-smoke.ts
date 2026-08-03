/** Pack SQLSage, install the tarball into a fresh temporary prefix, and run it. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Read from package.json rather than hardcoding: this asserts the installed CLI
// reports the version it was built from, and does not need editing every release.
const packageVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;
const temporary = await mkdtemp(join(tmpdir(), 'sqlsage-install-'));
const packageDirectory = join(temporary, 'package');
const prefix = join(temporary, 'prefix');

function command(executable: string, args: string[], cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

try {
  await mkdir(packageDirectory);
  await mkdir(prefix);
  command('npm', ['pack', '--pack-destination', packageDirectory]);
  const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'npm pack must produce exactly one tarball');
  command('npm', ['install', '--ignore-scripts', '--prefix', prefix, join(packageDirectory, tarballs[0]!)]);

  const binary = join(prefix, 'node_modules', '.bin', 'sqlsage');
  const version = command(binary, ['--version'], temporary);
  assert.equal(version.stdout.trim(), packageVersion);

  const api = command(process.execPath, [
    '--input-type=module',
    '-e',
    "const module = await import('sqlsage'); if (typeof module.analyze !== 'function') process.exit(9);",
  ], prefix);
  assert.equal(api.stderr, '');

  const analysis = command(binary, ['analyze', '--corpus', 'q10', '--format', 'json'], temporary);
  const output = JSON.parse(analysis.stdout);
  assert.equal(output.complete, true);
  assert.equal(output.mode, 'offline-catalog');
  assert.deepEqual(output.analysis.missingModules, undefined);
  console.log(`Installed ${tarballs[0]} and completed the bundled q10 workflow.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
