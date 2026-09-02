# ADR 0018: Explicit Finnish stream eligibility

## Decision

Keep Twitch's `language` value unchanged and store Finnish eligibility and its
reason separately on each stream session. The accepted reasons are Twitch
language `fi`, a case-insensitive exact `Suomi` or `Finnish` tag, and a manual
channel pin.

The three-minute `language=fi` directory poll remains the low-cost primary
discovery path. Every 15 minutes, the worker checks known Finnish and manually
pinned channels through `Get Streams` requests containing at most 100 user IDs.
This catches tag-only streams and repairs omissions from dynamic directory
pagination. The supplemental response bodies are not retained, and only one
rate-limit sample is stored per scan.

An observed live stream clears any prior inferred end. A successful explicit
known-channel batch may close a missing stream only after it has not been seen
for 20 minutes. A failed batch never closes its channels.
When a channel is observed with a new Twitch stream ID, any older open session
for that channel is closed as superseded.
Historical inferred end timestamps that predate a later confirmed live
observation are clamped to that last observation without deleting snapshots or
changing the original detection source.

## Consequences

- Language, tag, and manual eligibility remain distinguishable in history and
  API responses.
- Tag-only discovery is available for channels already known to the tracker;
  Twitch Helix does not provide a global free-form tag filter for discovering
  entirely unknown channels.
- Explicit channel scans add Twitch requests but avoid raw-response storage and
  avoid duplicate snapshots for streams already seen by the primary poll.
- Dynamic directory omissions no longer permanently hide a still-live stream.
