# Priority-Based Chat Assignments

Status: accepted

Chat tracking capacity is assigned using a priority score with anti-churn rules,
not by constantly joining the current top channels. Manual pins and authorized
or modded channels come first, then remaining capacity is filled from live
Finnish streams ranked primarily by viewer count.

**Consequences**

Existing healthy assignments should be preserved unless a replacement is clearly
higher priority. Streams that end, stop qualifying, disconnect persistently, or
hit repeated errors can free their slot immediately after confirmation. The
worker must persist assignment state, account capacity, join/leave reasons,
cooldowns, and reconciliation runs so behavior is explainable and testable.
