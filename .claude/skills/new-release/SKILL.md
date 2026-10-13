---
name: new-release
description: Cut a new version (bump, check, screenshots, tag, release workflow). Use only when the user asks for a release.
disable-model-invocation: true
---

# Release procedure

1. Working tree clean on `master`; `npm run check` passes.
2. Bump `version` in `package.json` and `package-lock.json` (two places in the lock); update the README feature list and the `LICENSING.md` history line.
3. `npm run screenshots` (rebuilds and regenerates `docs/screenshots/*` and the README block; alt text uses the new version).
4. `npm run build`; commit `Release vX.Y.Z: …`; `git push origin master` (never force without asking).
5. `git tag vX.Y.Z && git push origin vX.Y.Z` — `.github/workflows/release.yml` builds the zip, creates the release and deploys Pages.
6. `gh run list --limit 3` / `gh run view` to confirm both workflows are green; check the Pages URL.

See `docs/RELEASING.md` for details.
