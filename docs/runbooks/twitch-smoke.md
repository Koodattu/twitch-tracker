# Twitch Smoke Runbook

Use this before calling the Twitch-backed implementation complete.

## Local No-Credential Check

```sh
corepack pnpm smoke:twitch
```

This verifies config parsing and reports missing live credentials as skipped
checks.

## Live Credential Check

Populate `.env` with at least:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `ENABLE_TWITCH_INGESTION=true`

`TWITCH_LOGIN_SCOPES` can stay blank for the current app-user login flow. Add
normal user scopes only when a product feature genuinely needs them.

Then provide bot credentials by either:

- setting `TWITCH_BOT_LOGIN` and `TWITCH_BOT_ACCESS_TOKEN` in `.env`
- or logging in as an admin and connecting a bot at `/internal/bot-accounts`

Then run:

```sh
corepack pnpm smoke:twitch -- --require-live
```

This requires:

- app access token request
- Helix `Get Streams` for `language=fi`
- bot token validation
- bot user lookup through Helix
- Twitch IRC login and own-channel join attempt

The command prints JSON and does not print token values.

## EventSub Callback Check

Do not enable real Twitch EventSub webhooks for plain localhost. Twitch requires
a public HTTPS callback on port 443. For local REST + IRC testing, keep
`EVENTSUB_ENABLED=false`.

For public EventSub verification, configure:

- `EVENTSUB_ENABLED=true`
- `PUBLIC_API_URL=https://your-public-api-host`
- `TWITCH_EVENTSUB_SECRET`

The public API URL must resolve to the API service and serve HTTPS on port 443.
With the API running, run:

```sh
corepack pnpm smoke:twitch -- --require-live --eventsub-callback
```

The callback check sends a signed EventSub challenge to
`/api/webhooks/twitch/eventsub` and expects the challenge text back. It may
create an ignored raw EventSub ledger row because it exercises the real webhook
route.

## Optional IRC Channel

By default, the IRC smoke joins the bot account's own channel. To join a
specific test channel:

```sh
corepack pnpm smoke:twitch -- --require-live --irc-channel=some_channel
```

Use a channel where joining with the bot account is acceptable.

## Bot OAuth Admin Setup

Set these before using the bot-account admin flow:

- `ADMIN_TWITCH_USER_IDS`: comma- or space-separated Twitch user IDs that should be admins at login
- `TWITCH_OAUTH_REDIRECT_URI`: normal user login callback, for example `https://example.com/api/auth/twitch/callback`
- `TWITCH_BOT_OAUTH_REDIRECT_URI`: bot login callback, for example `https://example.com/api/internal/bot-accounts/oauth/callback`
- `TWITCH_BOT_SCOPES`: recommended MVP value is `chat:read user:read:chat user:read:moderated_channels moderator:read:chatters`

Operator flow:

1. Log in through `/me` with a Twitch account listed in `ADMIN_TWITCH_USER_IDS`.
2. Open `/internal/bot-accounts`.
3. Click `Connect bot` and authorize with the dedicated bot Twitch account.
4. Confirm the bot account shows a stored token with `valid` status.
5. Enable ingestion only after the bot token is present or env bot credentials are set.

Minimum current IRC scope is `chat:read`. The recommended MVP scope set also includes `user:read:chat` for future EventSub chat-message paths, `user:read:moderated_channels` to detect where the bot is a moderator, and `moderator:read:chatters` to use Get Chatters where the bot has moderator authorization. Do not add send-message scopes unless the bot will actually send chat messages.

## Production Gate

Production mode intentionally fails fast unless:

- `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, and `TWITCH_OAUTH_REDIRECT_URI` are HTTPS and not localhost
- `COOKIE_SECURE=true`
- `SESSION_SECRET` and `TWITCH_EVENTSUB_SECRET` are real random secrets
- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are set

Unsigned EventSub webhook requests are rejected and are not stored.

For IRC reliability assumptions, missed JOIN/PART handling, and known lossy
membership limits, see `docs/runbooks/ingestion-edge-cases.md`.
