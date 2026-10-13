# Releasing

1. `npm run check` green on `master`.
2. Bump the version in `package.json` and `package-lock.json`; update the README feature list and `LICENSING.md`.
3. `npm run screenshots` to refresh `docs/screenshots/*` and the README gallery (alt text carries the version).
4. Commit, `git push origin master`.
5. `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` builds, publishes the release zip and deploys GitHub Pages.
6. Verify with `gh run list` and the Pages URL.

The relay (`relay/`) is deployed separately with Wrangler and is versioned by `PROTOCOL`.
