# REST, IRC, and EventSub Ingestion Ownership

Status: accepted

The ingestion system uses REST, IRC, and EventSub together, with each source
owning different signals. REST discovers all Finnish streams, hydrates metadata,
captures viewer snapshots, and reconciles stream state. IRC owns private-MVP
deep chat tracking for assigned chat rooms, including messages and membership
events. EventSub owns lifecycle and structured channel events such as
`stream.online`, `stream.offline`, `channel.update`, and `channel.raid`.

**Consequences**

No implementation should assume one Twitch interface is complete. When two
sources can observe the same real-world event, the system must define a primary
source and dedupe or retain the secondary source as raw evidence. REST remains
the repair path for missed EventSub or IRC events, and EventSub does not replace
REST discovery of previously unknown Finnish streams.
