# Twitch Tracker Architecture Notes

Status: initial planning notes, 2026-07-07.

This document records the current technical feasibility assumptions for a
private MVP that tracks Finnish Twitch streams. It is not yet a public-launch
privacy, compliance, or product policy document.

## Goal

Build a single-server Docker Compose application that discovers Finnish Twitch
streams, tracks stream and chat activity, stores the data in PostgreSQL, and
serves a public-style web UI from a private MVP deployment.

The intended production shape is:

- Caddy reverse proxy and TLS.
- Next.js web frontend.
- Hono TypeScript API.
- TypeScript worker process for Twitch ingestion.
- PostgreSQL database.
- One-shot migration container.
- Backup job/container for off-server database backups.

## Current Stack Direction

- Runtime: Node.js LTS is the conservative production default.
- Package manager: choose one, likely pnpm or Bun. Do not mix without a reason.
- API framework: Hono.
- Frontend: Next.js and React.
- Client data fetching: TanStack Query.
- Database: PostgreSQL.
- ORM/query layer: Drizzle.
- Validation: Zod at runtime boundaries.
- Deployment: Docker Compose on one server.

Bun remains viable for local development or all-runtime use, but long-lived
Twitch connections, PostgreSQL drivers, and production observability should be
tested early before committing to it as the production runtime.

## Twitch Source Summary

The ingestion model should be hybrid. No single Twitch interface gives all the
data we want.

### Helix REST API

Use REST API calls for discovery, metadata, snapshots, and authorization-aware
lookups.

Useful endpoints:

- `Get Streams`: discover live streams, including `language=fi`.
- `Get Users`: hydrate Twitch user/channel metadata in batches of up to 100.
- `Get Moderated Channels`: ask which channels the bot account moderates.
- `Get Chatters`: get a snapshot of connected chat users, but only where the
  bot is broadcaster/moderator or otherwise has the required authorization.
- `Get EventSub Subscriptions`: reconcile active EventSub state.

Important constraints:

- `Get Streams` is a dynamic paginated list. Duplicate or missing streams are
  possible while paging because viewer counts change.
- Stream language is not the same as streamer nationality. "Finnish streams"
  should initially mean streams currently broadcasting with language `fi`.
- API rate limits must be tracked from response headers and persisted in worker
  state or logs.

### EventSub

Use EventSub for near-real-time events where it is clearly better than polling.

Useful subscriptions:

- `channel.chat.message`: chat message events for a channel.
- `channel.chat.notification`: chat-visible events such as subs, raids, gifts.
- `channel.chat.message_delete` / clear events: moderation-related chat changes.
- `stream.online` / `stream.offline`: useful for curated or opt-in channels.
- `channel.update`: title/category/language changes for curated or opt-in
  channels.
- `channel.shared_chat.*`: shared chat session metadata.

Important constraints:

- `channel.chat.message` requires reading as a user and joining the chat room.
- A normal account is currently limited to 100 concurrent joined chat rooms.
- A normal account is currently limited to 20 join attempts per 10 seconds.
- EventSub WebSockets require reconnect/resubscribe handling. Missed events are
  not replayed after a dropped connection.
- WebSocket subscriptions have per-user-token limits. Plan for reconciliation,
  not a fire-and-forget setup.

EventSub is probably the right long-term API for chat messages, but it does not
provide every signal we want.

### Twitch IRC

Use IRC when we specifically need membership events.

Useful IRC capabilities:

- `twitch.tv/membership`: receive `JOIN` and `PART` messages.
- `twitch.tv/tags`: receive message metadata.
- `twitch.tv/commands`: receive Twitch-specific IRC messages.

Important constraints:

- IRC `JOIN` counts as joining a chat room.
- The same 100 concurrent joined-room limit applies to a normal account.
- Dropping EventSub and using only IRC does not let one bot join every Finnish
  channel if more than 100 relevant channels are live.
- JOIN/PART is chat-room presence, not viewer count. It should not be marketed
  as exact stream viewership.
- IRC is lower-level and more parser-heavy than EventSub. Keep it isolated in
  an ingestion adapter.

Recommended MVP posture:

- Use REST for discovery and metadata.
- Use IRC for the selected active channel set if JOIN/PART is a first-class
  metric.
- Use EventSub for non-membership events and later for chat where it provides
  better reliability/structure.
- Avoid joining the same channel through both IRC and EventSub unless we have
  verified how it affects join limits and duplicate data.

