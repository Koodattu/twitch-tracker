# Architecture Deepening Plan

Status: implementation in progress. Candidate 1 was implemented on 2026-08-09;
candidates 2–5 remain recommended designs.

This record resolves the five candidates from the architecture review. It uses
the project glossary in `CONTEXT.md` and the module vocabulary of interface,
implementation, depth, seam, adapter, leverage, and locality.

## Overall opinion

The repository does not need a folder-layout rewrite. Its main problem is that
important domain lifecycles are implemented as direct table mutations inside
broad callers. The right move is to deepen a few modules at the existing domain
seams, keep deployable apps unchanged, and replace scattered tests with tests at
the new interfaces.

Implement the candidates sequentially:

1. Chat Assignment control.
2. Raw REST observation intake.
3. IRC observation intake.
4. Twitch Authorization lifecycle.
5. Privacy Request completion.

Chat Assignment control comes first because IRC intake and Privacy Request
completion both need it. Raw REST observation intake is next because it is the
smallest low-risk proof of the deep-module pattern. Twitch Authorization and
Privacy Request completion come later because they handle secrets and privacy
effects and should reuse the test and transaction patterns established earlier.

Do not combine these into one rewrite. Each item should be a separately
reviewable change that preserves behavior before it improves policy.

## Decisions shared by every candidate

- Keep the web, REST, and worker deployables from ADR-0009 and ADR-0015.
- Do not create generic repository ports around PostgreSQL. There is one data
  store by ADR-0008, so a database port would be a hypothetical seam.
- Test PostgreSQL-specific behavior against a dedicated local PostgreSQL 16 test
  database. Use a separate `TEST_DATABASE_URL`, run migrations in setup, isolate
  cases with a fresh schema or transaction, and fail closed if the URL is not a
  test database. Do not substitute an in-memory SQL implementation for queries
  whose locking, JSONB, enum, or conflict behavior matters.
- Pass `now` into time-sensitive operations. A clock adapter is unnecessary.
- Keep the existing Twitch REST and IRC adapter seams. They already have more
  than one adapter, and mocks add real test leverage for true external behavior.
- A state mutation and its domain event belong in one database transaction.
- Route modules and worker loops should translate transport or scheduling facts,
  call one domain interface, and translate the result. They should not reproduce
  domain rules.
- Do not add a general `packages/domain` package. Put a module in an existing
  package or app unless cross-app reuse is already real.

The repository currently has seven tests in two files and no REST, worker, or
domain tests. Each deepening must add tests at the new interface before old
private helpers are removed.

## 1. Chat Assignment control

Implementation status: implemented 2026-08-09.

### Opinion

This is the highest-value change. Chat Assignment has a real domain seam, but
its implementation is currently spread across selection, IRC, maintenance,
privacy, and Channel Analytics reads. The spread is not merely untidy: a late
IRC observation can currently promote a `left` or `failed` assignment back to
`joined`, including after a privacy-driven closure. Routine transitions also do
not consistently append `chat_assignment_events`, so explainability promised by
ADR-0004 is incomplete.

The selection implementation also stops short of ADR-0004. It ranks live
Finnish Streams primarily by viewer count and does not apply manual pins,
opt-in/moderator priority, or meaningful anti-churn.

### Recommended module and seam

Add `packages/db/src/chat-assignments.ts` and export a factory bound to a
`DbClient`. This is a pragmatic location: both the REST and worker apps need the
module, its implementation is transaction-heavy PostgreSQL behavior, and no
second data-store adapter exists. Do not create a new workspace package for one
module.

The external interface should expose four behaviors:

1. Reconcile eligible Finnish Streams against one bot account's capacity.
2. Claim the next IRC JOIN/PART commands within capacity and rate limits.
3. Record a typed Chat Assignment observation or failure.
4. Read effective assignment status for a set of stream IDs.

The interface should use a discriminated observation vocabulary rather than one
method per status. Callers report facts such as room observed, JOIN command
failed, socket disconnected, stream ended, or subject tracking opted out. The
module owns the resulting transition, timestamps, reason, and event history.

Keep `TwitchIrcAdapter` outside this seam. Chat Assignment control decides which
commands are due; the IRC loop executes them and reports outcomes.

### Rules behind the interface

- Allowed normal flow is `desired → joining → joined → leaving → left`.
- `failed` is terminal until reconciliation explicitly retries it.
- An observed room may confirm `desired` or `joining` as `joined`; it must never
  reopen `leaving`, `left`, or `failed`.
