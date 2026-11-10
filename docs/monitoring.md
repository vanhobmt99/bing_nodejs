# Grafana Setup And Account Monitoring

The monitoring stack runs Prometheus and Grafana alongside the Control API. The provisioned **Microsoft Rewards Accounts** dashboard includes an account filter, health and status, observed balances, verified points, activity attribution, remaining quotas, streaks and time since the last completed run.

## Choose A Setup

| Setup                                              | Where to view the dashboard                         | Services added          |
| -------------------------------------------------- | --------------------------------------------------- | ----------------------- |
| [Local Grafana](#start-with-docker)                | `http://127.0.0.1:3000/d/rewards-accounts`          | Prometheus and Grafana  |
| [Grafana Cloud](#grafana-cloud)                    | `https://your-stack.grafana.net/d/rewards-accounts` | Grafana Alloy           |
| [Existing Grafana](#existing-grafana-installation) | Your existing Grafana URL                           | Your Prometheus scraper |

See [Login And Password Recovery](#login-and-password-recovery), [Search Views](#search-views), and [Troubleshooting](#troubleshooting) after setup.

## Prerequisites

Run commands from the repository root. Docker deployments need Docker Engine and the Docker Compose plugin (`docker compose version`). The Cloud dashboard installer also needs Node.js 24 or newer and project dependencies installed with `npm ci --include=dev --ignore-scripts`.

Create `.env` using [env.example](../env.example) if it does not already exist. Keep an existing `.env` and add the required settings to it. Configure at least `ACCOUNT_1_EMAIL`, plus the account's required authentication/session settings. Complete account setup using the [project guide](../README.md) before running rewards jobs. Keep actual passwords and tokens in the ignored environment file.

The Compose examples below read `.env`. A file such as `.env.monitoring.local` is not loaded automatically. Shell environment values take precedence over `.env` for Compose substitution and the Cloud installer.

## Start With Docker

Configure accounts in `.env` using [env.example](../env.example), then add:

```dotenv
API_TOKEN=replace-with-a-generated-token
GRAFANA_ADMIN_PASSWORD=replace-with-a-strong-password
GRAFANA_ADMIN_USER=admin
GRAFANA_PORT=3000
```

Generate a token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The base [compose.yaml](../compose.yaml) has `RUN_ON_START: 'true'` and a daily schedule. Set `RUN_ON_START: 'false'` in that service before starting if you do not want an immediate rewards run. The monitoring override preserves those service settings.

Validate configuration, then start the application and monitoring services:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
docker compose -f compose.yaml -f compose.monitoring.yaml up -d --build
docker compose -f compose.yaml -f compose.monitoring.yaml ps
```

Open [Grafana](http://127.0.0.1:3000/d/rewards-accounts) and sign in with `admin` (or `GRAFANA_ADMIN_USER`) and `GRAFANA_ADMIN_PASSWORD`. The data source and dashboard are provisioned automatically. Grafana is bound to host loopback; Prometheus is accessible inside the Compose network. The monitoring override enables the Control API on internal port 3010 and preserves the application's existing schedule and startup-run settings.

Grafana's administrator password is initialized on its first start. Changing `.env` does not reset a password already stored in its persistent volume. Set `GRAFANA_PORT` to a free port if 3000 is occupied.

Select **Rewards Prometheus** as the data source and **local** as the deployment. Allow up to a minute for the first samples. Accounts appear before a rewards run, while balances and search results remain Unknown until observed. See [Search Views](#search-views) for account/device filters.

Prometheus scrapes every 30 seconds and retains samples for 30 days. Named Docker volumes retain both monitoring databases across container recreation. Avoid `docker compose down -v` when retaining monitoring data.

### Access From Another Computer

Grafana listens on the Docker host's loopback address. From your own computer, forward the port over SSH:

```bash
ssh -N -L 3300:127.0.0.1:3000 ubuntu@your-server
```

Open `http://127.0.0.1:3300/d/rewards-accounts` on your computer. If the server uses `GRAFANA_PORT=3300`, change the tunnel destination to `3300:127.0.0.1:3300`. Use a free local port if 3300 is already occupied.

## Login And Password Recovery

| Credential                                                            | Purpose                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`                     | Local Grafana browser login; default username is `admin`.           |
| `API_TOKEN`                                                           | Authentication for Control API requests and metric scraping.        |
| Your Grafana.com account or organization SSO                          | Grafana Cloud browser login.                                        |
| `GRAFANA_CLOUD_PROMETHEUS_USERNAME` and `GRAFANA_CLOUD_METRICS_TOKEN` | Alloy remote writes to Grafana Cloud.                               |
| `GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN`                                 | Installing or updating the Cloud dashboard through the Grafana API. |

For local Grafana, use the username and password configured when that instance was first initialized. A later browser password change overrides the original environment setting. Restarting or recreating the container keeps that stored password. Confirm you are opening the port selected by `GRAFANA_PORT`; the local preview used during development may instead run on port 3300 with credentials in `.env.monitoring.local`.

To recover the administrator password for the Compose-managed local Grafana, run this Bash snippet on the Docker host. It prompts without echoing and sends the new password to Grafana through stdin:

```bash
read -r -s -p 'New Grafana admin password: ' grafana_reset_password
printf '\n'
printf '%s\n' "$grafana_reset_password" | docker compose -f compose.yaml -f compose.monitoring.yaml exec -T grafana \
    grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini \
    admin reset-admin-password --password-from-stdin
unset grafana_reset_password
```

The command resets the default administrator (user ID 1), preserves dashboards and data, and leaves the username unchanged. Update `GRAFANA_ADMIN_PASSWORD` in `.env` to match afterward. For a separately started preview container, use `docker exec -i rewards-grafana-preview` in place of `docker compose -f compose.yaml -f compose.monitoring.yaml exec -T grafana`. Use your Grafana.com or SSO recovery flow for Cloud access.

## Grafana Cloud

Use Grafana Alloy to scrape the local Control API and send metrics to Grafana Cloud over HTTPS. This setup runs the application and Alloy; a local Grafana or Prometheus server is not required. No inbound API port is published.

### 1. Get Metrics Credentials

Sign in to [Grafana Cloud](https://grafana.com/) and create or open your stack. In the stack, open **Connections > Add new connection > Hosted Prometheus** and copy the Prometheus remote-write URL and username. Create a Cloud Access Policy token with `metrics:write` scope for that stack.

These values become `GRAFANA_CLOUD_PROMETHEUS_URL`, `GRAFANA_CLOUD_PROMETHEUS_USERNAME` and `GRAFANA_CLOUD_METRICS_TOKEN` in the next steps. Use the actual URL and username shown by your stack.

### 2. Get Dashboard Credentials

In your stack's **Administration > Users and access > Service accounts**, create a service account with the **Editor** role, or equivalent permission to read the selected data source and create/update dashboards. Generate a service account token for `GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN`.

Open **Connections > Data sources**, select your Cloud Prometheus data source and copy its UID for `GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID`. The UID identifies the data source, and may look like `grafanacloud-your-stack-prom`. Use your stack's HTTPS browser URL for `GRAFANA_CLOUD_URL`.

The service account token installs the dashboard; the Cloud Access Policy token from step 1 sends metrics. Keep both values in their corresponding settings.

### 3. Configure The Environment

Create `.env` from [env.example](../env.example) if needed, or edit the existing repository-root `.env`. Keep your `ACCOUNT_N_*` settings and add this complete Cloud configuration:

```dotenv
API_TOKEN=replace-with-a-generated-local-api-token

GRAFANA_CLOUD_PROMETHEUS_URL=https://prometheus-prod-REGION.grafana.net/api/prom/push
GRAFANA_CLOUD_PROMETHEUS_USERNAME=123456
GRAFANA_CLOUD_METRICS_TOKEN=replace-with-a-metrics-write-token
GRAFANA_CLOUD_DEPLOYMENT=rewards

GRAFANA_CLOUD_URL=https://your-stack.grafana.net
GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN=replace-with-a-grafana-service-account-token
GRAFANA_CLOUD_PROMETHEUS_DATASOURCE_UID=grafanacloud-your-stack-prom
```

Replace the example values with your stack's settings. Generate a new `API_TOKEN` with the following command if you do not already have one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`API_TOKEN` protects local scraping; `GRAFANA_CLOUD_METRICS_TOKEN` authenticates remote writes. Assign a unique `GRAFANA_CLOUD_DEPLOYMENT` value to each server sending to the same Cloud stack. The dashboard selects one deployment at a time to keep each server's account records separate. Cloud metrics include account email labels, balances and activity information.

### 4. Start The Application And Alloy

Run from the repository root. The base [compose.yaml](../compose.yaml) has `RUN_ON_START: 'true'` and a daily schedule. Set `RUN_ON_START: 'false'` in that service before starting if you do not want an immediate rewards run; scheduled runs remain enabled.

```bash
docker compose -f compose.yaml -f compose.grafana-cloud.yaml config --quiet
docker compose -f compose.yaml -f compose.grafana-cloud.yaml up -d --build
docker compose -f compose.yaml -f compose.grafana-cloud.yaml ps
```

Alloy receives these monitoring settings only, and keeps its remote-write queue in a persistent Docker volume. Its HTTP port is not published. To run local monitoring and Cloud together, include both `compose.monitoring.yaml` and `compose.grafana-cloud.yaml` in the same Compose command and also configure the local Grafana variables.

### 5. Install The Cloud Dashboard

Using Node.js 24 or newer, run from the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm run monitoring:cloud:dashboard
```

The command loads `.env`, verifies the selected Prometheus data source and creates or updates the dashboard with UID `rewards-accounts`. Re-running it replaces that dashboard, including manual edits made to it in Grafana. It prints the dashboard URL when successful. Your existing shell environment takes precedence over `.env`.

Preview the dashboard payload without contacting Cloud:

```bash
npm run monitoring:cloud:dashboard -- --dry-run
```

Alternatively, import [accounts.json](../monitoring/grafana/dashboards/accounts.json) manually in Grafana Cloud.

### 6. Open And Verify The Dashboard

Open the URL printed by the installer, such as `https://your-stack.grafana.net/d/rewards-accounts`. Sign in with your **Grafana.com account or organization SSO**. Local `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` settings apply to local Grafana; use your Cloud login for this stack.

Select your Cloud Prometheus **Data source**, **Deployment** (`rewards` unless changed), **Account**, and **Search device**. Allow about a minute for initial samples. In **Explore**, select the same data source and run:

```promql
up{job="microsoft-rewards",deployment="rewards"}
```

Replace `rewards` with your `GRAFANA_CLOUD_DEPLOYMENT` value if different. A value of `1` confirms successful scraping and delivery to Cloud. `0` indicates an API scrape failure; an absent series may indicate Alloy or Cloud remote-write configuration issues. Balances and search results populate as rewards jobs run through the Control API. See [Troubleshooting](#troubleshooting) for logs and common errors.

## Search Views

Select an **Account** and **Search device** (`mobile`, `desktop` or All) to compare regular search points. The search table lists each account/device pair with its latest activity status, verified points and available search points at the start of the run. The account and device charts show the same selected results grouped for comparison, followed by a history chart. These views work in local Grafana and Grafana Cloud; re-run `npm run monitoring:cloud:dashboard` to update an existing Cloud dashboard.

Search points use the current run's device summary when available and otherwise verified regular-search activity results. While a device has no verified result, its points remain Unknown. A known zero is shown as zero. During a new run, earlier search results are not reused for an account already active in that run. Bonus searches and experimental API reports are excluded from regular mobile/desktop search totals and remain visible in activity attribution. Available points are the initial quota observation, not a live remaining quota or search count.

## Search Diagnostic Logs

The **Rewards Search Diagnostics** dashboard (`/d/rewards-search-diagnostics`) shows Bing sign-in checks and their evidence source, quota reads, successful query submissions, failed submission attempts, points per measured batch, balances, and session outcomes. Filter by deployment, account email regex, device, and stage. Expand a log entry to inspect its fields and `runId`. Counts reflect diagnostic events in the selected time range, rather than unique accounts or runs. A final zero-point measurement is excluded from the zero-credit batch count.

Diagnostics are emitted with debug logging disabled. Runs launched through the Control API save these events to `diagnostics/search/events.jsonl`; the file rotates at 5 MiB and keeps three archives (about 20 MiB total). Alloy tails the current file and forwards it to Loki. Log write failures produce a warning and do not stop Rewards work. The local Loki store retains logs for 30 days; local file retention bounds recovery if the collector is offline. Only the allowlisted diagnostic fields are written: no cookies, tokens, passwords, raw URLs, or query text. Account emails and run IDs remain searchable JSON fields, rather than indexed Loki labels. Keep the diagnostics directory private; the bundled Alloy collector runs as root to read the private file.

The local monitoring Compose stack includes Loki and the log collector. After updating and rebuilding the application, run the normal local Compose startup command from this guide to apply them. Loki has no published host port; Grafana queries it over the Compose network. The dashboard starts receiving events with the next API-managed Rewards run. Earlier runs cannot be reconstructed from metrics.

For Grafana Cloud, obtain the hosted Loki push URL, username, and a token with `logs:write` scope from your Cloud connection details, and set these in `.env`:

```env
GRAFANA_CLOUD_LOKI_URL=https://logs-prod-REGION.grafana.net/loki/api/v1/push
GRAFANA_CLOUD_LOKI_USERNAME=123456
GRAFANA_CLOUD_LOGS_TOKEN=your-logs-write-token
GRAFANA_CLOUD_LOKI_DATASOURCE_UID=your-cloud-loki-datasource-uid
```

Add the logs overlay to the Cloud stack and install the diagnostic dashboard using the same Grafana service account settings as the account dashboard:

```bash
docker compose -f compose.yaml -f compose.grafana-cloud.yaml -f compose.grafana-cloud-logs.yaml up -d --build
npm run monitoring:cloud:logs-dashboard
```

The Cloud metrics configuration remains usable without the logs overlay or Loki credentials. `npm run monitoring:cloud:logs-dashboard -- --dry-run` prints the dashboard payload without publishing it. Cloud log retention follows your stack's configured policy.

For a custom Node.js deployment, run Alloy with `monitoring/alloy/logs.alloy`, mount the project's `diagnostics` directory at `/var/log/rewards`, and set `REWARDS_DEPLOYMENT`, `LOKI_URL`, `LOKI_USERNAME`, and `LOKI_TOKEN`. The last two may be empty for a local Loki instance with authentication disabled.

The diagnostic outcome distinguishes a verified completed quota from an unknown-quota probe that stopped without credit (`quota-probe-no-credit`). Existing Rewards behavior is unchanged: normal runs can continue after unverified sign-in, and legacy activity summaries can still mark bounded probes confirmed. The diagnostic log makes both conditions explicit; it does not establish why Microsoft withheld credit.

## Troubleshooting

| Symptom                                                 | What to check                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid username or password                            | Use the correct instance/port and local or Cloud credentials from the table above. Recover the stored local password if needed; editing `.env` alone will not change it.       |
| Port is already allocated                               | Set an unused `GRAFANA_PORT` in `.env`, re-run the same Compose startup command, and open that port.                                                                           |
| `up` is `0`                                             | The scraper cannot reach or authenticate with the API. Check the application health and matching `API_TOKEN`.                                                                  |
| `up` is absent                                          | Check the selected data source/deployment and whether Prometheus or Alloy is running. For Cloud, check the remote-write URL, username, token scope, and outbound HTTPS access. |
| Accounts exist but points are Unknown                   | Run rewards work through the Control API. Metrics need verified observations; jobs launched directly outside the API are not tracked.                                          |
| Cloud dashboard installation returns 401 or 403         | Check `GRAFANA_CLOUD_SERVICE_ACCOUNT_TOKEN` and its dashboard/data-source permissions. The metrics-write token cannot install dashboards.                                      |
| Cloud dashboard installation reports a missing variable | Add the required Cloud settings to the repository-root `.env`. Check for stale shell values overriding them.                                                                   |

For local setup, inspect service health and recent logs:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml ps
docker compose -f compose.yaml -f compose.monitoring.yaml logs --tail=100 grafana prometheus microsoft-rewards-script
```

For Cloud setup, inspect Alloy and API logs:

```bash
docker compose -f compose.yaml -f compose.grafana-cloud.yaml logs --tail=100 alloy microsoft-rewards-script
```

In Grafana **Explore**, select the relevant Prometheus data source and query `up{job="microsoft-rewards",deployment="local"}` for local setup, or replace `local` with `GRAFANA_CLOUD_DEPLOYMENT` for Cloud. A value of `1` confirms successful scraping. After adding panels or updating dashboard JSON, local provisioning reloads it within about 30 seconds; re-run `npm run monitoring:cloud:dashboard` for Cloud.

## Metrics

`GET /metrics` uses the same `Authorization: Bearer` or `X-API-Key` authentication as the other Control API endpoints. No credentials are included in exported labels; account email addresses and slot numbers identify series. The Prometheus container receives only the API token and writes it to a private runtime credential file for scraping.

```bash
curl http://127.0.0.1:3010/metrics -H "Authorization: Bearer $API_TOKEN"
```

The example above needs a locally running API or a host port mapping for the API. The monitoring Compose override does not publish that port.

| Metric                                                | Meaning                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `rewards_accounts_configured`                         | Configured account slots.                                                            |
| `rewards_run_active`                                  | Active rewards run; excludes session regeneration.                                   |
| `rewards_account_status`                              | Numeric state shown below.                                                           |
| `rewards_account_balance_points`                      | Latest verified/observed available balance.                                          |
| `rewards_account_balance_updated_timestamp_seconds`   | Timestamp of the exported balance observation.                                       |
| `rewards_account_points_known`                        | Whether the current or latest run's collected points are verified.                   |
| `rewards_account_collected_points`                    | Verified collected points in the current or latest run.                              |
| `rewards_account_collected_points_by_source`          | Attributed points by activity source.                                                |
| `rewards_account_last_run_timestamp_seconds`          | Latest completed account run.                                                        |
| `rewards_account_last_run_duration_seconds`           | Duration of that completed run.                                                      |
| `rewards_account_last_run_success`                    | `1` for success, `0` otherwise; absent before any run.                               |
| `rewards_account_history_*`                           | Counts and verified points across retained run summaries.                            |
| `rewards_account_remaining_points`                    | Remaining earnable points by `mobile`, `browser` or `app` pool.                      |
| `rewards_account_search_info`                         | Configured account/device pairs (`mobile` and `desktop`).                            |
| `rewards_account_search_collected_points`             | Verified regular-search points by account and device.                                |
| `rewards_account_search_points_known`                 | Whether the selected run has known regular-search points for a device.               |
| `rewards_account_search_available_points`             | Initial available regular-search points by device.                                   |
| `rewards_account_search_status`                       | Latest search result: 0 unobserved, 1 confirmed, 2 unconfirmed, 3 skipped, 4 failed. |
| `rewards_account_streak_length`                       | Last observed streak length in calendar days.                                        |
| `rewards_account_streak_protection_remaining_seconds` | Last observed remaining protection time in seconds.                                  |

Account status codes: `0` never run, `1` running, `2` completed, `3` partial, `4` skipped, `5` failed, `6` cancelled, `7` unknown.

All exported application metrics are **gauges**. History metrics cover the retained `API_RUN_HISTORY` summaries (default 20), and can decrease as older summaries expire. Do not apply `rate()` or `increase()` to these gauges. The points chart shows snapshots of each account's current/latest run, rather than a daily earnings total.

Unknown points, balances and quotas are omitted rather than reported as zero. A verified zero is exported as zero. Failed runs retain the most recent observed balance when available. An observed balance can be known even when collected points are unknown. The table's last-finished timestamp refers to completed history, even while a new run is active. Source attribution can contain a verified subtotal while the overall collected amount is still unknown.

The API restores account observations from `config/run-history.json` after restart. Session-generation jobs do not replace rewards observations. Metrics cover configured accounts, and only work managed through the Control API is tracked. Keep the same account slot/email pairing to retain continuous Prometheus series. No history is synthesized for the period before monitoring starts.

## Existing Grafana Installation

Scrape the Control API's `/metrics` with a bearer token, a job named `microsoft-rewards`, and a 30-second interval. Use [prometheus.yml](../monitoring/prometheus/prometheus.yml) as a template, updating the API address and credential-file location for your environment.

Import [accounts.json](../monitoring/grafana/dashboards/accounts.json), then select your Prometheus data source and deployment. The local provisioned data source uses UID `rewards-prometheus`; use [the data-source definition](../monitoring/grafana/provisioning/datasources/prometheus.yml) as a template, updating its URL if needed. Scrape targets must include a `deployment` label, such as `local`, for the dashboard's deployment filter.

## Verification

```bash
npm ci --include=dev --ignore-scripts
npm run check
```

The focused monitoring tests cover authenticated HTTP scraping, unknown versus zero values, live/historical selection, session-job exclusion, label escaping and Grafana Cloud dashboard provisioning. Run them after building with `npm run test:monitoring`.