## Can We Join All Finnish Channels?

Only if the active target set stays within Twitch limits.

With one normal bot account:

- Maximum concurrent joined channels: 100.
- Join rate: 20 join attempts per 10 seconds.
- IRC does not bypass this.
- EventSub chat subscriptions do not bypass this.

If more than 100 Finnish-language channels are live, the worker needs a channel
selection policy.

Possible MVP policy:

1. Always track a manually curated allowlist.
2. Fill remaining capacity with currently live `language=fi` streams sorted by
   viewer count.
3. Prefer channels where the bot is moderator or has app authorization.
4. Rotate low-priority channels slowly; do not churn joins.
5. Record when a live channel was discovered but not joined because capacity was
   exhausted.

Do not work around Twitch limits by spreading load over many throwaway accounts.
That is operationally messy and likely to be treated as limit circumvention.

## Moderator-Aware Behavior

By default, assume the bot is not modded anywhere.

Still, the bot can periodically query `Get Moderated Channels` using the bot
account token and `user:read:moderated_channels` authorization. For channels in
that result set, the system can enable moderator-only features if the bot token
also has the needed scopes.

If the bot is a moderator for a channel:

- `Get Chatters` can be used with the bot as `moderator_id`, assuming the token
  has `moderator:read:chatters`.
- Moderator-only EventSub events may become available depending on scopes.
- Joined-room limits may be more favorable for channels where the bot is
  moderator, but this should be verified in implementation against current
  Twitch behavior.

## Data To Track

This is the initial data catalogue. It is intentionally broader than the first
MVP tables so we can design stable identifiers and retention boundaries.

### Twitch Users

Represents any Twitch account we encounter: streamer, chatter, moderator, bot,
or event actor.

Track:

- Twitch user ID.
- Current login.
- Current display name.
- Account type.
- Broadcaster type.
- Description.
- Profile image URL.
- Offline image URL.
- Account creation timestamp.
- First seen timestamp.
- Last seen timestamp.
- Last metadata refresh timestamp.

Avoid:

- Email.
- Deprecated `view_count`.
- Any private OAuth-specific fields unless needed for our own bot account.

### User Login History

Twitch logins/display names can change. Store history separately.

Track:

- Twitch user ID.
- Login.
- Display name.
- Valid/observed from timestamp.
- Observed until timestamp, nullable.
- Source that observed the change.

### Streamers / Channels

Streamer/channel state is mostly Twitch user metadata plus tracker-specific
classification.

Track:

- Twitch user ID.
- Whether channel is in manual allowlist.
- Whether channel has been seen broadcasting in Finnish.
- Whether channel is opted in, if opt-in is added later.
- Whether bot is currently known to be moderator.
- Tracking priority.
- Notes/tags for internal classification.

### Live Stream Sessions

Represents one Twitch stream lifecycle.

Track:

- Twitch stream ID.
- Broadcaster user ID.
- Started at.
- Ended at, nullable until confirmed offline.
- First seen at.
- Last seen live at.
- End detection source: REST missing, EventSub offline, manual reconciliation.
- Language.
- Initial title.
- Latest title.
- Initial category/game.
- Latest category/game.
- Mature flag if Twitch still returns a meaningful value.

The stream may be discovered after it started. Preserve both `started_at` from
Twitch and `first_seen_at` from our system.

### Stream Snapshots

Periodic point-in-time stream state.

Track:

- Stream ID.
- Broadcaster user ID.
- Snapshot timestamp.
- Viewer count.
- Title.
- Category/game ID and name.
- Language.
- Tags.
- Thumbnail URL/template.
- Source request ID or ingestion run ID.

Snapshots power charts and reduce reliance on raw event history.

### Chat Rooms Joined

Tracks our own ingestion state per channel.

Track:

- Broadcaster user ID.
- Join method: IRC, EventSub, or both if intentionally tested.
- Joined at.
- Left at.
- Reason joined.
- Reason left.
- Bot account user ID.
- Connection/session identifier.
- Last message received at.
- Last membership event received at.
- Error/reconnect state.

### Chat Messages

For private MVP, raw messages can be useful for debugging. For public launch,
default to aggregate-first and short raw retention.

Track if raw storage is enabled:

- Twitch message ID.
- Stream ID if known.
- Broadcaster user ID.
- Chatter user ID.
- Sent timestamp.
- Received timestamp.
- Message type.
- Message text.
- Reply parent message ID if available.
- Source channel in shared chat cases.
- Badges.
- Emotes/fragments.
- Cheer/bits metadata if present.
- Deleted/cleared state if observed.

