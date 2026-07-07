# Twitch Tracker

This context defines the product language for a tracker of Finnish Twitch
streams, channels, and chat-derived activity.

## Language

**Finnish Stream**:
A Twitch livestream treated by this product as part of Finnish Twitch. This is a
product classification, not a claim about the streamer's nationality.
_Avoid_: Finnish streamer, Finnish viewer base

**Discovered Stream**:
A Finnish Stream the product has found and tracks at the stream metadata level.
_Avoid_: Tracked stream

**Chat-Tracked Stream**:
A Discovered Stream whose chat room is actively joined by the product so chat
messages, membership events, and chatter activity can be observed.
_Avoid_: Fully tracked stream, joined stream

**Chat Assignment**:
A worker decision that binds a bot account to a Chat-Tracked Stream for a period
of time.
_Avoid_: Join, subscription

**Ingestion Source**:
One official Twitch interface used to collect observed data: REST, IRC, or
EventSub.
_Avoid_: Data source, crawler source

**Channel Analytics**:
Public-facing statistics about Twitch channels and streams, such as live state,
viewer history, categories, stream sessions, and aggregate chat activity.
_Avoid_: Surveillance, user dossiers

**Chatter Data**:
Observed data tied to an individual Twitch user who appears in chat or
chat-related events.
_Avoid_: Viewer data, audience identity

**Raw Observed Data**:
The fullest practical record of Twitch-derived data received by the product,
kept during the private MVP so ingestion can be verified before retention is
tightened.
_Avoid_: Everything, permanent archive

**Raw Event Ledger**:
Append-first database tables that preserve Twitch observations before or
alongside parsing into normalized product tables.
_Avoid_: Audit log, analytics table

**Public Chatter Summary**:
A limited public view of an individual chatter's aggregate activity, excluding
full timelines and raw message history.
_Avoid_: Public profile, full profile

**Own Data View**:
An authenticated view where a Twitch user can inspect detailed data the product
has associated with their own Twitch identity.
_Avoid_: Admin profile, public profile

**Private MVP Profile**:
A development-only view that exposes detailed observed chatter data without the
public launch privacy restrictions.
_Avoid_: Public profile, production profile

**Deployment Mode**:
The configured operating mode that decides whether development-only access
shortcuts are available.
_Avoid_: Environment, NODE_ENV