- Tracking opt-out is a hard exclusion checked by reconciliation and by every
  observation that could promote an assignment.
- Stream end, loss of Finnish Stream eligibility, disabled bot account, and
  tracking opt-out retire an assignment immediately or after the existing
  confirmed-end grace period.
- Every status change appends one `chat_assignment_events` row in the same
  transaction. Activity timestamps that do not change status need no event.
- Conditional updates must include the expected current status so repeated or
  delayed observations are idempotent.
- Reconciliation preserves a healthy current assignment unless a challenger is
  clearly better.

Use three priority classes, in order:

1. Manually pinned channels.
2. Opted-in or known-moderator channels.
3. Other eligible live Finnish Streams.

Within a class, compare `trackingPriority`, then viewer count, then
`lastSeenLiveAt`. A higher class or higher `trackingPriority` may replace an
assignment immediately. Within the same class and `trackingPriority`, the
recommended initial hysteresis is both ten viewers and 25 percent above the
current stream. Keep this as an implementation constant until measurements
justify configuration.

Multiple bot-account allocation is deliberately out of scope for the first
change. The interface accepts a bot account so a later pool allocator can call
it without changing transition rules.

### Migration sequence

1. Add interface tests for the existing status behavior and the known late-
   observation/privacy case.
2. Implement typed transitions and same-transaction event persistence.
3. Route IRC status writes through the module without changing selection.
4. Route maintenance and Privacy Request closure through the module.
5. Route Channel Analytics status interpretation through the read behavior.
6. Move selection into reconciliation and then add ADR-0004 priority and
   anti-churn behavior with focused tests.
7. Delete the direct mutation helpers only after no caller writes assignment
   status directly.

### Required test surface

- Every allowed and rejected transition.
- Duplicate and delayed observations.
- Privacy closure followed by late IRC traffic.
- Disconnect recovery and stale JOIN recovery.
- Capacity and JOIN-rate enforcement.
- Manual, opt-in/moderator, and ordinary priority classes.
- Same-class hysteresis and assignment preservation.
- One event per status transition.
- Concurrent conditional updates do not double-transition.

Completion means `chat_assignments.status` is mutated only inside this module
and tests exercise the same interface used by every caller.

## 2. Raw REST observation intake

### Opinion

This is the safest first extraction after Chat Assignment transition control.
Discovery and Chatters reconciliation duplicate raw response persistence,
rate-limit persistence, and pagination parsing. User hydration calls the same
Twitch REST adapter without the same Raw Observed Data path. Every caller must
therefore remember an ordering invariant that belongs behind one interface.

### Recommended module and seam

Add `apps/worker/src/ingestion/rest-observation.ts`. It is worker-only behavior,
so moving it to a shared package would reduce locality.

Bind the module to `DbClient` and `TwitchRestAdapter`. Its main interface accepts
endpoint metadata and a fetch operation, then returns the Twitch response plus
the persisted Raw Event Ledger row ID. Pagination cursor parsing belongs inside
the same module.

The implementation order is mandatory:

1. Call the existing Twitch REST adapter.
2. Commit the raw response and rate-limit observation together.
3. Return the recorded response to caller-specific normalization.

Normalization must not share the raw-write transaction. If normalization fails,
the Raw Observed Data must remain committed for reprocessing and diagnosis.
An exception before Twitch returns a response is an ingestion-run failure, not a
fabricated raw response.

The module must never accept or persist an access token in request metadata.
The current adapter already excludes it from `requestParams`; tests should lock
that invariant down.

### Migration sequence

1. Test successful, non-successful, disabled, and paginated responses through a
   mock `TwitchRestAdapter`.
2. Move discovery to the module and compare persisted rows before and after.
3. Move both Chatters reconciliation call paths.
4. Move user hydration so its REST lookup also records Raw Observed Data and
   rate limits.
5. Remove the duplicated persistence and cursor helpers.

### Required test surface

- Raw response is committed before normalization begins.
- Rate-limit observation and raw response are atomic.
- HTTP failure responses remain Raw Observed Data.
- Network failure creates no invented raw response.
- Cursor presence and absence.
- Request metadata contains no authorization secret.
- Caller normalization failure preserves the raw row.

Completion means no worker loop directly inserts `raw_helix_responses` or
`rate_limit_observations`.

## 3. IRC observation intake

### Opinion

The IRC loop is currently a 697-line module that owns two different seams:
socket control and observed-data processing. That makes its interface look
small, but tests cannot exercise its important behavior without starting the
entire scheduler and connection lifecycle. Exporting the parser for tests does
not cover the bugs in how parsed messages are persisted and interpreted.

