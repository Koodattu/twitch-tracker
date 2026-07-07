# Public Analytics and Ingestion Diagnostics First

Status: accepted

The first web surface is a public-style Finnish Twitch analytics product, not
only an admin dashboard. It includes live stream rankings, channel pages, stream
session pages, chatter pages with deployment-mode-sensitive detail, an Own Data
View, and an internal ingestion diagnostics page.

**Consequences**

Implementation must build real analytics queries and UI flows early, while also
exposing operational visibility for the crawler. The internal diagnostics page
is part of the MVP because chat assignments, bot account state, rate limits,
worker heartbeats, and ingestion errors need to be visible during private MVP
testing.
