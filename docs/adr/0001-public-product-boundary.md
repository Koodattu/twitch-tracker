# Public Product Boundary

Status: accepted

The public product is Finnish Twitch stream and channel analytics first. Detailed
individual chatter timelines and raw chat-message history are private-MVP or
authenticated own-data features, while public chatter pages are limited summaries
unless a later decision explicitly expands that boundary.

**Considered Options**

- Make all observed chatter data public from the start.
- Avoid individual chatter data entirely.
- Collect individual chatter data where needed, but keep detailed views private
  or subject-authenticated by default.

**Consequences**

The private MVP may expose detailed chatter profiles to validate ingestion and
data modeling quickly, but public deployment needs a deployment-mode gate,
privacy review, retention rules, and subject-authenticated access before those
details are exposed.
