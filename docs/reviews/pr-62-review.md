# PR #62 Review — Redesign: Simple Trip Proposals with Drizzle ORM + Hugo Coder theme

Branch: `IamJasonBian/trip-proposal-redesign` @ `aa0ff89`
Base: `main` @ `e56b3bf`
Scope: 37 files, +6946 / −4485

## 1. Overview

This PR does four things at once:

1. Swaps raw `pg` for Drizzle ORM, with parallel SQLite (`schema.ts`) and Postgres (`schema.pg.ts`) schemas.
2. Introduces a "Trip Proposal" domain (CRUD API + `ProposalsPage` + `ProposeTripModal` + `HomePage` redesign).
3. Rewrites the CSS to a minimal "Hugo Coder"–style theme with `useTheme` + `ThemeToggle` (dark/light).
4. Extracts a `buildGoogleFlightsUrl` utility and adds it to `PriceTrendsPage`.

The direction is good: Drizzle, typed schemas, a real DB for proposals (instead of `localStorage`), and a cohesive design system via CSS vars. However, the PR is too large to merge as-is and contains at least one **blocking security issue** plus several correctness/ops concerns.

## 2. Blocking issues

### 2.1 🚨 Arbitrary SQL execution — `netlify/functions/db.js`

```js
const { query, params = [] } = JSON.parse(event.body);
const result = db.run(sql.raw(query));
```

This endpoint accepts any SQL string from any unauthenticated caller and runs it against the production database. There is no auth, no allow-list, no rate limit. An attacker can:

- `DROP TABLE proposals;` / `DROP TABLE routes;`
- `SELECT * FROM pg_shadow;` (or equivalent data exfiltration)
- Read and write arbitrary rows

**Required fix before merge:** delete this endpoint entirely (the Drizzle-backed `routes.js` / `proposals.js` make it obsolete), or restrict it to non-prod + an explicit auth header. The `params` argument is also parsed but ignored — another smell.

### 2.2 Postgres migrations do not exist

`drizzle.config.ts` is SQLite-only:

```ts
schema: './src/db/schema.ts',
dialect: 'sqlite',
```

Only `drizzle/0000_parallel_mathemanic.sql` (SQLite) is committed. Production is TimescaleDB (`docker-compose.yml` → `timescale/timescaledb:latest-pg17`), and all Netlify functions `import` from `schema.pg.ts`. There is **no committed migration path** for the Postgres schema. First prod deploy will hit "relation does not exist" errors.

**Required fix:** add a second `drizzle.config.pg.ts` targeting `schema.pg.ts`, generate a Postgres migration, and document `drizzle-kit migrate` as part of deploy (or wire it into a one-shot Netlify function / GitHub Action job). If TimescaleDB hypertables are needed for `price_history`, add that as a follow-up migration.

## 3. Correctness concerns

### 3.1 Race condition in `routes.js` upsert

```js
const existing = await db.select().from(routes).where(...);
if (existing.length > 0) { update } else { insert }
```

Two concurrent callers with the same `(origin, destination, departure_date, flight_number)` will both miss the row and both insert, violating `idx_route_unique` and failing the second request. Replace with Drizzle's `onConflictDoUpdate` / `.onConflictDoNothing()` using the unique index as the target — it's one SQL statement and atomic.

### 3.2 Bulk insert is O(n) round trips

```js
for (const route of body.routes) {
  const result = await db.insert(routes).values({...}).returning();
  saved.push(result[0]);
}
```

Use `db.insert(routes).values(body.routes.map(...)).returning()` — one query, one transaction. Matters most on the seed path (100+ routes).

### 3.3 N+1 in `get-routes-summary` and `routes.js?action=summary`

```js
const allRoutes = await db.select().from(routes);
await Promise.all(allRoutes.map(async (route) => {
  const prices = await db.select().from(priceHistory).where(...);
  ...
}));
```

One select per route. On 200 routes × 90 snapshots this is ~200 queries. Use a single `LEFT JOIN` query, then group in JS, or a Drizzle relational `with: { prices: true }` query. This is probably the single biggest perf win available.

### 3.4 `priceHistory` unique index is fragile

```ts
uniqueIndex('idx_price_history_unique').on(table.routeId, table.recordedAt);
```

