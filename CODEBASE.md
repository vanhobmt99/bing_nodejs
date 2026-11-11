# Codebase Guide

This project automates Microsoft Rewards work across configured accounts. It has two rewards execution modes, shared account/session infrastructure, a standalone Control API, and local or cloud monitoring. There is no dashboard frontend in this repository; a separate client can connect to the Control API.

Use [CODING_CONVENTION.md](CODING_CONVENTION.md) for implementation conventions and [OPERATION_GUIDE.md](OPERATION_GUIDE.md) for commands and deployment behavior.

## Repository Map

| Location                                                                   | Responsibility                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [src/index.ts](src/index.ts)                                               | Runtime entry point, Node version check, bot creation, lifecycle setup, and final cleanup.                   |
| [src/core](src/core)                                                       | Bot context, account state, run coordination, account workflows, clustering, and shutdown.                   |
| [src/config](src/config)                                                   | Types, defaults, validation, config synchronization, environment overrides, and execution-plan reporting.    |
| [src/browser](src/browser)                                                 | Patchright browser management, profiles, page/request helpers, authentication methods, and browser sessions. |
| [src/session](src/session)                                                 | SQLite-backed saved session state and login-only session generation.                                         |
| [src/network](src/network)                                                 | HTTP clients, headers, errors, and cookie utilities.                                                         |
| [src/rewards](src/rewards)                                                 | Rewards service, browser/API/app implementations, shared orchestration, parsers, and domain types.           |
| [src/logging](src/logging)                                                 | Structured events, diagnostics, run summaries, sanitization, and notification transports.                    |
| [src/control-api](src/control-api)                                         | HTTP server, job process management, authentication, settings, persisted history, live events, and metrics.  |
| [src/util](src/util), [src/constants](src/constants), [src/data](src/data) | Utilities, locale handling, URLs/feed definitions, and bundled query data.                                   |
| [scripts](scripts)                                                         | Operational commands, shared JavaScript helpers, Docker startup/scheduling, and Nix launchers.               |
| [tests](tests)                                                             | Node test suites for monitoring, cloud dashboards, and search diagnostics.                                   |
| [monitoring](monitoring)                                                   | Prometheus, Grafana dashboard/provisioning, Loki, and Alloy configuration.                                   |
| [docs](docs)                                                               | Detailed usage, Control API, monitoring, and recorded review documents.                                      |

Root configuration includes `package.json`, the npm lockfile, TypeScript/ESLint/Prettier settings, Docker/Compose files, and the Nix flake. `dist` is generated output and is not an implementation location.

## Rewards Execution Flow

1. `src/index.ts` validates the Node version and loads configuration. `src/core/createBot.ts` selects `BrowserRewardsBot` or `ApiRewardsBot` from `rewardsMode`.
2. `BotRunner` delegates initialization and execution to `RunCoordinator`. Accounts come from numbered environment entries. With multiple clusters, the primary process distributes account chunks to workers and gathers results.
3. `AccountRunner` resets per-account state, establishes desktop sign-in, creates the selected workflow, loads dashboard data, resolves locale, and runs enabled work. Its cleanup closes account sessions.
4. The mode workflow decides which desktop/mobile sessions and tasks are needed. Browser mode retains pages for browser work. API mode closes sign-in browsers and continues using saved cookies through HTTP clients.
5. Activities, search managers, app tasks, and final accounting emit results. Run coordination aggregates account outcomes and notifications. Process lifecycle handlers propagate cancellation, close browsers, flush diagnostics/notifications, and close the session store.

`BotContext` provides shared configuration, services, account state, and cancellation. `ExecutionContext` carries account/platform context through asynchronous work. Preserve these boundaries when adding account-scoped behavior.

## Rewards Subsystems

