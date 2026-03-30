# WebWaka Transport Suite

## Overview
WebWaka Transport is the Transportation & Mobility vertical suite (Part 10.3) of the WebWaka OS v4 ecosystem. It is a comprehensive, mobile-first, offline-first platform for seat inventory management, agent sales, customer booking, and operator management — targeted at Nigerian and African markets.

## Modules
- **TRN-1**: Seat Inventory Synchronization — atomic validation and sync of seat availability
- **TRN-2**: Agent Sales Application — offline-first POS for bus park agents
- **TRN-3**: Customer Booking Portal — public-facing trip search and booking
- **TRN-4**: Operator Management — tools for transport companies to manage routes/vehicles

## Tech Stack
- **Frontend**: React 19 + TypeScript + Vite 8 (PWA, mobile-first)
- **Backend**: Cloudflare Workers + Hono framework (not run locally)
- **Database**: Cloudflare D1 (server), Dexie.js/IndexedDB (client offline storage)
- **Package Manager**: npm

## Project Structure
```
src/
  app.tsx          - Main React application shell
  main.tsx         - Entry point, service worker registration
  api/             - Hono API route handlers (for Cloudflare Workers)
  core/            - Business logic modules
    booking/       - Booking domain logic
    i18n/          - Africa-First internationalization (en, yo, ig, ha)
    offline/       - Dexie.js DB schema + sync logic
    sales/         - Agent sales logic
    seat-inventory/- Seat inventory management
    trip-state/    - Trip state machine
  middleware/      - JWT auth middleware
  worker.ts        - Cloudflare Worker entry point
migrations/        - SQL migrations for Cloudflare D1
public/            - Static assets, PWA manifest, service worker
```

## Local Development
The frontend runs as a Vite dev server on port 5000. The backend (Cloudflare Worker) is not run locally — the app connects to the production API by default.

### Start the app
```bash
npm run dev:ui
```

## Dependencies
- `@webwaka/core` — Local stub at `/home/runner/webwaka-core/` (symlinked from node_modules). Provides JWT auth middleware and role-based access control stubs for local development.
- `dexie` — IndexedDB wrapper for offline-first storage
- `hono` — Web framework for Cloudflare Workers
- `react` + `react-dom` — UI framework

## Deployment
Configured as a static site deployment:
- Build: `npm run build:ui`
- Output: `dist/` directory

## Design Principles
- **Nigeria-First**: Naira/kobo currency, Nigerian timezones, NDPR compliance
- **Offline-First**: Transactions queued locally in IndexedDB, synced via Service Workers
- **Africa-First i18n**: English, Yoruba, Hausa, Igbo
- **Mobile-First**: UI designed for mobile devices at bus parks
