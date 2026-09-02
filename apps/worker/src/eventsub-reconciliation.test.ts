import type { EventSubSubscription } from "@twitch-tracker/twitch";
import { describe, expect, it } from "vitest";
import {
  eventSubSubscriptionKey,
  hasEquivalentEventSubSubscription,
  planEventSubReconciliation,
  selectDesiredEventSubChannelIds,
  type DesiredEventSubSubscription
} from "./eventsub-reconciliation.js";

const callbackUrl = "https://example.com/api/webhooks/twitch/eventsub";
const desired: DesiredEventSubSubscription = {
  localId: "local-1",
  twitchSubscriptionId: "preferred",
  type: "channel.raid",
  version: "1",
  condition: { to_broadcaster_user_id: "123" }
};

const remote = (input: Partial<EventSubSubscription> & Pick<EventSubSubscription, "id">): EventSubSubscription => ({
  id: input.id,
  status: input.status ?? "enabled",
  type: input.type ?? desired.type,
  version: input.version ?? desired.version,
  cost: input.cost ?? 1,
  condition: input.condition ?? desired.condition,
  transport: input.transport ?? { method: "webhook", callback: callbackUrl },
  createdAt: input.createdAt ?? new Date("2026-09-02T12:00:00.000Z")
});

describe("EventSub desired channel selection", () => {
  const recent = new Date("2026-09-02T12:00:00.000Z");
  const old = new Date("2026-07-01T12:00:00.000Z");
  const recentCutoff = new Date("2026-08-03T12:00:00.000Z");

  it("keeps the eligible prior cohort stable ahead of newly seen channels", () => {
    expect(selectDesiredEventSubChannelIds({
      candidates: [
        { twitchUserId: "new", isManuallyPinned: false, lastSeenFinnishAt: recent },
        { twitchUserId: "existing", isManuallyPinned: false, lastSeenFinnishAt: recent }
      ],
      previousChannelIds: ["existing"],
      maxChannels: 1,
      recentCutoff
    })).toEqual(["existing"]);
  });

  it("prioritizes manual pins and excludes stale or ineligible prior channels", () => {
    expect(selectDesiredEventSubChannelIds({
      candidates: [
        { twitchUserId: "manual", isManuallyPinned: true, lastSeenFinnishAt: old },
        { twitchUserId: "recent", isManuallyPinned: false, lastSeenFinnishAt: recent },
        { twitchUserId: "stale", isManuallyPinned: false, lastSeenFinnishAt: old }
      ],
      previousChannelIds: ["stale", "recent"],
      maxChannels: 2,
      recentCutoff
    })).toEqual(["manual", "recent"]);
  });
});

describe("EventSub reconciliation planning", () => {
  it("normalizes empty condition fields added by Twitch", () => {
    expect(eventSubSubscriptionKey("channel.raid", "1", {
      from_broadcaster_user_id: "",
      to_broadcaster_user_id: "123"
    })).toBe(eventSubSubscriptionKey(desired.type, desired.version, desired.condition));
    expect(hasEquivalentEventSubSubscription(desired, [remote({
      id: "remote-1",
      condition: { from_broadcaster_user_id: "", to_broadcaster_user_id: "123" }
    })])).toBe(true);
  });

  it("keeps one preferred match and retires duplicates and obsolete owned subscriptions", () => {
    const duplicate = remote({ id: "duplicate" });
    const preferred = remote({ id: "preferred", createdAt: new Date("2026-09-02T12:01:00.000Z") });
    const obsolete = remote({ id: "obsolete", type: "stream.online" });
    const foreign = remote({
      id: "foreign",
      type: "stream.offline",
      transport: { method: "webhook", callback: "https://other.example/webhook" }
    });

    const plan = planEventSubReconciliation({
      desired: [desired],
      remote: [duplicate, preferred, obsolete, foreign],
      callbackUrl,
      locallyOwnedRemoteIds: new Set(["obsolete"])
    });

    expect(plan.matches.map((match) => match.remote.id)).toEqual(["preferred"]);
    expect(plan.stale.map((subscription) => subscription.id)).toEqual(["duplicate", "obsolete"]);
    expect(plan.unmanagedRemoteSubscriptions).toBe(1);
  });
});
