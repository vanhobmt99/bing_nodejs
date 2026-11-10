# Agent Onboarding

This repository contains Microsoft Rewards automation with browser and API task modes, a separate HTTP Control API, and a monitoring stack. It requires Node.js 24 or newer and uses npm with a committed lockfile.

## Read Before Working

1. Read [RULE.md](RULE.md) for repository working rules.
2. Read [CODEBASE.md](CODEBASE.md) to locate the relevant subsystem and understand its data flow.
3. Read [CODING_CONVENTION.md](CODING_CONVENTION.md) before changing code or tests.
4. Consult [OPERATION_GUIDE.md](OPERATION_GUIDE.md) for setup, execution, deployment, or troubleshooting tasks.

These supporting documents must be opened explicitly; their filenames alone do not make them agent instructions. This root guide applies throughout the repository.

## Working Sequence

- Inspect `git status --short`, the relevant implementation, and nearby tests before editing. Preserve existing local changes.
- Identify whether a task affects browser rewards, API rewards, shared behavior, or the Control API. API rewards mode and the Control API server are separate concepts.
- Follow the local module format: TypeScript compiles to CommonJS, while the Control API and JavaScript scripts use ESM package boundaries.
- Make the smallest complete change, update affected documentation, and select verification appropriate to its behavior.
- Review the final diff and report the result, checks performed, and any remaining limitations.

## Development Commands

Run commands from the repository root.

```bash
npm ci --include=dev --ignore-scripts
npm run check
```

`check` builds the runtime, type-checks the Control API, runs the monitoring and search-diagnostic tests, lints, and checks formatting. It does not start a rewards job. Chromium installation is a separate operation needed for actual browser use, including API-mode sign-in.

| Change                           | Verification                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Application or shared behavior   | `npm run check`, plus focused regression coverage where behavior changes.          |
| Control API                      | Include `npm run check:api`; rebuild before tests that import `dist`.              |
| Monitoring or search diagnostics | Include `npm run build` followed by `npm run test:monitoring`.                     |
| Markdown only                    | Check changed files with the local Prettier executable and run `git diff --check`. |

Do not use `npm start`, `npm run dev`, login commands, or deployment commands as routine build verification. Those commands can access configured accounts or start services.

## Useful References

- [Setup and settings](docs/usage.md)
- [Control API contract](docs/control-api.md)
- [Monitoring and dashboard setup](docs/monitoring.md)
- [Recorded code review](docs/code-review.md)

Verify behavior against the implementation and current configuration when documentation disagrees. In particular, read the Docker configuration caveat in [OPERATION_GUIDE.md](OPERATION_GUIDE.md) before restarting a deployment.
