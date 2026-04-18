/**
 * ingest/discovery-queue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Queue manager for the discovery_jobs table (Phase 2a).
 *
 * - insertSeeds()       — bulk insert with ON CONFLICT DO NOTHING (partial unique
 *                         index on (source, job_type, neighborhood, guest, stay,
 *                         bedroom, window) WHERE status IN ('pending','in_progress')
 *                         protects against duplicate active seeds across re-runs).
 * - claimNext()         — atomic FOR UPDATE SKIP LOCKED claim of the highest-
 *                         priority pending job, optionally filtered by source/region.
 * - markComplete()      — close out a job with discovered/new counts + termination reason.
 * - markFailed()        — mark a job failed with error_message; bumps attempts.
 * - saveCursor()        — persist adapter-specific resume state.
 * - resumePending()     — list (or count) pending jobs, useful for diagnostics.
 *
 * No live-scraper coupling — Phase 2b plugs adapters into claimNext()/markComplete().
 */

import { db } from "@workspace/db";
import { discoveryJobsTable, type InsertDiscoveryJob, type DiscoveryJob } from "@workspace/db/schema";
import { sql, and, eq, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// insertSeeds
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertSeedsResult {
  attempted: number;
  inserted: number;
  skipped: number;
}

/**
 * Bulk insert seed rows. Conflicts on the partial unique index (an active
 * pending/in_progress job already exists for the same permutation) are silently
 * skipped — making the call idempotent across re-runs.
 *
 * Inserts in chunks of 500 to keep parameter counts under Postgres' limit.
 */
export async function insertSeeds(
  rows: InsertDiscoveryJob[]
): Promise<InsertSeedsResult> {
  if (rows.length === 0) return { attempted: 0, inserted: 0, skipped: 0 };

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await db
      .insert(discoveryJobsTable)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: discoveryJobsTable.id });
    inserted += result.length;
  }
  return {
    attempted: rows.length,
    inserted,
    skipped: rows.length - inserted,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// claimNext  —  atomic FOR UPDATE SKIP LOCKED
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimFilter {
  source?: string;
  parentRegion?: "puerto_vallarta" | "riviera_nayarit";
  jobType?: string;
}

/**
 * Atomically claim the highest-priority pending job. Returns the row, or null
 * if the queue is empty for the given filter.
 *
 * Implementation: a single CTE + UPDATE ... RETURNING using FOR UPDATE
 * SKIP LOCKED so concurrent runners never claim the same row.
 */
export async function claimNext(
  filter: ClaimFilter = {}
): Promise<DiscoveryJob | null> {
  const conds: string[] = ["status = 'pending'"];
  const params: unknown[] = [];
  if (filter.source) {
    params.push(filter.source);
    conds.push(`source = $${params.length}`);
  }
  if (filter.parentRegion) {
    params.push(filter.parentRegion);
    conds.push(`parent_region_bucket = $${params.length}`);
  }
  if (filter.jobType) {
    params.push(filter.jobType);
    conds.push(`job_type = $${params.length}`);
  }
  const where = conds.join(" AND ");

  const query = sql.raw(`
    WITH next AS (
      SELECT id FROM discovery_jobs
      WHERE ${where}
      ORDER BY priority DESC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE discovery_jobs dj
    SET status = 'in_progress',
        started_at = COALESCE(dj.started_at, NOW()),
        last_run_at = NOW(),
        attempts = dj.attempts + 1,
        updated_at = NOW()
    FROM next
    WHERE dj.id = next.id
    RETURNING dj.*;
  `);

  // drizzle-orm raw queries don't bind param arrays, so we re-issue with execute
  // using parameterised SQL via sql template tag.
  const result = await db.execute(buildClaimSql(filter));
  const rows = (result as unknown as { rows: unknown[] }).rows ?? (result as unknown as unknown[]);
  if (!rows || (rows as unknown[]).length === 0) return null;
  return rowsToCamel(rows as Record<string, unknown>[])[0];
}

function buildClaimSql(filter: ClaimFilter) {
  const parts: ReturnType<typeof sql>[] = [
    sql`WITH next AS (SELECT id FROM discovery_jobs WHERE status = 'pending'`,
  ];
  if (filter.source) parts.push(sql` AND source = ${filter.source}`);
  if (filter.parentRegion)
    parts.push(sql` AND parent_region_bucket = ${filter.parentRegion}`);
  if (filter.jobType) parts.push(sql` AND job_type = ${filter.jobType}`);
  parts.push(
    sql` ORDER BY priority DESC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE discovery_jobs dj
    SET status = 'in_progress',
        started_at = COALESCE(dj.started_at, NOW()),
        last_run_at = NOW(),
        attempts = dj.attempts + 1,
        updated_at = NOW()
    FROM next WHERE dj.id = next.id RETURNING dj.*`
  );
  return sql.join(parts, sql``);
}

/** snake_case → camelCase column mapping for the discovery_jobs row shape. */
function rowsToCamel(rows: Record<string, unknown>[]): DiscoveryJob[] {
  return rows.map((r) => ({
    id: r.id as number,
    source: r.source as string,
    jobType: r.job_type as string,
    parentRegionBucket: (r.parent_region_bucket ?? null) as string | null,
    normalizedNeighborhoodBucket: (r.normalized_neighborhood_bucket ?? null) as string | null,
    guestCount: (r.guest_count ?? null) as number | null,
    stayLengthNights: (r.stay_length_nights ?? null) as number | null,
    bedroomBucket: (r.bedroom_bucket ?? null) as string | null,
    checkinWindow: (r.checkin_window ?? null) as string | null,
    status: r.status as string,
    attempts: r.attempts as number,
    discoveredCount: r.discovered_count as number,
    newCount: r.new_count as number,
    startedAt: r.started_at ? new Date(r.started_at as string) : null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at as string) : null,
    errorMessage: (r.error_message ?? null) as string | null,
    terminationReason: (r.termination_reason ?? null) as string | null,
    cursorState: (r.cursor_state ?? null) as unknown,
    priority: r.priority as number,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// markComplete / markFailed / saveCursor
// ─────────────────────────────────────────────────────────────────────────────

export interface CompleteResult {
  discoveredCount: number;
  newCount: number;
  terminationReason:
    | "exhausted"
    | "manual_cap"
    | "timeout"
    | "blocked"
    | "parse_fail"
    | "duplicate_only";
}

export async function markComplete(
  jobId: number,
  result: CompleteResult
): Promise<void> {
  await db
    .update(discoveryJobsTable)
    .set({
      status: "complete",
      completedAt: new Date(),
      lastRunAt: new Date(),
      updatedAt: new Date(),
      discoveredCount: result.discoveredCount,
      newCount: result.newCount,
      terminationReason: result.terminationReason,
      errorMessage: null,
    })
    .where(eq(discoveryJobsTable.id, jobId));
}

export async function markFailed(
  jobId: number,
  errorMessage: string,
  terminationReason: string = "parse_fail"
): Promise<void> {
  await db
    .update(discoveryJobsTable)
    .set({
      status: "failed",
      completedAt: new Date(),
      lastRunAt: new Date(),
      updatedAt: new Date(),
      errorMessage: errorMessage.slice(0, 1000),
      terminationReason,
    })
    .where(eq(discoveryJobsTable.id, jobId));
}

export async function saveCursor(
  jobId: number,
  cursor: unknown
): Promise<void> {
  await db
    .update(discoveryJobsTable)
    .set({
      cursorState: cursor,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(discoveryJobsTable.id, jobId));
}

// ─────────────────────────────────────────────────────────────────────────────
// resumePending  —  diagnostics + Phase 2b's runner entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeFilter extends ClaimFilter {
  limit?: number;
}

export interface PendingSummary {
  total: number;
  byStatus: Record<string, number>;
  bySourceRegion: Array<{
    source: string;
    parentRegionBucket: string | null;
    pending: number;
  }>;
  topPending: DiscoveryJob[];
}

export async function summarizePending(
  filter: ResumeFilter = {}
): Promise<PendingSummary> {
  const totalRow = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM discovery_jobs`
  );
  const byStatusRow = await db.execute(
    sql`SELECT status, COUNT(*)::int AS n FROM discovery_jobs GROUP BY status`
  );
  const breakdown = await db.execute(
    sql`SELECT source, parent_region_bucket, COUNT(*)::int AS pending
        FROM discovery_jobs
        WHERE status = 'pending'
        GROUP BY source, parent_region_bucket
        ORDER BY pending DESC`
  );

  const conds = [eq(discoveryJobsTable.status, "pending")];
  if (filter.source) conds.push(eq(discoveryJobsTable.source, filter.source));
  if (filter.parentRegion)
    conds.push(eq(discoveryJobsTable.parentRegionBucket, filter.parentRegion));
  if (filter.jobType) conds.push(eq(discoveryJobsTable.jobType, filter.jobType));

  const top = await db
    .select()
    .from(discoveryJobsTable)
    .where(and(...conds))
    .orderBy(sql`priority DESC, id ASC`)
    .limit(filter.limit ?? 10);

  const totalRows = ((totalRow as unknown as { rows?: { n: number }[] }).rows ?? (totalRow as unknown as { n: number }[]));
  const byStatusRows = ((byStatusRow as unknown as { rows?: { status: string; n: number }[] }).rows ?? (byStatusRow as unknown as { status: string; n: number }[]));
  const breakdownRows = ((breakdown as unknown as { rows?: { source: string; parent_region_bucket: string | null; pending: number }[] }).rows ?? (breakdown as unknown as { source: string; parent_region_bucket: string | null; pending: number }[]));

  const byStatus: Record<string, number> = {};
  for (const r of byStatusRows) byStatus[r.status] = Number(r.n);

  return {
    total: Number(totalRows[0]?.n ?? 0),
    byStatus,
    bySourceRegion: breakdownRows.map((r) => ({
      source: r.source,
      parentRegionBucket: r.parent_region_bucket,
      pending: Number(r.pending),
    })),
    topPending: top,
  };
}

/**
 * Reset 'in_progress' jobs older than `staleAfterMs` back to 'pending'.
 * Used by the runner on startup so a crashed previous run doesn't leave jobs
 * permanently stuck.
 */
export async function reclaimStaleInProgress(
  staleAfterMs: number = 30 * 60 * 1000
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await db
    .update(discoveryJobsTable)
    .set({
      status: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(discoveryJobsTable.status, "in_progress"),
        sql`(${discoveryJobsTable.lastRunAt} IS NULL OR ${discoveryJobsTable.lastRunAt} < ${cutoff})`
      )
    )
    .returning({ id: discoveryJobsTable.id });
  return result.length;
}
