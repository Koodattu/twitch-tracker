import { z } from "zod";

const twitchAuthBaseUrl = "https://id.twitch.tv/oauth2";

const twitchTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.array(z.string()).default([]),
  token_type: z.string().min(1)
});

const twitchTokenValidationSchema = z.object({
  client_id: z.string().min(1),
  login: z.string().nullable(),
  scopes: z.array(z.string()).default([]),
  user_id: z.string().nullable(),
  expires_in: z.number().int().nonnegative()
});

export type TwitchUserToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
  tokenType: string;
};

export type TwitchTokenValidation = {
  clientId: string;
  login: string | null;
  scopes: string[];
  userId: string | null;
  expiresInSeconds: number;
};

export type TwitchAppToken = {
  accessToken: string;
  expiresInSeconds: number;
  tokenType: string;
};

export class TwitchAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody: unknown
  ) {
    super(message);
    this.name = "TwitchAuthError";
  }
}

export const exchangeTwitchAuthorizationCode = async (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TwitchUserToken> => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });

  const response = await fetch(`${twitchAuthBaseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new TwitchAuthError("Twitch token exchange failed.", response.status, responseBody);
  }

  const token = twitchTokenResponseSchema.parse(responseBody);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresInSeconds: token.expires_in,
    scopes: token.scope,
    tokenType: token.token_type
  };
};

export const getTwitchAppAccessToken = async (input: {
  clientId: string;
  clientSecret: string;
}): Promise<TwitchAppToken> => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "client_credentials"
  });

  const response = await fetch(`${twitchAuthBaseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new TwitchAuthError("Twitch app token request failed.", response.status, responseBody);
  }

  const token = twitchTokenResponseSchema.parse(responseBody);
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in,
    tokenType: token.token_type
  };
};

export const validateTwitchAccessToken = async (accessToken: string): Promise<TwitchTokenValidation> => {
  const response = await fetch(`${twitchAuthBaseUrl}/validate`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new TwitchAuthError("Twitch token validation failed.", response.status, responseBody);
  }

  const validation = twitchTokenValidationSchema.parse(responseBody);
  return {
    clientId: validation.client_id,
    login: validation.login,
    scopes: validation.scopes,
    userId: validation.user_id,
    expiresInSeconds: validation.expires_in
  };
};

export const refreshTwitchUserAccessToken = async (input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TwitchUserToken> => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken
  });

  const response = await fetch(`${twitchAuthBaseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new TwitchAuthError("Twitch token refresh failed.", response.status, responseBody);
  }

  const token = twitchTokenResponseSchema.parse(responseBody);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresInSeconds: token.expires_in,
    scopes: token.scope,
    tokenType: token.token_type
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
