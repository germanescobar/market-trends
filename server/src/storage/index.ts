export * from "./types.js";
export * from "./memory.js";
export * from "./postgres.js";

import type { Storage } from "./types.js";
import { InMemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";

/** Pick the appropriate store based on env. */
export function createStorage(): Storage {
  const url = process.env.DATABASE_URL;
  if (url && url.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[storage] using Postgres (${url.replace(/:[^:@]+@/, ":***@")})`);
    return new PostgresStore(url);
  }
  // eslint-disable-next-line no-console
  console.log("[storage] using in-memory store (data will not persist)");
  return new InMemoryStore();
}
