# CI/CD

This repository uses GitHub Actions for validation and production deployment.

## Pipeline

- Pull requests to `main` run tests and builds for `apps/web`, `apps/server`, and `apps/daemon`.
- Pushes to `main` run the same validation first.
- After validation passes on `main`, the workflow triggers production deployments:
  - `apps/web` deploys through a Vercel Deploy Hook.
  - `apps/server` deploys through the Railway CLI in CI mode.
  - `apps/daemon` publishes to npm as `@agentbean/daemon`.

## Required GitHub Secrets

Set these in GitHub repository settings under **Secrets and variables > Actions**.

Only secret values belong in GitHub Secrets. Stable Railway IDs are committed in the workflow so they can be reviewed with the deployment config.

### Vercel

- `VERCEL_DEPLOY_HOOK_URL`: Vercel deploy hook URL for the production `main` branch.

Create it in the Vercel project settings under **Git > Deploy Hooks**.

The Vercel project should point at the frontend app:

| Setting | Value |
|---------|-------|
| Framework Preset | Next.js |
| Root Directory | `apps/web` |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | Next.js default |

### Railway

- `RAILWAY_TOKEN`: Railway Project Token for the production environment.

The workflow is pinned to the current production Railway resources:

| Setting | Value |
|---------|-------|
| Project ID | `c6b70675-f7d5-47a1-a8e7-05b37d13e476` |
| Service ID | `7b1dce9b-b7e7-4cfb-bb3f-ef86d10e8647` |
| Environment ID | `e9c1a221-28b1-49c0-b279-be249a428737` |
| Public domain | `api.agentbean.dev` |

The workflow deploys `apps/server` with:

```sh
railway up apps/server --ci --path-as-root \
  --project c6b70675-f7d5-47a1-a8e7-05b37d13e476 \
  --service 7b1dce9b-b7e7-4cfb-bb3f-ef86d10e8647 \
  --environment e9c1a221-28b1-49c0-b279-be249a428737
```

The server deployment config lives in `apps/server/railway.json`; it builds with `npm run build`, starts with `npm start`, and uses `/healthz` as the Railway healthcheck path.
If Railway's own GitHub auto-deploy remains enabled, keep the service root directory aligned to `apps/server`; otherwise let GitHub Actions be the production deploy source of truth.

### npm

- `NPM_TOKEN`: npm access token with publish permission for `@agentbean/daemon`.

Create it at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) — use a **Granular Access Token** scoped to the `@agentbean` package.

## Platform Environment Variables

### Railway (Server)

| Variable | Description |
|----------|-------------|
| `AGENT_BEAN_AGENT_TOKEN` | Production agent auth token used by daemons and artifact upload/download |
| `AGENT_BEAN_WEB_TOKEN` | Optional legacy web token; omit once browser auth is the only web entrypoint |
| `AGENT_BEAN_PUBLIC_SERVER_URL` | Public API URL, e.g. `https://api.agentbean.dev` |
| `WEB_URL` | Public frontend URL on Vercel, used for invite/join links |
| `CORS_ORIGIN` | Public frontend origin, e.g. `https://agentbean.vercel.app` or your custom domain |
| `GLOBAL_DB_PATH` | SQLite path, e.g. `/data/global.db` (requires Volume) |
| `STORAGE_BASE_DIR` | Network-local SQLite/artifact root, e.g. `/data/storage` (requires Volume) |
| `ARTIFACT_DIR` | Legacy/global artifact root, e.g. `/data/artifacts` |
| `LOG_LEVEL` | Log level, e.g. `info` |

Railway Volume: Mount Path `/data` for SQLite persistence.

### Vercel (Web)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_AGENT_BEAN_SERVER_URL` | Server public URL, e.g. `https://api.agentbean.dev` |

## Deployment Verification

After pushing to `main`:

1. **GitHub Actions** — check the Actions tab for workflow status.
2. **Vercel** — visit the deployed URL, confirm the web app loads.
3. **Railway** — `curl https://<server-url>/healthz` returns 200.
4. **npm** — `npm info @agentbean/daemon` shows the new version.
5. **End-to-end** — log in on the web app, run `npx @agentbean/daemon@latest --server-url <url> --token <token>` on a device, confirm it appears in the UI.

## Notes

- If deployment secrets are missing, CI still runs and the deploy step is skipped with a GitHub Actions notice.
- npm publishing is version-aware: if `@agentbean/daemon@<version>` already exists, the publish step exits successfully without republishing.
- Keep real `.env` files out of GitHub. Use platform environment variables for Vercel and Railway production secrets.