Recommended default:

- Store message metadata and aggregate counts long term.
- Store raw text only behind a retention period for debugging.

### Chat Membership Events

From IRC JOIN/PART.

Track:

- Broadcaster user ID.
- Chatter user ID or login, depending on IRC payload availability.
- Event type: join or part.
- Event timestamp.
- Received timestamp.
- Connection/session ID.
- Stream ID if known.

Important interpretation:

- This is chat presence, not viewing.
- JOIN/PART may not produce an accurate "currently watching stream" number.

### Chatter Activity Aggregates

Long-term user-facing stats should come from aggregates.

Possible buckets:

- Per channel, stream, chatter, and time bucket.
- Message count.
- First message time.
- Last message time.
- Distinct active minutes.
- Join count.
- Part count.
- Approximate present duration, if defensible.
- Emote counts.
- Badge observations.

Use time buckets such as 1 minute or 5 minutes for live charts, then daily
rollups for long-term stats.

### Chat Room Snapshots

Only where `Get Chatters` is authorized.

Track:

- Broadcaster user ID.
- Snapshot timestamp.
- Total chatters reported by Twitch.
- Page count.
- Source token/moderator user ID.
- Optional per-user presence rows if needed.

Do not assume this is available for arbitrary channels.

### Ingestion Runs

Every recurring worker loop should be observable.

Track:

- Run ID.
- Job type.
- Started at.
- Finished at.
- Status.
- Items requested.
- Items inserted/updated/skipped.
- Twitch rate-limit headers.
- Error code/message class.

### OAuth And Bot Authorization

Track only what is needed to operate the bot securely.

Track:

- Bot user ID.
- Granted scopes.
- Token expiry.
- Refresh status.
- Last successful validation.

Store secrets encrypted or in deployment secrets, not in ordinary tables if
avoidable. Never expose token values through logs or API responses.

## Initial Database Direction

Likely tables:

- `twitch_users`
- `twitch_user_names`
- `channels`
- `stream_sessions`
- `stream_snapshots`
- `chat_room_sessions`
- `chat_messages_raw`
- `chat_membership_events`
- `chat_activity_buckets`
- `chatters_snapshots`
- `chatters_snapshot_users`
- `ingestion_runs`
- `bot_authorizations`

Use PostgreSQL indexes around:

- Twitch IDs.
- Stream ID.
- Broadcaster ID.
- Chatter ID.
- Timestamp buckets.
- Stream/channel ranking query paths.

Consider partitioning later for high-volume raw chat tables. Do not start with
ClickHouse or TimescaleDB until PostgreSQL is proven insufficient.

## MVP Feasibility

Technically feasible:

- Discover Finnish-language live streams.
- Track stream sessions and viewer snapshots.
- Join up to the normal bot account's chat-room capacity.
- Track chat messages for joined rooms.
- Track IRC JOIN/PART for joined rooms.
- Hydrate users through `Get Users`.
- Detect where the bot is moderator through `Get Moderated Channels`.
- Use `Get Chatters` for channels where authorization allows it.

Not technically feasible as a general default:

- Exact all-chatters state for arbitrary Finnish Twitch channels.
- Joining every Finnish channel if the active set exceeds account limits.
- Exact viewer identity or exact viewer presence.
- Lossless EventSub ingestion across disconnects.

## Open Decisions

- Use Node LTS for all production containers, or Bun for API/worker too?
- Is IRC the primary chat ingestion path for MVP because JOIN/PART is important?
- How many raw chat messages do we keep, and for how long?
- Should public launch expose chatter-level pages at all?
- What is the channel capacity policy when more than 100 Finnish streams are
  live?
- Should streamer opt-in become a first-class concept before public launch?

## Source Links

- Twitch Chat and chatbot limits:
  https://dev.twitch.tv/docs/chat/
- Twitch IRC capabilities:
  https://dev.twitch.tv/docs/chat/irc/
- EventSub subscription types:
  https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
- EventSub WebSocket behavior and limits:
  https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
- EventSub subscription management:
  https://dev.twitch.tv/docs/eventsub/manage-subscriptions/
- Twitch API reference:
  https://dev.twitch.tv/docs/api/reference/
- Twitch API rate limits:
  https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits
- Twitch Developer Agreement:
  https://legal.twitch.com/en/legal/developer-agreement/
