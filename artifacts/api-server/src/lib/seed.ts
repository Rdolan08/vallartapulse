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

export async function seedIfEmpty(): Promise<void> {
  const [{ value: existing }] = await db.select({ value: count() }).from(tourismMetricsTable);
  if (existing > 0) {
    logger.info({ existing }, "Database already seeded, skipping");
    // Still check if safety needs upgrading
    await reseedSafetyIfOutdated();
    return;
  }

  logger.info("Database is empty — seeding now…");

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // ── TOURISM ──
  const baseOccupancy = [62, 65, 71, 68, 58, 55, 60, 63, 59, 67, 74, 78];
  const baseArrivals  = [85000, 88000, 102000, 95000, 72000, 68000, 74000, 79000, 71000, 90000, 105000, 115000];
  const tourismData: (typeof tourismMetricsTable.$inferInsert)[] = [];
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    const yGrowth = 1 + (year - 2022) * 0.04;
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 >= currentMonth) continue;
      tourismData.push({
        year,
        month: m + 1,
        monthName: MONTHS[m],
        hotelOccupancyRate: String(((baseOccupancy[m] + (year - 2022) * 2.5) * yGrowth).toFixed(2)),
        totalHotelRooms: 13200,
        internationalArrivals: Math.floor(baseArrivals[m] * 0.63 * yGrowth),
        domesticArrivals: Math.floor(baseArrivals[m] * 0.37 * yGrowth),
        totalArrivals: Math.floor(baseArrivals[m] * yGrowth),
        cruiseVisitors: Math.floor(16000 + m * 900 + (year - 2022) * 1200),
        avgHotelRateUsd: String(((120 + m * 5 + (year - 2022) * 9) * yGrowth).toFixed(2)),
        revenuePerAvailableRoomUsd: String(((75 + m * 3 + (year - 2022) * 6) * yGrowth).toFixed(2)),
        source: "DATATUR / SECTUR",
      });
    }
  }
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