| Area                  | Ownership                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/rewards/browser` | Rendered-page workflows, task discovery/execution, browser searches, page parsers, and visual search.                                                        |
| `src/rewards/api`     | HTTP rewards workflows, searches, action reporting, and API visual search.                                                                                   |
| `src/rewards/app`     | App identity, platform data, daily check-in, promotions, and app activity execution.                                                                         |
| `src/rewards/shared`  | Activities, point accounting, promotion eligibility, normalized data/parsers, search planning, query sources, HTTP helpers, and shared Edge/visual behavior. |
| `src/rewards/types`   | Rewards state, activity results, data-source contracts, visual-search types, and mode-service interfaces.                                                    |

The `createBrowserMode` and `createApiMode` factories supply the existing `ModeServices` contract. `RewardsService` and shared activities consume those services. Prefer extending the relevant mode implementation or shared service rather than spreading mode checks across callers.

Browser mode can still use HTTP/app actions. API mode still requires browser authentication. Transport selection does not remove the need to coordinate desktop/mobile session state or point verification.

## Configuration and Sessions

- `Load.ts` locates `config.json`, loads `.env` without overwriting existing process environment values, applies supported overrides, and caches the resulting configuration. `Validator.ts` validates configuration/accounts using Zod; `Defaults.ts` holds built-in defaults.
- `ConfigSync.ts` adds missing default keys on request. `ExecutionPlan.ts` describes effective workers and browser requirements. Keep these aligned when configuration behavior changes.
- `scripts/lib/projectFiles.cjs` implements shared path resolution, environment loading, and atomic JSON writes; both source and compiled execution rely on the root `scripts` helpers.
- `SessionStore.ts` uses Node's `node:sqlite` and `scripts/lib/sessionDatabase.cjs`. The database stores desktop/mobile state, fingerprints, resolved regions, and per-date search completion. Its default location is `sessions/sessions.db`.
- Browser authentication is under `src/browser/auth`; automated login-session generation is under `src/session`. Interactive maintenance commands live under `scripts/main`.

The Docker entrypoint has additional configuration behavior, including an overwrite on startup. See [OPERATION_GUIDE.md](OPERATION_GUIDE.md) before relying on mounted settings surviving a restart.

## Control API and Observability

`src/control-api/server.js` assembles access control and route factories for monitoring, settings, sessions, diagnostics, and run control. It uses Node HTTP directly. Shared request/response validation is in `http.js`; the documented HTTP contract is in [docs/control-api.md](docs/control-api.md).

`ProcessManager` owns one managed rewards or session-generation job, process lifecycle, output collection, and run state. Completed summaries persist to `config/run-history.json`; active state and retained log buffers are held in memory. Schedule persistence and cron application are handled separately from local API startup.

The main observability flow is:

```text
Rewards runtime structured events
  -> managed child-process output
  -> Control API event parsing and state application
  -> status / events / history / metrics

Search diagnostic events
  -> diagnostics/search/events.jsonl
  -> Alloy -> Loki -> Grafana

Control API metrics
  -> Prometheus or Alloy -> local Grafana or Grafana Cloud
```

Event producers are in `src/logging`; consumers and validation are in `src/control-api/logs`. `metrics.js` renders Prometheus samples, and `searchDiagnosticLog.js` writes allowlisted diagnostic fields with rotation. Account observations require API-managed work; standalone CLI runs do not populate its managed run history.

Point accounting distinguishes observed balances, verified credit, activity confirmation, and unknown data. Metrics/tests preserve known zeroes and omit unavailable values. Session-generation jobs and removed accounts must not become new rewards observations. Retained-history gauges are not lifetime counters.

## Build and Tests

`npm run build` removes `dist`, compiles TypeScript as CommonJS, and copies `src/data` and the ESM `src/control-api` into it. The copied Control API retains its own `package.json`. JavaScript scripts also have an ESM package boundary; shared `.cjs` helpers bridge module formats.

`npm run check:api` separately checks Control API JavaScript without emitting files. Existing tests use Node's test runner and import a mix of generated runtime modules and source script helpers. Build before running tests that depend on `dist`.

CI in [.github/workflows/validate.yml](.github/workflows/validate.yml) installs locked dependencies on Node 24 and runs build, API checks, the monitoring suite, lint, and formatting. The local aggregate is `npm run check`.

## Common Change Locations

| Task                                      | Start here and follow through                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Add a configuration setting               | `src/config`: types, defaults, validation, overrides and plan; update examples and relevant docs.         |
| Change browser login/session reuse        | `src/browser/auth`, browser sessions, `src/session`, and matching script helpers.                         |
| Change a rewards task                     | Relevant browser/API/app implementation; shared activities and result types when both modes are affected. |
| Change query selection or search progress | `src/rewards/shared/query`, `src/rewards/shared/search`, and the matching mode's search implementation.   |
| Add an API endpoint                       | Existing route factory, HTTP/access helpers, endpoint listing, tests, and API documentation.              |
| Change account reporting                  | Structured event producer, `src/control-api/logs`, history mapping, metrics, and dashboard queries.       |
| Change deployment startup                 | Docker entrypoint/scheduler or Nix launcher; configuration persistence and shutdown behavior.             |
| Change a dashboard                        | `monitoring/grafana`, metric/log consumers, cloud installer helpers, and relevant tests.                  |
