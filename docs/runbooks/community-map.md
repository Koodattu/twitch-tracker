# Community map

The public explorer is at `/communities`. In **Admin → Ingestion**, the **Community map → Build now** button queues a rebuild and shows its progress and last successful build. It requires the existing admin session and a same-origin request. Repeated pending requests coalesce.

The explorer fills the viewport below the site navigation. Search, community filters, channel details, map controls, and the explanation float over the graph. Mouse-wheel zoom follows the cursor; touch gestures support pan and pinch zoom. Keyboard users can select channels from search, use arrow keys to pan, +/− to zoom, Home to fit the map, and Escape to close panels. Mobile channel details use a scrollable bottom panel, with search and connection-list navigation positioning the selected channel above it. Clicking a circle only selects it and preserves the camera. Reporting dates, coverage, and the recipe explanation are available under **How it works**.

## Scheduling and input

The existing worker checks every 30 seconds. The nightly window becomes due at **03:00 UTC**; restarts catch up to the latest due window. An on-demand build uses the latest 30 completed UTC days even before 03:00. No external cron or additional deployment service is needed.

Recipe `finnish-presence-v4` combines at least 3 original messages per person/channel with repeated chat presence during recorded Finnish-eligible live sessions. Presence requires observations on at least two UTC dates at least six hours apart; repeated JOIN/PART events on one day do not qualify. Positive Get Chatters observations from successful or truncated snapshots also count, without interpreting missing names as absence. Channels need 5 distinct qualifying people, and connections need 3 shared people. The earlier v1/v2 snapshots used 10 and 5; each new snapshot saves its thresholds so the UI describes the displayed map accurately. Each person/channel has weight 1 for messages or 0.25 for presence alone; sources are deduplicated using the strongest evidence. Connection scores sum the minimum endpoint weight for each shared person, divided by the geometric mean of the two distinct audience sizes. Thus a presence-only pair has at most one-quarter the score of an otherwise identical message pair; the union of each channel's 10 strongest connections is clustered with weighted Louvain and laid out using ForceAtlas2. Qualifying channels without connections stay ungrouped.

Shared Chat copies, missing session links, known ingestion bots, and subjects with existing privacy restrictions are excluded. Historical messages with a null source are used only when retained raw IRC tags verify that they were original channel messages. Unverifiable rows are excluded and disclosed on the page. The reporting window and actual qualifying observation span are shown separately; neither claims complete viewer coverage.

## Identity collection and historical data

Migration `0014_membership_identity.sql` adds identity lookup state and a partial index for unresolved events. The IRC writer saves a stable ID only when one unambiguous login mapping has been refreshed through Twitch metadata within an hour. Unknown names remain available for the `membership-identity` worker loop, which resolves up to 100 logins every 30 seconds through Get Users. It considers only the preceding 24 hours, scans at most 10,000 pending events per pass, and leaves failed requests pending. Successful unknown-name lookups are marked checked, so they cannot starve later batches. No credentials or lookup payloads are logged. The existing token and ingestion configuration are reused.

Current usernames are never used to assign IDs to older history. During map computation, unresolved events can use an unambiguous login/ID observation from messages or presence on the same UTC date. Conflicting evidence on that date is excluded. Renames across dates can still connect to the same stable ID; recycled names assigned to different IDs stay separate. This reconstruction is transient and does not rewrite historical events. Redacted names are never restored. Writer/resolver transactions coordinate with privacy completion; tracking opt-outs and deletion prevent new identity attachment.

Known ingestion bots and all map privacy restrictions apply to both sources. As a noise heuristic, people observed through presence in more than 50 distinct eligible channels in the window contribute through messages only. This is not a declaration that those accounts are bots. JOIN/PART records chat connection activity, not video viewing or watch time, and Twitch suppresses these events in rooms above 1,000 users. Get Chatters additionally requires channel moderator access. Source coverage, unresolved identity counts, and the contribution of presence alone are recorded with every snapshot. Missing coverage is unknown, not absence.

