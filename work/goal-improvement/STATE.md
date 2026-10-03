# Goal improvement state

## Starting point and scope
- Started 2026-10-03 from `91060038860b63b67d4055195eb665f860a9e04c`; staged, unstaged and untracked sets all empty.
- One agent. Initial scope was local changes only. The later explicit merge/deploy authorization is recorded in the release section below; policy and production-data restrictions otherwise remain in force.
- Existing `.workflow/ultracode` records are historical orchestration runs, not a current general work log. This directory holds this goal's compact record and reproducible synthetic fixtures.
- Product: English-language, dark/violet analytics UI for Finnish Twitch streams. Desktop and mobile web. No maintained translation catalogs found. Preserve existing tokens and data/presence distinctions.
- Main journeys: live ranking → channel → session overview → chat/events/data; channel history; community search/select/profile; signed-out own-data guidance; internal diagnostics (access unchanged).

## Baseline
- Read README, CONTEXT, relevant PRD/architecture sections, package scripts, CI, schema and nearby tests. No repository or ancestor AGENTS.md found beyond instructions supplied in chat.
- `pnpm check:structure`, `pnpm lint`, `pnpm typecheck`: passed initially.
- Host Node 24.4.1 is below required 24.19. Initial unit run: 124 passed, one worker-thread failure, 14 DB suites skipped. **Environment mismatch:** same worker test passes with bundled Node 24.19.0. No worker fix warranted.
- Use Node from `%USERPROFILE%/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe` (prepend its folder to PATH).
- Created only Docker container `twitch-tracker-goal-test` (ID `c4374bfff87a`), pinned repository PostgreSQL 16.14 image, 2 CPUs/1 GiB, tmpfs data, localhost:55432. Existing containers untouched. Test databases use synthetic local credentials only.
- All existing migrations applied successfully to dedicated `twitch_tracker_goal_test`.
- `TEST_DATABASE_URL=postgres://goal_test:goal_test_local_only@127.0.0.1:55432/twitch_tracker_goal_test node node_modules/vitest/vitest.mjs run`: **37 files / 244 tests passed**, 24.56 s, Node 24.19.0.
- Pinned pnpm is available, but `corepack pnpm exec vitest` on this machine failed to resolve its executable after runtime selection. Direct Node invocation of installed CLIs works; do not alter dependencies to compensate.

## Ranked backlog (initial, continue with browser evidence)
| Priority | Finding / evidence | Acceptance | Confidence / effort / risk |
| --- | --- | --- | --- |
| P1 | Channel category airtime reads raw sparse snapshots although ingestion stores unchanged metadata as null. Likely loses most classified airtime. | API yields correct time-weighted category totals after sparse samples, category changes/removal and period boundaries; PostgreSQL regression. | High / medium / medium |
| P2 | Live directory has no search/filter; a channel below the first 100 requires paging and scanning. Verify in browser. | Find a channel/title/category while preserving ranks and clear empty/reset states on desktop/mobile. | High / small / low |
| P2 | UI recovery/keyboard/map states need browser assessment. | Record reproducible issues, fix coherent high-value subset, validate post-interaction screenshots. | Pending |
| P3 | PRD channel-overview description disagrees with current time-weighted implementation. | Correct relevant documentation alongside category fix. | High / small / low |

## Decisions and test seams
- Primary aesthetic direction: existing restrained dark/violet product interface; use Impeccable audit then targeted harden/adapt/polish. No redesign.
- API integration tests with real disposable PostgreSQL are the seam for category recovery, not mocked SQL. Browser journeys are the seam for interaction changes.
- Architecture: existing channel-period module has useful depth; retain it. Fix sparse-metadata reconstruction at its data-loading seam; avoid broad route/module extraction.
- Skills read: end-user-ui-ux, impeccable (+ audit/product references), improve-codebase-architecture, codebase-design, diagnosing-bugs, tdd (+ tests/mocking). User's unattended adjustments govern approval/delegation steps.

