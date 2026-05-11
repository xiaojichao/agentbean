# CI/CD

This repository uses GitHub Actions for validation and production deployment.

## Pipeline

- Pull requests to `main` run tests and builds for `apps/web`, `apps/server`, and `apps/agent`.
- Pushes to `main` run the same validation first.
- After validation passes on `main`, the workflow triggers production deployments:
  - `apps/web` deploys through a Vercel Deploy Hook.
  - `apps/server` deploys through the Railway CLI in CI mode.
  - `apps/agent` publishes to npm as `@agentbean/daemon`.

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

### npm

- `NPM_TOKEN`: npm access token with publish permission for `@agentbean/daemon`.

Create it at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) — use a **Granular Access Token** scoped to the `@agentbean` package.

## Platform Environment Variables

### Railway (Server)

| Variable | Description |
|----------|-------------|
| `AGENT_BEAN_AGENT_TOKEN` | Production agent auth token |
| `AGENT_BEAN_PUBLIC_SERVER_URL` | Public URL, e.g. `https://agentbean.up.railway.app` |
| `GLOBAL_DB_PATH` | SQLite path, e.g. `/data/global.db` (requires Volume) |
| `LOG_LEVEL` | Log level, e.g. `info` |

Railway Volume: Mount Path `/data` for SQLite persistence.

### Vercel (Web)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_AGENT_BEAN_SERVER_URL` | Server public URL, e.g. `https://agentbean.up.railway.app` |

## Deployment Verification

After pushing to `main`:

1. **GitHub Actions** — check the Actions tab for workflow status.
2. **Vercel** — visit the deployed URL, confirm the web app loads.
3. **Railway** — `curl https://<server-url>/healthz` returns 200.
4. **npm** — `npm info @agentbean/daemon` shows the new version.
5. **End-to-end** — log in on the web app, run `npx @agentbean/daemon@latest --server-url <url> --token <token>` on a device, confirm it appears in the UI.

## Notes

- If deployment secrets are missing, CI still runs and the deploy step is skipped with a GitHub Actions notice.
- Keep real `.env` files out of GitHub. Use platform environment variables for Vercel and Railway production secrets.
