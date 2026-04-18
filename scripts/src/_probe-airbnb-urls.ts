import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // First: list actual columns
  const cols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rental_listings'
    ORDER BY ordinal_position`);
  const present = new Set((cols.rows ?? []).map((r: any) => r.column_name));
  console.log("=== local rental_listings columns ===");
  console.log([...present].join(", "));

  // Detect which column identifies an Airbnb listing
  const sourceCol = ["source", "provider", "listing_source", "data_source"].find((c) => present.has(c));
  const idCol = ["source_listing_id", "external_id", "platform_id"].find((c) => present.has(c));
  const urlCol = ["source_url", "listing_url", "url"].find((c) => present.has(c));
  const identityCol = present.has("identity_key") ? "identity_key" : null;
  console.log(`\nDetected: source=${sourceCol} id=${idCol} url=${urlCol} identity=${identityCol}`);

  // Look at distinct sources
  if (sourceCol) {
    const r = await db.execute(sql.raw(`SELECT ${sourceCol} AS s, COUNT(*)::int AS c FROM rental_listings GROUP BY 1 ORDER BY 2 DESC`));
    console.log("\nrows by source:");
    for (const row of r.rows ?? []) console.log(" ", row);
  } else if (identityCol) {
    const r = await db.execute(sql.raw(`SELECT split_part(${identityCol}, ':', 1) AS s, COUNT(*)::int AS c FROM rental_listings GROUP BY 1 ORDER BY 2 DESC`));
    console.log("\nrows by identity_key prefix:");
    for (const row of r.rows ?? []) console.log(" ", row);
  }

  // Pull airbnb sample
  const filter = sourceCol
    ? sql.raw(`${sourceCol} = 'airbnb'`)
    : identityCol
    ? sql.raw(`${identityCol} LIKE 'airbnb:%'`)
    : sql`1=1`;
  const urlExpr = urlCol ?? "NULL";
  const r2 = await db.execute(sql.raw(`
    SELECT id, ${idCol ?? "NULL AS source_listing_id"}, ${urlExpr} AS url, title, bedrooms, max_guests, last_seen_at
    FROM rental_listings
    WHERE ${(filter as any).queryChunks?.[0]?.value ?? `${sourceCol ?? identityCol} IS NOT NULL`}
      ${urlCol ? `AND ${urlCol} IS NOT NULL` : ""}
    ORDER BY id
    LIMIT 200`));
  const rows = r2.rows ?? [];
  console.log(`\nairbnb listings with URL: ${rows.length}`);
  const step = Math.max(1, Math.floor(rows.length / 12));
  console.log("\n=== Sample 12 (spread across id range) ===");
  for (let i = 0; i < rows.length && i < step * 12; i += step) {
    const row: any = rows[i];
    console.log(`  id=${row.id} src_id=${row.source_listing_id} br=${row.bedrooms ?? "—"} guests=${row.max_guests ?? "—"} url=${row.url}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
