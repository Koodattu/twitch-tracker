# Community map

The public explorer is at `/communities`. In **Admin → Ingestion**, the **Community map → Build now** button queues a rebuild and shows its progress and last successful build. It requires the existing admin session and a same-origin request. Repeated pending requests coalesce.

The explorer fills the viewport below the site navigation. Search, community filters, channel details, map controls, and the explanation float over the graph. Mouse-wheel zoom follows the cursor; touch gestures support pan and pinch zoom. Keyboard users can select channels from search, use arrow keys to pan, +/− to zoom, Home to fit the map, and Escape to close panels. Mobile channel details use a scrollable bottom panel, with the selected channel positioned above it. Reporting dates, coverage, and the recipe explanation are available under **How it works**.

## Scheduling and input

The existing worker checks every 30 seconds. The nightly window becomes due at **03:00 UTC**; restarts catch up to the latest due window. An on-demand build uses the latest 30 completed UTC days even before 03:00. No external cron or additional deployment service is needed.

Recipe `finnish-chat-v1` includes messages from recorded Finnish-eligible sessions, with at least 3 original messages per chatter/channel, 10 qualifying chatters per channel, and 5 shared chatters per candidate connection. Connections use binary cosine similarity; the union of each channel's 10 strongest connections is clustered with weighted Louvain and laid out using ForceAtlas2. Qualifying channels without connections stay ungrouped.

Shared Chat copies, missing session links, known ingestion bots, and subjects with existing privacy restrictions are excluded. Historical messages with a null source are used only when retained raw IRC tags verify that they were original channel messages. Unverifiable rows are excluded and disclosed on the page. The reporting window and actual qualifying observation span are shown separately; neither claims complete viewer coverage.

## Persistence, failures, and privacy

Migration `0013_community_maps.sql` adds daily snapshots and one durable state row for scheduling, admin requests, and privacy revisions. The existing migration service applies it during normal deployment.

- A renewable four-minute database lease coordinates workers. Publication checks lease ownership and the privacy revision in a transaction.
- A failed build keeps the last valid result, records an error, and retries after 15 minutes. **Build now** clears that delay. A successful empty result replaces the previous map.
- Privacy completion invalidates and clears all saved map payloads in the same transaction as the subject changes, and queues a rebuild. An in-flight build cannot publish against an older privacy revision. Privacy-invalidated maps are never served as stale results.
- Snapshots contain channel IDs, aggregate counts, connections, communities, and positions. Chatter IDs are used only during computation. Current channel names are resolved and visibility is checked on each API read; responses use `Cache-Control: no-store`.

Worker heartbeat and ingestion records use `community-map`. Every completed build is recorded, including on-demand builds between routine sampled due checks. Successful summaries include the reporting window, input/graph durations, payload size, qualifying memberships, exclusions, candidate edges, pair contributions, and maximum channel degree per chatter.

## Resource limits

Each of the two input queries has a 90-second statement timeout and 32 MB PostgreSQL `work_mem` per operation. Graph computation runs in a separate worker thread with a 512 MB old-generation heap limit and a 90-second deadline; the overall build deadline is four minutes. Lease renewal runs every 30 seconds.

The builder rejects more than 500,000 memberships, 10,000 qualifying channels, 10 million pair contributions, one million distinct candidate pairs, or a 10 MB graph payload. Exceeding a limit fails the build instead of silently dropping channels. These are operational limits, not privacy guarantees.

## Validation on 2026-09-06

The approved production checks used read-only transactions, a 60-second statement timeout, and aggregate output only. No migrations or map publications were performed against production during validation.

| Production input, 2026-08-07 through 2026-09-05 UTC | Count |
| --- | ---: |
| Normalized messages in the window | 2,470,482 |
| Messages missing session links | 7,182 |
| Eligible, permitted messages with unverifiable source | 0 |
| Eligible, permitted relayed Shared Chat messages excluded | 45,658 |
| Chatter/channel memberships before the 3-message threshold | 106,062 |
| Qualifying memberships | 66,294 |
| Qualifying channels | 1,125 |
| Channels below the 10-chatter threshold | 1,799 |
| Maximum qualifying channels per chatter | 480 |
| Pair contributions / distinct pairs | 357,005 / 216,090 |
| Candidate connections meeting the shared-count threshold | 8,661 |

The membership query's measured execution time was **21.3 seconds**, reduced from 24.9 seconds by replacing per-message combined privacy probes with independently hashable checks. The final plan scans much of the retained data and spills intermediate joins to temporary storage (about 1.6 GB read and 1.7 GB written per membership-query execution). No speculative index was added: the window covers almost all retained messages. Revisit the input plan as volume grows; the query is deliberately scheduled outside page requests and has a timeout.

Independent SQL channel counts and pair counts were passed through the same compiled edge-reduction, clustering, and layout code locally, without retrieving chatter identities. This produced **1,125 nodes, 3,943 retained edges, 39 communities, and 251 isolates**, in approximately **505 ms**, with a **429,086-byte** graph payload. Observed source coverage begins on August 14. A high-degree chatter is retained as legitimate activity; weak overlaps still have to meet the shared-count threshold.

An isolated PostgreSQL fixture exercised the full input/build/publication path with **1,125 channels and 9,985 edges**. Input processing took approximately **1.05 seconds**, layout/publication **0.77 seconds**, and the graph payload was **853,402 bytes**. Browser checks at 1440×1000 and 390×844 verified search, keyboard selection, overlap percentages, community filtering, pan, zoom/reset, and no horizontal page overflow. One desktop zoom action plus tool round trip took 296 ms; this is not a frame-rate measurement. The local admin button queued a real build and polling returned to Ready after completion.

Automated coverage includes source/session/eligibility/privacy/bot filtering, distinct chatter counts, normalized scores, sparse edges, isolates, repeatable communities, worker-thread execution, budget rejection, competing leases, expiry recovery, retry behavior, empty snapshots, stale publication rejection, admin authorization, and all three existing privacy request types. The complete suite passed with **120 tests** against an isolated PostgreSQL database. Production build, typecheck, lint, structure, dependency audits, and Compose configuration validation also passed. Production deployment and ingestion continuity after deployment were not monitored.
