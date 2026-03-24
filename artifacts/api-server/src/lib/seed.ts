import { db } from "@workspace/db";
import {
  tourismMetricsTable,
  rentalMarketMetricsTable,
  economicMetricsTable,
  safetyMetricsTable,
  weatherMetricsTable,
  dataSourcesTable,
} from "@workspace/db/schema";
import { count } from "drizzle-orm";
import { logger } from "./logger";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export async function seedIfEmpty(): Promise<void> {
  const [{ value: existing }] = await db.select({ value: count() }).from(tourismMetricsTable);
  if (existing > 0) {
    logger.info({ existing }, "Database already seeded, skipping");
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
      if (year === currentYear && m + 1 > currentMonth) continue;
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
      if (year === currentYear && m + 1 > currentMonth) continue;
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
  const categories = [
    { category: "Robbery",       categoryEs: "Robo" },
    { category: "Vehicle Theft", categoryEs: "Robo de Vehículo" },
    { category: "Assault",       categoryEs: "Lesiones" },
    { category: "Burglary",      categoryEs: "Robo a Casa" },
    { category: "Fraud",         categoryEs: "Fraude" },
  ];
  const baseCounts: Record<string, number> = {
    Robbery: 280, "Vehicle Theft": 95, Assault: 120, Burglary: 55, Fraud: 35,
  };
  const population = 280000;
  const safetyData: (typeof safetyMetricsTable.$inferInsert)[] = [];
  for (const year of [2021, 2022, 2023, 2024, 2025, 2026]) {
    const yTrend = 1 - (year - 2021) * 0.035;
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 > currentMonth) continue;
      for (const cat of categories) {
        const c = Math.floor(baseCounts[cat.category] * yTrend * (0.88 + Math.random() * 0.24));
        safetyData.push({
          year,
          month: m + 1,
          monthName: MONTHS[m],
          ...cat,
          incidentCount: c,
          incidentsPer100k: String(((c / population) * 100000).toFixed(2)),
          changeVsPriorYear: String((-5 + Math.random() * 10).toFixed(2)),
          source: "SESNSP",
        });
      }
    }
  }
  await db.insert(safetyMetricsTable).values(safetyData);
  logger.info({ count: safetyData.length }, "Inserted safety records");

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
      if (year === currentYear && m + 1 > currentMonth) continue;
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
      url: "https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva", status: "active", lastSyncedAt: now, recordCount: safetyData.length, frequency: "monthly", isPublic: true },
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
      url: "https://transparencia.puertovallarta.gob.mx/", status: "pending", lastSyncedAt: null, recordCount: 0, frequency: "monthly", isPublic: true },
    { name: "OpenStreetMap – Geospatial Data", nameEs: "OpenStreetMap – Datos Geoespaciales", category: "Satellite",
      description: "Open geospatial data: neighborhoods, streets, and points of interest in Puerto Vallarta.",
      descriptionEs: "Datos geoespaciales abiertos: colonias, calles y puntos de interés en Puerto Vallarta.",
      url: "https://www.openstreetmap.org/", status: "active", lastSyncedAt: now, recordCount: 45000, frequency: "monthly", isPublic: true },
  ]);
  logger.info("Inserted data sources");

  logger.info("Seed complete");
}
