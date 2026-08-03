# Releasing SQLSage

SQLSage publishes to npm from GitHub Actions using **npm trusted publishing**, so no
long-lived npm token is stored in the repository or in GitHub secrets. The workflow
proves its identity to npm with a short-lived OIDC token, and npm attaches build
provenance automatically.

Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)

## One-time setup (maintainer, on npmjs.com)

These steps cannot be automated from this repository — they are account-level actions on
npm.

1. ~~**Claim the package name with a first manual publish.**~~ **Done** — `sqlsage@0.1.0`
   was published manually on 2026-08-02, which is what made the package exist so a
   trusted publisher could be attached. That version carries no provenance, because a
   manual publish cannot produce one; everything released through the workflow does.

2. **Configure the trusted publisher.** On npmjs.com go to the `sqlsage` package →
   *Settings* → *Trusted publisher*, choose **GitHub Actions**, and enter:

   | field | value |
   |---|---|
   | Organization or user | `Figo5` |
   | Repository | `sqlsage` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave blank)* |

3. **Remove any classic automation token** you were using for this package, so the OIDC
   path is the only way to publish.

Reference: <https://docs.npmjs.com/trusted-publishers/>

## Cutting a release

1. Update the version in `package.json` and the entry in `CHANGELOG.md`.
2. Commit, then tag with a `v` prefix matching the version exactly:

   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```

The tag push triggers the workflow, which:

1. **verifies the tag matches `package.json`** and fails before doing any work if not —
   a mismatch would publish a version nobody asked for, and npm versions cannot be
   reissued;
2. runs `npm ci`, the test suite, `node eval/dump-ir.ts --check`, and `node eval/run.ts`;
3. builds `dist/` and runs the install smoke test;
4. packs the tarball and writes `SHA256SUMS.txt`;
5. **publishes to npm**, skipping if that version is already on the registry so a re-run
   is safe; and
6. creates the GitHub release with the tarball and checksums attached.

npm publishing runs before the GitHub release deliberately: it is the step that cannot be
undone, so it happens only after every check has passed. A GitHub release without an npm
publish is easy to redo; the reverse is not.

## Verifying a published release

```bash
npm view sqlsage version
npm view sqlsage dist-tags

# Provenance: confirms which workflow and commit produced the tarball.
npm audit signatures
```

The npm package page shows a provenance badge linking back to the exact workflow run and
source commit. Reference:
<https://docs.npmjs.com/viewing-package-provenance/>

## What ships

`package.json` `files` limits the tarball to `dist/`, `corpus/catalog.json`, `README.md`,
and `LICENSE` — six files, roughly 200 kB packed.

`corpus/catalog.json` is not optional: `sqlsage demo` and `sqlsage doctor` both read it
for their bundled-example and self-test checks. Removing it from `files` would leave both
commands broken in the installed package while every local test still passed.

Confirm the contents before any release:

```bash
npm publish --dry-run
```
