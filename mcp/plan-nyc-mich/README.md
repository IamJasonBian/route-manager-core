# plan-nyc-mich

Curated MCP server for planning weekend flights between **NYC-area airports
(JFK / LGA / NYC city code)** and **Michigan (GRR, DTW)**.

This server is intentionally *not* a generic flight CLI — the routes are
hard-coded. We add a new MCP per route family rather than parameterizing this
one.

## Tools

- `weekend_price_matrix({ weeks?: number = 4 })` — markdown matrix of the
  cheapest one-way price for each weekend day (Sat + Sun) over the next N
  weekends, across all 6 curated route pairs. Each cell links to Google
  Flights.
- `cheapest_weekend_trip({ weeks?: number = 4 })` — the single cheapest
  (route, weekend date) pair across the curated routes.

## Auth

Credential-less. Proxies to the deployed Netlify function
`netlify/functions/search-flights.js`, which reads `AMADEUS_API_KEY` /
`AMADEUS_API_SECRET` / `AMADEUS_HOSTNAME` from its Netlify site environment
(set per-environment in the Netlify UI; alpha/gamma/prod site IDs in
`CLAUDE.md`).

Override the upstream with:

```
ROUTE_MANAGER_ENDPOINT=https://route-manager-alpha.netlify.app/.netlify/functions/search-flights
```

## Run

```
cd mcp/plan-nyc-mich
npm install
node server.mjs   # stdio MCP
```

Wire into a Claude Code config:

```json
{
  "mcpServers": {
    "plan-nyc-mich": {
      "command": "node",
      "args": ["/absolute/path/to/route-manager-core/mcp/plan-nyc-mich/server.mjs"]
    }
  }
}
```
