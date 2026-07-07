# Twitch SDKs Behind Adapters

Status: accepted

Product code depends on project-owned Twitch adapter interfaces rather than
Twurple objects directly. The first implementation uses native `fetch` clients
for OAuth, Helix REST, and EventSub management, Hono-owned EventSub webhook
receipt, and a project-owned TLS IRC socket adapter. Raw line/payload
persistence, JOIN/PART handling, reconnect behavior, and capacity management
are core product requirements. The adapters translate SDK or custom-client
output into Raw Event Ledger rows, normalized DTOs, and domain state owned by
this project.

**Considered Options**

- Use Twurple directly throughout the API and worker.
- Avoid Twitch SDKs and hand-roll all REST, IRC, EventSub, and OAuth code.
- Use Twurple where it saves work, but keep it behind adapters and validate the
  raw-data requirements with focused spikes.

**Consequences**

Twurple remains a valid future dependency if it clearly reduces maintenance
cost behind the existing adapters. `@twurple/chat` is not the first IRC
implementation because the product must persist raw IRC lines and control chat
assignment, reconnect, JOIN/PART, and capacity behavior. `@twurple/eventsub-http`
is not needed for the initial webhook receiver because Hono owns the route and
signature verification directly. High-level bot abstractions such as
`@twurple/easy-bot` are out of scope.
