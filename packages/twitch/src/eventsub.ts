import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EventSubEnvelope } from "./types.js";

export const eventSubHeaders = {
  messageId: "twitch-eventsub-message-id",
  messageTimestamp: "twitch-eventsub-message-timestamp",
  messageSignature: "twitch-eventsub-message-signature",
  messageType: "twitch-eventsub-message-type",
  subscriptionType: "twitch-eventsub-subscription-type",
  subscriptionVersion: "twitch-eventsub-subscription-version"
} as const;

export const verifyEventSubSignature = (input: {
  secret: string;
  messageId: string;
  messageTimestamp: string;
  rawBody: string;
  signature: string;
}): boolean => {
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.messageId + input.messageTimestamp + input.rawBody)
    .digest("hex")}`;

  const actualBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
};

export const createEventSubEnvelope = (headers: Headers, payload: unknown): EventSubEnvelope => {
  return {
    messageId: headers.get(eventSubHeaders.messageId),
    messageType: headers.get(eventSubHeaders.messageType),
    subscriptionType: headers.get(eventSubHeaders.subscriptionType),
    subscriptionVersion: headers.get(eventSubHeaders.subscriptionVersion),
    payload,
    receivedAt: new Date()
  };
};

const eventSubBaseUrl = "https://api.twitch.tv/helix/eventsub/subscriptions";

const eventSubSubscriptionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  type: z.string().min(1),
  version: z.string().min(1),
  cost: z.number().int().nonnegative().nullable().optional(),
  condition: z.record(z.string()),
  transport: z.object({
    method: z.string().min(1),
    callback: z.string().optional()
  }),
  created_at: z.string().min(1)
});

const eventSubSubscriptionsResponseSchema = z.object({
  data: z.array(eventSubSubscriptionSchema),
  total: z.number().int().nonnegative().optional(),
  total_cost: z.number().int().nonnegative().optional(),
  max_total_cost: z.number().int().nonnegative().optional(),
  pagination: z.object({
    cursor: z.string().optional()
  }).optional()
});

export type EventSubSubscription = {
  id: string;
  status: string;
  type: string;
  version: string;
  cost: number | null;
  condition: Record<string, string>;
  transport: {
    method: string;
    callback: string | null;
  };
  createdAt: Date;
};

export type EventSubSubscriptionsPage = {
  data: EventSubSubscription[];
  total: number;
  totalCost: number;
  maxTotalCost: number;
  cursor: string | null;
};

export class FetchEventSubAdapter {
  constructor(private readonly clientId: string) {}

  async listSubscriptions(input: {
    accessToken: string;
    after?: string;
  }): Promise<EventSubSubscriptionsPage> {
    const url = new URL(eventSubBaseUrl);
    if (input.after != null && input.after !== "") {
      url.searchParams.set("after", input.after);
    }

    const response = await fetch(url, {
      headers: this.headers(input.accessToken)
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Twitch EventSub list failed with HTTP ${response.status}.`);
    }

    return parseSubscriptionsPage(body);
  }

  async createWebhookSubscription(input: {
    accessToken: string;
    type: string;
    version: string;
    condition: Record<string, string>;
    callback: string;
    secret: string;
  }): Promise<EventSubSubscription> {
    const response = await fetch(eventSubBaseUrl, {
      method: "POST",
      headers: {
        ...this.headers(input.accessToken),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: input.type,
        version: input.version,
        condition: input.condition,
        transport: {
          method: "webhook",
          callback: input.callback,
          secret: input.secret
        }
      })
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Twitch EventSub create failed with HTTP ${response.status}.`);
    }

    const page = parseSubscriptionsPage(body);
    const subscription = page.data[0];
    if (subscription == null) {
      throw new Error("Twitch EventSub create response did not include a subscription.");
    }
    return subscription;
  }

  private headers(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": this.clientId
    };
  }
}

const parseSubscriptionsPage = (body: unknown): EventSubSubscriptionsPage => {
  const parsed = eventSubSubscriptionsResponseSchema.parse(body);
  return {
    data: parsed.data.map((subscription) => ({
      id: subscription.id,
      status: subscription.status,
      type: subscription.type,
      version: subscription.version,
      cost: subscription.cost ?? null,
      condition: subscription.condition,
      transport: {
        method: subscription.transport.method,
        callback: subscription.transport.callback ?? null
      },
      createdAt: new Date(subscription.created_at)
    })),
    total: parsed.total ?? parsed.data.length,
    totalCost: parsed.total_cost ?? 0,
    maxTotalCost: parsed.max_total_cost ?? 0,
    cursor: parsed.pagination?.cursor ?? null
  };
};

const readJsonResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text === "") {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
};
