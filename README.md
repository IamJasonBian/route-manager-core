# Route Manager - Travel in the Power of the Traveler 

<div align="center">
  <p align="center">
    <a href="#">
      <img src="https://img.shields.io/badge/Status-Development-yellow" alt="Status">
    </a>
    <a href="https://opensource.org/licenses/MIT">
      <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
    </a>
  </p>
</div>

Rag Based Flight Planner and Trip Autobook. 

"Calling AirCanada - " 

"Sorry, we do not have any updates - please use our chatbot for the latest updates"

Flying is often full of surprises, airline inventory is currently opaque with fragmented availability. Seat inventory is vended to third party agencies and rewards systems are opaque. Prices are often spiked last minute when travelers need it the most and point inventory are often yanked without visibility. 

Given last minute flight cancellations, delays, and even the recent bankruptcy [1](https://en.wikipedia.org/wiki/Spirit_Airlines#cite_note-82) of cheap carriers like spirit, travelers should be armed with the tools to manage last-minute travel risk. This includes managing rebookings, flight-changes, and surprise delays at the airport without the friction of the airline front-desk, third party booking sites, and airline websites. Route Manager aims to create an agent stack for flight operations. 

## Environments

| Environment | URL |
|-------------|-----|
| Prod | https://route-manager-prod.netlify.app/ |
| Gamma | https://route-manager-gamma.netlify.app/ |

## Test-Flight

* (IOS) Reflight - https://flight-branch--jasonbian75.replit.app/

# Overview 

##  Features

Route Manager is designed to enable last minute travel by prebooking commonly taken flights at rebookable and point based tiers. This allows for spontaneous trips, upgrades and reduces overall airport planning. 

By solving for price and modeling common travel risks and dependencies, Route Manager can increase travel optionality by reducing operational friction. This is done primarily via

* Parsing through flight websites and holding a locked "offered" flight pre-checkout (~20 mins) [1]
* Using Raw Booking Apis to reduce slow UI and website load times [2]
* Chatbot use, rebooking, and travel credit workflows [3]

This adds value on top of common workflows in Google Flights (and associated notifications) as well as other softwares like Scot's cheap flights etc 

## Some Current Features

- **Low Latency Flight Monitoring** - Fetch flight prices with historical, projected, volatility and delay analysis
- **Route Management** - Track common flight routes and associated pricing
- **API Integration** - Kiwi.com public flight search (credential-less)
- **Git Style Forking and Trip Sharing** - IOS App based 

## Some Planned Features 

- **Booking, Rescheduling, and Buying Agents **
  * Track and book commonly flown routes at historical lows with reasonable refund, exchange, and rescheduling fees in anticipation of future upgrades (as we approach the travel date) 
  * Notification based - Change Management and cancellation workflows via the original airline sites or travel brokers (I.E. VentureX)
  * Comprehensive flight inventory data (higher coverage than google flights)

## Route Manager is good at
* Finding the best price in context of a specific user
* Reducing and simplifying the technical dependencies surrounding air travel by improving ease of access
* Helping share and manage last minute flights (and newly occuring last minute flights) from last minute cancellations


## Route Manager not good at
* Finding the best price overall on the market

# Quick Start

### Prerequisites (Self Service Install)
- Node.js 18+ & npm 9+
- Netlify Account (for hosting data access functions, we're using netlify rather than doing direct calls from front-end code)
- Github Repository and Pipelines Personal Stacks

### Local Environment Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/route-manager.git
   cd route-manager
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   - Copy `.env.example` to `.env`
   - Update the values in `.env` with your configuration
   ```bash
   cp .env.example .env
   ```

4. **Netlify setup**
   - Set up Netlify environments (alpha/gamma/prod). Flight search needs no API keys.

### Running Locally

#### Development Build

```bash
# Start the development server
npm run dev:clean
```

This will start:
- Frontend on http://localhost:3000
- Netlify dev server on http://localhost:8888
- API endpoints under `/.netlify/functions/`

```
# Start the netlify functions (add instructions)
```

#### Production Build

```bash
# Build the application
npm run build

# Preview the production build
npm run preview
```

#### Deployment

CI is off for now; deploy manually from a clean checkout after `npx netlify login`:

```bash
make deploy-alpha   # or deploy-gamma / deploy-prod
```

**Runtime Permissions:**

Netlify Account Used (current): jasonzb@umich.edu

| Secret | Description |
|--------|-------------|
| `NETLIFY_SITE_ID_GAMMA` | Site ID for gamma environment |
| `NETLIFY_SITE_ID_PROD` | Site ID for prod environment |

### Available Netlify API Endpoints in Gamma and Prod

- `GET /.netlify/functions/health` - Health check
- `POST /.netlify/functions/search-flights` - Search for flights
- `GET /.netlify/functions/flight-prices?from=SEA&to=SFO` - Cheapest prices for the next 14 days
- `GET /.netlify/functions/airport-search?keyword=sea` - Static airport lookup

##  Auth Configuration

### Development Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Application environment | `development` |
| `PORT` | Port to run the server | `3000` |
| `KIWI_MCP_URL` | Kiwi MCP endpoint | `https://mcp.kiwi.com/` |
| `DB_USER` | Database username | `routeuser` |
| `DB_PASSWORD` | Database password | - |
| `DB_NAME` | Database name | `routedb` |
| `DB_HOST` | Database host | `localhost` |
| `DB_PORT` | Database port | `5432` |

## Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Older Releases

* Alpha | Single Page Analytics Demo: https://apollo-route-manager-0acz9.netlify.app/ 

## API Driver

```bash
# One-way search (Kiwi via search-flights; maxStops 0 = nonstop only)
curl -X POST "https://route-manager-alpha.netlify.app/.netlify/functions/search-flights" \
  -H "Content-Type: application/json" \
  -d '{"origin":"SEA","destination":"NYC","departureDate":"2026-12-15","maxResults":5,"maxStops":0}'
```
