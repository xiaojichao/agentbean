# Vercel Preview Deployment Filter

This repository keeps Vercel Preview Deployments for web changes, but skips the Vercel build for changes that do not affect `apps/web`.

## Required Vercel Setting

Only a Vercel team member can apply this setting.

@xiaojichao please configure the `web` project in Vercel:

1. Open Vercel Dashboard.
2. Select the `web` project.
3. Go to `Settings` -> `Git`.
4. Enable `Automatically expose System Environment Variables` if it is not already enabled.
5. Set `Ignored Build Step` to:

   ```bash
   bash scripts/vercel-ignore-build.sh
   ```

6. Save the project settings.

## Behavior

Vercel uses inverted exit codes for the ignored build step:

- `exit 0` skips the build.
- `exit 1` continues the build.

The script continues Vercel builds for:

- The `main` branch.
- Changes under `apps/web/`.
- Changes to `vercel.json`, if that file is added later.

The script skips Vercel builds for docs-only, daemon-only, server-only, and GitHub Actions-only changes.
