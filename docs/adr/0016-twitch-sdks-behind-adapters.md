# Twitch SDKs Behind Adapters

Status: accepted

Twurple is the default SDK candidate for Twitch auth, Helix REST, EventSub, and
possibly chat, but product code depends on project-owned Twitch adapter
interfaces rather than Twurple objects directly. The adapters translate SDK or
custom-client output into Raw Event Ledger rows, normalized DTOs, and domain
state owned by this project.

**Considered Options**

- Use Twurple directly throughout the API and worker.
- Avoid Twitch SDKs and hand-roll all REST, IRC, EventSub, and OAuth code.
- Use Twurple where it saves work, but keep it behind adapters and validate the
  raw-data requirements with focused spikes.

**Consequences**

`@twurple/auth` and `@twurple/api` are good default candidates for auth and
Helix calls. `@twurple/eventsub-http` should be used only if it fits cleanly
with Hono and Caddy webhook routing. `@twurple/chat` needs an early spike before
commitment because the product must persist raw IRC lines and control chat
assignment, reconnect, JOIN/PART, and capacity behavior. High-level bot
abstractions such as `@twurple/easy-bot` are out of scope.
