# Production deployment

This runbook deploys the public, fail-closed Compose stack. It does not approve the unresolved privacy, GDPR, Twitch-policy, or retention decisions required for a public launch.

## 1. Prerequisites

- A Linux host with current Docker Engine and the Compose plugin.
- A DNS `A`/`AAAA` record for the final hostname pointing to the host.
- TCP 80 and 443 reachable publicly; UDP 443 is recommended for HTTP/3.
- A Twitch application whose user and bot callback URLs exactly match the final HTTPS URLs.
- An off-host mount, or a separately replicated mount, for database backups.
- A maintenance window if the existing PostgreSQL volume has not recently been backed up and restored.

The checked-in database image is PostgreSQL 16.14. Do not point PostgreSQL 18 at the existing `twitch-tracker_postgres_data` volume. A 16-to-18 upgrade needs a new volume and a tested dump/restore or `pg_upgrade` procedure.

## 2. Production configuration and secrets

Copy `.env.production.example` to an ignored `.env.production` file and replace every placeholder. Set `IMAGE_TAG` to an immutable release ID and `VCS_REF` to the exact Git commit. Use an immutable Twitch user ID for `ADMIN_TWITCH_USER_IDS`.

Create the ignored `secrets` directory and five mode-`0600` files:

- `postgres_password`: a long random PostgreSQL password.
- `database_url`: the full URL-encoded connection URL using host `postgres`, for example `postgres://USER:PASSWORD@postgres:5432/DATABASE`.
- `session_secret`: at least 32 cryptographically random characters.
- `twitch_client_secret`: the Twitch application secret.
- `twitch_eventsub_secret`: at least 32 cryptographically random characters.

Generate random values with a password manager or `openssl rand -base64 48`. Do not commit, paste into shell history, or put secret values in `.env.production`. Ensure the backup directory exists and is writable by uid/gid `70`, used by the pinned Alpine PostgreSQL image.

Keep `PUBLIC_WEB_URL` and `PUBLIC_API_URL` on the same origin. Compose derives both from `PUBLIC_DOMAIN`. Start with Twitch ingestion and EventSub disabled; enable them only after the base deployment, login, and callback checks pass.

## 3. Validate, build, and migrate

Run from the repository root:

```sh
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production pull caddy postgres backup
docker compose --env-file .env.production build --pull
docker compose --env-file .env.production up -d postgres
docker compose --env-file .env.production run --rm migrate
```

Apply the concurrent public analytics indexes once per database, outside a transaction:

```sh
docker compose --env-file .env.production exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < packages/db/online-migrations/0009_public_analytics_indexes.sql
```

See [public analytics indexes](public-analytics-indexes.md) for validation and invalid-index recovery.

Start the application:

```sh
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

All application containers must become healthy, `migrate` must exit successfully, and `backup` must produce a non-empty `.last-success` marker. Caddy obtains its certificate only after DNS and inbound ports are correct.

## 4. Release verification

Verify these before enabling ingestion:

1. `https://HOST/healthz` returns `200` and `https://HOST/api/health` reports database readiness.
2. HTTP redirects to HTTPS and the certificate covers the final hostname.
3. An unauthenticated request to a private/admin API returns `403`, not private data.
4. Twitch login, logout, administrator navigation, and privacy-request flows work.
5. No browser console errors, horizontal overflow, missing focus indicators, or false zero-data states appear at mobile and desktop widths.
6. Container logs contain no tokens, secrets, cookies, raw authorization codes, or database URLs.
7. Worker heartbeat rows become fresh after ingestion is enabled.
8. The live Twitch and EventSub checks in [the Twitch smoke runbook](twitch-smoke.md) pass with production callbacks.

After the checks pass, set `ENABLE_TWITCH_INGESTION=true`. Set `EVENTSUB_ENABLED=true` only when Twitch can reach the HTTPS callback on public port 443, then recreate the API and worker services.

## 5. Backup and restore drill

Backups are custom-format dumps. A dump is exposed under its final name only after `pg_dump` succeeds and `pg_restore --list` validates it; a SHA-256 sidecar and last-success marker are written afterward.

List backup files on the host mount, choose one, and create an empty drill database:

```sh
docker compose --env-file .env.production exec postgres \
  sh -c 'createdb -U "$POSTGRES_USER" twitch_tracker_restore_test'
docker compose --env-file .env.production run --rm \
  -e RESTORE_DATABASE=twitch_tracker_restore_test \
  backup /bin/sh /scripts/restore.sh twitch_tracker_YYYYMMDDTHHMMSSZ.dump
```

Compare representative row counts and run read-only queries against the drill database. Record the date, dump name, duration, and result. Drop the drill database only after verification. The restore script refuses to target the configured production database.

The backup mount must be copied or replicated off the application host. A directory on the same physical server is not a disaster-recovery backup.

## 6. Updating and rollback

Before every update, confirm a fresh off-host backup and a successful recent restore drill. Then pull the exact revision, rebuild with `VCS_REF` set to the Git commit, run migrations, apply any documented online migrations, and recreate services.

Application rollback means redeploying the previous revision. Database rollback is migration-specific; never use `docker compose down -v`, delete the named volume, or attach a new PostgreSQL major to it. Keep the prior application images and the pre-update backup until verification finishes.

## 7. Public-launch gates outside code

An operator or legal owner must still approve:

- raw chat and raw payload retention periods;
- deletion/opt-out policy, response time, and completion procedure;
- public chatter-summary scope;
- Twitch Developer Agreement obligations;
- GDPR/privacy obligations for identifiable or pseudonymous data;
- the actual off-host backup destination and alerting owner;
- production OAuth, EventSub, access-control, and deletion-flow evidence.

Do not describe the service as publicly launch-ready until those decisions and the live checks are recorded.
