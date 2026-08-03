/**
 * Paths to files that ship inside the published package.
 *
 * Always derive these with `fileURLToPath`, never from a URL's `pathname`.
 *
 * A `pathname` is a URL component, not a filesystem path. On Windows it keeps the
 * leading slash on a drive-letter path — `/C:/Users/...` — and `fs` then resolves
 * that against the current drive root, producing the nonexistent
 * `C:\C:\Users\...`. POSIX has no drive letter, so the same expression works on
 * Linux and macOS and the bug never appears in CI.
 *
 * It is also percent-encoded, so any install directory containing a space
 * (`C:\Users\Jane Doe\...`, `/Users/jane doe/...`) arrives as `%20` and fails to
 * open on **every** platform.
 */
import { fileURLToPath } from 'node:url';

/** Absolute path to the example catalog bundled with the package. */
export function bundledCatalogPath(): string {
  return fileURLToPath(new URL('../corpus/catalog.json', import.meta.url));
}
