# Ingestion Edge Cases

This system treats Twitch ingestion as observed telemetry, not perfect ground
truth. Raw records are preserved first, and normalized tables are best-effort
views over those records.

## IRC Join And Part Limits

Twitch IRC `twitch.tv/membership` enables JOIN and PART messages, but those
messages are lossy:

- JOIN/PART is not available for every practical situation.
- Twitch documents that JOIN/PART messages are not sent in rooms with more than
  1,000 users.
- IRC messages can arrive in bursts, and application code must tolerate
  reconnects, duplicate observations, and delayed command acknowledgements.

Do not market or model JOIN/PART as an exact viewer timeline. It is a useful
activity signal for smaller and medium channels, and a lower-confidence signal
for large channels.

## Current Worker Behavior

- Assignment selection ranks one candidate set against the pool's combined
  capacity, preserves incumbents where possible, and partitions streams into
  disjoint per-account assignments.
- Each enabled account with a valid token gets its own IRC connection and its
  configured room and JOIN-rate limits. Accounts without a valid token
  contribute zero effective capacity.
- Discovery batches a Twitch user lookup for each stream page so broadcaster
  profile images and other user metadata stay populated alongside stream data.
- Existing `left`, `failed`, or pending `leaving` assignments are revived when
  they move back into the selected capacity set.
- Pending PART commands are sent before new JOIN commands to avoid temporary
  capacity overflow during churn.
- New JOIN commands are capped by both `joinRatePer10Seconds` and remaining room
  capacity.
- A JOIN that remains unacknowledged for more than two minutes is moved back to
  `desired` for retry.
- IRC `RECONNECT` and socket disconnects move `joined`/`joining` assignments
  back to `desired` so the worker rejoins selected rooms.
- Bot self JOIN/PART is not counted as chatter membership.
- `lastMessageAt` and `lastMembershipEventAt` on assignments are updated from
  observed channel activity for stale-room diagnostics.
- `CLEARMSG` marks a single normalized chat message as deleted when Twitch sends
  a target message ID.
- `CLEARCHAT` marks current-stream messages as cleared for the affected chatter,
  or for the whole current stream when no target user is provided.
- IRC JOIN/PART events carry `source`, `confidence`, and a dedupe key.
- IRC `USERNOTICE` and `NOTICE` are normalized into channel events. Blocking
  notices can mark a chat assignment failed.
- Get Chatters reconciliation runs only for tracked live channels where the bot
  is known to be a moderator and has `user:read:moderated_channels` plus
  `moderator:read:chatters`.
- Get Chatters observations are stored as presence snapshots, not fake JOIN
  events.

## Shared Chat Attribution

IRC `PRIVMSG` records preserve `source-room-id` in
`chat_messages.shared_chat_source_channel_id`. An absent or empty tag is stored
as null. The receiving broadcaster and message ID remain unchanged: Shared Chat
copies have their own message IDs and still belong in the receiving channel's
observed message archive.

For chatter-overlap analysis, a non-null source different from the receiving
broadcaster identifies a relayed message, not evidence that the chatter visited
both channels. A matching source identifies the original message in a shared
room. See [Twitch's Shared Chat documentation](https://dev.twitch.tv/docs/chat/irc/#shared-chat).

Migration `0012_recover_shared_chat_sources` recovers historical source tags
from linked raw IRC records. It only reads the leading tag block, preserves
already populated source IDs, and skips messages without a chatter identity.
Missing or redacted raw records cannot establish historical source attribution;
historical null values alone do not prove that messages were native. Existing
message-count rollups still include observed relayed messages; the map needs
its own source-filtered input.

## Aggregation Boundaries

Rolling lookback windows begin at a complete time-bucket boundary or UTC
midnight for daily statistics. Replacing a full aggregate with only the portion
after a moving cutoff would progressively undercount messages, active chatters,
membership events, viewer samples, and daily streams.

The aggregation loop runs `aggregation-boundary-repair-v1` once to rebuild
historical aggregates from retained normalized observations, including every
stored bucket resolution. It reuses the normal rollup queries and records
success only after all queries finish. A failed or interrupted repair is retried
on a later run; a successful record prevents repeating it after restart. The
initial repair scans retained history and may take longer than routine rollups.
It preserves source observations and does not require a separate maintenance
command. Existing null chatter identities remain excluded from chatter rollups.

## Missed JOIN

Symptoms:

- Assignment stays `joining`.
- No `ROOMSTATE`, `USERSTATE`, or bot JOIN acknowledgement arrives.

Handling:

- The worker retries after the stale JOIN timeout.
- Repeated failures should be investigated through raw IRC `NOTICE` messages and
  the worker heartbeat summary.

## Missed PART

Symptoms:

- Assignment was marked `left`, but IRC activity still arrives from the channel.
- Capacity appears correct in the DB, but the socket may still be receiving an
  unwanted room.

Handling:

- Observed room activity promotes the assignment back to `joined`.
- The assignment loop then retires it again if it is outside the selected
  capacity set, causing another PART attempt.

## Reconnects

Twitch can send an IRC `RECONNECT` command before closing the socket. A plain
network close can also happen without a prior command.

Handling:

- The adapter reports a single disconnect event for each socket.
- Active assignments are moved back to `desired`.
- The next IRC loop reconnects and rejoins selected rooms within capacity and
  join-rate limits.

## EventSub Scope

EventSub subscriptions are independent from IRC joins. Subscribing to
`stream.online`, `stream.offline`, `channel.update`, raids, shared-chat events,
and `user.update` does not put the bot into chat rooms.

Chat-message EventSub is different: it is authorization-gated and should not be
treated as a replacement for IRC across arbitrary Finnish channels. Use it later
for opted-in or moderator-authorized channels.

The webhook worker keeps a stable, bounded desired channel cohort and reconciles
it once per minute. It deletes only subscriptions tied to the current callback
or remote IDs already recorded locally. A large stale backlog is expected to
shrink over multiple runs because each run has deletion and creation limits.
Use the `eventsub-reconciliation` heartbeat details to check active, desired,
stale, deleted, deferred, failed, blocked, and unmanaged counts. A non-zero
unmanaged count means another callback shares the Twitch application; those
subscriptions are deliberately not changed.

Twitch may return raid conditions with an empty `from_broadcaster_user_id` or
`to_broadcaster_user_id`. Empty condition values are ignored when matching so
these subscriptions are not recreated as duplicates.

When both sides of a raid belong to the desired cohort, the inbound and
outbound subscriptions may each deliver it. Deliveries with the same source and
target within one minute are one normalized raid; both raw webhook rows remain
available for provenance.

## Remaining Known Gaps

- IRC `353` NAMES replies are stored raw but not normalized into membership
  observations, because treating the initial names list as real joins would
  inflate join counts.
- Get Chatters reconciliation does not infer PART events from missing users yet.
- EventSub subscriptions are reconciled only when a public HTTPS callback on
  port 443 is configured.
- EventSub is not exercised locally unless a public HTTPS callback on port 443
  is available.
- Failed raw EventSub events are recorded for diagnosis, but there is not yet an
  automated replay loop for them.
