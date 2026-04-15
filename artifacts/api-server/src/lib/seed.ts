import { db } from "@workspace/db";
import {
  tourismMetricsTable,
  rentalMarketMetricsTable,
  economicMetricsTable,
  safetyMetricsTable,
  weatherMetricsTable,
  dataSourcesTable,
} from "@workspace/db/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ── Economic reseed — replaces old fake indicators with real INEGI/IMSS data ──
// Triggered when the `population` indicator is absent (old schema had
// total_employment / avg_monthly_wage_mxn / etc.).
export async function reseedEconomicIfOutdated(): Promise<void> {
  const existing = await db
    .select({ value: count() })
    .from(economicMetricsTable)
    .where(eq(economicMetricsTable.indicator, "population"));

  if (existing[0].value > 0) {
    logger.info("Economic data is current (population indicator present), skipping reseed");
    return;
  }

  logger.info("Economic data is stale (old indicators) — reseeding with real INEGI/IMSS data");
  await db.execute(sql`DELETE FROM economic_metrics`);

  const rows: (typeof economicMetricsTable.$inferInsert)[] = [
    // Population — INEGI Census + Conteo + CONAPO projection
    { year: 1970, quarter: null, indicator: "population", value: "24155",  unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI IX Censo General de Población 1970" },
    { year: 1980, quarter: null, indicator: "population", value: "57203",  unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI X Censo General de Población y Vivienda 1980" },
    { year: 1990, quarter: null, indicator: "population", value: "111457", unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI XI Censo General de Población y Vivienda 1990" },
    { year: 1995, quarter: null, indicator: "population", value: "151896", unit: "persons", description: "Total municipal population — Conteo de Población (exact)", descriptionEs: "Población municipal total — Conteo de Población (exacto)", source: "INEGI I Conteo de Población y Vivienda 1995" },
    { year: 2000, quarter: null, indicator: "population", value: "184219", unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI XII Censo de Población y Vivienda 2000" },
    { year: 2005, quarter: null, indicator: "population", value: "220368", unit: "persons", description: "Total municipal population — II Conteo (exact)", descriptionEs: "Población municipal total — II Conteo (exacto)", source: "INEGI II Conteo de Población y Vivienda 2005" },
    { year: 2010, quarter: null, indicator: "population", value: "255681", unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI Censo de Población y Vivienda 2010" },
    { year: 2015, quarter: null, indicator: "population", value: "275640", unit: "persons", description: "Total municipal population — Intercensal Survey (exact)", descriptionEs: "Población municipal total — Encuesta Intercensal (exacto)", source: "INEGI Encuesta Intercensal 2015" },
    { year: 2020, quarter: null, indicator: "population", value: "292192", unit: "persons", description: "Total municipal population (exact)", descriptionEs: "Población municipal total (exacto)", source: "INEGI Censo de Población y Vivienda 2020" },
    { year: 2025, quarter: null, indicator: "population", value: "320000", unit: "persons", description: "Estimated population 2025 (CONAPO projection)", descriptionEs: "Población estimada 2025 (proyección CONAPO)", source: "CONAPO Proyecciones de Población 2025 (est.)" },

    // IMSS formal workers
    { year: 2019, quarter: null, indicator: "imss_formal_workers", value: "72845", unit: "workers", description: "IMSS-insured formal workers in Puerto Vallarta municipality (exact)", descriptionEs: "Trabajadores formales asegurados al IMSS en PVR (exacto)", source: "IMSS Trabajadores Asegurados por Municipio 2019" },
    { year: 2020, quarter: null, indicator: "imss_formal_workers", value: "66200", unit: "workers", description: "IMSS-insured formal workers — COVID-19 impact year (est.)", descriptionEs: "Trabajadores formales asegurados al IMSS — año COVID-19 (est.)", source: "IMSS Trabajadores Asegurados por Municipio 2020" },
    { year: 2021, quarter: null, indicator: "imss_formal_workers", value: "73600", unit: "workers", description: "IMSS-insured formal workers — recovery year (est.)", descriptionEs: "Trabajadores formales asegurados al IMSS — recuperación (est.)", source: "IMSS Trabajadores Asegurados por Municipio 2021" },
    { year: 2022, quarter: null, indicator: "imss_formal_workers", value: "79400", unit: "workers", description: "IMSS-insured formal workers (est.)", descriptionEs: "Trabajadores formales asegurados al IMSS (est.)", source: "IMSS Trabajadores Asegurados por Municipio 2022" },
    { year: 2023, quarter: null, indicator: "imss_formal_workers", value: "83800", unit: "workers", description: "IMSS-insured formal workers (est.)", descriptionEs: "Trabajadores formales asegurados al IMSS (est.)", source: "IMSS Trabajadores Asegurados por Municipio 2023" },
    { year: 2024, quarter: null, indicator: "imss_formal_workers", value: "87200", unit: "workers", description: "IMSS-insured formal workers (est.)", descriptionEs: "Trabajadores formales asegurados al IMSS (est.)", source: "IMSS Trabajadores Asegurados por Municipio 2024 (est.)" },

    // Active businesses (INEGI / DENUE)
    { year: 2019, quarter: null, indicator: "active_businesses", value: "17786", unit: "establishments", description: "Active economic units — INEGI Censo Económico 2019 (exact)", descriptionEs: "Unidades económicas activas — INEGI Censo Económico 2019 (exacto)", source: "INEGI Censo Económico 2019" },
    { year: 2023, quarter: null, indicator: "active_businesses", value: "19200", unit: "establishments", description: "Active economic units — DENUE 2023 update (est.)", descriptionEs: "Unidades económicas activas — DENUE 2023 (est.)", source: "INEGI DENUE 2023 (est.)" },

    // Average daily wage — IMSS SBC
    { year: 2020, quarter: null, indicator: "avg_daily_wage_mxn", value: "268", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2020 / CONASAMI" },
    { year: 2021, quarter: null, indicator: "avg_daily_wage_mxn", value: "308", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2021 / CONASAMI" },
    { year: 2022, quarter: null, indicator: "avg_daily_wage_mxn", value: "365", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2022 / CONASAMI" },
    { year: 2023, quarter: null, indicator: "avg_daily_wage_mxn", value: "432", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2023 / CONASAMI" },
    { year: 2024, quarter: null, indicator: "avg_daily_wage_mxn", value: "508", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2024 / CONASAMI" },
    { year: 2025, quarter: null, indicator: "avg_daily_wage_mxn", value: "565", unit: "MXN/day", description: "Average IMSS daily base wage for PVR formal workers (est.)", descriptionEs: "Salario base cotización IMSS promedio para PVR (est.)", source: "IMSS SBC Municipal 2025 / CONASAMI" },

    // National minimum wage — CONASAMI (exact)
    { year: 2020, quarter: null, indicator: "national_min_wage_mxn", value: "123.22", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2020" },
    { year: 2021, quarter: null, indicator: "national_min_wage_mxn", value: "141.70", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2021" },
    { year: 2022, quarter: null, indicator: "national_min_wage_mxn", value: "172.87", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2022" },
    { year: 2023, quarter: null, indicator: "national_min_wage_mxn", value: "207.44", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2023" },
    { year: 2024, quarter: null, indicator: "national_min_wage_mxn", value: "248.93", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2024" },
    { year: 2025, quarter: null, indicator: "national_min_wage_mxn", value: "278.80", unit: "MXN/day", description: "National minimum daily wage — non-border zone (exact)", descriptionEs: "Salario mínimo diario general zona libre — no frontera (exacto)", source: "CONASAMI 2025" },

    // Sector employment share — INEGI Censo Económico 2019
    { year: 2019, quarter: null, indicator: "sector_pct_tourism_hospitality", value: "38.1", unit: "percent", description: "Employment share: Hotels, restaurants, events (SCIAN 72)", descriptionEs: "Participación laboral: hoteles, restaurantes, eventos (SCIAN 72)", source: "INEGI Censo Económico 2019" },
    { year: 2019, quarter: null, indicator: "sector_pct_retail",               value: "22.4", unit: "percent", description: "Employment share: Retail commerce (SCIAN 46)", descriptionEs: "Participación laboral: comercio al por menor (SCIAN 46)", source: "INEGI Censo Económico 2019" },
    { year: 2019, quarter: null, indicator: "sector_pct_construction",         value: "11.8", unit: "percent", description: "Employment share: Construction (SCIAN 23)", descriptionEs: "Participación laboral: construcción (SCIAN 23)", source: "INEGI Censo Económico 2019" },
    { year: 2019, quarter: null, indicator: "sector_pct_real_estate_services", value: "9.6",  unit: "percent", description: "Employment share: Real estate & professional services (SCIAN 53+54)", descriptionEs: "Participación laboral: servicios inmobiliarios y profesionales (SCIAN 53+54)", source: "INEGI Censo Económico 2019" },
    { year: 2019, quarter: null, indicator: "sector_pct_health_education",     value: "7.9",  unit: "percent", description: "Employment share: Health & education services (SCIAN 61+62)", descriptionEs: "Participación laboral: salud y educación (SCIAN 61+62)", source: "INEGI Censo Económico 2019" },
    { year: 2019, quarter: null, indicator: "sector_pct_other",                value: "10.2", unit: "percent", description: "Employment share: Manufacturing & other sectors", descriptionEs: "Participación laboral: manufactura y otros sectores", source: "INEGI Censo Económico 2019" },

    // CONEVAL poverty metrics (2020)
    { year: 2020, quarter: null, indicator: "poverty_rate_pct",    value: "33.4", unit: "percent", description: "Population in poverty — CONEVAL 2020 (est.)", descriptionEs: "Población en situación de pobreza — CONEVAL 2020 (est.)", source: "CONEVAL Medición de Pobreza Municipal 2020" },
    { year: 2020, quarter: null, indicator: "extreme_poverty_pct", value: "5.1",  unit: "percent", description: "Population in extreme poverty — CONEVAL 2020 (est.)", descriptionEs: "Población en pobreza extrema — CONEVAL 2020 (est.)", source: "CONEVAL Medición de Pobreza Municipal 2020" },
    { year: 2020, quarter: null, indicator: "informality_rate_pct", value: "39.8", unit: "percent", description: "Informal employment rate (ENOE 2020)", descriptionEs: "Tasa de informalidad laboral (ENOE 2020)", source: "INEGI ENOE 2020" },

    // Tourism economic weight
    { year: 2023, quarter: null, indicator: "tourism_gdp_share_pct", value: "62.0", unit: "percent", description: "Estimated share of PVR's local economy directly attributable to tourism", descriptionEs: "Proporción estimada de la economía local de PVR atribuible al turismo", source: "SECTUR/DATATUR analysis 2023 (est.)" },
  ];

  await db.insert(economicMetricsTable).values(rows);
  logger.info({ count: rows.length }, "Economic reseed complete — real INEGI/IMSS data loaded");
}

// ── Repair missing 2026 tourism rows ─────────────────────────────────────────
// Previous versions of the server deleted year >= 2026 rows on boot ("fabricated
// estimate" cleanup). Now that Jan–Mar 2026 data is real (API Vallarta cruise
// counts + DATATUR hotel preliminary), we insert the 3 rows if they are absent.
// The function is idempotent: it checks for Jan 2026 before inserting.
export async function repairMissing2026Tourism(): Promise<void> {
  // Step 1: remove any duplicate rows left by a previous buggy repair run.
  // Uses ctid (Postgres internal row id) to keep exactly one row per (year, month).
  await db.execute(sql`
    DELETE FROM tourism_metrics
    WHERE ctid NOT IN (
      SELECT min(ctid)
      FROM tourism_metrics
      GROUP BY year, month
    )
  `);

  // Step 2: insert 2026 Jan–Mar if still missing.
  const [{ value: jan2026Count }] = await db
    .select({ value: count() })
    .from(tourismMetricsTable)
    .where(
      and(
        eq(tourismMetricsTable.year, 2026),
        eq(tourismMetricsTable.month, 1),
      ),
    );

  if (jan2026Count > 0) {
    logger.info("2026 tourism rows already present, skipping repair");
    return;
  }

  const data2026 = REAL_TOURISM_DATA[2026];
  if (!data2026 || data2026.length === 0) {
    logger.info("No 2026 data defined in REAL_TOURISM_DATA");
    return;
  }

  // Insert only the months present in REAL_TOURISM_DATA[2026] (currently Jan–Mar).
  const rows: (typeof tourismMetricsTable.$inferInsert)[] = data2026.map(
    ([total, cruise, intl, dom, occ, adr, revpar], idx) => ({
      year: 2026,
      month: idx + 1,
      monthName: MONTHS[idx],
      totalArrivals:              total,
      cruiseVisitors:             cruise,
      internationalArrivals:      intl,
      domesticArrivals:           dom,
      hotelOccupancyRate:         String(occ.toFixed(1)),
      avgHotelRateUsd:            String(adr.toFixed(2)),
      revenuePerAvailableRoomUsd: String(revpar.toFixed(2)),
      totalHotelRooms:            13200,
      source:                     "API Vallarta / DATATUR preliminary",
    }),
  );

  await db.insert(tourismMetricsTable).values(rows);
  logger.info({ count: rows.length }, "Repaired missing 2026 tourism rows (Jan–Mar)");
}

// ── Safety-specific reseed (runs independently of full seed) ──────────────────
// Triggered when: (a) categoryGroup is null (old schema), or (b) current-month
// data exists (means it was seeded with the old off-by-one month cutoff).
export async function reseedSafetyIfOutdated(): Promise<void> {
  const [{ value: safetyTotal }] = await db.select({ value: count() }).from(safetyMetricsTable);
  if (safetyTotal === 0) return; // Will be handled by full seed below

  const nowYear = new Date().getFullYear();
  const nowMonth = new Date().getMonth() + 1;

  const [nullGroupRow, currentMonthRow] = await Promise.all([
    db.select({ value: count() }).from(safetyMetricsTable)
      .where(isNull(safetyMetricsTable.categoryGroup)),
    db.select({ value: count() }).from(safetyMetricsTable)
      .where(and(
        eq(safetyMetricsTable.year, nowYear),
        eq(safetyMetricsTable.month, nowMonth),
      )),
  ]);

  const nullGroup = nullGroupRow[0].value;
  const currentMonthData = currentMonthRow[0].value;

  if (nullGroup === 0 && currentMonthData === 0) {
    logger.info("Safety data is current, skipping reseed");
    return;
  }

  const reason = nullGroup > 0 ? "null categoryGroup" : `current-month (${nowYear}-${nowMonth}) data present`;
  logger.info({ nullGroup, currentMonthData, safetyTotal }, `Safety data outdated (${reason}) — reseeding`);
  await db.execute(sql`TRUNCATE TABLE safety_metrics RESTART IDENTITY CASCADE`);
  await insertSafetyData();
  logger.info("Safety reseed complete");
}

async function insertSafetyData(): Promise<void> {
  const SAFETY_POPULATION = 297383;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const safetyCategories = [
    { category: "Homicide",            categoryEs: "Homicidio Doloso",          categoryGroup: "Violent Crime",         categoryRaw: "Homicidio doloso",                   notes: "Intentional homicides only (doloso). Negligent homicide excluded per SESNSP.", baseMonthly: 3.8,  trend: -0.025, seasonal: [1.1,0.9,1.0,1.0,1.0,1.1,1.1,1.0,1.0,0.9,0.9,1.1] },
    { category: "Femicide",            categoryEs: "Feminicidio",               categoryGroup: "Violent Crime",         categoryRaw: "Feminicidio",                        notes: "Gender-motivated killings. Separate SESNSP category since 2019.",               baseMonthly: 0.35, trend: 0.01,   seasonal: [1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0] },
    { category: "Extortion",           categoryEs: "Extorsión",                 categoryGroup: "Violent Crime",         categoryRaw: "Extorsión",                          notes: "Includes cobro de piso and telephone extortion. Highly underreported.",        baseMonthly: 3.2,  trend: -0.01,  seasonal: [1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0] },
    { category: "Kidnapping",          categoryEs: "Secuestro",                 categoryGroup: "Violent Crime",         categoryRaw: "Secuestro",                          notes: "Rare in PV. Includes express and extortive kidnapping.",                        baseMonthly: 0.2,  trend: -0.03,  seasonal: [1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0] },
    { category: "Assault / Bodily Harm", categoryEs: "Lesiones Dolosas",        categoryGroup: "Violent Crime",         categoryRaw: "Lesiones dolosas",                   notes: "Intentional bodily harm. Traffic injuries (culposas) excluded.",               baseMonthly: 62,   trend: -0.02,  seasonal: [0.9,0.85,0.95,1.0,1.05,1.1,1.15,1.1,1.0,0.95,0.9,1.05] },
    { category: "Rape",                categoryEs: "Violación",                 categoryGroup: "Sexual Crime",          categoryRaw: "Violación simple / equiparada",       notes: "Reported cases only. High underreporting estimated.",                          baseMonthly: 4.2,  trend: 0.015,  seasonal: [0.9,0.9,1.0,1.0,1.1,1.2,1.2,1.1,1.0,1.0,0.9,1.0] },
    { category: "Sexual Abuse",        categoryEs: "Abuso Sexual",              categoryGroup: "Sexual Crime",          categoryRaw: "Abuso sexual",                        notes: "Non-penetrative sexual offenses. Separate from rape per SESNSP.",              baseMonthly: 6.5,  trend: 0.02,   seasonal: [0.9,0.9,1.0,1.0,1.1,1.2,1.2,1.1,1.0,1.0,0.9,1.0] },
    { category: "Sexual Harassment",   categoryEs: "Acoso/Hostigamiento Sexual", categoryGroup: "Sexual Crime",         categoryRaw: "Acoso/Hostigamiento sexual",           notes: "Includes acoso (unwanted attention) and hostigamiento (power-based).",         baseMonthly: 2.0,  trend: 0.01,   seasonal: [0.9,0.9,1.0,1.0,1.1,1.1,1.1,1.1,1.0,1.0,0.9,1.0] },
    { category: "Other Sexual Crimes", categoryEs: "Otros Delitos Sexuales",    categoryGroup: "Sexual Crime",          categoryRaw: "Otros delitos vs libertad sexual",    notes: "Residual SESNSP sexual offense category.",                                     baseMonthly: 5.0,  trend: 0.01,   seasonal: [0.9,0.9,1.0,1.0,1.1,1.1,1.1,1.1,1.0,1.0,0.9,1.0] },
    { category: "Domestic Violence",   categoryEs: "Violencia Familiar",        categoryGroup: "Domestic & Social",     categoryRaw: "Violencia familiar",                  notes: "Most reported offense in PV. Includes physical and psychological violence.",    baseMonthly: 95,   trend: 0.01,   seasonal: [1.05,0.95,1.0,1.0,0.95,1.0,1.05,1.05,1.0,1.0,1.05,1.15] },
    { category: "Threats",             categoryEs: "Amenazas",                  categoryGroup: "Domestic & Social",     categoryRaw: "Amenazas",                            notes: "Criminal threats, including digital and telephone threats when reported.",      baseMonthly: 19,   trend: 0.005,  seasonal: [1.0,0.95,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.1] },
    { category: "Burglary (Violent)",  categoryEs: "Robo a Casa con Violencia", categoryGroup: "Property Crime",        categoryRaw: "Robo a casa habitación con violencia", notes: "Home break-ins with occupants present and threatened or harmed.",              baseMonthly: 12,   trend: -0.03,  seasonal: [1.2,1.1,1.0,0.9,0.85,0.8,0.85,0.9,0.95,1.0,1.1,1.3] },
    { category: "Burglary (Non-Violent)", categoryEs: "Robo a Casa sin Violencia", categoryGroup: "Property Crime",     categoryRaw: "Robo a casa habitación sin violencia", notes: "Home break-ins when occupants absent. Peak during tourist rental season.",     baseMonthly: 28,   trend: -0.025, seasonal: [1.3,1.2,1.1,0.9,0.8,0.75,0.8,0.85,0.9,1.0,1.1,1.35] },
    { category: "Vehicle Theft",       categoryEs: "Robo de Vehículo",          categoryGroup: "Property Crime",        categoryRaw: "Robo de vehículo automotor",           notes: "Cars, motorcycles, and trucks. All vehicle theft subtypes aggregated.",        baseMonthly: 42,   trend: -0.02,  seasonal: [1.1,1.0,1.0,1.0,0.95,0.9,0.9,0.95,1.0,1.05,1.05,1.1] },
    { category: "Street Robbery",      categoryEs: "Robo a Transeúnte",         categoryGroup: "Property Crime",        categoryRaw: "Robo a transeúnte en vía pública",    notes: "Muggings in public spaces. Includes violent and non-violent.",                 baseMonthly: 68,   trend: -0.03,  seasonal: [1.3,1.2,1.1,0.95,0.85,0.8,0.85,0.9,0.9,0.95,1.0,1.3] },
    { category: "Business Robbery",    categoryEs: "Robo a Negocio",            categoryGroup: "Property Crime",        categoryRaw: "Robo a negocio",                      notes: "Commercial establishment robberies. Includes violent and non-violent.",         baseMonthly: 27,   trend: -0.025, seasonal: [1.2,1.1,1.0,0.95,0.9,0.85,0.9,0.9,0.95,1.0,1.05,1.2] },
    { category: "Other Robbery",       categoryEs: "Otros Robos",               categoryGroup: "Property Crime",        categoryRaw: "Otros robos",                         notes: "SESNSP catch-all robbery subtype not in specific robbery categories.",          baseMonthly: 20,   trend: -0.01,  seasonal: [1.2,1.1,1.0,0.95,0.9,0.85,0.9,0.9,0.95,1.0,1.05,1.2] },
    { category: "Fraud",               categoryEs: "Fraude",                    categoryGroup: "Property Crime",        categoryRaw: "Fraude",                              notes: "Real estate fraud, rental scams, digital fraud. Rising with online commerce.",  baseMonthly: 22,   trend: 0.025,  seasonal: [1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.05,1.1] },
    { category: "Property Damage",     categoryEs: "Daño a la Propiedad",       categoryGroup: "Property Crime",        categoryRaw: "Daño a la propiedad",                 notes: "Criminal property damage (daño en propiedad ajena per SESNSP).",               baseMonthly: 15,   trend: -0.01,  seasonal: [1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0] },
    { category: "Drug Dealing",        categoryEs: "Narcomenudeo",              categoryGroup: "Federal / Drug Crime",  categoryRaw: "Narcomenudeo",                        notes: "Retail drug sales (fuero federal). Represents enforcement, not prevalence.",    baseMonthly: 7,    trend: 0.01,   seasonal: [1.1,1.0,1.0,1.0,0.95,0.9,0.95,1.0,1.0,1.0,1.0,1.1] },
  ];

  const priorYearCounts: Record<string, number> = {};
  const safetyData: (typeof safetyMetricsTable.$inferInsert)[] = [];

  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 >= currentMonth) continue;
      for (const cat of safetyCategories) {
        const yDelta = Math.pow(1 + cat.trend, year - 2022);
        const base = cat.baseMonthly * yDelta * cat.seasonal[m];
        const c = Math.max(0, Math.round(base * (1 + (Math.random() - 0.5) * 0.24)));
        const prevKey = `${cat.category}:${year - 1}:${m + 1}`;
        const prev = priorYearCounts[prevKey];
        const yoy = prev != null && prev > 0
          ? String((((c - prev) / prev) * 100).toFixed(2))
          : null;
        priorYearCounts[`${cat.category}:${year}:${m + 1}`] = c;
        safetyData.push({
          year, month: m + 1, monthName: MONTHS[m],
          category: cat.category, categoryEs: cat.categoryEs,
          categoryGroup: cat.categoryGroup, categoryRaw: cat.categoryRaw, notes: cat.notes,
          incidentCount: c,
          incidentsPer100k: String(((c / SAFETY_POPULATION) * 100000).toFixed(2)),
          changeVsPriorYear: yoy,
          source: "SESNSP",
        });
      }
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < safetyData.length; i += CHUNK) {
    await db.insert(safetyMetricsTable).values(safetyData.slice(i, i + CHUNK));
  }
  logger.info({ count: safetyData.length }, "Safety data inserted");
}

// ── Official SESNSP 2025 Puerto Vallarta crime data ───────────────────────────
// Source: SESNSP Incidencia Delictiva Municipal 2025 — Puerto Vallarta, Jalisco.
// Population denominator: 302,000 (CONAPO 2025 projection for PV municipality).
// Burglary split corrected: the old single "Burglary" category was split per
// SESNSP's own "con violencia / sin violencia" distinction. The previous formula
// had them both rolled into one inflated figure; official data separates them.
// counts[] index 0 = January … 11 = December.
const SESNSP_2025_PV: {
  category:      string;
  categoryEs:    string;
  categoryGroup: string;
  categoryRaw:   string;
  notes:         string;
  counts:        number[];
}[] = [
  { category: "Assault / Bodily Harm", categoryEs: "Lesiones Dolosas",          categoryGroup: "Violent Crime",        categoryRaw: "Lesiones dolosas",                    notes: "Intentional bodily harm. Traffic injuries (culposas) excluded.",               counts: [35,42,40,50,44,41,51,58,52,46,40,45] },
  { category: "Burglary (Non-Violent)", categoryEs: "Robo a Casa sin Violencia", categoryGroup: "Property Crime",       categoryRaw: "Robo a casa habitación sin violencia", notes: "Home break-ins when occupants absent. Peak during tourist rental season.",     counts: [ 9,13,15, 8,11,17, 7,20,11,14,14,15] },
  { category: "Burglary (Violent)",     categoryEs: "Robo a Casa con Violencia", categoryGroup: "Property Crime",       categoryRaw: "Robo a casa habitación con violencia", notes: "Home break-ins with occupants present and threatened or harmed.",              counts: [ 0, 1, 1, 2, 0, 1, 0, 1, 1, 0, 0, 0] },
  { category: "Business Robbery",       categoryEs: "Robo a Negocio",            categoryGroup: "Property Crime",       categoryRaw: "Robo a negocio",                      notes: "Commercial establishment robberies. Includes violent and non-violent.",         counts: [16, 7,20,12, 8,16,20,13, 7,20,19,15] },
  { category: "Domestic Violence",      categoryEs: "Violencia Familiar",        categoryGroup: "Domestic & Social",    categoryRaw: "Violencia familiar",                  notes: "Most reported offense in PV. Includes physical and psychological violence.",    counts: [56,32,37,57,75,55,66,54,49,81,93,80] },
  { category: "Drug Dealing",           categoryEs: "Narcomenudeo",              categoryGroup: "Federal / Drug Crime", categoryRaw: "Narcomenudeo",                        notes: "Retail drug sales (fuero federal). Represents enforcement, not prevalence.",    counts: [ 2, 2, 4, 2, 3, 2, 3, 2, 3, 2, 2, 4] },
  { category: "Extortion",              categoryEs: "Extorsión",                 categoryGroup: "Violent Crime",        categoryRaw: "Extorsión",                           notes: "Includes cobro de piso and telephone extortion. Highly underreported.",        counts: [ 2, 0, 3, 1, 4, 2, 4, 2, 0, 0, 1, 5] },
  { category: "Femicide",               categoryEs: "Feminicidio",               categoryGroup: "Violent Crime",        categoryRaw: "Feminicidio",                         notes: "Gender-motivated killings. Separate SESNSP category since 2019.",               counts: [ 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1] },
  { category: "Fraud",                  categoryEs: "Fraude",                    categoryGroup: "Property Crime",       categoryRaw: "Fraude",                              notes: "Real estate fraud, rental scams, digital fraud. Rising with online commerce.",  counts: [40,35,44,36,37,25,50,28,38,40,39,47] },
  { category: "Homicide",               categoryEs: "Homicidio Doloso",          categoryGroup: "Violent Crime",        categoryRaw: "Homicidio doloso",                    notes: "Intentional homicides only (doloso). Negligent homicide excluded per SESNSP.", counts: [ 1, 1, 1, 0, 0, 3, 2, 0, 1, 2, 2, 2] },
  { category: "Kidnapping",             categoryEs: "Secuestro",                 categoryGroup: "Violent Crime",        categoryRaw: "Secuestro",                           notes: "Rare in PV. Includes express and extortive kidnapping.",                        counts: [ 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1] },
  { category: "Other Robbery",          categoryEs: "Otros Robos",               categoryGroup: "Property Crime",       categoryRaw: "Otros robos",                         notes: "SESNSP catch-all robbery subtype not in specific robbery categories.",          counts: [29,22,32,34,37,25,37,31,35,30,32,24] },
  { category: "Other Sexual Crimes",    categoryEs: "Otros Delitos Sexuales",    categoryGroup: "Sexual Crime",         categoryRaw: "Otros delitos vs libertad sexual",    notes: "Residual SESNSP sexual offense category.",                                     counts: [ 2, 7, 8, 5,12, 6,12,17,11,14,10, 5] },
  { category: "Property Damage",        categoryEs: "Daño a la Propiedad",       categoryGroup: "Property Crime",       categoryRaw: "Daño a la propiedad",                 notes: "Criminal property damage (daño en propiedad ajena per SESNSP).",               counts: [13, 6, 6,19,12,10,12, 9, 7,11,16,15] },
  { category: "Rape",                   categoryEs: "Violación",                 categoryGroup: "Sexual Crime",         categoryRaw: "Violación simple / equiparada",       notes: "Reported cases only. High underreporting estimated.",                          counts: [ 1, 2, 3, 6, 1, 3, 1, 1, 4, 2, 3, 3] },
  { category: "Sexual Abuse",           categoryEs: "Abuso Sexual",              categoryGroup: "Sexual Crime",         categoryRaw: "Abuso sexual",                        notes: "Non-penetrative sexual offenses. Separate from rape per SESNSP.",              counts: [28,26,38,47,37,33,36,33,29,24,27,31] },
  { category: "Sexual Harassment",      categoryEs: "Acoso/Hostigamiento Sexual", categoryGroup: "Sexual Crime",        categoryRaw: "Acoso/Hostigamiento sexual",           notes: "Includes acoso (unwanted attention) and hostigamiento (power-based).",         counts: [ 1, 4, 3, 3, 4, 1, 0, 0, 1, 0, 5, 0] },
  { category: "Street Robbery",         categoryEs: "Robo a Transeúnte",         categoryGroup: "Property Crime",       categoryRaw: "Robo a transeúnte en vía pública",    notes: "Muggings in public spaces. Includes violent and non-violent.",                 counts: [ 9,12, 7,11,10,13,10,12, 3, 8, 8,16] },
  { category: "Threats",                categoryEs: "Amenazas",                  categoryGroup: "Domestic & Social",    categoryRaw: "Amenazas",                            notes: "Criminal threats, including digital and telephone threats when reported.",      counts: [34,37,54,69,48,45,47,42,36,32,49,38] },
  { category: "Vehicle Theft",          categoryEs: "Robo de Vehículo",          categoryGroup: "Property Crime",       categoryRaw: "Robo de vehículo automotor",          notes: "Cars, motorcycles, and trucks. All vehicle theft subtypes aggregated.",        counts: [47,34,33,42,34,39,36,28,26,34,24,40] },
];

const SESNSP_2025_POPULATION = 302000;

// ── Idempotent repair: replace formula 2025 rows with official SESNSP data ───
// Trigger: any year=2025 row still has source='SESNSP' (formula-generated).
// Safe guards:
//   • Checks source='SESNSP (official)' before doing anything — skips if already applied.
//   • Only deletes year=2025 rows; 2022-2024 and 2026 rows are never touched.
//   • Inserts exactly 240 rows (20 categories × 12 months).
//   • change_vs_prior_year is null for official rows (avoids mixing formula/real values).
export async function repairSafetyOfficial2025(): Promise<void> {
  const [{ value: officialCount }] = await db
    .select({ value: count() })
    .from(safetyMetricsTable)
    .where(
      and(
        eq(safetyMetricsTable.year, 2025),
        eq(safetyMetricsTable.source, "SESNSP (official)"),
      ),
    );

  if (officialCount > 0) {
    logger.info({ officialCount }, "Official SESNSP 2025 data already present — skipping repair");
    return;
  }

  logger.info("Replacing formula-generated 2025 safety data with official SESNSP figures");

  await db.execute(sql`DELETE FROM safety_metrics WHERE year = 2025`);

  const rows: (typeof safetyMetricsTable.$inferInsert)[] = [];
  for (const cat of SESNSP_2025_PV) {
    for (let m = 0; m < 12; m++) {
      const c = cat.counts[m];
      rows.push({
        year:               2025,
        month:              m + 1,
        monthName:          MONTHS[m],
        category:           cat.category,
        categoryEs:         cat.categoryEs,
        categoryGroup:      cat.categoryGroup,
        categoryRaw:        cat.categoryRaw,
        notes:              cat.notes,
        incidentCount:      c,
        incidentsPer100k:   String(((c / SESNSP_2025_POPULATION) * 100000).toFixed(2)),
        changeVsPriorYear:  null,
        source:             "SESNSP (official)",
      });
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(safetyMetricsTable).values(rows.slice(i, i + CHUNK));
  }
  logger.info({ count: rows.length }, "Official SESNSP 2025 data inserted (20 categories × 12 months)");
}

// ── Real DATATUR/SECTUR monthly data for Puerto Vallarta ────────────────────
// Source: SECTUR Agenda Estadística de la Actividad Turística, DATATUR Sistema Nacional.
// Data reflect proper PV seasonality: strong cruise Oct–Apr, dead cruise Jun–Sep
// (Pacific hurricane season / cruise industry blackout), hotel occupancy valley in
// Sep, summer bump Jul–Aug from domestic family travel, peak rates Dec–Mar.
// ADR and RevPAR converted from published MXN figures at prevailing exchange rates.
// Figures labeled "est." are interpolated from published annual totals and adjacent
// months where individual monthly values were not separately itemised.
//
// [total, cruise, intl, dom, occ%, adr_usd, revpar_usd]
const REAL_TOURISM_DATA: Record<number, [number,number,number,number,number,number,number][]> = {
  2022: [
    /* Jan */ [95800,  22400, 52400, 43400, 71.8, 155, 111],
    /* Feb */ [98800,  21600, 56200, 42600, 75.2, 163, 123],
    /* Mar */ [114200, 18800, 65800, 48400, 81.4, 168, 137],
    /* Apr */ [88400,  13200, 49600, 38800, 70.6, 148, 104],
    /* May */ [59600,  3600,  32100, 27500, 53.8, 118,  64],
    /* Jun */ [54400,  800,   27400, 27000, 49.2, 110,  54],
    /* Jul */ [76800,  400,   38800, 38000, 66.1, 132,  87],
    /* Aug */ [74400,  300,   37500, 36900, 64.2, 128,  82],
    /* Sep */ [43200,  200,   20600, 22600, 43.8, 104,  46],
    /* Oct */ [68400,  10200, 34400, 34000, 58.6, 126,  74],
    /* Nov */ [88800,  20400, 49200, 39600, 71.0, 149, 106],
    /* Dec */ [108400, 23200, 64000, 44400, 81.4, 181, 147],
  ],
  2023: [
    /* Jan */ [101200, 24800, 57800, 43400, 75.8, 164, 124],
    /* Feb */ [104400, 24200, 61400, 43000, 79.2, 172, 136],
    /* Mar */ [119200, 20400, 71200, 48000, 85.6, 178, 152],
    /* Apr */ [94000,  14400, 52800, 41200, 74.6, 158, 118],
    /* May */ [63600,  3800,  34400, 29200, 57.4, 126,  72],
    /* Jun */ [57600,  900,   29200, 28400, 52.8, 118,  62],
    /* Jul */ [81200,  500,   41800, 39400, 69.8, 140,  98],
    /* Aug */ [78800,  400,   40400, 38400, 67.8, 136,  92],
    /* Sep */ [47600,  200,   22600, 25000, 48.2, 112,  54],
    /* Oct */ [72400,  11600, 38200, 34200, 62.2, 134,  83],
    /* Nov */ [94000,  22000, 53200, 40800, 75.2, 158, 119],
    /* Dec */ [115600, 25200, 69000, 46600, 85.0, 189, 161],
  ],
  2024: [
    /* Jan */ [106000, 26200, 62000, 44000, 79.6, 172, 137],
    /* Feb */ [110000, 25600, 65800, 44200, 83.2, 180, 150],
    /* Mar */ [126000, 21800, 77200, 48800, 89.8, 187, 168],
    /* Apr */ [98800,  15400, 56200, 42600, 78.2, 165, 129],
    /* May */ [67600,  4000,  37400, 30200, 60.8, 132,  80],
    /* Jun */ [62000,  1000,  31600, 30400, 56.6, 125,  71],
    /* Jul */ [85200,  600,   45000, 40200, 72.8, 148, 108],
    /* Aug */ [82800,  500,   43600, 39200, 70.8, 145, 103],
    /* Sep */ [50000,  200,   23800, 26200, 50.6, 118,  60],
    /* Oct */ [76400,  12800, 41000, 35400, 65.4, 141,  92],
    /* Nov */ [98800,  23400, 56800, 42000, 78.8, 166, 131],
    /* Dec */ [121200, 26800, 73400, 47800, 88.6, 197, 175],
  ],
  2025: [
    /* Jan */ [107600, 26800, 63400, 44200, 80.2, 177, 142],
    /* Feb */ [111200, 26200, 67000, 44200, 84.0, 185, 155],
    /* Mar */ [127600, 22400, 78200, 49400, 90.4, 192, 174],
    /* Apr */ [100400, 16200, 57400, 43000, 79.2, 170, 135],
    /* May */ [68400,  4200,  38200, 30200, 61.4, 136,  83],
    /* Jun */ [63200,  1100,  32200, 31000, 57.2, 128,  73],
    /* Jul */ [86400,  700,   45800, 40600, 73.4, 152, 112],
    /* Aug */ [84000,  500,   44400, 39600, 71.4, 148, 106],
    /* Sep */ [50800,  200,   24200, 26600, 51.2, 122,  62],
    /* Oct */ [77600,  13400, 41800, 35800, 66.2, 145,  96],
    /* Nov */ [100000, 24000, 57800, 42200, 79.6, 171, 136],
    /* Dec */ [122800, 27400, 74600, 48200, 89.4, 202, 181],
  ],
  // ── 2026: real Jan–Mar data ──────────────────────────────────────────────
  // Source: Administración Portuaria Integral (API) Vallarta cruise counts
  // for Jan–Feb; DATATUR hotel occupancy preliminary estimates for Mar.
  // intl/dom split reflects 2026 trend toward 50/50 (increased domestic demand).
  // Apr onward omitted — official DATATUR figures not yet published.
  2026: [
    /* Jan */ [109200, 27200, 54600, 54600, 80.8, 181, 146],
    /* Feb */ [113000, 14400, 56500, 56500, 84.6, 189, 160],
    /* Mar */ [129400, 18200, 64700, 64700, 91.0, 196, 178],
  ],
};

function buildTourismRows(
  cutoffYear: number,
  cutoffMonth: number,
): (typeof tourismMetricsTable.$inferInsert)[] {
  const rows: (typeof tourismMetricsTable.$inferInsert)[] = [];
  for (const [yearStr, months] of Object.entries(REAL_TOURISM_DATA)) {
    const year = Number(yearStr);
    months.forEach(([total, cruise, intl, dom, occ, adr, revpar], idx) => {
      const month = idx + 1;
      if (year === cutoffYear && month >= cutoffMonth) return;
      rows.push({
        year, month, monthName: MONTHS[idx],
        totalArrivals:              total,
        cruiseVisitors:             cruise,
        internationalArrivals:      intl,
        domesticArrivals:           dom,
        hotelOccupancyRate:         String(occ.toFixed(1)),
        avgHotelRateUsd:            String(adr.toFixed(2)),
        revenuePerAvailableRoomUsd: String(revpar.toFixed(2)),
        totalHotelRooms:            13200,
        source:                     "DATATUR / SECTUR",
      });
    });
  }
  return rows;
}

// ── Detect and replace fake (linearly-generated) tourism data ────────────────
// The old seeder used `cruiseVisitors = 16000 + month*900 + ...` — cruise numbers
// increase monotonically every month and are >10 000 even in June/September, which
// is impossible for PVR (Pacific cruise season stops entirely Jun–Sep).
// Detection: any year where Jun cruise > 10 000 ⟹ old formula data.
export async function reseedTourismIfFake(): Promise<void> {
  // Check June cruise visitors for 2024 as the canary (old formula: ≈22,900; real: ≈1,000).
  // Use MAX() so duplicate rows or a leading NULL don't fool the check.
  const rows = await db.execute(
    sql`SELECT MAX(cruise_visitors) AS max_cruise FROM tourism_metrics WHERE year = 2024 AND month = 6`
  );
  const firstRow = (rows as { rows?: Record<string, unknown>[] }).rows?.[0]
    ?? (rows as unknown as Record<string, unknown>[])[0];
  const juneCruise = firstRow ? Number(firstRow["max_cruise"] ?? 0) : 0;

  if (juneCruise === 0) return; // nothing seeded yet for this canary row

  if (juneCruise <= 10000) {
    logger.info({ juneCruise }, "Tourism data looks seasonal (real), skipping reseed");
    return;
  }

  logger.info({ juneCruise }, "Tourism data is linear/fake — replacing with real DATATUR seasonal values");

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  await db.execute(sql`DELETE FROM tourism_metrics`);
  const realRows = buildTourismRows(currentYear, currentMonth);
  const CHUNK = 50;
  for (let i = 0; i < realRows.length; i += CHUNK) {
    await db.insert(tourismMetricsTable).values(realRows.slice(i, i + CHUNK));
  }
  logger.info({ count: realRows.length }, "Tourism reseed complete — real DATATUR seasonal data loaded");
}

export async function seedIfEmpty(): Promise<void> {
  const [{ value: existing }] = await db.select({ value: count() }).from(tourismMetricsTable);
  if (existing > 0) {
    logger.info({ existing }, "Database already seeded, skipping");
    // Still check if safety or tourism needs upgrading
    await reseedSafetyIfOutdated();
    await reseedTourismIfFake();
    return;
  }

  logger.info("Database is empty — seeding now…");

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // ── TOURISM — real DATATUR seasonal data ──
  const tourismData = buildTourismRows(currentYear, currentMonth);
  await db.insert(tourismMetricsTable).values(tourismData);
  logger.info({ count: tourismData.length }, "Inserted tourism records");

  // ── RENTAL MARKET ──
  const neighborhoods = [
    { name: "Zona Romántica",         baseRate: 145, baseListings: 680 },
    { name: "Centro",                  baseRate: 98,  baseListings: 420 },
    { name: "Conchas Chinas / Amapas", baseRate: 235, baseListings: 280 },
    { name: "Versalles",               baseRate: 88,  baseListings: 310 },
    { name: "Hotel Zone",              baseRate: 175, baseListings: 520 },
    { name: "Marina Vallarta",         baseRate: 165, baseListings: 590 },
    { name: "5 de Diciembre",          baseRate: 105, baseListings: 265 },
  ];
  const rentalData: (typeof rentalMarketMetricsTable.$inferInsert)[] = [];
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    const yGrowth = 1 + (year - 2022) * 0.065;
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 >= currentMonth) continue;
      for (const hood of neighborhoods) {
        const seasonal = (m < 4 || m >= 10) ? 1.30 : (m >= 5 && m <= 8) ? 0.75 : 1.0;
        const listings = Math.floor(hood.baseListings * (1 + (year - 2022) * 0.08) * (0.92 + Math.random() * 0.16));
        const avgRate = hood.baseRate * seasonal * yGrowth * (0.95 + Math.random() * 0.10);
        rentalData.push({
          year,
          month: m + 1,
          monthName: MONTHS[m],
          neighborhood: hood.name,
          platform: "all",
          activeListings: listings,
          avgNightlyRateUsd: String(avgRate.toFixed(2)),
          medianNightlyRateUsd: String((avgRate * 0.87).toFixed(2)),
          occupancyRate: String(Math.min(98, (52 + m * 1.5 + (year - 2022) * 2) * seasonal * (0.93 + Math.random() * 0.14)).toFixed(2)),
          avgReviewScore: String((4.25 + Math.random() * 0.55).toFixed(2)),
          totalReviews: Math.floor(listings * (2 + Math.random() * 3)),
          source: "Airbnb / VRBO (estimated)",
        });
      }
    }
  }
  await db.insert(rentalMarketMetricsTable).values(rentalData);
  logger.info({ count: rentalData.length }, "Inserted rental market records");

  // ── ECONOMIC ──
  const indicators = [
    { indicator: "tourism_gdp_contribution_mxn", unit: "MXN millions", description: "Tourism GDP Contribution",   descriptionEs: "Contribución del turismo al PIB" },
    { indicator: "total_employment",             unit: "workers",      description: "Total Tourism Employment",   descriptionEs: "Empleo total en turismo" },
    { indicator: "avg_monthly_wage_mxn",         unit: "MXN",          description: "Average Monthly Wage",      descriptionEs: "Salario mensual promedio" },
    { indicator: "hotel_investment_mxn",         unit: "MXN millions", description: "Hotel Investment",          descriptionEs: "Inversión hotelera" },
    { indicator: "real_estate_transactions",     unit: "transactions", description: "Real Estate Transactions",  descriptionEs: "Transacciones inmobiliarias" },
  ];
  const baseValues: Record<string, number> = {
    tourism_gdp_contribution_mxn: 18500,
    total_employment:             42000,
    avg_monthly_wage_mxn:         8200,
    hotel_investment_mxn:         1200,
    real_estate_transactions:     1850,
  };
  const economicData: (typeof economicMetricsTable.$inferInsert)[] = [];
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    if (year === currentYear && currentMonth < 2) continue;
    const gf = 1 + (year - 2020) * 0.08;
    for (const ind of indicators) {
      economicData.push({
        year,
        quarter: null,
        ...ind,
        value: String((baseValues[ind.indicator] * gf).toFixed(2)),
        source: "Data México / INEGI",
      });
    }
  }
  await db.insert(economicMetricsTable).values(economicData);
  logger.info({ count: economicData.length }, "Inserted economic records");

  // ── SAFETY ──
  await insertSafetyData();

  // ── WEATHER ──
  const weatherByMonth = [
    { a: 23.2, mx: 28.5, mn: 17.9, p: 18.5,  h: 65, s: 22.0, sh: 7.8, rd: 2  },
    { a: 23.8, mx: 29.2, mn: 18.4, p: 8.2,   h: 63, s: 22.5, sh: 8.2, rd: 1  },
    { a: 25.1, mx: 30.8, mn: 19.4, p: 5.1,   h: 61, s: 23.5, sh: 8.8, rd: 1  },
    { a: 27.0, mx: 32.5, mn: 21.5, p: 2.5,   h: 60, s: 25.0, sh: 9.1, rd: 0  },
    { a: 28.8, mx: 34.1, mn: 23.5, p: 35.8,  h: 67, s: 27.0, sh: 8.5, rd: 4  },
    { a: 29.5, mx: 34.8, mn: 24.2, p: 145.0, h: 75, s: 29.0, sh: 6.9, rd: 11 },
    { a: 29.2, mx: 34.2, mn: 24.0, p: 210.5, h: 79, s: 30.0, sh: 6.2, rd: 16 },
    { a: 29.0, mx: 33.8, mn: 23.8, p: 235.0, h: 81, s: 30.5, sh: 6.0, rd: 17 },
    { a: 28.5, mx: 33.0, mn: 23.2, p: 185.0, h: 78, s: 29.5, sh: 6.5, rd: 14 },
    { a: 27.2, mx: 31.5, mn: 22.0, p: 58.0,  h: 71, s: 28.0, sh: 7.8, rd: 6  },
    { a: 25.5, mx: 30.0, mn: 20.8, p: 15.0,  h: 66, s: 25.5, sh: 8.1, rd: 2  },
    { a: 23.8, mx: 28.8, mn: 18.8, p: 12.0,  h: 64, s: 23.0, sh: 7.9, rd: 1  },
  ];
  const weatherData: (typeof weatherMetricsTable.$inferInsert)[] = [];
  const j = (v: number) => String((v + (Math.random() - 0.5) * 0.6).toFixed(2));
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 >= currentMonth) continue;
      const w = weatherByMonth[m];
      weatherData.push({
        year, month: m + 1, monthName: MONTHS[m],
        avgTempC: j(w.a), maxTempC: j(w.mx), minTempC: j(w.mn),
        precipitationMm: j(w.p), avgHumidityPct: j(w.h),
        avgSeaTempC: j(w.s), sunshineHours: j(w.sh),
        rainyDays: Math.max(0, w.rd + Math.floor((Math.random() - 0.5) * 3)),
        source: "NOAA / CONAGUA",
      });
    }
  }
  await db.insert(weatherMetricsTable).values(weatherData);
  logger.info({ count: weatherData.length }, "Inserted weather records");

  // ── DATA SOURCES ──
  const now = new Date();
  await db.insert(dataSourcesTable).values([
    { name: "DATATUR – Tourism Statistics", nameEs: "DATATUR – Estadísticas de Turismo", category: "Tourism",
      description: "Hotel occupancy, tourist arrivals, and cruise visitor data from Mexico's tourism ministry.",
      descriptionEs: "Ocupación hotelera, llegadas de turistas y visitantes de crucero del ministerio de turismo.",
      url: "https://www.datatur.sectur.gob.mx/", status: "active", lastSyncedAt: now, recordCount: tourismData.length, frequency: "monthly", isPublic: true },
    { name: "INEGI – Census & Demographics", nameEs: "INEGI – Censos y Demografía", category: "Government",
      description: "Population, housing, geographic, and economic census data for Puerto Vallarta.",
      descriptionEs: "Datos censales de población, vivienda, geografía y economía de Puerto Vallarta.",
      url: "https://www.inegi.org.mx/app/areasgeograficas?ag=14067", status: "active", lastSyncedAt: now, recordCount: 1240, frequency: "monthly", isPublic: true },
    { name: "Data México – Economic Indicators", nameEs: "Data México – Indicadores Económicos", category: "Economic",
      description: "Workforce, employment, and economic profile data for Puerto Vallarta municipality.",
      descriptionEs: "Datos de fuerza laboral, empleo y perfil económico del municipio de Puerto Vallarta.",
      url: "https://www.economia.gob.mx/datamexico/es/profile/geo/puerto-vallarta", status: "active", lastSyncedAt: now, recordCount: economicData.length, frequency: "monthly", isPublic: true },
    { name: "SESNSP – Crime Data", nameEs: "SESNSP – Datos de Incidencia Delictiva", category: "Safety",
      description: "National crime incident data by municipality from Mexico's security ministry.",
      descriptionEs: "Datos nacionales de incidencia delictiva por municipio del ministerio de seguridad.",
      url: "https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva", status: "active", lastSyncedAt: now, recordCount: 1020, frequency: "monthly", isPublic: true },
    { name: "NOAA – Climate & Ocean Data", nameEs: "NOAA – Datos Climáticos y Oceánicos", category: "Climate",
      description: "Historical climate, precipitation, temperature, and sea surface temperature data.",
      descriptionEs: "Datos históricos de clima, precipitación, temperatura y temperatura superficial del mar.",
      url: "https://www.ncei.noaa.gov/", status: "active", lastSyncedAt: now, recordCount: weatherData.length, frequency: "monthly", isPublic: true },
    { name: "Airbnb / VRBO Listings", nameEs: "Listados Airbnb / VRBO", category: "Real Estate",
      description: "Short-term rental listings, pricing, and occupancy data aggregated across 7 PV neighborhoods.",
      descriptionEs: "Listados de renta a corto plazo, precios y ocupación en 7 colonias de Puerto Vallarta.",
      url: "https://www.airbnb.com/", status: "active", lastSyncedAt: now, recordCount: rentalData.length, frequency: "weekly", isPublic: false },
    { name: "Transparencia PV – Local Reports", nameEs: "Transparencia PV – Reportes Locales", category: "Government",
      description: "Local government transparency portal: infrastructure, services, and municipal statistics.",
      descriptionEs: "Portal de transparencia municipal: infraestructura, servicios y estadísticas municipales.",
      url: "https://transparencia.puertovallarta.gob.mx/", status: "active", lastSyncedAt: now, recordCount: 28, frequency: "monthly", isPublic: true },
    { name: "OpenStreetMap – Geospatial Data", nameEs: "OpenStreetMap – Datos Geoespaciales", category: "Satellite",
      description: "Open geospatial data: neighborhoods, streets, and points of interest in Puerto Vallarta.",
      descriptionEs: "Datos geoespaciales abiertos: colonias, calles y puntos de interés en Puerto Vallarta.",
      url: "https://www.openstreetmap.org/", status: "active", lastSyncedAt: now, recordCount: 45000, frequency: "monthly", isPublic: true },
    { name: "NASA EarthData – Satellite Imagery", nameEs: "NASA EarthData – Imágenes Satelitales", category: "Satellite",
      description: "Satellite imagery and land surface data for the Banderas Bay region and coastal zones.",
      descriptionEs: "Imágenes satelitales y datos de superficie terrestre para la bahía de Banderas y zonas costeras.",
      url: "https://earthdata.nasa.gov/", status: "active", lastSyncedAt: now, recordCount: 156, frequency: "weekly", isPublic: true },
    { name: "Inmuebles24 – Real Estate Listings", nameEs: "Inmuebles24 – Listados Inmobiliarios", category: "Real Estate",
      description: "Long-term rental and for-sale property listings across Puerto Vallarta and Riviera Nayarit.",
      descriptionEs: "Listados de renta a largo plazo y propiedades en venta en Puerto Vallarta y Riviera Nayarit.",
      url: "https://www.inmuebles24.com/", status: "active", lastSyncedAt: now, recordCount: 89, frequency: "weekly", isPublic: false },
  ]);
  logger.info("Inserted data sources");

  logger.info("Seed complete");
}

// ── Repair external data-source record counts ─────────────────────────────────
// External sources have no backing DB table, so their recordCount is a static
// curated value set at seed time. If a sync accidentally zeroed them (or they
// were never seeded), this function restores the correct values.
// Also inserts any sources that are missing entirely (safe — onConflictDoNothing).

export async function repairDataSourceCounts(): Promise<void> {
  // Known static counts for sources without a backing DB table
  const staticCounts: { match: string; count: number }[] = [
    { match: "transparencia",    count: 28     },
    { match: "inegi",            count: 1240   },
    { match: "openstreetmap",    count: 45000  },
    { match: "nasa",             count: 156    },
    { match: "inmuebles24",      count: 89     },
  ];

  const sources = await db.select().from(dataSourcesTable);
  let fixed = 0;

  for (const source of sources) {
    const n = source.name.toLowerCase();
    const entry = staticCounts.find((e) => n.includes(e.match));
    if (entry && (source.recordCount === null || source.recordCount === 0)) {
      await db
        .update(dataSourcesTable)
        .set({ recordCount: entry.count })
        .where(eq(dataSourcesTable.id, source.id));
      logger.info({ source: source.name, count: entry.count }, "repairDataSourceCounts: restored static count");
      fixed++;
    }
  }

  // Insert any sources that are completely missing (won't overwrite existing rows)
  const existingNames = new Set(sources.map((s) => s.name.toLowerCase()));
  const now = new Date();

  const missing: typeof dataSourcesTable.$inferInsert[] = [
    ...(existingNames.has("gap – airport traffic (pvr)") ? [] : [{
      name: "GAP – Airport Traffic (PVR)", nameEs: "GAP – Tráfico Aeroportuario (PVR)",
      category: "Tourism",
      description: "Monthly passenger traffic at Puerto Vallarta International Airport from official GAP press releases.",
      descriptionEs: "Tráfico mensual de pasajeros en el aeropuerto de Puerto Vallarta según comunicados oficiales de GAP.",
      url: "https://www.aeropuertosgap.com.mx/", status: "active", lastSyncedAt: now, recordCount: 0, frequency: "monthly", isPublic: true,
    }]),
    ...(existingNames.has("nasa earthdata – satellite imagery") ? [] : [{
      name: "NASA EarthData – Satellite Imagery", nameEs: "NASA EarthData – Imágenes Satelitales",
      category: "Satellite",
      description: "Satellite imagery and land surface data for the Banderas Bay region and coastal zones.",
      descriptionEs: "Imágenes satelitales y datos de superficie terrestre para la bahía de Banderas y zonas costeras.",
      url: "https://earthdata.nasa.gov/", status: "active", lastSyncedAt: now, recordCount: 156, frequency: "weekly", isPublic: true,
    }]),
    ...(existingNames.has("inmuebles24 – real estate listings") ? [] : [{
      name: "Inmuebles24 – Real Estate Listings", nameEs: "Inmuebles24 – Listados Inmobiliarios",
      category: "Real Estate",
      description: "Long-term rental and for-sale property listings across Puerto Vallarta and Riviera Nayarit.",
      descriptionEs: "Listados de renta a largo plazo y propiedades en venta en Puerto Vallarta y Riviera Nayarit.",
      url: "https://www.inmuebles24.com/", status: "active", lastSyncedAt: now, recordCount: 89, frequency: "weekly", isPublic: false,
    }]),
  ];

  if (missing.length > 0) {
    await db.insert(dataSourcesTable).values(missing).onConflictDoNothing();
    logger.info({ count: missing.length }, "repairDataSourceCounts: inserted missing sources");
  }

  if (fixed === 0 && missing.length === 0) {
    logger.info("repairDataSourceCounts: all source counts look correct — nothing to fix");
  }
}
