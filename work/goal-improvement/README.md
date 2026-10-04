# Isolated local QA

These fixtures use only PostgreSQL at `127.0.0.1:55432` and the two databases named below. They do not read `.env`. Seeding truncates the dedicated UI database; never repoint these scripts at another database. The API harness disables Twitch ingestion and EventSub and uses a synthetic session secret. The worker is not started.

The implementation, verification, and release history are recorded in [STATE.md](STATE.md). Round 4 adds historical channel analysis and reusable day inspection to the preceding reliability and discovery releases. The earlier release also replaced a vulnerable development-only ESLint dependency with an already-used package and a tested compatibility patch. No new runtime dependency, database migration or production configuration change is required.

## Community controls and visibility

After migrating the dedicated UI database below, run `node work/goal-improvement/community-controls-fixture.mjs`. This replaces only that disposable database with 98 synthetic map channels, including dense clusters, sparse members, six isolates and a two-channel community. Start the API and web app as below and open `/communities`.

The browser regression helper `community-visibility-check.mjs` exports `checkVisibilityJourney(page)`. In the initialized CUA runtime, import it using the absolute local file URL and pass the tab's documented `playwright` interface. It runs against the rendered application: both small-community channels and their connection remain visible with overview filters enabled; selecting a channel then choosing the group focuses correctly; search/clear and unconnected/all restore defaults. Run at desktop and 320px widths. The helper was executed through CUA, not a separate browser driver. Evidence and broader journey coverage are in `evidence/final-discovery-20261004/` and the top of [STATE.md](STATE.md).

## Channel analytical workflow (round 4)

Open any channel from `/channels`. Choose 7, 30 or 90 days, step to earlier
periods, or choose an end date. Viewer/chat selections survive reload and can
be shared with **Copy view link**. **Daily figures** exposes the chart's exact
values, with missing observations shown as dashes. Open a day to find streams
active during it, including overnight streams, then return through Overview.
History's date filter adjusts the overview period when necessary.

Start the isolated database/API/web as below, then run:

```powershell
node work/goal-improvement/browser-channel-period.mjs built
node work/goal-improvement/measure-channel-period.mjs
```

The browser harness creates/removes 87 synthetic sessions and 837 observations
across 95 dates. It covers shared links, history/back/reload, period/date controls,
daily values, zero/missing data, four viewport widths, keyboard/touch, 200% CSS
zoom, clipboard denial and an actual API outage/retry. The capacity harness
expands the same fixture to 10,407 observations and cleans it up. Run them
sequentially because they share that task-owned fixture identity. Neither uses
production data. The `.temp/goal-api-failure` marker must be absent afterward.

Evidence is in `evidence/round4/`; decisions and release status are at the top
of [STATE.md](STATE.md). No dependency, migration or deployment configuration
change is needed. To review this pass, use `git diff 97e7778 -- apps packages
docs work/goal-improvement` (plus untracked files before committing).

## Channel discovery and release (round 3)

The current goal includes the round 2 changes below plus a searchable Channels page. Open `/channels` or use “Search all channels” below the Live search. Name/login queries and result pages can be bookmarked or shared; each result opens channel analytics or its latest observed Finnish stream. Public suppression rules remain in force. No migration or new dependency is required.

With the isolated API and built web app running as below:

```powershell
node work/goal-improvement/browser-directory.mjs built
node work/goal-improvement/measure-directory.mjs
```

The directory browser harness creates and removes 53 synthetic channel fixtures and covers offline discovery, both result links, history/back/reload, 52-result paging, clear/empty/error states, keyboard/touch, long text and 200% CSS zoom. Its `before` mode checks the original missing-discovery baseline and intentionally fails on the new UI. The capacity check creates and removes 1,000 channels with 20,000 sessions; do not run either script against a different database. Evidence and the source-linked product/research decisions are in `evidence/round3/` and [STATE.md](STATE.md).

Release requires the unchanged CI checks, including both dependency audits. Source/build/browser checks and both audits now pass; see [the compatibility patch notes](../../patches/README.md) and the current state log for commit/release status.

## Prior local pass (round 2)

This pass started at `85dd30b14d4bb7accdb6c86bd7bfb28a3b80138e` as local-only work and is now included in the authorized release. It corrects mixed-duration stream audience averages and false first-interval gap warnings; makes stream charts readable on phones and single observations inspectable without a pointer; and adds load-failure recovery to stream activity, communities and My data. Request-failure copy no longer claims a timed-out request was never recorded. Authentication and privacy behavior are unchanged.

Use the same isolated setup below. Before `pnpm -r build`, set `INTERNAL_API_URL` and `NEXT_PUBLIC_API_URL` to `http://127.0.0.1:4400` in the build terminal as well as the server terminal: Next captures the `/api` rewrite destination at build time. The account harness imports the built configuration package and creates only temporary synthetic account/session rows. It never logs in to Twitch. Run browser scripts sequentially because they share synthetic failure flags and fixtures:

```powershell
node work/goal-improvement/browser-round2.mjs built
node work/goal-improvement/browser-account.mjs built
node work/goal-improvement/browser-chart-states.mjs built
$env:GOAL_EVIDENCE_DIR = './evidence/round2/regression/'
node work/goal-improvement/browser-journeys.mjs
node work/goal-improvement/browser-extended.mjs
node work/goal-improvement/browser-edge-states.mjs built
```

`built` labels evidence; it does not start a server. Start the API as below and use `next start --hostname 127.0.0.1 --port 3300` from `apps/web` for the local built-UI checks, with the same API environment. This Windows verification uses `next start`, not the generated standalone deployment server. The new evidence is in `evidence/round2/`. `GOAL_EVIDENCE_DIR` is optional, relative to the harness directory, and must end with `/`; it keeps repeat QA from overwriting earlier evidence.

The stream benchmark uses 360 non-overlapping activity intervals over 18 synthetic hours. With the **baseline API** running, `node work/goal-improvement/measure-stream.mjs before` seeds and measures it; restart the API with the new code and run `node work/goal-improvement/measure-stream.mjs after`. The script checks the expected source version through the resulting average. Running `before` against current code intentionally fails; it cannot recreate historical measurements. Saved measurements show the correct average **25 instead of 55**, unchanged peaks/message totals/payload, and warm medians of 15.14/14.66 ms (within variance, not a speedup).

Review application changes with `git diff 85dd30b14d4bb7accdb6c86bd7bfb28a3b80138e -- apps docs packages` and the QA scripts/evidence under this directory. Full checks and limitations are recorded at the top of [STATE.md](STATE.md). No new migrations, dependencies, or deployment steps are required by this pass.

## Runtime

Use the repository's Node 24.19 and pnpm 11.21.0 with installed locked dependencies. Commands below run in PowerShell from the repository root unless specified otherwise. On the machine used for this run, select the bundled compatible runtime in each terminal:

```powershell
$env:PATH = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:PATH
node --version
```

The machine's default Node 24.4.1 is unsupported. Its Corepack executable can still select that older runtime despite PATH ordering. In the commands below, substitute this invocation for `pnpm` on that machine:

```powershell
node 'C:\Program Files\nodejs\node_modules\corepack\dist\pnpm.js' --version
```

## Disposable PostgreSQL

Create a new task-owned container. An existing container with the same name must be inspected before reuse or removal. This command uses a tmpfs database with no persistent volume:

```powershell
docker run --detach --name twitch-tracker-goal-test --label purpose=twitch-tracker-goal-improvement --cpus 2 --memory 1g --publish 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data:rw,size=768m --env POSTGRES_USER=goal_test --env POSTGRES_PASSWORD=goal_test_local_only --env POSTGRES_DB=twitch_tracker_goal_test postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
docker exec twitch-tracker-goal-test pg_isready -U goal_test -d twitch_tracker_goal_test
```

Wait for `accepting connections`, then migrate both databases and seed UI data:

```powershell
$env:DATABASE_URL = 'postgres://goal_test:goal_test_local_only@127.0.0.1:55432/twitch_tracker_goal_test'
pnpm --filter @twitch-tracker/db db:migrate
node work/goal-improvement/fixture.mjs create
$env:DATABASE_URL = 'postgres://goal_test:goal_test_local_only@127.0.0.1:55432/twitch_tracker_goal_ui_test'
pnpm --filter @twitch-tracker/db db:migrate
node work/goal-improvement/fixture.mjs seed
```

The fixture contains four synthetic channels, twelve sessions, 252 sparse viewer snapshots, 55 messages, and a small community map. Re-seeding resets only this UI database. Automated integration tests use the separate `twitch_tracker_goal_test` database because their cleanup truncates shared tables.

## Run the UI

Start the synthetic API from the repository root:

```powershell
node --conditions=development --import ./apps/api/node_modules/tsx/dist/loader.mjs work/goal-improvement/local-api.ts
```

In another terminal, set the compatible Node runtime and start the web app:

```powershell
$env:INTERNAL_API_URL = 'http://127.0.0.1:4400'
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:4400'
$env:NEXT_TELEMETRY_DISABLED = '1'
Set-Location apps/web
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3300
```

Open <http://127.0.0.1:3300>. Search for `LumiStudio`, open `AuroraPelaa`, inspect the Messages chart and stream chat, then search/select a channel in Communities. All identities and chat records are synthetic. Signed-out account guidance is available at `/me`; real OAuth is intentionally outside this fixture.

## Verification

In a root terminal with Node 24.19 selected:

```powershell
$env:TEST_DATABASE_URL = 'postgres://goal_test:goal_test_local_only@127.0.0.1:55432/twitch_tracker_goal_test'
pnpm check:structure
pnpm lint
node node_modules/vitest/vitest.mjs run
pnpm -r typecheck
$env:INTERNAL_API_URL = 'http://127.0.0.1:4400'
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:4400'
pnpm -r build
```