## Completed batch 1: category correctness
- Reproduced through `GET /api/channels/channel/overview`: 12 known category minutes reported as 6. Added real PostgreSQL regressions for compacted samples, category changes/removal, metadata before the period, session isolation, and uncounted audience gaps.
- Recover sparse metadata in the channel data-loading module. One bulk seed query supplies older metadata; a linear pass resolves current samples. Pure period calculations remain unchanged, preserving unknown-value semantics. No schema, index, external contract or policy changes.
- Corrected stale channel-overview PRD documentation.
- `node node_modules/vitest/vitest.mjs run apps/api/src/routes.integration.test.ts apps/api/src/channel-period.test.ts`: 50 passed before adding boundary case; targeted category rerun: 2 passed including boundary case.
- Synthetic measured workload: 29 six-hour sessions / 3,509 snapshots. Classified airtime **10,440 → 626,400 seconds** (correct 174 hours), full period audience/category weighting preserved. Warm HTTP median **16.52 → 26.73 ms** in 15 local runs, response **5,169 → 5,174 bytes**. This is a correctness fix, not a speedup. Small absolute latency remains acceptable; no speculative index/cache change. Evidence: `evidence/channel-before.json`, `channel-after.json`.
- Initial browser captures needed an explicit streaming/hydration wait. Corrected harness and reran: all six baseline routes at 1440/390 widths have no document overflow or browser errors. Screenshots and `baseline-browser.json` saved. Visual inspection: existing identity/hierarchy coherent; channel screenshot visibly undercounts 3h of categories as 9m before the fix.

## Completed batch 2: live directory task completion
- Benefit: find a live channel/title/category without scanning paginated rows; recover from no matches and service failures.
- Scope: server-rendered URL search, original rank preservation, existing form/button tokens, retry controls. No new dependencies, production service, or live API contract change.
- Acceptance: keyboard search, mobile 320/390 and desktop, query survives navigation/back, clear works, no-match/empty/unavailable distinguished, pagination retains query; preserve useful featured streams when unfiltered. Browser regression written first.
- Implemented URL-based search across channel identity, title and category, original ranks, clear/no-match states, query-preserving pagination, shared retry button for homepage and detail failures. Added narrow-screen navigation placement and stacked empty-state actions after screenshots showed clipping/cramping at 320px.
- `node work/goal-improvement/browser-journeys.mjs`: passed at 1440/390/320px (keyboard, match, rank, channel navigation/back, clear/empty, reduced motion; no console/page errors). Extended fixture verified 101 matching streams over two pages, title/category queries, malformed directory parameters, actual HTTP 503 recovery, channel chart/history/data, chat filters/paging/retry, community controls at 1440/390px. `node work/goal-improvement/browser-extended.mjs`: passed, no page errors. Evidence scripts restore their synthetic fixture state.
- Lint/typechecks for changed web code passed. Broader lint caught only the task's temporary edit script; removed that script rather than changing lint rules. All workspace typechecks passed.

## Completed batch 3: chat query validation
- Browser reproduction: repeated `chatter` parameters crash `.trim()`, and `2026-02-31T10:00` silently becomes March 3 and fetches the wrong range. Acceptance: duplicate filter values safely ignored, impossible dates show validation, retained valid chatter filter remains available.
- Narrowed query values before string operations; validate UTC calendar roundtrip, preserving existing inclusive/exclusive filter contract. Browser regression in `browser-edge-states.mjs`.
- Both failures now pass through the actual browser and API. Valid chatter filters remain populated during invalid-range and service-error recovery. Evidence: `before-edge-states.json`, `after-edge-states.json`, `built-edge-states.json`.

## Completed batch 4: community boundary states
- Browser reproduction: four qualifying channels and zero edges render **zero visible nodes**, including after Fit map. Keyboard canvas explicitly disables its focus outline. Acceptance: show all qualifying nodes when no communities exist, preserve that behavior on reset, visible keyboard focus. Empty graph already provides a useful explanation and needs no redesign.
- Default and Fit map now show all four channels when no communities exist. Canvas keyboard focus has a visible 3px accent outline. Existing connected-map behavior, search/select, zoom, and Escape remain working. All six chat/map edge checks pass, including the unchanged empty graph explanation.

## Completed batch 5: request validation and useful diagnostics
- Reproduced four malformed/bounds-invalid query requests returning HTTP 500: recent streams, channel sessions, viewer history, and activity. Added PostgreSQL API regressions that first failed with 500 and now pass with 400 and a stable generic error body.
- Added one shared Hono error boundary. Input Zod errors receive 400; HTTP exceptions retain their status, body and headers; unexpected errors retain 500 and log only method, registered route pattern and error type. A regression verifies that path/query values and database-error text are not logged. No access policy changed.
- Targeted API suite: 48 tests passed. Final full suite: 251 tests passed.

## Final verification (2026-10-03)
Run from the repository root with Node 24.19.0 and the pinned pnpm. On this host use `node 'C:/Program Files/nodejs/node_modules/corepack/dist/pnpm.js'` in place of `pnpm` to avoid the older Corepack-selected runtime. Full setup is in [README.md](README.md).

