# REST API With Zod Contracts

Status: accepted

The backend exposes a plain REST/JSON API through Hono. Runtime validation uses
Zod for environment configuration, route parameters, query strings, request
bodies, Twitch webhook payloads, parsed ingestion payloads, and response
contracts where explicit DTO validation is useful.

**Considered Options**

- GraphQL.
- tRPC.
- Plain REST/JSON with explicit validation contracts.

**Consequences**

The frontend uses TanStack Query against REST endpoints. The API remains easy to
cache, debug, document, and expose publicly later, without tightly coupling the
frontend and backend to a single RPC abstraction.