Stop the web dev server before building. The `-r` forms avoid the root scripts' nested Corepack selection on this Windows machine.
The local API variables must also be set during the build: Next embeds the API proxy destination in its rewrite manifest. Keep them set when starting the built app.

For the stream/community inspection release, run these after the base fixture is seeded and the local app is ready:

```powershell
$env:GOAL_EVIDENCE_DIR = './evidence/round5/'
node work/goal-improvement/browser-stream-inspection.mjs built
node work/goal-improvement/browser-stream-context.mjs
node work/goal-improvement/browser-community-sharing.mjs built
node work/goal-improvement/browser-chart-states.mjs built
node work/goal-improvement/browser-round2.mjs built
node work/goal-improvement/browser-account.mjs built
node work/goal-improvement/measure-stream-inspection.mjs
```

Run browser scripts sequentially; they share temporary synthetic rows and the failure flag. The inspection and capacity scripts remove their dedicated stream in `finally`. The new evidence is under `evidence/round5/`; baseline screenshots show the old UI and cannot be recreated by running a `before` label against current code. Only representative screenshots are retained; JSON records cover all tested widths. The broader discovery scripts below also accept `GOAL_EVIDENCE_DIR`.

Browser scripts use the already-installed bundled Playwright module and Chromium. On another machine, set `PLAYWRIGHT_MODULE` to its installed Playwright module path. No dependency was added. Run these sequentially while the synthetic API and web server are running:

```powershell
node work/goal-improvement/browser-journeys.mjs
node work/goal-improvement/browser-extended.mjs
node work/goal-improvement/browser-edge-states.mjs after
```

The extended and edge scripts temporarily modify synthetic rows and restore them in `finally`. Extended QA uses `.temp/goal-api-failure` to inject a 503 at the local HTTP boundary and removes the flag afterward. If interrupted forcibly, remove that task-owned flag and re-seed the UI database. These scripts are local evidence tools, not an installed CI browser suite.

Checks cover search/back/clear at 1440, 390, and 320 pixels; 101 filtered streams across pages with preserved original ranks; title/category search; retry with retained input; channel chart/history/data; chat filtering/pagination; invalid and repeated query values; community selection, keyboard interaction, no connections, and no data. Synthetic external imagery is replaced with placeholders in the main journey scripts. This is Chromium viewport testing, not physical-device or cross-browser verification.

The production build passed. The generated standalone server failed locally with `EPERM` resolving a React dependency link on Windows, both inside and outside the sandbox. Built-app browser checks therefore used `next start` with the same API environment and port; Next warns that this is not the intended standalone deployment entry point. Round 3 separately built all five Linux Compose images and verified standalone web health and channel-directory rendering in a read-only local container. Production release status is recorded separately in [STATE.md](STATE.md).

## Evidence and measurements

- `evidence/baseline-browser.json` and `before-*.png`: six baseline journeys at desktop/mobile widths.
- `evidence/browser-journeys.json`, `browser-extended.json`, and `after-*.png`: interactions and recovery after changes.
- `evidence/before-edge-states.json`, `after-edge-states.json`, and `built-edge-states.json`: reproduced and fixed chat/map boundary cases.
- `evidence/channel-before.json` and `channel-after.json`: one cold request followed by 15 warm requests against 29 six-hour sessions and 3,509 snapshots.
- `evidence/audit-production.json` and `audit-all.json`: original audits with 2 production / 9 total findings. Release patch updates reduce this to zero production findings and one development-only advisory without a published fix; see `audit-release-production.json`, `audit-release-all.json`, and `STATE.md`.

The category fixture's classified airtime increased from 10,440 to the correct 626,400 seconds. Warm median HTTP time increased from 16.52 to 26.73 ms because correctness requires a metadata seed query. Response size changed from 5,169 to 5,174 bytes. This is a local correctness tradeoff, not a production speedup or storage saving. No index, cache, or storage policy was changed.

`measure-channel.mjs before` seeds that bounded workload and records the currently running API; `after` reuses it. The saved evidence was captured before and after the implementation. To reproduce a comparison, run the respective code revisions with fresh fixtures and preserve each result separately; running both labels against current code does not recreate the historical baseline. Baseline capture scripts overwrite their own evidence names.

## Cleanup

Stop only the two terminal servers with Ctrl+C. Verify the disposable container's label before removing it:

```powershell
docker inspect --format '{{ index .Config.Labels "purpose" }}' twitch-tracker-goal-test
```

After confirming `twitch-tracker-goal-improvement`, remove only that container:

```powershell
docker rm --force twitch-tracker-goal-test
```

Its tmpfs databases disappear with it. Do not prune containers or volumes. Next dev may generate `apps/web/AGENTS.md` and `CLAUDE.md`; they were absent at this goal's start and are not application changes.
