# Coding Convention

Use this guide for implementation and test changes. [RULE.md](RULE.md) defines working rules; [CODEBASE.md](CODEBASE.md) describes subsystem ownership.

## Formatting and Names

The authoritative settings are [.prettierrc](.prettierrc), [eslint.config.mjs](eslint.config.mjs), and the TypeScript configurations.

| Setting                       | Convention                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Indentation                   | Four spaces, no tabs.                                                                  |
| JavaScript/TypeScript strings | Single quotes.                                                                         |
| Statement endings             | No semicolons.                                                                         |
| Trailing commas               | None.                                                                                  |
| Line endings                  | LF.                                                                                    |
| Print width                   | 120, as configured in Prettier.                                                        |
| Arrow parameters              | Omit parentheses where Prettier permits.                                               |
| Names                         | PascalCase types/classes, camelCase functions/variables; follow neighboring filenames. |

TypeScript domain files commonly use PascalCase names, with existing factory names such as `createBot.ts`. Control API files use camelCase, and tests use descriptive `.test.mjs` filenames. Preserve the established convention in the directory being changed.

Use ASCII for new text unless existing content or the task calls for other characters. Add short comments for non-obvious constraints or behavior; use names and control flow to explain straightforward operations.

## Module Boundaries

- The TypeScript runtime compiles with `module: commonjs`, `target: ES2022`, and strict checking from [tsconfig.json](tsconfig.json). Follow existing extensionless relative TypeScript imports and `import type` usage.
- [src/control-api/package.json](src/control-api/package.json) makes the Control API JavaScript ESM. Use explicit `.js` extensions for relative imports. Its JavaScript is checked separately through [tsconfig.control-api.json](tsconfig.control-api.json), with `allowJs`, `checkJs`, and `noEmit`.
- [scripts/package.json](scripts/package.json) makes scripts ESM. Shared `.cjs` helpers remain CommonJS so both the runtime and scripts can use them.
- Update the corresponding `.d.cts` or `.d.ts` declarations when changing the interface of a declared JavaScript helper. Preserve the existing JSON import attribute syntax where used.
- [scripts/main/copyAssets.js](scripts/main/copyAssets.js) copies runtime data and the Control API into `dist` after TypeScript compilation. Implement changes in source files and rebuild.

Do not introduce a module-system conversion as part of an unrelated fix.

## Types and Validation

- Use existing domain interfaces for configuration, rewards state, mode services, activity results, and run results. Narrow external values before treating them as domain data.
- Prefer `unknown` to a new `any`; explicit `any` is an ESLint warning. Avoid non-null assertions unless the surrounding code establishes the invariant.
- Account for missing indexed values: `noUncheckedIndexedAccess` is enabled. Other enforced checks include unused locals/parameters, explicit overrides, return paths, and switch fallthrough.
- Keep configuration types, defaults, Zod validation, supported environment overrides, and examples aligned when adding a setting. Follow [src/config](src/config) rather than introducing a second configuration loader.
- Preserve the distinction between an unknown value and a known zero. Use existing point-accounting and completion helpers instead of coercing missing observations to zero.

## Ownership and Shared Helpers

- Put transport-specific reward behavior in `src/rewards/browser` or `src/rewards/api`. Put behavior shared by both modes in `src/rewards/shared`, retaining the existing `ModeServices` boundary.
- Reuse the browser/session managers and request clients for browser lifetime, authentication state, cookies, and HTTP requests.
- Reuse `scripts/lib/projectFiles.cjs` for project-file resolution, environment loading, and atomic JSON writes. Reuse the session database, proxy, argument-parsing, and logging helpers where applicable.
- Keep Control API handlers within its existing route factories, access control, HTTP helpers, and process manager.
- Add an abstraction when it removes meaningful duplication or matches an established pattern. Keep unrelated refactors and dependency changes outside the task.

## Errors, Cancellation, and Logging

- Preserve the original error and enough context to diagnose a failure. Narrow caught values before reading error properties in TypeScript.
- Propagate cancellation and account deferral through the existing signals and result types. Close owned browser/session resources in cleanup paths and preserve process shutdown flushing.
- Catch an error locally when the operation has an intentional fallback or cleanup behavior. Keep that behavior explicit; ESLint rejects empty blocks except its configured exceptions.
- Use the existing logger and structured domain events for operational results. Control API state is derived from those events; changing an event requires checking its producer, parser, state application, persistence, and metrics consumers.
- Keep passwords, tokens, cookies, proxy credentials, and raw sensitive payloads out of logs, diagnostics, fixtures, and error responses. Reuse the sanitization and diagnostic field allowlist.

## Tests and Verification

Tests use `node:test` and `node:assert/strict`. The existing `test:monitoring` command runs monitoring, Grafana Cloud, and search-diagnostic tests; there is no generic `npm test` script.

```bash
npm run build
npm run check:api
npm run test:monitoring
npm run lint
npm run format:check
```

`npm run check` runs that full sequence. Several tests import compiled modules from `dist`; rebuild before running them after source changes. For a focused run after building:

```bash
node --test tests/search-diagnostics.test.mjs
```

Test observable behavior and relevant failure cases. Use synthetic accounts, mocked external requests, and temporary directories cleaned up with test hooks. Restore changed environment variables and close servers or processes created by a test. Do not make real Microsoft or Grafana requests to validate a local change.

For Markdown-only edits, use the installed formatter on changed files rather than running the application checks. Keep formatting rewrites scoped to the files being changed; `npm run format` rewrites the whole repository.
