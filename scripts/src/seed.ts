import { db } from "@workspace/db";
import {
  tourismMetricsTable,
  rentalMarketMetricsTable,
  economicMetricsTable,
  safetyMetricsTable,
  weatherMetricsTable,
  dataSourcesTable,
} from "@workspace/db/schema";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function seed() {
  console.log("Seeding PV DataStore database...");

  await db.delete(tourismMetricsTable);
  await db.delete(rentalMarketMetricsTable);
  await db.delete(economicMetricsTable);
  await db.delete(safetyMetricsTable);
  await db.delete(weatherMetricsTable);
  await db.delete(dataSourcesTable);

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // ─── TOURISM METRICS (2022-2026) ──────────────────────────────────────────
  const tourismData = [];
  const baseOccupancy = [62, 65, 71, 68, 58, 55, 60, 63, 59, 67, 74, 78];
  const baseArrivals   = [85000, 88000, 102000, 95000, 72000, 68000, 74000, 79000, 71000, 90000, 105000, 115000];

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
  console.log(`Inserted ${tourismData.length} tourism records`);

  // ─── RENTAL MARKET METRICS ────────────────────────────────────────────────
  // Correct PV neighborhoods per user
  const neighborhoods = [
    { name: "Zona Romántica", baseRate: 145, baseListings: 680 },
    { name: "Centro", baseRate: 98, baseListings: 420 },
    { name: "Conchas Chinas / Amapas", baseRate: 235, baseListings: 280 },
    { name: "Versalles", baseRate: 88, baseListings: 310 },
    { name: "Hotel Zone", baseRate: 175, baseListings: 520 },
    { name: "Marina Vallarta", baseRate: 165, baseListings: 590 },
    { name: "5 de Diciembre", baseRate: 105, baseListings: 265 },
  ];

  const rentalData = [];
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    const yGrowth = 1 + (year - 2022) * 0.065;
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 > currentMonth) continue;
      for (const hood of neighborhoods) {
        // High season: Dec-Apr; Low season: Jun-Sep
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
  console.log(`Inserted ${rentalData.length} rental market records`);

  // ─── ECONOMIC METRICS (2020-2026) ────────────────────────────────────────
  const economicData = [];
  const indicators = [
    { indicator: "tourism_gdp_contribution_mxn", unit: "MXN millions", description: "Tourism GDP Contribution", descriptionEs: "Contribución del turismo al PIB" },
    { indicator: "total_employment", unit: "workers", description: "Total Tourism Employment", descriptionEs: "Empleo total en turismo" },
    { indicator: "avg_monthly_wage_mxn", unit: "MXN", description: "Average Monthly Wage", descriptionEs: "Salario mensual promedio" },
    { indicator: "hotel_investment_mxn", unit: "MXN millions", description: "Hotel Investment", descriptionEs: "Inversión hotelera" },
    { indicator: "real_estate_transactions", unit: "transactions", description: "Real Estate Transactions", descriptionEs: "Transacciones inmobiliarias" },
  ];
  const baseValues: Record<string, number> = {
    "tourism_gdp_contribution_mxn": 18500,
    "total_employment": 42000,
    "avg_monthly_wage_mxn": 8200,
    "hotel_investment_mxn": 1200,
    "real_estate_transactions": 1850,
  };
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    if (year === currentYear && currentMonth < 2) continue;
    const growthFactor = 1 + (year - 2020) * 0.08;
    for (const ind of indicators) {
      economicData.push({
        year,
        quarter: null,
        ...ind,
        value: String((baseValues[ind.indicator] * growthFactor).toFixed(2)),
        source: "Data México / INEGI",
      });
    }
  }
  await db.insert(economicMetricsTable).values(economicData);
  console.log(`Inserted ${economicData.length} economic records`);

  // ─── SAFETY METRICS (2021-2026) ───────────────────────────────────────────
  const safetyData = [];
  const categories = [
    { category: "Robbery", categoryEs: "Robo" },
    { category: "Vehicle Theft", categoryEs: "Robo de Vehículo" },
    { category: "Assault", categoryEs: "Lesiones" },
    { category: "Burglary", categoryEs: "Robo a Casa" },
    { category: "Fraud", categoryEs: "Fraude" },
  ];
  const baseCounts: Record<string, number> = {
    "Robbery": 280, "Vehicle Theft": 95, "Assault": 120, "Burglary": 55, "Fraud": 35,
  };
  const population = 280000;
  for (const year of [2021, 2022, 2023, 2024, 2025, 2026]) {
    const yTrend = 1 - (year - 2021) * 0.035;
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 > currentMonth) continue;
      for (const cat of categories) {
        const count = Math.floor(baseCounts[cat.category] * yTrend * (0.88 + Math.random() * 0.24));
        safetyData.push({
          year,
          month: m + 1,
          monthName: MONTHS[m],
          ...cat,
          incidentCount: count,
          incidentsPer100k: String(((count / population) * 100000).toFixed(2)),
          changeVsPriorYear: String((-5 + Math.random() * 10).toFixed(2)),
          source: "SESNSP",
        });
      }
    }
  }
  await db.insert(safetyMetricsTable).values(safetyData);
  console.log(`Inserted ${safetyData.length} safety records`);

  // ─── WEATHER METRICS (2020-2026) ──────────────────────────────────────────
  const weatherData = [];
  const weatherByMonth = [
    { avgTempC: 23.2, maxTempC: 28.5, minTempC: 17.9, precipMm: 18.5, humidity: 65, seaTemp: 22.0, sunshine: 7.8, rainyDays: 2 },
    { avgTempC: 23.8, maxTempC: 29.2, minTempC: 18.4, precipMm: 8.2, humidity: 63, seaTemp: 22.5, sunshine: 8.2, rainyDays: 1 },
    { avgTempC: 25.1, maxTempC: 30.8, minTempC: 19.4, precipMm: 5.1, humidity: 61, seaTemp: 23.5, sunshine: 8.8, rainyDays: 1 },
    { avgTempC: 27.0, maxTempC: 32.5, minTempC: 21.5, precipMm: 2.5, humidity: 60, seaTemp: 25.0, sunshine: 9.1, rainyDays: 0 },
    { avgTempC: 28.8, maxTempC: 34.1, minTempC: 23.5, precipMm: 35.8, humidity: 67, seaTemp: 27.0, sunshine: 8.5, rainyDays: 4 },
    { avgTempC: 29.5, maxTempC: 34.8, minTempC: 24.2, precipMm: 145.0, humidity: 75, seaTemp: 29.0, sunshine: 6.9, rainyDays: 11 },
    { avgTempC: 29.2, maxTempC: 34.2, minTempC: 24.0, precipMm: 210.5, humidity: 79, seaTemp: 30.0, sunshine: 6.2, rainyDays: 16 },
    { avgTempC: 29.0, maxTempC: 33.8, minTempC: 23.8, precipMm: 235.0, humidity: 81, seaTemp: 30.5, sunshine: 6.0, rainyDays: 17 },
    { avgTempC: 28.5, maxTempC: 33.0, minTempC: 23.2, precipMm: 185.0, humidity: 78, seaTemp: 29.5, sunshine: 6.5, rainyDays: 14 },
    { avgTempC: 27.2, maxTempC: 31.5, minTempC: 22.0, precipMm: 58.0, humidity: 71, seaTemp: 28.0, sunshine: 7.8, rainyDays: 6 },
    { avgTempC: 25.5, maxTempC: 30.0, minTempC: 20.8, precipMm: 15.0, humidity: 66, seaTemp: 25.5, sunshine: 8.1, rainyDays: 2 },
    { avgTempC: 23.8, maxTempC: 28.8, minTempC: 18.8, precipMm: 12.0, humidity: 64, seaTemp: 23.0, sunshine: 7.9, rainyDays: 1 },
  ];
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    for (let m = 0; m < 12; m++) {
      if (year === currentYear && m + 1 > currentMonth) continue;
      const w = weatherByMonth[m];
      const j = (v: number) => String((v + (Math.random() - 0.5) * 0.6).toFixed(2));
      weatherData.push({
        year,
        month: m + 1,
        monthName: MONTHS[m],
        avgTempC: j(w.avgTempC),
        maxTempC: j(w.maxTempC),
        minTempC: j(w.minTempC),
        precipitationMm: j(w.precipMm),
        avgHumidityPct: j(w.humidity),
        avgSeaTempC: j(w.seaTemp),
        sunshineHours: j(w.sunshine),
        rainyDays: Math.max(0, w.rainyDays + Math.floor((Math.random() - 0.5) * 3)),
        source: "NOAA / CONAGUA",
      });
    }
  }
  await db.insert(weatherMetricsTable).values(weatherData);
  console.log(`Inserted ${weatherData.length} weather records`);

  // ─── DATA SOURCES ─────────────────────────────────────────────────────────
  const now = new Date();
  const sources = [
    {
      name: "DATATUR – Tourism Statistics", nameEs: "DATATUR – Estadísticas de Turismo",
      category: "Tourism", description: "Hotel occupancy, tourist arrivals, and cruise visitor data from Mexico's tourism ministry.",
      descriptionEs: "Ocupación hotelera, llegadas de turistas y visitantes de crucero del ministerio de turismo.",
      url: "https://www.datatur.sectur.gob.mx/", status: "active",
      lastSyncedAt: now, recordCount: tourismData.length, frequency: "monthly", isPublic: true,
    },
    {
      name: "INEGI – Census & Demographics", nameEs: "INEGI – Censos y Demografía",
      category: "Government", description: "Population, housing, geographic, and economic census data for Puerto Vallarta.",
      descriptionEs: "Datos censales de población, vivienda, geografía y economía de Puerto Vallarta.",
      url: "https://www.inegi.org.mx/app/areasgeograficas?ag=14067", status: "active",
      lastSyncedAt: now, recordCount: 1240, frequency: "monthly", isPublic: true,
    },
    {
      name: "Data México – Economic Indicators", nameEs: "Data México – Indicadores Económicos",
      category: "Economic", description: "Workforce, employment, and economic profile data for Puerto Vallarta municipality.",
      descriptionEs: "Datos de fuerza laboral, empleo y perfil económico del municipio de Puerto Vallarta.",
      url: "https://www.economia.gob.mx/datamexico/es/profile/geo/puerto-vallarta", status: "active",
      lastSyncedAt: now, recordCount: economicData.length, frequency: "monthly", isPublic: true,
    },
    {
      name: "SESNSP – Crime Data", nameEs: "SESNSP – Datos de Incidencia Delictiva",
      category: "Safety", description: "National crime incident data by municipality from Mexico's security ministry.",
      descriptionEs: "Datos nacionales de incidencia delictiva por municipio del ministerio de seguridad.",
      url: "https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva", status: "active",
      lastSyncedAt: now, recordCount: safetyData.length, frequency: "monthly", isPublic: true,
    },
    {
      name: "NOAA – Climate & Ocean Data", nameEs: "NOAA – Datos Climáticos y Oceánicos",
      category: "Climate", description: "Historical climate, precipitation, temperature, and sea surface temperature data.",
      descriptionEs: "Datos históricos de clima, precipitación, temperatura y temperatura superficial del mar.",
      url: "https://www.ncei.noaa.gov/", status: "active",
      lastSyncedAt: now, recordCount: weatherData.length, frequency: "monthly", isPublic: true,
    },
    {
      name: "Airbnb / VRBO Listings", nameEs: "Listados Airbnb / VRBO",
      category: "Real Estate", description: "Short-term rental listings, pricing, and occupancy data aggregated across 7 PV neighborhoods.",
      descriptionEs: "Listados de renta a corto plazo, precios y ocupación en 7 colonias de Puerto Vallarta.",
      url: "https://www.airbnb.com/", status: "active",
      lastSyncedAt: now, recordCount: rentalData.length, frequency: "weekly", isPublic: false,
    },
    {
      name: "Transparencia PV – Local Reports", nameEs: "Transparencia PV – Reportes Locales",
      category: "Government", description: "Local government transparency portal: infrastructure, services, and municipal statistics.",
      descriptionEs: "Portal de transparencia municipal: infraestructura, servicios y estadísticas municipales.",
      url: "https://transparencia.puertovallarta.gob.mx/", status: "pending",
      lastSyncedAt: null, recordCount: 0, frequency: "monthly", isPublic: true,
    },
    {
      name: "NASA EarthData – Satellite Imagery", nameEs: "NASA EarthData – Imágenes Satelitales",
      category: "Satellite", description: "Satellite imagery and environmental data for PV coastal analysis.",
      descriptionEs: "Imágenes satelitales y datos ambientales para análisis costero de PV.",
      url: "https://earthdata.nasa.gov/", status: "pending",
      lastSyncedAt: null, recordCount: 0, frequency: "weekly", isPublic: true,
    },
    {
      name: "OpenStreetMap – Geospatial Data", nameEs: "OpenStreetMap – Datos Geoespaciales",
      category: "Satellite", description: "Open geospatial data: neighborhoods, streets, and points of interest in Puerto Vallarta.",
      descriptionEs: "Datos geoespaciales abiertos: colonias, calles y puntos de interés en Puerto Vallarta.",
      url: "https://www.openstreetmap.org/", status: "active",
      lastSyncedAt: now, recordCount: 45000, frequency: "monthly", isPublic: true,
    },
    {
      name: "Inmuebles24 – Real Estate Listings", nameEs: "Inmuebles24 – Listados Inmobiliarios",
      category: "Real Estate", description: "Long-term rental and purchase listings from Mexico's largest real estate portal.",
      descriptionEs: "Listados de renta y compra a largo plazo del portal inmobiliario más grande de México.",
      url: "https://www.inmuebles24.com/", status: "pending",
      lastSyncedAt: null, recordCount: 0, frequency: "weekly", isPublic: false,
    },
  ];

  await db.insert(dataSourcesTable).values(sources);
  console.log(`Inserted ${sources.length} data sources`);

  console.log("✅ Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