References: [Twitch IRC membership](https://dev.twitch.tv/docs/chat/irc/#membership-messages), [Get Chatters](https://dev.twitch.tv/docs/api/reference/#get-chatters), [Get Users](https://dev.twitch.tv/docs/api/reference/#get-users).

## Persistence, failures, and privacy

Migration `0013_community_maps.sql` adds daily snapshots and one durable state row for scheduling, admin requests, and privacy revisions. The existing migration service applies it during normal deployment.

- A renewable four-minute database lease coordinates workers. Publication checks lease ownership and the privacy revision in a transaction.
- A failed build keeps the last valid result, records an error, and retries after 15 minutes. **Build now** clears that delay. A successful empty result replaces the previous map.
- Privacy completion invalidates and clears all saved map payloads in the same transaction as the subject changes, and queues a rebuild. An in-flight build cannot publish against an older privacy revision. Privacy-invalidated maps are never served as stale results.
- Snapshots contain channel IDs, aggregate counts, connections, communities, and positions. Chatter IDs are used only during computation. Current channel names are resolved and visibility is checked on each API read; responses use `Cache-Control: no-store`.

Worker heartbeat and ingestion records use `community-map`. Every completed build is recorded, including on-demand builds between routine sampled due checks. Successful summaries include the reporting window, input/graph durations, payload size, qualifying memberships, exclusions, candidate edges, pair contributions, and maximum channel degree per chatter.

## Resource limits

Each of the three input queries has a 90-second statement timeout and 32 MB PostgreSQL `work_mem` per operation. Graph computation runs in a separate worker thread with a 512 MB old-generation heap limit and a 90-second deadline; category enrichment has a separate 30-second SQL timeout; the overall build deadline is four minutes. Lease renewal runs every 30 seconds.

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


## Presence validation on 2026-09-06

A bounded read-only production audit found 2,516,966 JOIN/PART events across 4,395 channels over the preceding 30 days, with no stable IDs. Get Chatters had two observations from one successful snapshot in one channel. No individual identities or messages were returned by the audit.

For the completed window `[2026-08-07, 2026-09-06)`, the implemented presence query processed 2,438,080 eligible live observations in **20.83 seconds**, with 32 MB work_mem and a 60-second audit timeout. Same-day identity evidence recovered 916,949 events; 1,521,129 remained unresolved. After repetition, privacy, and widespread-presence filtering, 48,267 person/channel memberships qualified from presence. These overlap message memberships; they are not 48,267 additional people.

The 0.25 weight, two-date/six-hour repetition rule, and 50-channel noise threshold are initial recipe choices, not empirically proven measures of viewer affinity. Versioning the recipe triggers a fresh build after deployment while retaining a valid previous snapshot during construction. The UI supports both snapshot versions and explains the actual recipe used.

A second aggregate-only comparison took **39.40 seconds** for the same window. It found 66,294 message memberships and **16,762 additional memberships** from presence, increasing qualifying channels from **1,125 to 1,193**. Combined pair contributions were 480,368, within the existing 10 million limit. This measures additional recorded coverage, not independent ground truth about communities.

Validation includes PostgreSQL integration tests for live/Finnish filtering, ambiguous same-day identity evidence, renames and recycled logins, repetition thresholds, partial snapshots, widespread presence, writer batching/retries, privacy exclusions, and actual threaded snapshot publication. Browser checks use synthetic lurker-only channels to verify participant counts, connection percentages, and the scrollable explanation on desktop and mobile. The standard nightly schedule and admin build control both execute the same versioned build path.


## Adaptive labels, outer ring, and category descriptions (v3)

Labels prioritize the selected channel, then the largest audiences. Hover highlights circles without changing label eligibility or priority. Selection includes connected channels' names. The label budget grows with zoom, text widths are measured using the rendered font, and collision checks run in screen-sized units. Label allocation and collision checks cover the whole graph before viewport clipping. At a fixed zoom, panning cannot promote a competing or lower-ranked name when another leaves the screen. Zoom, selection, search, and filters can change the allocation; offscreen labels reserve their places until those inputs change. Text and outlines stay the same screen size while zooming. The search panel can hide unconnected channels; selecting one from search still reveals it.

The outer ring represents channels that qualify for the map but share fewer than the snapshot's minimum shared people with any other qualifying channel. Top-10 edge pruning cannot itself isolate a channel: a channel with any qualifying candidate keeps at least its strongest connection. Lowering the v3 thresholds to 5 people/channel and 3 shared people admits smaller audiences while retaining the 3-message or two-date/six-hour presence requirements and source/privacy/noise filters. Gray ring positions are not distances or additional community evidence.

The nightly and admin builds also calculate each channel's leading category from recorded category durations in Finnish-eligible sessions during the same reporting window. Initial category observations and non-null category-change snapshots form time intervals; compact null metadata snapshots carry the preceding category forward, while explicit empty category IDs end known category time. Intervals are clipped to observed stream time and the reporting window. A channel is described only when category information covers at least half its observed streaming time. The graph stores only the leading category's ID, name, and fraction of known category time, and the final payload size limit is checked after enrichment.

Community descriptions give each channel one vote. A main category requires at least 60% of that channel's known category time. “Mostly [category]” requires at least 60% of channels with category information to share that main category; otherwise the description is “Mixed categories.” At least three channels and coverage of at least half the community are required. The panel shows counts for up to three leading categories, identifies channels that split time across categories, and discloses missing coverage. Mixed categories do not establish that every member is a variety streamer. Shared people determine membership; categories describe a pattern without claiming its cause. Descriptions are recomputed from visible channel nodes, so removed channels cannot remain in their counts.

A bounded read-only production category audit against the existing 1,193-channel snapshot produced 1,191 usable channel summaries in 5.83 seconds including SSH overhead. The observed eight-channel World of Warcraft group had eight main-category matches; other groups described Fortnite, Counter-Strike, Dota 2, and Old School RuneScape. These are data-derived descriptions, not manually assigned community labels. No individual viewer identities are involved in category calculation.

A subsequent aggregate-only threshold audit on refreshed data in the same window took 40.95 seconds. It found 1,196 channels under the old 10-person minimum and 1,676 under the new 5-person minimum. With 3 shared people per connection, 1,390 channels had a qualifying connection and 286 remained isolated. There were 32,862 candidate edges before top-10 pruning and 556,213 pair contributions, within the existing limits. These counts can change as recent identity lookups complete.


The v3 layout resolves circle collisions after ForceAtlas2 normalization using the same audience radius as the browser. A bounded spatial-grid pass moves smaller circles more than larger ones, followed by a residual uniform expansion. Unconnected channels receive enough ring circumference for their diameters and clear the connected layout. The browser fits the saved bounds and caps circle radii at 18 screen pixels, so zoom opens space between nodes. Labels use the displayed radius and remain constant in screen size.

Applying the spacing pass to the public 1,193-channel snapshot reduced 196 overlapping circle pairs to zero in approximately 150 ms, with a 1.000443 residual expansion. Browser validation of the titaanitv cluster confirmed neighbor labels and the 36-pixel diameter cap. Dense coincident-node and 500-isolate tests cover deterministic separation and ring spacing.


## Layout and hover revision (v4)

Unconnected channels are hidden by default and after Fit map; the initial camera fits connected channels. Search still finds unconnected channels, and disabling the checkbox or choosing No connections reveals the ring.

The layout uses 1,200 ForceAtlas2 iterations in LinLog mode, normal gravity at 0.5, scaling ratio 10, and Barnes-Hut repulsion. Strong gravity is explicitly disabled. The normalized bounding square grows with the sum of padded circle areas (12% target occupancy, minimum span 800), followed by the existing collision pass. This avoids compressing an increasingly large network into the same fixed square and then packing it into a disk. These parameters are visual choices; scores, edges, and detected communities are unchanged. Recipe versioning requests a fresh snapshot after deployment.

The [ForceAtlas2 paper](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0098679) describes LinLog as emphasizing community structure and strong gravity as producing compact layouts. On the public 1,676-channel / 7,626-edge graph, the final layout and spacing audit took 4.83 seconds and left zero circle overlaps. With identical area normalization, mean inter-community / intra-community edge length was 3.24 under LinLog versus 1.53 under linear attraction. This is a readability comparison, not evidence of more accurate communities.

Hover state updates from pointer movement or keyboard focus. The fixed hit circle alone receives pointer hits; decorative circles and labels do not. This removes feedback from mounting hover decoration and changing SVG hit targets. The reported flicker was not reproduced at the sampled pre-change boundaries; the revised browser checks confirmed stable labels during stationary hover, including after zoom.


Interaction regression checks cover fixed-zoom panning across budget and collision boundaries. Browser checks confirmed that pointer movement across multiple nodes leaves labels unchanged, circle selection preserves the viewBox, and dragging across text changes camera position without creating a text selection or selecting a channel. The canvas suppresses its full-screen focus outline while keeping keyboard pan/zoom and node focus styles; text selection is disabled only on the map canvas.
