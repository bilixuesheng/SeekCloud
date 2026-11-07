import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export function runMigrations(db: Database): Promise<void> {
  return migrate(db, { migrationsFolder });
}