Two snapshots inserted in the same millisecond for the same route (the `defaultNow()` timestamp) collide. Either drop the unique index (you already have an autoincrement PK) or include something else in the tuple, or explicitly pass `recordedAt`.

### 3.5 `db/client.ts` environment detection is ambiguous

```ts
function usePostgres(): boolean {
  const host = process.env.DB_HOST;
  return !!(host && host !== 'localhost' && host !== '127.0.0.1');
}
```

`netlify.toml` sets `DB_HOST=localhost` for `netlify dev`, but `docker-compose.yml` exposes Postgres on `localhost:5432`. The logic therefore always picks SQLite locally, even when a dev runs `docker compose up`. Either:
- Use an explicit `DB_DRIVER=sqlite|postgres` env var, or
- Drop SQLite and standardize on Postgres (matches prod; avoids the two-schemas problem entirely).

Given §2.2 and the maintenance cost of duplicate `schema.ts` / `schema.pg.ts`, I recommend the latter. Use a Postgres container (or embedded pg) for local and CI.

### 3.6 PUT accepts unbounded `status` values

`proposals.js` PUT forwards `body.status` straight to the DB. Add an enum check:

```js
const ALLOWED = new Set(['draft', 'proposed', 'accepted', 'rejected']);
if (body.status !== undefined && !ALLOWED.has(body.status)) return 400;
```

Same enum already exists in `types/proposal.ts` — lift it into a shared constant and reuse.

### 3.7 Missing input validation on POST

No validation that `origin` / `destination` are 3-letter IATA codes, dates are real ISO dates, `estimatedPrice` is non-negative, `title` length is bounded, etc. A 4 KB `rationale` is fine; a 400 KB one is not. Use `zod` (already idiomatic in the React/TS ecosystem) at the function boundary.

### 3.8 No pagination

`getProposals()` and `GET /routes` return everything. Works now, breaks at 1k proposals. Add `?limit=&cursor=` and enforce a max in the handler.

### 3.9 `.ts` imports from Netlify functions

`netlify/functions/*.js` does `import { getDb } from '../../src/db/client.ts'`. esbuild handles this, but it's unusual and couples function bundling to Vite's module graph. Safer: point the function at a `.js`/`.mjs` shim that re-exports from the TS module, or compile `src/db` to JS as part of the function build. Low priority, but expect future "works on my machine" bundling bugs.

## 4. Security (beyond §2.1)

- `'Access-Control-Allow-Origin': '*'` on every function. Once auth lands, tighten this to the known site origin (`CORS_ORIGIN` is already in `netlify.toml`).
- Error bodies return `error.message` verbatim on 500. Swap to a generic message in prod and log the detail.
- No rate limiting — the app is unauthenticated, so anyone can spam `POST /proposals`. Add IP-based rate limiting at the Netlify edge or a simple token-bucket.
- `crypto.randomUUID()` is fine in Node 18+ (Netlify default). Confirm the runtime is pinned (currently no `node` field in `package.json > engines`).
- No CSRF concern since there are no auth cookies — but once auth lands, remember to switch off wildcard CORS.

## 5. Frontend

Mostly clean. A few notes:

- `ProposeTripModal` and `ProposalsPage` silently `console.error` on failure; users see no toast/inline error. Add a visible error state ("Couldn't save proposal. Try again.") — especially important because the DB layer can actually fail now.
- `ProposeTripModal.handleSubmit` doesn't validate IATA codes — a user can submit `"jfk  "` and it goes straight to the DB and Google Flights URL. Uppercase + trim + regex check client-side.
- `HomePage.tsx` swallows errors with empty `catch {}`. At minimum log them.
- `useTheme` writes `localStorage` on every render (via effect dep). Fine, but set `<html data-theme="dark">` and read it in `index.html` to avoid the dark/light flash on first paint.
- `recentProposals = proposals.slice(0, 3)` — server returns sorted by `createdAt DESC` already (good), but this implicit coupling deserves a comment or an explicit sort client-side.

## 6. Testing strategy (how to actually verify this)

Current tests cover `RouteCard`, `PriceChart`, `api.test.ts` — none of the new proposal code. For a redesign of this size, propose the following before merge:

