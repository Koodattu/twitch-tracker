import { streamSnapshots } from "@twitch-tracker/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const detailPageNumberSchema = z.coerce.number().int().min(1).max(100_000).default(1);
export const detailPageSize = 50;

export function detailPage<T>(items: T[], page: number) {
  return { items: items.slice(0, detailPageSize), page, hasMore: items.length > detailPageSize };
}

export const viewerObservationFields = {
  id: streamSnapshots.id, observedAt: streamSnapshots.observedAt, viewerCount: streamSnapshots.viewerCount,
  title: sql<string | null>`coalesce(${streamSnapshots.title}, (select metadata.title from stream_snapshots metadata
    where metadata.twitch_stream_id = stream_snapshots.twitch_stream_id and metadata.title is not null
      and metadata.observed_at <= stream_snapshots.observed_at order by metadata.observed_at desc, metadata.id desc limit 1))`,
  categoryName: sql<string | null>`coalesce(${streamSnapshots.categoryName}, (select metadata.category_name from stream_snapshots metadata
    where metadata.twitch_stream_id = stream_snapshots.twitch_stream_id and metadata.title is not null
      and metadata.observed_at <= stream_snapshots.observed_at order by metadata.observed_at desc, metadata.id desc limit 1))`
};
