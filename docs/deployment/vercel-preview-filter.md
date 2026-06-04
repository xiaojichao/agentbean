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

The `apps/web` project root also includes `apps/web/vercel.json` with an equivalent command that points back to the root script. This covers Vercel monorepo projects whose configured root directory is `apps/web`.

## Behavior

Vercel uses inverted exit codes for the ignored build step:

- `exit 0` skips the build.
- `exit 1` continues the build.

The script continues Vercel builds for:

- The `main` branch.
- Changes under `apps/web/`, except `apps/web/vercel.json` configuration-only updates.

The script skips Vercel builds for docs-only, daemon-only, server-only, AgentBean Next rewrite, Vercel configuration-only, and GitHub Actions-only changes.
