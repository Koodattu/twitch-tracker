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
- `TWITCH_BOT_LOGIN`
- `TWITCH_BOT_ACCESS_TOKEN`
- `ENABLE_TWITCH_INGESTION=true`

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

For public EventSub verification, also configure:

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
