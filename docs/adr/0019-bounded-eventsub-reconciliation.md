# ADR 0019: Bounded EventSub desired-state reconciliation

## Decision

Persist an explicit desired flag for EventSub subscription rows and reconcile a
stable cohort of at most `EVENTSUB_MAX_CHANNELS` channels. Manually pinned
channels take priority. Existing desired channels remain selected while they
were seen as Finnish within 30 days; remaining capacity is filled by priority
and recent Finnish activity. On the first run after this change, recently
synced subscriptions seed the cohort so deployment does not arbitrarily replace
all subscriptions.

Reconciliation lists only active `enabled` and
`webhook_callback_verification_pending` subscriptions. Conditions are compared
after removing empty values because Twitch may add an empty counterpart to raid
conditions. One active subscription is retained for each desired identity.

Stale remote subscriptions are deleted only if they use the current callback or
their Twitch ID is already recorded locally. This prevents the worker from
deleting unrelated subscriptions that share the same Twitch application.
Deletion runs before creation and is bounded to 500 deletes and 100 creates per
run by default. The one-minute reconciliation interval lets a large backlog
converge without spending the entire app-token rate-limit budget at once.

Webhook receipt stores the Twitch message type. Notifications are processed
every five seconds in a loop separate from remote reconciliation. Revocations
clear the corresponding remote ID so desired subscriptions can be recreated.
Webhook bodies are authenticated and checked for a fresh timestamp before JSON
parsing or persistence.

Inbound and outbound raid subscriptions can both deliver the same raid when
both channels are in the cohort. A second delivery for the same source and
target within one minute is treated as a duplicate normalized fact. Its raw
EventSub row remains preserved. The migration removes existing duplicate raid
and channel-event facts using the same rule without deleting raw events.

Non-desired local rows are operational cache, not observation history. They are
deleted after their remote subscription is absent or successfully deleted. Raw
EventSub payloads and normalized stream/channel history keep their existing
preservation policy.

## Consequences

- A moving `lastSeenFinnishAt` ranking no longer creates subscriptions forever.
- Duplicate and obsolete owned subscriptions converge toward the configured
  desired set, while unrelated callbacks are left untouched.
- Active-only listing avoids repeatedly paging through Twitch's retained
  disabled subscription records.
- Dual-direction raid deliveries no longer inflate normalized raid counts.
- Reconciliation progress and desired/non-desired local counts are visible in
  worker heartbeat details and the admin ingestion view.
- The stable cohort intentionally favors continuity over continuously moving
  EventSub coverage to whichever channels were most recently observed.
