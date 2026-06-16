# route-manager-mcp

MCP server exposing flight price lookups for this project.

## Tools

- `flight_price` — cheapest one-way price for a single (origin, destination, date).
- `price_matrix` — markdown matrix of cheapest one-way prices across origins × destinations over the next N weeks (optionally weekends only). Each cell links to Google Flights.

## Auth

The server is **credential-less**. It proxies to the deployed Netlify function
`netlify/functions/search-flights.js`, which is where the Amadeus credentials
live: the function reads `AMADEUS_API_KEY` / `AMADEUS_API_SECRET` /
`AMADEUS_HOSTNAME` from its Netlify site environment (set per-environment in the
Netlify UI; see `CLAUDE.md` for the alpha/gamma/prod site IDs).

Override the upstream with:

```
ROUTE_MANAGER_ENDPOINT=https://route-manager-alpha.netlify.app/.netlify/functions/search-flights
```

## Run

```
cd mcp
npm install
node server.mjs    # speaks MCP over stdio
```

Wire into a Claude Code config (`.mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "route-manager": {
      "command": "node",
      "args": ["/absolute/path/to/route-manager-core/mcp/server.mjs"]
    }
  }
}
```
