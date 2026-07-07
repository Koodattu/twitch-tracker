# All Streams With Capacity-Managed Chat Tracking

Status: accepted

The product tracks all discovered Finnish streams at the stream metadata and
snapshot level, while chat-level tracking is assigned to a capacity-managed set
of bot account joins. The system starts with one bot account but is designed to
manage a compliant pool of accounts, where each account has explicit join
capacity, join-rate limits, connection state, and channel assignments.

**Considered Options**

- Track only the top Finnish streams end to end.
- Track all Finnish streams equally, including chat, with no capacity model.
- Track all Finnish streams at the stream level, and manage chat tracking as a
  separate capacity-limited assignment problem.

**Consequences**

The worker must include robust assignment logic for joining the top `n * 100`
eligible streams when using `n` normal bot accounts, while leaving capacity for
authorized or priority channels as needed. When streams end, are no longer
Finnish, disconnect, error, or fall out of priority, assignments must be
reconciled without excessive join churn. Multiple accounts must not be used to
evade Twitch limits or collect data outside official interfaces.
