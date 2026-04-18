/**
 * scripts/setup-airbnb-comp-signal-view.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Idempotently apply the airbnb_comp_signal SQL view to the local database.
 *
 * Local-only Phase 2c setup helper. Reads the view definition from
 * lib/db/src/views/airbnb_comp_signal.sql and runs CREATE OR REPLACE VIEW
 * against the configured DATABASE_URL. No schema mutation — views are
 * read-only projections over existing source tables.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/setup-airbnb-comp-signal-view.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, "../../lib/db/src/views/airbnb_comp_signal.sql");

async function main(): Promise<void> {
  const ddl = readFileSync(sqlPath, "utf8");
  console.log(`Applying view from ${sqlPath} (${ddl.length} bytes)…`);

  // Drizzle's `db.execute(sql.raw(...))` runs the entire string as one
  // multi-statement command via node-postgres' simple-query path, which
  // is exactly what we need for `CREATE OR REPLACE VIEW … ; COMMENT ON …`.
  await db.execute(sql.raw(ddl));

  // Sanity-check: count rows so we know the view actually resolves.
  const res = await db.execute(
    sql.raw("SELECT COUNT(*)::int AS n FROM airbnb_comp_signal")
  );
  const rows = res as unknown as { rows: Array<{ n: number }> };
  const n = rows.rows?.[0]?.n ?? 0;
  console.log(`✓ View airbnb_comp_signal applied. Total Airbnb rows: ${n}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("setup-airbnb-comp-signal-view failed:", err);
    process.exit(1);
  });
