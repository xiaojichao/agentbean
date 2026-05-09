# CI/CD

This repository uses GitHub Actions for validation and production deployment.

## Pipeline

- Pull requests to `main` run tests and builds for `apps/web`, `apps/server`, and `apps/agent`.
- Pushes to `main` run the same validation first.
- After validation passes on `main`, the workflow triggers production deployments:
  - `apps/web` deploys through a Vercel Deploy Hook.
  - `apps/server` deploys through the Railway CLI in CI mode.

## Required GitHub Secrets

Set these in GitHub repository settings under **Secrets and variables > Actions**.

### Vercel

- `VERCEL_DEPLOY_HOOK_URL`: Vercel deploy hook URL for the production `main` branch.

Create it in the Vercel project settings under **Git > Deploy Hooks**.

### Railway

- `RAILWAY_TOKEN`: Railway Project Token for the production environment.
- `RAILWAY_PROJECT_ID`: Railway project ID.
- `RAILWAY_SERVICE_ID`: Railway backend service ID or service name.
- `RAILWAY_ENVIRONMENT`: Railway environment ID or environment name, for example `production`.

The workflow deploys `apps/server` with:

```sh
railway up apps/server --ci --path-as-root
```

The server deployment config lives in `apps/server/railway.json`; it builds with `npm run build`, starts with `npm start`, and uses `/healthz` as the Railway healthcheck path.

## Notes

- If deployment secrets are missing, CI still runs and the deploy step is skipped with a GitHub Actions notice.
- Keep real `.env` files out of GitHub. Use platform environment variables for Vercel and Railway production secrets.
