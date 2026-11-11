# Repository Working Rules

These rules apply to work in this repository. [AGENTS.md](AGENTS.md) is the onboarding entry point; [CODING_CONVENTION.md](CODING_CONVENTION.md), [CODEBASE.md](CODEBASE.md), and [OPERATION_GUIDE.md](OPERATION_GUIDE.md) provide supporting detail.

## Work Within the Task

- Read the relevant code and check the working tree before editing. Preserve changes made by the user or other tools; incorporate them when they affect the task.
- Carry authorized work through implementation, suitable verification, and a clear handoff. Resolve routine implementation choices from repository patterns and existing task context.
- Ask for clarification when missing intent materially affects correctness and cannot be discovered from the repository. Honor authorization already given; avoid adding confirmation steps for routine edits, reads, or checks.
- Keep the diff focused. Avoid unrelated refactors, broad formatting rewrites, dependency churn, or configuration changes.
- Do not reset the working tree, discard someone else's changes, or rewrite history without explicit authorization.

## Protect Credentials and Runtime State

- Never commit actual passwords, API tokens, TOTP secrets, cookies, session databases, proxy credentials, or sensitive captures. Use synthetic values in examples and tests.
- Avoid printing `.env`, session contents, full resolved deployment configuration, or secret-bearing payloads during investigation. Read the narrowest information needed and redact evidence before sharing it.
- Treat account identifiers, metrics labels, browser captures, and diagnostic logs as private data even when credential sanitization is present.
- Preserve configuration, sessions, schedules, and run history unless changing them is part of the task. Keep private file/directory permissions and existing atomic-write behavior.
- Running account jobs, logging in, deleting stored state, applying schedules, and writing cloud dashboards are operational actions. Perform them when the task authorizes them; use build/static checks and mocked tests for development verification.
- Respect required environment approvals, including network and filesystem restrictions, without bypassing them.

## Preserve Behavioral Contracts

- Maintain the browser/API rewards distinction and the separate Control API role. Keep transport-specific behavior behind existing mode services and shared behavior in its established ownership area.
- Preserve account isolation, desktop/mobile session boundaries, browser cleanup, cancellation, and process shutdown flushing.
- Keep unknown values distinct from known zeroes, and observed balances distinct from verified rewards credit. Do not infer successful credit solely from a completed request or submitted search.
- Preserve API authentication, origin restrictions, request validation, sensitive-field redaction, and opt-in write/reveal capabilities. Keep session operations and diagnostic downloads within their existing access and path checks.
- When changing domain events or response fields, inspect downstream parsing, run state, persistence, metrics, and dashboard consumers. Update the documented contract and behavioral tests as needed.
- Preserve the distinction between rewards runs and login-only session generation in reporting and monitoring.

## Edit Sources and Keep Guides Accurate

- Edit maintained source files, not generated `dist` output, dependencies, or runtime state as a substitute for a source change.
- Follow the existing module formats and local helpers. Add a dependency or abstraction only when the task needs it; keep the lockfile consistent with deliberate dependency changes.
- Update configuration types, defaults, validation, overrides, and examples together when applicable.
- Document current behavior from implementation evidence. If an existing guide disagrees with code, state the discrepancy and avoid presenting a proposed fix as existing behavior.
- Keep working rules here, coding details in `CODING_CONVENTION.md`, architecture in `CODEBASE.md`, and operational procedures in `OPERATION_GUIDE.md`. Keep `AGENTS.md` as the short entry point and verification index.

## Verify and Report

- Select checks based on the changed behavior. Use `npm run check` for application changes and focused formatting/link/path checks for documentation-only work.
- Rebuild before tests that import generated modules. Add regression coverage for meaningful behavior changes and failure cases; avoid tests that merely repeat implementation details.
- Use mocked external services and disposable test state. Close resources and restore environment changes created by tests.
- Review the final diff for accidental secrets, unrelated changes, and stale documentation. Run `git diff --check`.
- Report what changed and how it was verified. State failed or unrun checks and material remaining limitations accurately; never imply that a live deployment or account run was tested when it was not.

## Code Review Rules

- Lead with actionable bugs, regressions, security issues, data-loss risks, and missing behavioral coverage, ordered by severity and supported by file/line references.
- Review configuration persistence, auth/capability boundaries, account isolation, unknown-versus-zero semantics, and cleanup when the change touches those areas.
- Treat existing review notes as investigation leads and verify them against current source. Separate pre-existing issues from regressions introduced by the change.
- If no findings remain, say so and identify meaningful verification gaps without inventing issues.
