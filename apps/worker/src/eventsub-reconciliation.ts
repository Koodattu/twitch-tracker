import type { EventSubSubscription } from "@twitch-tracker/twitch";

export type DesiredEventSubSubscription = {
  localId: string;
  twitchSubscriptionId: string | null;
  type: string;
  version: string;
  condition: Record<string, string>;
};

export type EventSubChannelCandidate = {
  twitchUserId: string;
  isManuallyPinned: boolean;
  lastSeenFinnishAt: Date | null;
};

export const selectDesiredEventSubChannelIds = (input: {
  candidates: EventSubChannelCandidate[];
  previousChannelIds: Array<string | null>;
  maxChannels: number;
  recentCutoff: Date;
}) => {
  const eligible = input.candidates.filter((channel) => (
    channel.isManuallyPinned
    || (channel.lastSeenFinnishAt != null && channel.lastSeenFinnishAt >= input.recentCutoff)
  ));
  const eligibleIds = new Set(eligible.map((channel) => channel.twitchUserId));
  const selected: string[] = [];
  const add = (twitchUserId: string | null) => {
    if (
      twitchUserId != null
      && eligibleIds.has(twitchUserId)
      && !selected.includes(twitchUserId)
      && selected.length < input.maxChannels
    ) {
      selected.push(twitchUserId);
    }
  };

  for (const channel of eligible) {
    if (channel.isManuallyPinned) {
      add(channel.twitchUserId);
    }
  }
  for (const twitchUserId of input.previousChannelIds) {
    add(twitchUserId);
  }
  for (const channel of eligible) {
    add(channel.twitchUserId);
  }
  return selected;
};

export const eventSubSubscriptionKey = (
  type: string,
  version: string,
  condition: Record<string, string>
) => {
  const normalizedCondition = Object.fromEntries(
    Object.entries(condition)
      .filter(([, value]) => value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return `${type}:${version}:${JSON.stringify(normalizedCondition)}`;
};

export const planEventSubReconciliation = (input: {
  desired: DesiredEventSubSubscription[];
  remote: EventSubSubscription[];
  callbackUrl: string;
  locallyOwnedRemoteIds: Set<string>;
}) => {
  const currentCallbackByKey = new Map<string, EventSubSubscription[]>();
  for (const subscription of input.remote) {
    if (subscription.transport.method !== "webhook" || subscription.transport.callback !== input.callbackUrl) {
      continue;
    }
    const key = eventSubSubscriptionKey(subscription.type, subscription.version, subscription.condition);
    const subscriptions = currentCallbackByKey.get(key) ?? [];
    subscriptions.push(subscription);
    currentCallbackByKey.set(key, subscriptions);
  }

  const matches: Array<{
    desired: DesiredEventSubSubscription;
    remote: EventSubSubscription;
  }> = [];
  const keptRemoteIds = new Set<string>();
  for (const desired of input.desired) {
    const key = eventSubSubscriptionKey(desired.type, desired.version, desired.condition);
    const candidates = currentCallbackByKey.get(key) ?? [];
    const preferred = candidates.find((candidate) => candidate.id === desired.twitchSubscriptionId)
      ?? [...candidates].sort(compareRemoteSubscriptions)[0];
    if (preferred == null) {
      continue;
    }
    keptRemoteIds.add(preferred.id);
    matches.push({ desired, remote: preferred });
  }

  const managed = input.remote.filter((subscription) => (
    subscription.transport.method === "webhook"
    && (subscription.transport.callback === input.callbackUrl || input.locallyOwnedRemoteIds.has(subscription.id))
  ));
  const stale = managed
    .filter((subscription) => !keptRemoteIds.has(subscription.id))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  return {
    matches,
    missing: input.desired.filter((desired) => !matches.some((match) => match.desired.localId === desired.localId)),
    stale,
    unmanagedRemoteSubscriptions: input.remote.length - managed.length
  };
};

export const hasEquivalentEventSubSubscription = (
  desired: DesiredEventSubSubscription,
  remote: EventSubSubscription[]
) => {
  const desiredKey = eventSubSubscriptionKey(desired.type, desired.version, desired.condition);
  return remote.some((subscription) => (
    eventSubSubscriptionKey(subscription.type, subscription.version, subscription.condition) === desiredKey
  ));
};

const compareRemoteSubscriptions = (left: EventSubSubscription, right: EventSubSubscription) => {
  if (left.status === "enabled" && right.status !== "enabled") {
    return -1;
  }
  if (right.status === "enabled" && left.status !== "enabled") {
    return 1;
  }
  return left.createdAt.getTime() - right.createdAt.getTime();
};
