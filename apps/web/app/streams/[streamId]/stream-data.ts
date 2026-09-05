import "server-only";
import { cache } from "react";
import type { StreamSessionDetail } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";

export const getStreamSession = cache(async (streamId: string) => {
  return getApiData<StreamSessionDetail>(`/api/streams/${encodeURIComponent(streamId)}`, await getPublicApiInit());
});

export { getDetailPageNumber } from "../../api-client";
