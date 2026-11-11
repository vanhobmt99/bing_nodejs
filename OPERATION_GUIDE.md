# Operation Guide

Commands below run from the repository root in a Bash-compatible shell. Use [docs/usage.md](docs/usage.md) for the full settings reference, [docs/control-api.md](docs/control-api.md) for HTTP operations, and [docs/monitoring.md](docs/monitoring.md) for monitoring setup.

## Development Setup

Install Node.js 24 or newer and npm. Git is needed for a clone; Nix and Docker are optional alternatives.

```bash
node --version
npm ci --include=dev --ignore-scripts
npm run check
```

This uses the committed lockfile and runs build, API type checking, automated tests, lint, and formatting checks. These checks do not need a live Microsoft account or a Chromium download. Build output goes into `dist`; the build recreates that directory.

For the five root onboarding documents, the focused formatting check is:

```bash
./node_modules/.bin/prettier --check AGENTS.md CODING_CONVENTION.md OPERATION_GUIDE.md CODEBASE.md RULE.md
git diff --check
```

## Prepare an Account Run

Create `.env` from [env.example](env.example) if it does not exist. Keep an existing file and add only the settings needed. Example account entries:

```dotenv
ACCOUNT_1_EMAIL=user@example.com
ACCOUNT_1_PASSWORD=replace-with-your-password
```

The password can be omitted for supported passwordless sign-in. Account slots can have gaps. See the usage guide for TOTP, recovery email, locale, and proxy options. Keep `.env`, stored sessions, and diagnostic captures private; a Git ignore rule does not encrypt their contents.

Install the matching Chromium revision and build:

```bash
npm run install:browser
npm run build
```

On Linux, if Chromium system libraries are missing, the supported installer is `npx patchright install --with-deps chromium`; installing system packages may require administrator access. A visible browser requires a graphical display. Chromium is also used to sign in for API rewards mode.

Inspect the existing root `config.json`. To add missing built-in defaults while retaining existing settings:

```bash
node dist/config/ConfigSync.js sync --patch
```

The synchronizer creates a missing config, and patching an existing config creates a `.bak` backup. Without `--patch`, an existing config is inspected for missing defaults, but a missing file is still created.

Configuration is validated using built-in defaults and supported `CONFIG_*` overrides. Shell environment values take precedence over values loaded from `.env`. Project-file lookup checks the working directory before root, `dist`, and `src` fallbacks; running from the root avoids ambiguity.

## Run and Sign In

Set `rewardsMode` to `browser` or `api` in configuration, or use `CONFIG_REWARDS_MODE`. Browser mode uses rendered pages for browser tasks; API mode signs in with Chromium, saves cookies, closes sign-in browsers, and performs rewards tasks over HTTP. Both modes can use shared app/API actions.

```bash
npm start
```

This starts a real rewards job for configured accounts. `npm run ts-start` and `npm run dev` also execute the bot; they are not passive compilation or watch commands. Stop a foreground process with Ctrl+C and allow cleanup to finish.

For interactive sign-in without running rewards tasks:

```bash
npm run manual-login -- user@example.com --platform both
```

This needs a graphical desktop. `--fresh` skips restoring saved cookies; failed or cancelled verification preserves existing sessions. To inspect a saved session in a browser:

```bash
npm run open-session -- user@example.com --platform desktop
```

## Control API

The Control API is a separate server that works with either rewards mode. After building, generate a token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the generated value and local binding in `.env`:

```dotenv
API_TOKEN=replace-with-generated-token
API_HOST=127.0.0.1
API_PORT=3010
```

Start the server with `npm run api`, or rebuild and start it with `npm run dev:api`. Local API startup waits for requests and starts neither a rewards run nor a scheduler. The default local URL is `http://127.0.0.1:3010`.

An authenticated Bash request, using the same token configured for the server:

```bash
API_TOKEN='replace-with-generated-token'
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3010/health
```

`X-API-Key` is also supported. A non-loopback binding requires a token; use an HTTPS reverse proxy for access across machines. Config writes, schedule writes, config reveal, and per-job environment overrides have separate capability flags, disabled by default. Enable only the capabilities required for the intended operation.

| Endpoint                           | Operational use                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `GET /status`                      | Check the active job and previous exit before retrying a run-control request. |
| `GET /plan`                        | Inspect the effective execution plan.                                         |
| `GET /logs`, `/errors`, `/history` | Inspect retained logs and completed-run summaries.                            |
| `POST /start`, `/stop`, `/restart` | Control the rewards job.                                                      |
| `POST /sessions/regenerate`        | Create login sessions without rewards tasks.                                  |
| `POST /shutdown`                   | Stop the job and shut down the API.                                           |

The API manages one rewards or session-generation job at a time. Start, restart, stop, and regeneration operations return asynchronously; inspect status/events for completion. After a lost response, check `/status` before retrying. See the API guide for request bodies, authentication, SSE events, and error codes. Restart the API after changing its environment settings.

## Docker

Review [compose.yaml](compose.yaml) before starting. Its current defaults run a job immediately (`RUN_ON_START: 'true'`) and schedule daily work at `0 7 * * *` in `Asia/Ho_Chi_Minh`.

For manual API-only operation, enable `API_MODE`, configure `API_TOKEN`, set `RUN_ON_START: 'false'`, clear `CRON_SCHEDULE`, and disable any persisted schedule. `API_MODE` enables the server; `CONFIG_REWARDS_MODE` selects the rewards transport. Saved scheduling settings take precedence over the initial cron environment setting.

