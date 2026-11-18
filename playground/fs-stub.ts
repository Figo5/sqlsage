/**
 * Browser stub for `node:fs/promises`.
 *
 * `src/catalog.ts` imports `readFile`/`writeFile` for its live-introspection
 * helpers. The playground only needs the pure lookup helpers from that module,
 * and the bundled catalog is compiled into the JS, so those functions are never
 * reachable in the browser. The esbuild plugin in `build.mjs` aliases the
 * Node-only import here so the bundle stays self-contained.
 */

export async function readFile(): Promise<string> {
  throw new Error('Filesystem access is not available in the browser playground');
}

export async function writeFile(): Promise<void> {
  throw new Error('Filesystem access is not available in the browser playground');
}
