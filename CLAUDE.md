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
- Direct integration with Amadeus Flight API
- Planned: Booking, rescheduling, and buying agent

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS, Radix UI |
| Charts | Recharts, Chart.js |
| Backend | Netlify Functions (serverless) |
| API | Amadeus Flight API |
| Deployment | Netlify, GitHub Actions |

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
│       ├── popular-routes.js
│       ├── health.js
│       └── ...
└── common/               # Shared code between frontend and functions
```

## Architecture Patterns

### Frontend
- **Component Structure**: Functional components with hooks
- **State Management**: React useState/useEffect (no Redux)

### Backend (Netlify Functions)
- **Pattern**: Serverless functions with CORS middleware
- **API Integration**: Amadeus SDK for flight data

### Deployment
- **Environments**: Alpha (development), Gamma (staging), and Prod (protected)
- **CI/CD**: GitHub Actions with **tag-gated** environment selection (see "Releases" below)
- **CDK**: Optional AWS CDK infrastructure in `/cdk` directory
- **Secrets**: `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID_GAMMA`, `NETLIFY_SITE_ID_PROD`
- **Alpha Site ID**: `b26b3133-30c1-46f3-b976-59ab7c928b57` (hardcoded)

## Authentication

Currently no user authentication implemented. Amadeus API credentials are stored as environment variables in Netlify:
- `AMADEUS_API_KEY`
- `AMADEUS_API_SECRET`
- `AMADEUS_HOSTNAME`

## Backlog

Project backlog: https://github.com/users/IamJasonBian/projects/1

## Environments

| Environment | URL | Site ID |
|-------------|-----|---------|
| Alpha | https://route-manager-alpha.netlify.app/ | b26b3133-30c1-46f3-b976-59ab7c928b57 |
| Gamma | https://route-manager-gamma.netlify.app/ | (GitHub secret) |
| Prod | https://route-manager-prod.netlify.app/ | (GitHub secret) |

## Releases

Deploys are gated by git ref shape — no config file edits required.

| Ref pushed                  | Deploys to | Example                     |
|-----------------------------|------------|-----------------------------|
| `main` (no tag)             | alpha      | every merge                 |
| Tag `vX.Y.Z-<suffix>`       | gamma      | `v1.2.0-rc.0`               |
| Tag `vX.Y.Z` (clean semver) | prod       | `v1.2.0` (also cuts a GitHub Release) |

### Cutting a release

```bash
make release-rc       # 1.0.0 → 1.0.1-rc.0  → tag v1.0.1-rc.0  → gamma
make release-patch    # 1.0.0 → 1.0.1       → tag v1.0.1       → prod
make release-minor    # 1.0.0 → 1.1.0       → tag v1.1.0       → prod
make release-major    # 1.0.0 → 2.0.0       → tag v2.0.0       → prod
```

Each target bumps `package.json`, creates a `release: vX.Y.Z` commit, tags it,
and runs `git push --follow-tags`. Working tree must be clean — the target
aborts otherwise so a release never silently includes WIP.

### Breakglass

When you need to deploy a specific commit to a specific env outside the tag flow
(hotfix from a branch, redeploy of an old SHA, etc.):

1. GitHub → Actions → "Deploy to Netlify" → **Run workflow**
2. Pick the branch/tag and target environment
3. Run

This bypasses the ref-shape gating but still runs the full build + deploy.
