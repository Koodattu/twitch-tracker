import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbClient } from "./index.js";
import { streamSessions } from "./schema.js";

export const closeSupersededLiveStreamSessions = async (
  db: DbClient,
  input: {
    broadcasterUserId: string;
    currentStreamId: string;
    observedAt: Date;
    source: string;
  }
) => {
  await db
    .update(streamSessions)
    .set({
      endedAt: input.observedAt,
      endDetectionSource: input.source,
      updatedAt: input.observedAt
    })
    .where(and(
      eq(streamSessions.broadcasterUserId, input.broadcasterUserId),
      ne(streamSessions.twitchStreamId, input.currentStreamId),
      isNull(streamSessions.endedAt)
    ));
};