| Command / scenario | Result |
| --- | --- |
| Existing migrations on both dedicated PostgreSQL 16.14 databases | Passed fresh installation; no new migration or upgrade path required |
| `pnpm check:structure` | Passed, 17 paths |
| `pnpm lint` | Passed with zero warnings |
| `TEST_DATABASE_URL=<dedicated goal_test URL>` then `node node_modules/vitest/vitest.mjs run` | **37 files / 251 tests passed**, 28.96 s, no skipped DB suites |
| `pnpm -r typecheck` | All seven workspace packages passed |
| `pnpm -r build` | All packages and Next production build passed |
| `node work/goal-improvement/browser-journeys.mjs` | Passed at 1440/390/320px; keyboard search/back/clear, original ranks, no page/console errors or document overflow |
| `node work/goal-improvement/browser-extended.mjs` | Passed in dev and against the built app at 1440/390px; pagination, retry, chart, history/data, chat and map journeys; no page errors |
| `node work/goal-improvement/browser-edge-states.mjs built` | All six checks passed against built app |
| `docker compose --env-file .env.production.example config --quiet` | Exit 0; sandbox warned that private Docker config could not be read; no private config or services needed for validation |
| `sh -n` for every `infra/postgres/*.sh`, then retention and retry test scripts | Passed via Git Bash with `/usr/bin:/bin` on PATH; tests use disposable synthetic files |
| `git diff --check` | Passed |
| `pnpm audit --prod`, `pnpm audit` | Completed after explicit user approval of npm metadata transfer. Both exit 1: production has 1 critical / 1 moderate finding; full tree has 1 critical / 5 high / 3 moderate findings. See follow-up below |

- Inspected screenshots of search/missing matches, mobile navigation and actions, category/chart output, selected and unconnected maps, and failure/validation states. Full-page captures include sticky/fixed elements at their current scroll position; `built-chart-viewport-1440.png` separately confirms normal viewport placement and the hidden unfocused skip link. Existing dark/violet tokens retained; reduced-motion browser context used. No motion changed.
- Generated standalone startup failed resolving a React symbolic link with Windows `EPERM`, both in and outside the sandbox. `next start` successfully served the built UI for checks but warns that standalone output should use its generated server. This verifies built UI behavior, not the Linux deployment artifact. Deployment configuration was not changed.

## Coverage and sequential self-review
- **User journeys / UI:** live directory → channel → stream/chat/events/data, channel history, community search/select/keyboard, and signed-out `/me` exercised with synthetic data. Baseline six-route captures and post-interaction evidence saved. Recovery, validation, empty and no-connection states covered. No maintained i18n catalogs; new copy follows existing English voice. Physical touch devices, assistive technology, text zoom, Firefox and Safari were not tested.
- **Correctness / data / security:** followed compacted ingestion metadata through schema and API calculation to visible category totals. Verified boundary clipping, unknown observations, category removal and session isolation. Input parsing and error output reviewed; existing auth/privacy/ingestion tests remain passing. Real OAuth, external webhooks, and live Twitch require separate resources and were not called.
- **Performance / database / caching:** bounded HTTP benchmark recorded above. One bulk metadata lookup plus one linear pass; no N+1 lookup, new index, cache, schema, retention or storage change. Observed extra latency is a correctness cost; local measurements do not establish production gains. Larger production workloads and query plans remain separate investigations.
- **Architecture / developer experience:** retained the existing pure period-calculation boundary, fixed reconstruction in its loader, reused one retry control, and supplied reproducible fixtures. Clarified actual process-environment setup in the root README. Broader route extraction and caching would add unproven scope and were deferred.
- **Standards self-review:** reviewed the combined tracked diff and new component, harnesses, fixtures, reports and docs against the clean starting revision. No dependencies, auth policy, production configuration, user data, broad formatting, commits or publishing changed. Temporary Next-generated instructions and redundant intermediate screenshots were removed. No independent or delegated review was claimed.
- **Acceptance self-review:** every selected P1/P2 finding meets its recorded acceptance criteria; API regressions and browser scenarios cover changed behavior. Structure, lint, tests, typechecks and build passed. The subsequently authorized dependency audit found vulnerabilities requiring separate dependency remediation, detailed below. Standalone and external/device limitations remain explicit.

## Cleanup and next action
- Stopped only this goal's API and web processes after verification. Removed the verified task-owned container `c4374bfff87a` / `twitch-tracker-goal-test`; its two tmpfs databases disappeared. Existing containers and volumes were untouched. The downloaded pinned image and ignored local build output remain available for reuse.
- Synthetic fixtures, commands, screenshots and measurement JSON remain reviewable in this directory. No migration/deployment action is needed to review them.
- The five implementation batches and their local verification are complete. Review the release diff and use [README.md](README.md) to reproduce. The subsequent audit and release work are recorded below.

