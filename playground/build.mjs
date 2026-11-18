import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist-playground');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'playground', 'main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  minify: true,
  target: ['es2020'],
  outfile: path.join(outDir, 'main.js'),
  plugins: [
    {
      // src/catalog.ts loads JSON from disk for its live-introspection entry
      // points. The playground never calls those, so the Node-only import is
      // redirected to a stub that stays browser-safe.
      name: 'browser-fs-stub',
      setup(build) {
        build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
          path: path.join(root, 'playground', 'fs-stub.ts'),
        }));
      },
    },
  ],
});

await copyFile(path.join(root, 'playground', 'index.html'), path.join(outDir, 'index.html'));
await copyFile(path.join(root, 'playground', 'style.css'), path.join(outDir, 'style.css'));

console.log(`Playground built in ${path.relative(root, outDir)}/`);