### Unit / component
- `ProposeTripModal`: form renders, required fields block submit, calls `createProposal` with trimmed/uppercased IATA + constructed Google Flights URL.
- `ProposalsPage`: filters show correct counts; status change updates the card; delete removes from list.
- `ProposalCard`: status transitions render; Google Flights link targets correct URL.
- `googleFlights.buildGoogleFlightsUrl`: table-driven test for round-trip vs one-way, missing dates, cabin override, URL encoding.
- `useTheme`: system default, stored override, toggle flips `.dark` class.

### Integration (Netlify functions)
- Spin up an in-memory better-sqlite3 + Drizzle in tests. For each function:
  - `proposals.js`: GET empty → 200 []; POST → 201 with id; GET by id → 200; PUT status → 200; PUT unknown id → 404; DELETE → 200; method not allowed → 405.
  - `routes.js`: upsert idempotency (same origin/dest/date/flight inserted twice produces one row + update); bulk insert; `?action=summary` shape; `?action=exists` true/false.
  - `health.js`: returns `routeCount`.
- Add a separate suite that runs against Postgres (docker) in CI — catches the SQLite/Postgres schema drift that will otherwise bite on every migration.

### End-to-end (Playwright)
- Create → edit → accept → delete a proposal; assert DB state via health/list.
- Dark mode persists across reloads.
- Search page "Propose Trip" button pre-fills the modal correctly.
- Price trends page Google Flights link opens a new tab with matching `q=`.

### Smoke
- `curl -f $SITE/.netlify/functions/health` in GitHub Actions after deploy.
- Seed a known proposal and curl it back.

## 7. Redesign recommendations (how to reshape this PR)

This PR bundles an ORM migration, a new feature, and a theme rewrite. If any one of them is reverted later, the others will be painful to unwind. Suggested sequencing:

1. **PR A — infra only:** Drizzle + Postgres schema + Postgres migration + `routes.js`/`health.js` rewrites + delete `db.js`. Ship behind the existing UI. No user-visible change. Easier to review, easier to revert. *~1k LOC.*
2. **PR B — proposals feature:** `proposals.js`, `ProposeTripModal`, `ProposalsPage`, `ProposalCard`, types, service. Still uses existing theme. *~1k LOC.*
3. **PR C — Hugo Coder theme + `HomePage` redesign + `ThemeToggle`:** pure visual, no API changes. *~1k LOC.*
4. **PR D — `buildGoogleFlightsUrl` extraction + `PriceTrendsPage` wiring:** trivial refactor. Can ship anytime.

Within that, two design calls worth making explicitly:

- **Drop SQLite locally.** Two schemas = double the surface area for drift bugs (§3.5). Standardize on Postgres via `docker-compose` for dev/CI, one schema file, one migration chain. Onboarding cost is ~2 minutes; long-term cost of the split is much higher.
- **Model proposals as a child of routes, or keep them separate?** Right now `proposals` duplicates `origin`/`destination`/`departure_date` with `routes`. Decide: do proposals *reference* a route (FK), or are they free-form? If the latter (current design), fine — but spell it out in a comment, because the natural next step ("show price history for my proposal") will require joining back.

## 8. Summary table

| # | Severity | Issue | File |
|---|---------|-------|------|
| 1 | 🚨 Blocker | Unauthenticated arbitrary SQL | `netlify/functions/db.js` |
| 2 | 🚨 Blocker | No Postgres migration exists | `drizzle.config.ts`, `drizzle/*` |
| 3 | High | Upsert race condition | `netlify/functions/routes.js` |
| 4 | High | N+1 in summary | `netlify/functions/{routes,get-routes-summary}.js` |
| 5 | Medium | SQLite/Postgres local ambiguity | `src/db/client.ts` |
| 6 | Medium | No status / input validation | `netlify/functions/proposals.js` |
| 7 | Medium | No pagination | proposals + routes |
| 8 | Medium | Bulk insert is N round-trips | `netlify/functions/routes.js` |
| 9 | Low | Wildcard CORS | all functions |
| 10 | Low | Silent UI errors | `ProposeTripModal`, `HomePage` |
| 11 | Low | IATA code not normalized | `ProposeTripModal` |
| 12 | Low | Theme flash on first paint | `useTheme` |
| 13 | Low | No tests for proposals | — |

## 9. Recommendation

Request changes. Fix §2.1 and §2.2 before merge; address §3.1–§3.4 in the same PR or an immediate follow-up. Everything else can be iterated on, ideally after splitting the PR along §7.
