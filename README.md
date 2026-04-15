# VallartaPulse - > Data-driven pricing and market intelligence for Puerto Vallarta rentals.

**Real-time market intelligence for Puerto Vallarta’s short-term rental economy.**

Live at [www.vallartapulse.com](https://www.vallartapulse.com) — a bilingual (EN/ES) data platform built for property owners, investors, and managers across Bahía de Banderas.

---

## Overview

VallartaPulse aggregates and normalizes data from multiple sources to deliver a clear, unbiased view of the Puerto Vallarta rental market.

It is designed for decision-making—pricing, investment, and portfolio strategy—not just passive analytics.

---

## Core Features

- **Pricing Tool** — Comp-based nightly rate guidance powered by 190+ listings and a 7-layer pricing model accounting for location, seasonality, amenities, and quality
- **Tourism Metrics** — Occupancy, arrivals, and ADR from DATATUR and SECTUR
- **Rental Market** — Active listings, rate benchmarks, and occupancy trends by neighborhood
- **Economic Indicators** — Exchange rates, inflation, and macro signals from Banxico
- **Safety & Crime** — Index trends and neighborhood comparisons for investor context
- **Weather & Climate** — Seasonal patterns influencing demand (temperature, rainfall, humidity)
- **Data Transparency** — Clear sourcing, refresh cadence, and validation methodology

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Node.js, Express |
| Database | PostgreSQL (Drizzle ORM) |
| Monorepo | pnpm workspaces |
| Email | SMTP (Nodemailer) |
| Deployment | Any Node.js-compatible hosting environment |

---

## Architecture
/
├── artifacts/
│   ├── pv-datastore/   # React frontend
│   └── api-server/     # Express API
└── packages/
└── db/             # Schema + migrations
---

## Pricing Engine

The pricing model applies seven sequential adjustments:

1. Comparable listing median  
2. Building-level premium  
3. Beach proximity tier  
4. Seasonality (monthly + event overlays)  
5. View premium (ocean, partial, city, etc.)  
6. Rooftop pool premium  
7. Quality score (rating + amenities)  

Coverage includes all major Puerto Vallarta and Riviera Nayarit neighborhoods.

---

## Data Sources

| Source | Data | Refresh |
|---|---|---|
| Airbnb / VRBO / Booking | Listings, rates, reviews | Weekly |
| Local agencies | Off-platform comps | Monthly |
| DATATUR / SECTUR | Tourism metrics | Monthly |
| Banxico | Economic indicators | Monthly |
| Manual / CSV | Owner data | As provided |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `PORT` | Server port |
| `BASE_PATH` | Frontend base path |
| `CONTACT_FROM_EMAIL` | Sender email |
| `CONTACT_TO_EMAIL` | Recipient email |
| `CONTACT_FROM_PASSWORD` | SMTP credential (stored securely) |

---

## About

VallartaPulse was created by **Ryan Dolan**, a 20+ year leader in AI, data systems, and large-scale technology programs.

The platform is built from direct ownership and investment experience in Puerto Vallarta—not theoretical analysis.

---

## Contact

[www.vallartapulse.com/contact](https://www.vallartapulse.com/contact)
