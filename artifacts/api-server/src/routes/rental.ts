import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { rentalMarketMetricsTable } from "@workspace/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import { GetRentalMarketMetricsQueryParams, GetRentalMarketMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/rental-market", async (req, res) => {
  const parsed = GetRentalMarketMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year, month, neighborhood } = parsed.data;

  try {
    const conditions = [];
    if (year) conditions.push(eq(rentalMarketMetricsTable.year, year));
    if (month) conditions.push(eq(rentalMarketMetricsTable.month, month));
    if (neighborhood) conditions.push(eq(rentalMarketMetricsTable.neighborhood, neighborhood));

    const rows = await db
      .select()
      .from(rentalMarketMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(rentalMarketMetricsTable.year), asc(rentalMarketMetricsTable.month));

    const data = GetRentalMarketMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        avgNightlyRateUsd: Number(r.avgNightlyRateUsd),
        medianNightlyRateUsd: r.medianNightlyRateUsd ? Number(r.medianNightlyRateUsd) : undefined,
        occupancyRate: Number(r.occupancyRate),
        avgReviewScore: r.avgReviewScore ? Number(r.avgReviewScore) : undefined,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch rental market metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Live rental-market dashboard: every metric computed on-demand from
 * `rental_prices_by_date` (joined to `rental_listings` for neighborhood
 * segmentation, and to `airport_metrics` for tourism YoY).
 *
 * NO hardcoded values. NO pre-aggregated table reads.
 *
 * Window definitions (forward-looking, since `rental_prices_by_date` is a
 * forward-snapshot table — past dates are frozen at their last-seen state
 * and almost universally show as booked, which makes backward windows
 * statistically meaningless):
 *   recent_window = stay-dates in [TODAY,        TODAY + 30d)  — near-term demand
 *   prior_window  = stay-dates in [TODAY + 30d,  TODAY + 60d)  — mid-term baseline
 *
 * Trend label semantics:
 *   recent availability < prior  → demand increasing (booking acceleration)
 *   recent availability > prior  → demand decreasing
 */
router.get("/metrics/rental-market-live", async (req, res) => {
  try {
    const [aggRows, neighborhoodRows, tourismRows, sourceRows, bedBathRows] = await Promise.all([
      db.execute(sql`
        WITH recent_window AS (
          SELECT listing_id, nightly_price_usd, availability_status
          FROM rental_prices_by_date
          WHERE date >= CURRENT_DATE
            AND date <  CURRENT_DATE + INTERVAL '30 days'
        ),
        prior_window AS (
          SELECT listing_id, nightly_price_usd, availability_status
          FROM rental_prices_by_date
          WHERE date >= CURRENT_DATE + INTERVAL '30 days'
            AND date <  CURRENT_DATE + INTERVAL '60 days'
        ),
        recent_agg AS (
          SELECT
            COUNT(*)::bigint                                                                  AS total_rows,
            COUNT(*) FILTER (WHERE availability_status = 'available')::bigint                 AS available_rows,
            COUNT(DISTINCT listing_id)::bigint                                                AS distinct_listings,
            AVG(nightly_price_usd)                                                            AS avg_price,
            COUNT(DISTINCT listing_id) FILTER (WHERE nightly_price_usd IS NOT NULL)::bigint   AS listings_with_price
          FROM recent_window
        ),
        prior_agg AS (
          SELECT
            COUNT(*)::bigint                                                                  AS total_rows,
            COUNT(*) FILTER (WHERE availability_status = 'available')::bigint                 AS available_rows,
            AVG(nightly_price_usd)                                                            AS avg_price
          FROM prior_window
        ),
        cohort_total AS (
          SELECT COUNT(DISTINCT listing_id)::bigint AS distinct_listings
          FROM rental_prices_by_date
          WHERE date >= CURRENT_DATE
            AND date <  CURRENT_DATE + INTERVAL '60 days'
        ),
        freshness AS (
          SELECT MAX(scraped_at) AS newest_scrape
          FROM rental_prices_by_date
        )
        SELECT
          ra.total_rows           AS recent_total_rows,
          ra.available_rows       AS recent_available_rows,
          ra.distinct_listings    AS recent_distinct_listings,
          ra.avg_price            AS recent_avg_price,
          ra.listings_with_price  AS recent_listings_with_price,
          pa.total_rows           AS prior_total_rows,
          pa.available_rows       AS prior_available_rows,
          pa.avg_price            AS prior_avg_price,
          ct.distinct_listings    AS cohort_distinct_listings,
          f.newest_scrape         AS newest_scrape
        FROM recent_agg ra, prior_agg pa, cohort_total ct, freshness f;
      `),
      db.execute(sql`
        SELECT
          rl.neighborhood_normalized                                                  AS neighborhood,
          COUNT(DISTINCT rl.id)::bigint                                               AS listing_count,
          COUNT(*)::bigint                                                            AS total_rows,
          COUNT(*) FILTER (WHERE rpbd.availability_status = 'available')::bigint     AS available_rows,
          AVG(rpbd.nightly_price_usd)                                                 AS avg_price
        FROM rental_prices_by_date rpbd
        JOIN rental_listings rl ON rl.id = rpbd.listing_id
        WHERE rpbd.date >= NOW() - INTERVAL '30 days'
          AND rpbd.date <  NOW()
          AND rl.neighborhood_normalized IS NOT NULL
          AND rl.neighborhood_normalized <> ''
        GROUP BY rl.neighborhood_normalized
        HAVING COUNT(DISTINCT rl.id) >= 5
        ORDER BY listing_count DESC
        LIMIT 8;
      `),
      db.execute(sql`
        SELECT year, month, total_passengers
        FROM airport_metrics
        ORDER BY year DESC, month DESC
        LIMIT 24;
      `),
      db.execute(sql`
        SELECT
          rl.source_platform                                                          AS source,
          COUNT(DISTINCT rpbd.listing_id)::bigint                                     AS distinct_listings,
          AVG(rpbd.nightly_price_usd)                                                 AS avg_price
        FROM rental_prices_by_date rpbd
        JOIN rental_listings rl ON rl.id = rpbd.listing_id
        WHERE rpbd.date >= CURRENT_DATE
          AND rpbd.date <  CURRENT_DATE + INTERVAL '30 days'
          AND rpbd.nightly_price_usd IS NOT NULL
        GROUP BY rl.source_platform
        ORDER BY distinct_listings DESC;
      `),
      db.execute(sql`
        SELECT
          rl.bedrooms,
          rl.bathrooms,
          COUNT(DISTINCT rpbd.listing_id)::bigint                                     AS distinct_listings,
          AVG(rpbd.nightly_price_usd)                                                 AS avg_price
        FROM rental_prices_by_date rpbd
        JOIN rental_listings rl ON rl.id = rpbd.listing_id
        WHERE rpbd.date >= CURRENT_DATE
          AND rpbd.date <  CURRENT_DATE + INTERVAL '30 days'
          AND rpbd.nightly_price_usd IS NOT NULL
          AND rl.bedrooms IS NOT NULL
          AND rl.bathrooms IS NOT NULL
        GROUP BY rl.bedrooms, rl.bathrooms
        ORDER BY distinct_listings DESC
        LIMIT 6;
      `),
    ]);

    const a = (aggRows.rows[0] ?? {}) as Record<string, unknown>;

    const num = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const recentTotal = num(a.recent_total_rows) ?? 0;
    const recentAvail = num(a.recent_available_rows) ?? 0;
    const priorTotal = num(a.prior_total_rows) ?? 0;
    const priorAvail = num(a.prior_available_rows) ?? 0;
    const recentDistinct = num(a.recent_distinct_listings) ?? 0;
    const recentAvgPrice = num(a.recent_avg_price);
    const priorAvgPrice = num(a.prior_avg_price);
    const recentListingsWithPrice = num(a.recent_listings_with_price) ?? 0;
    const cohortDistinct = num(a.cohort_distinct_listings) ?? 0;

    const recentAvailRate = recentTotal > 0 ? recentAvail / recentTotal : null;
    const priorAvailRate = priorTotal > 0 ? priorAvail / priorTotal : null;
    const availRateDelta =
      recentAvailRate != null && priorAvailRate != null ? recentAvailRate - priorAvailRate : null;

    let demandTrend: "increasing" | "stable" | "decreasing" | "unknown" = "unknown";
    if (availRateDelta != null) {
      if (availRateDelta > 0.05) demandTrend = "decreasing"; // more availability => less demand
      else if (availRateDelta < -0.05) demandTrend = "increasing";
      else demandTrend = "stable";
    }

    let availabilityLevel: "high" | "moderate" | "low" | "unknown" = "unknown";
    if (recentAvailRate != null) {
      if (recentAvailRate > 0.65) availabilityLevel = "high";
      else if (recentAvailRate >= 0.5) availabilityLevel = "moderate";
      else availabilityLevel = "low";
    }

    const priceCoverage = cohortDistinct > 0 ? recentListingsWithPrice / cohortDistinct : null;
    let pricingTrend: "increasing" | "stable" | "softening" | "unknown" = "unknown";
    let pricingTrendPct: number | null = null;
    if (recentAvgPrice != null && priorAvgPrice != null && priorAvgPrice > 0) {
      pricingTrendPct = (recentAvgPrice - priorAvgPrice) / priorAvgPrice;
      if (pricingTrendPct > 0.05) pricingTrend = "increasing";
      else if (pricingTrendPct < -0.05) pricingTrend = "softening";
      else pricingTrend = "stable";
    }

    const newestScrape = a.newest_scrape ? new Date(a.newest_scrape as string) : null;
    const ageHours =
      newestScrape != null ? (Date.now() - newestScrape.getTime()) / (1000 * 60 * 60) : null;
    const isStale = ageHours != null && ageHours > 48;

    // Per-neighborhood breakdown, with the same availability label applied locally.
    const neighborhoods = neighborhoodRows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const tot = num(row.total_rows) ?? 0;
      const avail = num(row.available_rows) ?? 0;
      const rate = tot > 0 ? avail / tot : null;
      let level: "high" | "moderate" | "low" | "unknown" = "unknown";
      if (rate != null) {
        if (rate > 0.65) level = "high";
        else if (rate >= 0.5) level = "moderate";
        else level = "low";
      }
      return {
        neighborhood: String(row.neighborhood),
        listingCount: num(row.listing_count) ?? 0,
        availabilityRate: rate,
        avgPriceUsd: num(row.avg_price),
        availabilityLevel: level,
      };
    });

    // Tourism YoY: look up the most recent month present, then find that
    // same month one year prior. If either is missing, return null gracefully.
    let tourism: {
      currentYear: number;
      currentMonth: number;
      currentPassengers: number;
      priorYear: number;
      priorPassengers: number;
      yoyChangePct: number;
      label: "higher" | "in_line" | "slightly_lower" | "lower";
    } | null = null;

    if (tourismRows.rows.length > 0) {
      const latest = tourismRows.rows[0] as Record<string, unknown>;
      const ly = Number(latest.year);
      const lm = Number(latest.month);
      const lp = Number(latest.total_passengers);
      const priorRow = tourismRows.rows.find((r) => {
        const row = r as Record<string, unknown>;
        return Number(row.year) === ly - 1 && Number(row.month) === lm;
      }) as Record<string, unknown> | undefined;
      if (priorRow && Number.isFinite(lp) && Number(priorRow.total_passengers) > 0) {
        const pp = Number(priorRow.total_passengers);
        const pct = (lp - pp) / pp;
        let label: "higher" | "in_line" | "slightly_lower" | "lower";
        if (pct > 0.05) label = "higher";
        else if (pct >= -0.05) label = "in_line";
        else if (pct >= -0.1) label = "slightly_lower";
        else label = "lower";
        tourism = {
          currentYear: ly,
          currentMonth: lm,
          currentPassengers: lp,
          priorYear: ly - 1,
          priorPassengers: pp,
          yoyChangePct: pct,
          label,
        };
      }
    }

    const bySource = sourceRows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        source: String(row.source),
        listingsPriced: num(row.distinct_listings) ?? 0,
        avgPriceUsd: num(row.avg_price),
      };
    });

    const byBedBath = bedBathRows.rows.map((r, i) => {
      const row = r as Record<string, unknown>;
      return {
        bedrooms: num(row.bedrooms) ?? 0,
        bathrooms: num(row.bathrooms) ?? 0,
        listingCount: num(row.distinct_listings) ?? 0,
        avgPriceUsd: num(row.avg_price),
        mostPopular: i === 0,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      recent: {
        totalRows: recentTotal,
        availableRows: recentAvail,
        distinctListings: recentDistinct,
        availabilityRate: recentAvailRate,
        avgPriceUsd: recentAvgPrice,
        listingsWithPrice: recentListingsWithPrice,
      },
      prior: {
        totalRows: priorTotal,
        availableRows: priorAvail,
        availabilityRate: priorAvailRate,
        avgPriceUsd: priorAvgPrice,
      },
      cohort: {
        distinctListings: cohortDistinct,
        priceCoverage,
      },
      signals: {
        availabilityLevel,
        availabilityRateDelta: availRateDelta,
        demandTrend,
        pricingTrend,
        pricingTrendPct,
      },
      neighborhoods,
      bySource,
      byBedBath,
      tourism,
      freshness: {
        newestScrapeAt: newestScrape ? newestScrape.toISOString() : null,
        ageHours,
        isStale,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch live rental-market metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/metrics/rental-availability-trend
 * Daily availability rate for the last 30 days, computed from rental_prices_by_date.
 * Returns a flat array sorted ascending by date.
 */
router.get("/metrics/rental-availability-trend", async (req, res) => {
  try {
    // Forward-looking window: availability of inventory for the next 30 nights
    // starting today. (Backward dates have no data because rental_prices_by_date
    // tracks bookable future inventory, not historical occupancy.)
    const result = await db.execute(sql`
      SELECT
        date::date                                                        AS date,
        COUNT(*)                                                          AS total_rows,
        COUNT(*) FILTER (WHERE availability_status = 'available')::float
          / NULLIF(COUNT(*), 0)                                           AS availability_rate
      FROM rental_prices_by_date
      WHERE date >= CURRENT_DATE
        AND date <  CURRENT_DATE + INTERVAL '30 days'
      GROUP BY date
      ORDER BY date ASC;
    `);

    const series = result.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const d = row.date as string | Date;
      const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
      const rate = row.availability_rate == null ? null : Number(row.availability_rate);
      return {
        date: iso,
        availabilityRate: rate != null && Number.isFinite(rate) ? rate : null,
      };
    });

    res.json({ series });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch rental availability trend");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
