import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";

export const createPgPool = (connectionString: string): pg.Pool => {
  return new pg.Pool({ connectionString });
};

export const createDb = (connectionString: string) => {
  const pool = createPgPool(connectionString);
  return {
    pool,
    db: drizzle(pool, { schema })
  };
};

export type DbClient = ReturnType<typeof createDb>["db"];
