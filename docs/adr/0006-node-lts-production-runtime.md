# Node.js LTS Production Runtime

Status: accepted

The production API and worker services use Node.js LTS with TypeScript and pnpm.
This keeps the critical path on the most conservative runtime for long-running
IRC connections, EventSub webhooks, REST polling, PostgreSQL access, Docker
images, logging, and graceful shutdown behavior.

**Considered Options**

- Use Bun for all runtime and package-management concerns.
- Use Bun locally but Node.js in production.
- Use Node.js LTS and pnpm for the MVP critical path.

**Consequences**

Bun is not part of the MVP production critical path. It can be revisited later
after the ingestion system is stable, but initial implementation, Docker images,
dependency choices, and operational checks should assume Node.js LTS and pnpm.