This change should follow Chat Assignment control so IRC observations can cross
that interface instead of mutating assignment rows.

### Recommended module and seam

Add `apps/worker/src/ingestion/irc-observation.ts`. Bind it to `DbClient` and the
Chat Assignment control module. Expose one intake operation for a parsed IRC
message and return a small outcome summary for diagnostics.

Keep these responsibilities in `loops/irc.ts` and `TwitchIrcAdapter`:

- socket connect/disconnect and reconnect;
- authentication and IRC capabilities;
- JOIN/PART command execution;
- connection-level scheduling and shutdown.

Move these responsibilities behind the intake interface:

- Raw Event Ledger persistence and processing status;
- command dispatch;
- normalized chat messages and membership events;
- moderation and notice effects;
- Twitch user observations;
- Chat Assignment observations.

IRC messages must be delivered to intake in socket order. The socket adapter
currently starts asynchronous callbacks without serializing them. Replace that
with a per-connection promise chain: each parsed message waits for the preceding
message's intake result, and failures are reported through the existing error
path without breaking later delivery.

Use a two-phase raw-first implementation:

1. Insert the raw IRC row as pending and commit it.
2. Normalize in a transaction, update its processing status, and commit.
3. On failure, mark the raw row failed with a safe error classification, then
   rethrow so the ingestion run remains observable.

Do not wrap the raw insert and normalization in one transaction; rollback would
erase the evidence needed to diagnose the failure.

### Migration sequence

1. Add parser tests at `parseIrcLine` and intake tests at the new interface.
2. Move one command at a time: `PRIVMSG`, membership, moderation, notices, then
   assignment observations.
3. Serialize adapter delivery and test ordering with deferred callbacks.
4. Remove persistence and command-dispatch helpers from the loop.
5. Keep the loop as connection orchestration plus JOIN/PART execution.

### Required test surface

- Every supported IRC command and an unsupported command.
- Raw row survives normalization failure.
- Processing status reaches processed, ignored, or failed as appropriate.
- Message order is preserved across asynchronous writes.
- Duplicate messages remain idempotent.
- Bot self JOIN/PART is not Chatter Data.
- Delayed observations cannot reopen a closed Chat Assignment.
- Reconnect does not lose already accepted messages.

Completion means the socket callback calls one intake interface and contains no
domain persistence logic.

## 4. Twitch Authorization lifecycle

### Opinion

This is a strong candidate but a riskier change. Browser login, bot login,
session validation, bot credential resolution, and user hydration repeat token
validation, refresh, encryption, rotation, identity checks, and persistence with
different rules. A token-rotation bug can invalidate browser sessions or stop
ingestion, so this should be deepened only after the database test pattern is
proven.

The deep module must not take authentication or access control away from the
REST app. ADR-0011 remains intact: OAuth state, cookies, product sessions, and
authorization decisions stay in the REST route module.

### Recommended module and seam

Create a genuinely shared workspace package named
`packages/twitch-authorization`. Both REST and worker apps need the behavior, so
this is real reuse under ADR-0009. The package depends on configuration
cryptography, the database package, and the Twitch integration package. Do not
put database-backed product behavior into the Twitch adapter package.

Define a true external seam for Twitch authorization operations with a fetch
adapter in production and a mock adapter in tests. The deep module owns three
behaviors:

1. Inspect an authorization grant and return verified Twitch identity/scopes.
2. Store or supersede a grant for a known user or bot owner.
3. Resolve a usable authorization, refreshing and revalidating when required.

The owner is a discriminated value: product user authorization or bot
authorization. Table differences remain inside the implementation. Callers may
receive an access token only as an ephemeral result needed by a Twitch adapter;
it must never enter logs, summaries, errors, or Raw Observed Data metadata.

### Rules behind the interface

- Validate Twitch client ID and expected Twitch user ID before accepting or
  returning an authorization.
- Centralize refresh and validation freshness intervals.
- Preserve a rotated refresh token when Twitch omits a replacement; replace it
  when Twitch supplies one.
- Encrypt before persistence and decrypt only inside the module.
- Persist scopes from validation, not from caller assumptions.
- Return classified unavailable outcomes; do not expose Twitch response bodies
  or secrets in user-facing errors.
- A failed validation marks the authorization unusable but does not silently
  delete diagnostic status.
- Use a PostgreSQL advisory lock per authorization while refreshing so the REST
  and worker processes cannot rotate the same refresh token concurrently. The
  low refresh frequency justifies the short transaction-held external call.

