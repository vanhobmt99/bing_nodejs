# Account Monitoring Code Review

Review scope: account execution, Control API authentication, live account state, persisted run summaries and Docker startup. No live Microsoft account was used for verification.

## Finding

**P1: Docker restarts overwrite persisted configuration.** In [entrypoint.sh](../scripts/docker/entrypoint.sh#L40), startup unconditionally copies the bundled `config.default.json` over the volume-backed `config/config.json`. As a result, changes saved through `PUT /config` or `PATCH /config` are discarded when the container restarts or is recreated. Settings such as disabled workers and account delays return to the bundled values. The default should initialize a missing file; an existing persisted configuration should survive startup and then receive any configured environment overrides. This existing behavior is not changed by the monitoring integration.

## Monitoring Changes

- Added authenticated Prometheus metrics using the Control API's existing access control.
- Added Prometheus/Grafana Compose services with persistent storage and a provisioned account dashboard.
- Added an Alloy collector for Grafana Cloud and a dashboard setup command configured through `.env`.
- Kept unknown collected points distinct from zero, and observed balances independent of credit verification.
- Excluded session-generation jobs and removed accounts from account metrics.
- Used gauges for snapshots and retained-history statistics; these values are not lifetime counters.

The automated tests cover HTTP authentication and content type, point verification, live/history selection, actual failed-account domain events, session-job exclusion and label escaping. Grafana setup and metric semantics are documented in [monitoring.md](monitoring.md).
