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

/**
 * On Windows `npm` is `npm.cmd` and npm writes `sqlsage.cmd` into `.bin`, so neither
 * is an extensionless executable. Node 20 and newer also refuse to spawn a `.cmd` or
 * `.bat` without `shell: true` (the CVE-2024-27980 mitigation), so both the name and
 * the shell flag have to change together.
 */
const isWindows = process.platform === 'win32';
const npmExecutable = isWindows ? 'npm.cmd' : 'npm';
const binaryName = isWindows ? 'sqlsage.cmd' : 'sqlsage';

/** Under `shell: true` the args are re-parsed by the shell, so spaces need quoting. */
function shellSafe(argument: string): string {
  return isWindows && /[\s&|<>^]/.test(argument) ? `"${argument}"` : argument;
}

function command(executable: string, args: string[], cwd = root) {
  const result = spawnSync(executable, isWindows ? args.map(shellSafe) : args, {
    cwd,
    encoding: 'utf8',
    shell: isWindows,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.status !== 0) {
    // result.error carries spawn failures such as EINVAL or ENOENT, where stdout and
    // stderr are both null. Reporting only those printed "undefined" and said nothing.
    const detail = result.error?.message ?? result.stderr ?? result.stdout ?? `exit code ${result.status}`;
    throw new Error(`${executable} ${args.join(' ')} failed:\n${detail}`);
  }
  return result;
}

try {
  await mkdir(packageDirectory);
  await mkdir(prefix);
  command(npmExecutable, ['pack', '--pack-destination', packageDirectory]);
  const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'npm pack must produce exactly one tarball');
  command(npmExecutable, ['install', '--ignore-scripts', '--prefix', prefix, join(packageDirectory, tarballs[0]!)]);

  const binary = join(prefix, 'node_modules', '.bin', binaryName);
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