### Migration sequence

1. Add mock-adapter tests for current user and bot behavior.
2. Move `ensureTwitchSessionToken` to usable-authorization resolution; keep
   cookie clearing in the REST app.
3. Move bot credential resolution.
4. Move user-hydration token maintenance.
5. Move user and bot grant persistence from callback routes.
6. Remove direct decrypt/refresh/encrypt sequences from callers.

### Required test surface

- Current, expired, and stale-validation authorizations.
- Refresh token present, absent, retained, and rotated.
- Client-ID and user-ID mismatch.
- Scope changes.
- Decryption failure and Twitch failure.
- Concurrent resolution performs one refresh.
- User and bot storage mappings.
- No secret appears in returned errors or logs.

Completion means route and worker modules no longer perform token cryptography
or refresh persistence directly.

## 5. Privacy Request completion

### Opinion

This is the highest-risk implementation and should be last, even though its
architectural shape is straightforward. Privacy Request completion coordinates
visibility state, Raw Event Ledger redaction, Chatter Data deletion, aggregate
deletion, Twitch Authorization removal, product-session revocation, and Chat
Assignment closure. It currently performs effects, request completion, and the
completion event as separate writes with no encompassing transaction. A partial
failure can therefore apply effects while leaving the request pending.

### Recommended module and seam

Add `apps/api/src/privacy-requests.ts`. The behavior is REST-app-owned under
ADR-0011 and has no second caller outside that app. Bind the module to
`DbClient`; do not add a privacy repository port.

Expose three behaviors:

1. Submit a Privacy Request for the authenticated subject.
2. Complete a pending request for an authorized actor.
3. Read the subject's privacy state and request history.

The module owns which request types complete immediately. Preserve current
product behavior: public-summary opt-out and tracking opt-out complete during
submission; data deletion remains pending for explicit completion.

Completion must lock the request row and run all effects, the final request
state, and the completion event in one transaction. Construct Chat Assignment
control with that transaction and report a tracking-opt-out observation so
assignment closure participates atomically without duplicating transition SQL.

Add a partial unique index allowing at most one pending request of a given type
per subject. Repeated completion of a completed request returns its existing
result without applying effects or appending another completion event. A
rejected request cannot be completed.

If the transaction fails, roll it back and record a safe failure classification
in a separate best-effort write; never expose subject data or SQL details in the
error.

### Migration sequence

1. Add interface tests that reproduce partial-failure and duplicate-completion
   cases against PostgreSQL.
2. Move request submission and request-event creation into the module.
3. Move immediate completion for both opt-out request types.
4. Move data-deletion effects and wrap completion transactionally.
5. Delegate assignment closure to Chat Assignment control.
6. Add the pending-request uniqueness migration.
7. Leave route authorization and response translation in `routes.ts`; delete
   the old private helpers.

### Required test surface

- Submission and event creation are atomic.
- Immediate and manual completion paths.
- Duplicate submission and completion.
- Rejected-request behavior.
- Failure at each effect rolls back all completion effects.
- Public summary suppression and future tracking exclusion.
- Raw and normalized Chatter Data redaction/deletion.
- Twitch Authorization and product-session revocation.
- Chat Assignment closure in the same transaction.
- No private data appears in errors.

Completion means route handlers contain authorization and response translation
only, while all Privacy Request state and effects are tested through one
interface.

## Rejected approaches

- **Split files by route or loop name only.** This moves code without increasing
  depth; the deletion test fails because domain knowledge remains spread.
- **One universal ingestion module.** REST, IRC, and EventSub own different
  signals under ADR-0005. Combining them would enlarge the interface and reduce
  locality.
- **Mock the database behind repository ports.** PostgreSQL is the only store,
  and the important behavior is PostgreSQL-specific. A second fake adapter would
  create false confidence.
- **Move every shared type into `packages/shared`.** Share only interfaces used
  by multiple callers. Internal observation and transition types belong beside
  their deep module.
- **Rewrite all five candidates together.** The overlap is manageable through
  sequencing; a single rewrite would make regressions and review attribution
  needlessly difficult.

## End-to-end verification

For each implementation change, run the narrow new tests first, then:

```powershell
pnpm check:structure
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Run the PostgreSQL-backed interface tests against the dedicated test database
before reporting any candidate complete. Review the final diff after each
candidate and confirm that no unrelated route, schema, deployment, or product
behavior changed.

No new ADR is recommended for this plan. The module seams are reversible,
existing ADRs already constrain the important trade-offs, and the implementation
order is not a durable system decision.
