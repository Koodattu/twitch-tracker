# Raw Event Ledger and Normalized Tables

Status: accepted

The database stores raw Twitch observations first, then parses and upserts them
into normalized product tables and aggregates. Raw Helix responses, IRC
messages, and EventSub events preserve what Twitch sent, while normalized tables
power stream sessions, channel analytics, chat activity, and public UI queries.

**Consequences**

The private MVP can reprocess data when parsers improve and can inspect raw
payloads during ingestion debugging. Public and long-lived analytics must not
depend directly on raw payload tables, because those tables may later be
partitioned, truncated, retained for a short period, or disabled before public
deployment.