### Configuration Overwrite Caveat

The current image bundles the build-time root `config.json` as `config.default.json`. On every startup, [scripts/docker/entrypoint.sh](scripts/docker/entrypoint.sh) copies that file over the mounted `config/config.json`, then applies config synchronization and environment overrides. Existing mounted settings and changes saved through the API can therefore be overwritten by a restart or recreation.

Back up the mounted config before restarting. To carry intended settings through startup, use supported `CONFIG_*` environment overrides or update the bundled root config and rebuild the image. `CONFIG_AUTO_SYNC` controls adding missing defaults; it does not prevent this overwrite. This is recorded in [docs/code-review.md](docs/code-review.md); the usage guide's initialize-only description does not match the current entrypoint.

Validate without printing the resolved credentials, then start the deployment when ready to run its configured services and jobs:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Persist the `config`, `sessions`, and `diagnostics` bind mounts. Docker runs Chromium headlessly. If exposing the API on the host, use the documented loopback mapping `127.0.0.1:3010:3010`.

Use `docker compose stop` to stop the stack and allow its graceful shutdown. The supplied 60-second stop grace period accommodates API and browser cleanup. For a monitoring deployment, use the same Compose file combination for startup, status, logs, and shutdown.

## Nix

With Nix flakes enabled and account/configuration files prepared:

```bash
bash scripts/nix/run.sh
bash scripts/nix/run.sh api
bash scripts/nix/run.sh manual-login user@example.com --platform both
```

These are alternatives: the first executes rewards work, the second starts the Control API, and the third starts interactive login. The launcher installs locked dependencies and Chromium and rebuilds before starting the selected command. It stages the flake definition separately to keep account files and `node_modules` out of the Nix store.

## Monitoring

For local Grafana, set `API_TOKEN` and `GRAFANA_ADMIN_PASSWORD` in `.env`, review startup-run and scheduling settings, and use:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
docker compose -f compose.yaml -f compose.monitoring.yaml up -d --build
```

The overlay adds Prometheus, Grafana, Loki, and a log collector. Grafana defaults to `http://127.0.0.1:3000/d/rewards-accounts`; search diagnostics use `/d/rewards-search-diagnostics`. Set `GRAFANA_PORT` if 3000 is occupied. Grafana initializes its administrator credentials on first startup; changing `.env` later does not reset an existing stored password.

Grafana Cloud uses the metrics overlay `compose.grafana-cloud.yaml` and optional logs overlay `compose.grafana-cloud-logs.yaml`. Follow [docs/monitoring.md](docs/monitoring.md) for credentials, collector setup, and the dashboard installation commands. Those installers write to Grafana Cloud.

The account metrics and persisted search diagnostics track work managed through the Control API. Unknown points and quotas remain distinct from known zeroes. Session-generation jobs do not replace rewards observations. Monitoring overrides retain the application's existing startup-run and scheduling settings.

## Persistence and Maintenance

| Location                  | Contents                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.env`                    | Local credentials and environment settings.                                                               |
| `config.json`             | Local runtime settings; Docker links this to its mounted config.                                          |
| `config/config.json`      | Docker's mounted runtime settings, subject to the startup overwrite above.                                |
| `config/schedule.json`    | Default saved schedule location.                                                                          |
| `config/run-history.json` | Completed Control API run summaries.                                                                      |
| `sessions/sessions.db`    | Default SQLite session store, with cookies, fingerprints, region metadata, and search completion records. |
| `diagnostics/`            | Failure captures and Control API-managed search diagnostic logs.                                          |
| Named monitoring volumes  | Grafana, Prometheus, Loki, and collector state.                                                           |

The session directory is configurable through `sessionPath`; database WAL files can exist alongside `sessions.db`. Stop jobs and services using the store before taking an offline backup, and preserve its private permissions. Back up configuration and required runtime state before an update. Avoid `docker compose down -v` when retaining monitoring data.

Session maintenance commands have explicit scopes:

```bash
npm run clear-sessions -- list
npm run clear-sessions -- email user@example.com
npm run clear-sessions -- all
```

The last two delete saved login state; stop active runs first. `npm run clear-diagnostics` deletes the entire root diagnostics directory, including search logs, so retain evidence needed for troubleshooting before using it.

## Troubleshooting

| Symptom                                        | First checks                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Missing compiled entry point or stale behavior | Run `npm run build`; API JavaScript is copied into `dist`.                                                  |
| No configured accounts                         | Check `ACCOUNT_N_EMAIL` entries and the working directory without printing credentials.                     |
| Chromium missing or fails to launch            | Reinstall the matching browser revision; check Linux libraries and display/headless settings.               |
| Background login requires an interactive code  | Complete manual login on a graphical desktop, then reuse its saved sessions.                                |
| API rejects requests or cannot bind            | Check the matching token, binding/origin rules, and port availability; choose another `API_PORT` if needed. |
| Docker changes disappear after restart         | Inspect the bundled-config overwrite and `CONFIG_*` overrides described above.                              |
| Grafana shows Unknown or no observations       | Check API-managed run history, scraper authentication, and collector health; unknown does not mean zero.    |
| Search diagnostic file is absent               | Confirm runs are API-managed and inspect diagnostics directory permissions and disk space.                  |

Treat captures and logs as sensitive: account identifiers and page content may still be present even where credentials are redacted. Share only the minimum redacted evidence needed to diagnose the issue.
