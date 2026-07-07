# API-Owned Authentication and Access Control

Status: accepted

Authentication, sessions, Twitch OAuth handling, and access-control decisions
belong to the Hono API. The Next.js frontend may hide or show UI, but the API is
the source of truth for whether a request may access public channel analytics,
Private MVP Profiles, Own Data Views, admin views, or ingestion diagnostics.

**Consequences**

The web app uses Twitch OAuth through a server-side authorization-code flow.
OAuth state is validated to protect the callback, Twitch access and refresh
tokens are never exposed to browser JavaScript, and browser sessions use secure
HTTP-only cookies. The API validates and refreshes Twitch tokens as needed, and
keeps product sessions separate from Twitch API tokens.

Private MVP access is controlled by an explicit Deployment Mode such as
`local`, `private_mvp`, or `production`. In local or private MVP mode, detailed
chatter views may be available without normal subject login. In production mode,
detailed chatter timelines and raw message history require an authenticated Own
Data View or an explicit admin authorization path.

**Sources**

- https://dev.twitch.tv/docs/authentication/
- https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
- https://dev.twitch.tv/docs/authentication/refresh-tokens/
- https://dev.twitch.tv/docs/authentication/validate-tokens/
