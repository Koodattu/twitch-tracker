export type TwitchRateLimitHeaders = {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  raw: Record<string, string>;
};

export type RawTwitchResponse<T> = {
  endpoint: string;
  requestParams: Record<string, unknown>;
  statusCode: number;
  responseJson: T;
  pagination: Record<string, unknown>;
  rateLimit: TwitchRateLimitHeaders;
  observedAt: Date;
};

export type HelixStream = {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tag_ids?: string[];
  tags?: string[];
  is_mature?: boolean;
};

export type HelixUser = {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  created_at: string;
};

export type HelixStreamsResponse = {
  data: HelixStream[];
  pagination?: {
    cursor?: string;
  };
};

export type HelixUsersResponse = {
  data: HelixUser[];
};

export type TwitchRestAdapter = {
  getLiveStreamsByLanguage(input: {
    language: string;
    first?: number;
    after?: string;
    accessToken: string;
  }): Promise<RawTwitchResponse<HelixStreamsResponse>>;
  getUsers(input: {
    ids?: string[];
    logins?: string[];
    accessToken: string;
  }): Promise<RawTwitchResponse<HelixUsersResponse>>;
};

export type ParsedIrcMessage = {
  rawLine: string;
  tags: Record<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
  trailing: string | null;
};

export type IrcConnectionEvents = {
  rawMessage(message: ParsedIrcMessage): Promise<void> | void;
  connected?(): Promise<void> | void;
  disconnected?(reason: string): Promise<void> | void;
  error?(error: Error): Promise<void> | void;
};

export type TwitchIrcAdapter = {
  connect(): Promise<void>;
  join(channelLogin: string): Promise<void>;
  part(channelLogin: string): Promise<void>;
  disconnect(reason: string): Promise<void>;
};

export type EventSubEnvelope = {
  messageId: string | null;
  messageType: string | null;
  subscriptionType: string | null;
  subscriptionVersion: string | null;
  payload: unknown;
  receivedAt: Date;
};