## Authorized dependency audit follow-up (2026-10-03)
- The user explicitly approved sending dependency names and versions to npm after the original automatic-review rejection. Re-ran through the normal escalation mechanism; no bypass was used.
- Exact commands: `pnpm audit --prod --json --registry=https://registry.npmjs.org` and `pnpm audit --json --registry=https://registry.npmjs.org`, using Node 24.19.0 / pnpm 11.21.0 as above. Both requests completed and exited 1 because of findings, not an access failure.
- Raw results: [production](evidence/audit-production.json), [all dependencies](evidence/audit-all.json). Production: **2 findings** (1 critical, 1 moderate). Full tree: **9 findings** (1 critical, 5 high, 3 moderate), including production. Separate affected major versions can contribute separate findings for the same advisory.

| Dependency / scope | Installed | Severity / issue | Reported patched version |
| --- | --- | --- | --- |
| Next.js / production | 16.3.3 | Critical: Node `next/og` ImageResponse remote code execution | 16.3.6 |
| Hono / production | 4.13.5 | Moderate: unescaped strings in server-side `hono/jsx` boundary rendering | 4.13.7 |
| brace-expansion / development tooling | 1.1.18 and 5.0.9 | High and moderate: stack exhaustion and quadratic expansion | 1.1.21 and 5.0.12 cover all reported advisories for the respective major |
| braces / development tooling | 3.0.3 | High: deeply nested patterns can exhaust the stack | Audit reported 3.0.4; registry/release investigation later confirmed it is unpublished |

- Verified the production findings against the [Next.js maintainer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) and [Hono maintainer advisory](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv). Next requires attacker-controlled SVG values reaching its Node image-generation API; Hono requires untrusted strings in its affected JSX server-rendering positions.
- Read-only source assessment found no `next/og`, `ImageResponse`, `@vercel/og`, `hono/jsx`, `jsxRenderer`, or Hono JSX rendering calls in the application/shared source. No generated Open Graph image route was found. The web layout uses React's `Suspense`, not Hono's. Thus no direct application use of the affected production features was found; this is not a blanket claim of non-exploitability or a passing audit.
- Recommended follow-up: patch Next.js to at least 16.3.6 with its matching ESLint configuration, Hono to at least 4.13.7, and refresh the affected development transitive dependencies to the patched versions in their existing majors. Review the lockfile, rerun both audits, and rerun the existing checks after those changes. The original goal required locked dependencies and no stack upgrades; this follow-up authorized auditing only, so package manifests and the lockfile remain unchanged. Do not suppress these advisories or claim remediation without that work.

## Authorized release (2026-10-03)
- The user subsequently requested merging into `main` and deploying. Created `codex/ux-data-reliability-release` from the unchanged starting/main revision. The previous storage branch was already merged; these improvements were still uncommitted.
- Applied narrowly scoped security patches: Next.js and eslint-config-next 16.3.6, Hono 4.13.7, brace-expansion 1.1.21 and 5.0.12. The 5.0.9 transitive resolution required a version-specific override after normal nested updates retained it. No production dependency was added and no database migration or deployment configuration changed.
- Release checks on these versions: structure, lint, **251 tests in 37 files (26.67 s)**, all workspace typechecks, and full production build passed. Fresh migrations ran only against the recreated synthetic test databases.
- Production audit is now **zero findings** (`evidence/audit-release-production.json`). Full audit retains one high-severity **development-only** `braces@3.0.3` finding (`evidence/audit-release-all.json`). Its sole path is Next's ESLint plugin → fast-glob → micromatch. Registry versions stop at 3.0.3; the [upstream issue](https://github.com/micromatch/braces/issues/70) remains open and the [current advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) states no patched version. The audit API's suggested 3.0.4 cannot be installed. The latest Next ESLint plugin also retains this dependency. CI/audit commands are unchanged; no advisory is ignored or suppressed.
- Confirmed production is healthy on starting revision `91060038860b63b67d4055195eb665f860a9e04c`. Its existing automatic deployment uses a shared lock and can prune unrelated images. Release will use the same lock and Twitch Compose configuration with a targeted application rollout, preserving the previous images and unrelated services.
- Existing local production backup is healthy (2026-10-03); the latest verified off-host copy evidence is 2026-09-29. The user explicitly declined a fresh off-host copy and instructed deployment to proceed with the existing backup. No production dump is downloaded for this release.
- Release merge, Linux container verification, and deployment results are pending.

## Deferred / limits
- Live OAuth/Twitch ingestion and production performance require separately authorized resources; never use current `.env` or existing databases for this goal.
- The unchanged Linux image-build/Caddy CI job was not run locally. Validate the intended Linux deployment artifact in its normal CI environment before release; this goal neither deployed nor modified infrastructure.
