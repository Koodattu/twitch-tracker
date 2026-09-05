import "server-only";
import { cache } from "react";
import type { StreamSessionDetail } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";

export const getStreamSession = cache(async (streamId: string) => {
  return getApiData<StreamSessionDetail>(`/api/streams/${encodeURIComponent(streamId)}`, await getPublicApiInit());
});

export function getDetailPageNumber(value: string | undefined) {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1;
}
