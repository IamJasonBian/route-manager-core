# Claude Code Instructions

## Git Commits

When creating git commits:
- Do NOT include the "Generated with Claude Code" tag
- Do NOT include the robot emoji or Claude Code link
- Do NOT include the Co-Authored-By line for Claude
- Keep commit messages clean and professional

---

## Overview

Apollo Flight Trader (Route Manager) is a flight price monitoring and booking optimization tool. It enables last-minute travel by prebooking commonly taken flights at flex/main levels, allowing for spontaneous trips and upgrades while reducing airport planning overhead.

### Key Features
- Low latency flight price monitoring with historical and volatility analysis
- Route management for tracking common flight routes and pricing
- Flight search via Kiwi.com's public, credential-less API (Amadeus retired 2026-07-17)
- Planned: Booking, rescheduling, and buying agent

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS, Radix UI |
| Charts | Recharts, Chart.js |
| Backend | Netlify Functions (serverless) |
| API | Kiwi.com public search (MCP) |
| Deployment | Netlify (manual `make deploy-<env>`) |

## Development Commands

```bash
# Install dependencies
npm install

# Start development server (frontend + Netlify functions)
npm run dev:clean

# Build for production
npm run build

# Preview production build
npm run preview

# Run tests
npm test
npm run test:watch

# Linting
npm run lint

# Deploy to Netlify
npm run deploy

```

## Workspace Structure

**IMPORTANT**: Only look inside the directories defined below. Do not explore or modify files outside this structure.

```
monterrey/
├── src/
│   ├── components/       # React components
│   │   ├── ui/           # Reusable UI primitives (Radix-based)
│   │   ├── FlightSearch.tsx
│   │   ├── RoutesDashboard.tsx
│   │   ├── PriceChart.tsx
│   │   └── ...
│   ├── pages/            # Page components
│   ├── services/         # API service layers
│   ├── types/            # TypeScript type definitions
│   ├── utils/            # Utility functions
│   ├── config/           # Configuration files
│   └── lib/              # Shared libraries
├── netlify/
│   └── functions/        # Serverless API endpoints
│       ├── search-flights.js
│       ├── flight-prices.js
│       ├── airport-search.js
│       ├── health.js
│       └── ...
```

## Architecture Patterns

### Frontend
- **Component Structure**: Functional components with hooks
- **State Management**: React useState/useEffect (no Redux)

### Backend (Netlify Functions)
- **Pattern**: Serverless functions with CORS middleware
- **API Integration**: `netlify/functions/lib/kiwi.js` (Kiwi MCP), mapped to the FlightOffer shape

### Deployment
- **Environments**: Alpha (development), Gamma (staging), and Prod (protected)
- **CI/CD**: none for now; manual `make deploy-<env>` (see "Releases" below)
- **CDK**: Optional AWS CDK infrastructure in `/cdk` directory
- **Alpha Site ID**: `b26b3133-30c1-46f3-b976-59ab7c928b57` (hardcoded)

## Authentication

Currently no user authentication implemented. Flight search needs no credentials.

## Backlog

Project backlog: https://github.com/users/IamJasonBian/projects/1

## Environments

| Environment | URL | Site ID |
|-------------|-----|---------|
| Alpha | https://route-manager-alpha.netlify.app/ | b26b3133-30c1-46f3-b976-59ab7c928b57 |
| Gamma | https://route-manager-gamma.netlify.app/ | (GitHub secret) |
| Prod | https://route-manager-prod.netlify.app/ | (GitHub secret) |

## Releases

CI is off (GitHub Actions workflows removed, `NETLIFY_AUTH_TOKEN` secret deleted).
Deploys are manual, from a clean checkout, with your own `netlify login`:

```bash
make deploy-alpha     # route-manager-alpha
make deploy-gamma     # route-manager-gamma
make deploy-prod      # route-manager-prod
```

`_deploy` refuses a dirty tree, runs `npm ci` for the app and functions, then
`netlify deploy --build --prod --site <id>`. `make release-*` still bumps,
tags and pushes, but no longer deploys.
