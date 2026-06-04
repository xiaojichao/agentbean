# Vercel Preview Deployment Filter

This repository keeps Vercel Preview Deployments for web changes, but skips the Vercel build for changes that do not affect `apps/web`.

## Repository Configuration

The repository includes `vercel.json` with:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "ignoreCommand": "bash scripts/vercel-ignore-build.sh"
}
```

This overrides the Vercel project's ignored build step for deployments from this repository.

## Behavior

Vercel uses inverted exit codes for the ignored build step:

- `exit 0` skips the build.
- `exit 1` continues the build.

The script continues Vercel builds for:

- The `main` branch.
- Changes under `apps/web/`.
- Changes to `vercel.json`, if that file is added later.

The script skips Vercel builds for docs-only, daemon-only, server-only, and GitHub Actions-only changes.
