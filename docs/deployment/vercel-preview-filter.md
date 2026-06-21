# Vercel Preview Deployment Filter

This repository keeps Vercel Preview Deployments for web and web-next changes, but skips the Vercel build for changes that do not affect the deployed frontend.

## Repository Configuration

The repository includes `vercel.json` with:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "ignoreCommand": "bash scripts/vercel-ignore-build.sh"
}
```

This overrides the Vercel project's ignored build step for deployments from this repository.

The `apps/web` and `apps/web-next` project roots also include `vercel.json` files with equivalent commands that point back to the root script. This covers Vercel monorepo projects whose configured root directory is `apps/web` or `apps/web-next`.

## Behavior

Vercel uses inverted exit codes for the ignored build step:

- `exit 0` skips the build.
- `exit 1` continues the build.

The script continues Vercel builds for:

- The `main` branch.
- Changes under `apps/web-next/`.
- Changes under `packages/contracts/`, because `apps/web-next` depends on the generated contracts package.
- Changes to root dependency files (`package.json`, `package-lock.json`, or `.npmrc`), because `apps/web-next` installs from the root workspace.
- Changes to `scripts/vercel-ignore-build.sh`.
- Transition-period changes under `apps/web/`, except configuration-only updates to `apps/web/vercel.json` and `apps/web/.nvmrc`.

The script skips Vercel builds for docs-only, daemon-only, server-only, Vercel configuration-only, and GitHub Actions-only changes.
