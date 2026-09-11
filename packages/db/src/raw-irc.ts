import { inArray, sql } from "drizzle-orm";
import type { DbClient } from "./index.js";
import { rawIrcMessages } from "./schema.js";

export const rawIrcLineSql = sql<string | null>`read_raw_irc_line(
  ${rawIrcMessages.rawLine}, ${rawIrcMessages.payloadBlockId}, ${rawIrcMessages.payloadPosition}
)`;

export const readRawIrcLines = async (db: DbClient, ids: string[]): Promise<Map<string, string>> => {
  if (ids.length === 0) return new Map();
  const { rows } = await db.execute<{ id: string; line: string | null }>(sql`
    with selected as materialized (
      select id, raw_line, payload_block_id, payload_position from raw_irc_messages
      where ${inArray(rawIrcMessages.id, [...new Set(ids)])}
    ), expanded as materialized (
      select b.id, wire_line, slot from raw_irc_payload_blocks b
      join (select distinct payload_block_id from selected where payload_block_id is not null) needed
        on needed.payload_block_id = b.id
      cross join lateral unnest(b.lines) with ordinality as payload(wire_line, slot)
    )
    select r.id, case when r.payload_block_id is null then r.raw_line else expanded.wire_line end as line
    from selected r left join expanded
      on expanded.id = r.payload_block_id and expanded.slot = r.payload_position
  `);
  return new Map(rows.map((row) => {
    if (row.line == null) throw new Error("Missing archived IRC payload.");
    return [row.id, row.line];
  }));
};
