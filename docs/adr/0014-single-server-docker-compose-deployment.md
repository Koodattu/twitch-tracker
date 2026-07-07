# Single-Server Docker Compose Deployment

Status: accepted

The product is deployed to one server with Docker Compose. The planned services
are Caddy, web, API, worker, PostgreSQL, a one-shot migration runner, and a
backup job/container.

**Considered Options**

- Kubernetes.
- A single all-in-one application container.
- Docker Compose with focused service containers.

**Consequences**

Kubernetes is out of scope. Caddy owns TLS and reverse proxying, the API owns
REST/auth/EventSub webhooks, the worker owns ingestion loops, PostgreSQL is the
only database, migrations run separately, and backups are a first-class service.
The initial deployment should stay simple and working before adding extra
orchestration or observability services.
