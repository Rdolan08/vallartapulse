# VallartaPulse

**Business intelligence for Puerto Vallarta's short-term rental market.**

Live at [www.vallartapulse.com](https://www.vallartapulse.com) — a bilingual (EN/ES) data platform built for property managers and rental owners across greater Bahía de Banderas.

---

## What It Does

VallartaPulse aggregates data from multiple sources to give rental owners a clear, unbiased view of the Puerto Vallarta market:

- **Rental Pricing Tool** — Comp-based nightly rate guidance powered by 192+ multi-source listings. A 7-layer pricing stack accounts for neighborhood, beach distance, view type, rooftop pool, seasonality, guest rating, and amenity quality.
- **Tourism Metrics** — Hotel occupancy, tourist arrivals, and average nightly rates from DATATUR and SECTUR, updated monthly.
- **Rental Market** — Active listing counts, nightly rate benchmarks, and occupancy trends by neighborhood.
- **Economic Indicators** — Peso/dollar exchange rates, inflation, and regional economic context from Banxico.
- **Safety & Crime** — Crime index trends and neighborhood comparisons for investor context.
- **Weather & Climate** — Monthly temperature, rainfall, and humidity to understand demand seasonality.
- **Data Sources** — Full transparency on every data source, refresh cadence, and validation method.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, Wouter, Framer Motion |
| Backend | Node.js, Express, TypeScript, Pino logging |
| Database | PostgreSQL (Drizzle ORM) |
| Monorepo | pnpm workspaces |
| Email | Nodemailer (Gmail SMTP) |
| Deployment | Node.js host (any platform) |

---

## Project Structure

```
/
├── artifacts/
│   ├── pv-datastore/        # React frontend (Vite)
│   │   ├── src/
│   │   │   ├── pages/       # Dashboard, Pricing Tool, Tourism, etc.
│   │   │   ├── components/  # Layout, UI, charts
│   │   │   └── contexts/    # Language (EN/ES)
│   │   ├── about/           # Standalone About page entry point
│   │   ├── contact/         # Standalone Contact page entry point
│   │   ├── pricing-tool/    # Page-specific OG meta entry points
│   │   ├── tourism/
│   │   └── ...
│   └── api-server/          # Express API
│       └── src/
│           ├── routes/      # API endpoints
│           └── lib/
│               ├── comps-engine-v3.ts    # 7-layer pricing engine
│               ├── pv-seasonality.ts     # 12-month + 11-event multipliers
│               └── building-lookup.ts    # 30+ known PV buildings
└── packages/
    └── db/                  # Drizzle schema + migrations
```

---

## Pricing Engine

The `comps-engine-v3` applies seven sequential pricing layers:

1. **Comp median** — Filtered comparable listings from the database
2. **Building premium** — Known building-level price factors
3. **Beach tier** — Distance-to-beach pricing tiers (Beachfront → 6-10 blocks)
4. **Seasonality** — 12 monthly multipliers (Sep 0.68× → Mar 1.20×) plus 11 event overlays
5. **View premium** — Ocean +20%, Partial +10%, City +2%, Garden 0%, None −2%
6. **Rooftop pool** — +12–15% over standard pool
7. **Quality score** — Guest rating + amenity breadth composite

Neighborhoods covered: Zona Romántica, Centro, Versalles, 5 de Diciembre, Marina Vallarta, Conchas Chinas, Amapas, Fluvial, Emiliano Zapata, Pitillal, Nuevo Vallarta, Bucerias, La Cruz, Punta Mita, Sayulita, San Pancho, and more.

---

## Data Sources

| Source | Data Type | Refresh |
|---|---|---|
| Airbnb | Listings, rates, reviews | Weekly |
| VRBO | Listings, rates | Weekly |
| Booking.com | Listings, rates | Weekly |
| Vacation Vallarta | Local agency listings | Monthly |
| DATATUR / SECTUR | Hotel occupancy, tourist arrivals | Monthly |
| Banxico | Exchange rates, inflation | Monthly |
| Local agencies | Off-platform comps | Ongoing |
| Manual / CSV | Owner-submitted data | As provided |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Server port (default: `8080` for API, `5173` for frontend) |
| `BASE_PATH` | Frontend URL prefix (default: `/`) |
| `CONTACT_FROM_EMAIL` | Gmail address used to send contact form submissions |
| `CONTACT_TO_EMAIL` | Destination email for contact form submissions |
| `CONTACT_FROM_PASSWORD` | Gmail App Password (stored as secret) |

---

## About

VallartaPulse was founded by **Ryan Dolan** — a 20+ year veteran of AI, data, and technology, including leadership roles in the U.S. federal government. Ryan is an owner at [Ciye](https://www.vallartapulse.com/about), an upcoming development on Lázaro Cárdenas Park in Puerto Vallarta's Zona Romántica.

He built VallartaPulse from the perspective of someone actively investing in the area — not just analyzing it from the outside.

---

## Contact

Questions, data requests, or feedback → [www.vallartapulse.com/contact](https://www.vallartapulse.com/contact)
