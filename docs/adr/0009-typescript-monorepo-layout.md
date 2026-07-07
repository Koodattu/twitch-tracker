# TypeScript Monorepo Layout

Status: accepted

The project uses a single TypeScript monorepo with separate deployable apps for
the web frontend, API, and ingestion worker. Shared packages hold database
schema/migrations, configuration, Twitch integration helpers, and genuinely
shared types or utilities.

**Consequences**

Docker Compose can build separate containers from one repository while the API
and worker share the same Drizzle schema and Twitch/domain parsing code. Shared
packages should remain pragmatic: code used by only one app stays inside that
app until reuse is real.
