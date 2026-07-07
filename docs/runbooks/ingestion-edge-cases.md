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

- Assignment selection keeps the top configured Finnish live streams active for
  each bot account.
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

## Remaining Known Gaps

- IRC `353` NAMES replies are stored raw but not normalized into membership
  observations, because treating the initial names list as real joins would
  inflate join counts.
- Get Chatters reconciliation does not infer PART events from missing users yet.
- EventSub subscriptions are reconciled only when a public HTTPS callback on
  port 443 is configured.
- EventSub is not exercised locally unless a public HTTPS callback on port 443
  is available.
