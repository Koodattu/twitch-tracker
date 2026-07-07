import type { HelixStreamsResponse, HelixUsersResponse, RawTwitchResponse, TwitchRateLimitHeaders, TwitchRestAdapter } from "./types.js";

const helixBaseUrl = "https://api.twitch.tv/helix";

const readRateLimitHeaders = (headers: Headers): TwitchRateLimitHeaders => {
  const raw = Object.fromEntries(headers.entries());
  const limit = headers.get("ratelimit-limit");
  const remaining = headers.get("ratelimit-remaining");
  const reset = headers.get("ratelimit-reset");

  return {
    limit: limit == null ? null : Number(limit),
    remaining: remaining == null ? null : Number(remaining),
    resetAt: reset == null ? null : new Date(Number(reset) * 1000),
    raw
  };
};

const callHelix = async <T>(input: {
  endpoint: string;
  params: URLSearchParams;
  clientId: string;
  accessToken: string;
}): Promise<RawTwitchResponse<T>> => {
  const url = `${helixBaseUrl}${input.endpoint}?${input.params.toString()}`;
  const observedAt = new Date();
  const response = await fetch(url, {
    headers: {
      "Client-Id": input.clientId,
      Authorization: `Bearer ${input.accessToken}`
    }
  });
  const responseJson = (await response.json()) as T;

  return {
    endpoint: input.endpoint,
    requestParams: Object.fromEntries(input.params.entries()),
    statusCode: response.status,
    responseJson,
    pagination: typeof responseJson === "object" && responseJson != null && "pagination" in responseJson
      ? (responseJson as { pagination?: Record<string, unknown> }).pagination ?? {}
      : {},
    rateLimit: readRateLimitHeaders(response.headers),
    observedAt
  };
};

export class FetchHelixAdapter implements TwitchRestAdapter {
  constructor(private readonly clientId: string) {}

  async getLiveStreamsByLanguage(input: {
    language: string;
    first?: number;
    after?: string;
    accessToken: string;
  }): Promise<RawTwitchResponse<HelixStreamsResponse>> {
    const params = new URLSearchParams({
      language: input.language,
      first: String(input.first ?? 100)
    });
    if (input.after != null && input.after !== "") {
      params.set("after", input.after);
    }

    return callHelix<HelixStreamsResponse>({
      endpoint: "/streams",
      params,
      clientId: this.clientId,
      accessToken: input.accessToken
    });
  }

  async getUsers(input: {
    ids?: string[];
    logins?: string[];
    accessToken: string;
  }): Promise<RawTwitchResponse<HelixUsersResponse>> {
    const params = new URLSearchParams();
    for (const id of input.ids ?? []) {
      params.append("id", id);
    }
    for (const login of input.logins ?? []) {
      params.append("login", login);
    }

    return callHelix<HelixUsersResponse>({
      endpoint: "/users",
      params,
      clientId: this.clientId,
      accessToken: input.accessToken
    });
  }
}

export class DisabledHelixAdapter implements TwitchRestAdapter {
  async getLiveStreamsByLanguage(): Promise<RawTwitchResponse<HelixStreamsResponse>> {
    return {
      endpoint: "/streams",
      requestParams: { disabled: true },
      statusCode: 0,
      responseJson: { data: [] },
      pagination: {},
      rateLimit: { limit: null, remaining: null, resetAt: null, raw: {} },
      observedAt: new Date()
    };
  }

  async getUsers(): Promise<RawTwitchResponse<HelixUsersResponse>> {
    return {
      endpoint: "/users",
      requestParams: { disabled: true },
      statusCode: 0,
      responseJson: { data: [] },
      pagination: {},
      rateLimit: { limit: null, remaining: null, resetAt: null, raw: {} },
      observedAt: new Date()
    };
  }
}
