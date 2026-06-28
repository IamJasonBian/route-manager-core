# Google auth → Delta credentials → trip booking

A four-layer pipeline that authenticates you to Google Cloud, pulls your own
delta.com login out of GCP Secret Manager, and drives a booking on delta.com —
**dry-run by default** (it never charges a card without an explicit keystroke).

> **Scope:** this automates **your own** Delta SkyMiles account, with credentials
> you store in **your own** GCP project (`allocation-agent-service`). It is not a
> credential harvester — Google auth and Delta auth are separate; Secret Manager
> is just the vault that bridges them.

## Architecture

```
 scripts/gcloud/auth.sh ───────────────►  Google ADC on this machine
        │                                  (~/.config/gcloud/…default_credentials.json)
        ▼
 put-delta-credentials.sh ─────────────►  Secret Manager: delta-com-username / -password
        ▼
 get-delta-credentials.mjs  ◄── ADC ────  pulls the secrets at runtime
        ▼
 scripts/booking/delta-auth.mjs ───────►  Playwright auth LOOP
        │   • reuse cached session (.secrets/delta-storage-state.json)
        │   • else login → handle MFA/OTP → retry w/ backoff → persist
        ▼
 scripts/booking/book-delta-trip.mjs ──►  search → select → fill → STOP before pay
```

## Prerequisites

- **Google Cloud SDK** (`gcloud`): `brew install --cask google-cloud-sdk`
- **Node deps**: `npm install` (adds `@google-cloud/secret-manager`, `playwright`)
- **Playwright browser**: `npx playwright install chromium`

## One-time setup

```bash
# 1. Authenticate to GCP + enable Secret Manager (interactive; opens a browser).
#    In a Claude Code session, prefix with `!` so OAuth output is captured:
sh scripts/gcloud/auth.sh          # or: npm run gcloud:auth

# 2. Seed your delta.com login into Secret Manager (prompts, no echo).
npm run delta:creds:put

# 3. Verify the pull works.
npm run delta:creds:get            # add -- --reveal to print the password
```

## Booking

```bash
# Prove the login loop works (opens a browser, logs in, caches the session).
npm run delta:login

# Dry run — searches + selects + stops before payment. Nothing is charged.
npm run book:delta -- --from SEA --to JFK --depart 2026-07-10 --return 2026-07-17

# Actually purchase (requires the flag AND an interactive y/N).
npm run book:delta -- --from SEA --to JFK --depart 2026-07-10 --confirm-purchase
```

### Flags

| Flag                 | Meaning                                              |
|----------------------|------------------------------------------------------|
| `--from` `--to`      | IATA codes (required)                                |
| `--depart`           | `YYYY-MM-DD` (required)                              |
| `--return`           | `YYYY-MM-DD` (omit for one-way)                      |
| `--pax`              | passenger count (default 1)                          |
| `--headless`         | run without a visible browser window                 |
| `--confirm-purchase` | arm the real purchase path (still asks y/N)          |

## Notes & caveats

- **Selectors are best-effort.** Delta's markup and Akamai bot defenses change.
  Every selector is overridable via `DELTA_SEL_*` env vars (see `.env.example`)
  so you can re-point them without editing code.
- **Sessions are cached** at `.secrets/delta-storage-state.json` (gitignored) and
  reused until they expire, at which point the auth loop re-logs in.
- **Nothing secret is committed.** Credentials live only in Secret Manager and in
  the gitignored session cache.

## American Airlines (aa.com)

The same pipeline is mirrored for AA — different vault secrets, URLs, and
`AA_SEL_*` selectors, identical safety model (dry-run by default; purchase needs
`--confirm-purchase` + a live `y/N`). AA's default selectors are **best-effort
guesses** and almost certainly need tuning against the live site.

```bash
npm run aa:creds:put          # seed aa-com-username / aa-com-password (no echo)
npm run aa:creds:get          # verify the pull (add -- --reveal to show pw)
npm run aa:login              # prove the login loop; caches .secrets/aa-storage-state.json
npm run book:aa -- --from SEA --to JFK --depart 2026-07-10 --return 2026-07-17
```

Files: `scripts/gcloud/{put,get}-aa-credentials.*`, `scripts/booking/aa-auth.mjs`,
`scripts/booking/book-aa-trip.mjs`. Secret names + selectors are env-overridable
(see `.env.example`).

## Persistent CDP terminal (remote debugging from a VM)

`cdp-terminal.mjs` brings up a long-lived Chromium with (1) a **persistent
profile** so a login survives restarts, (2) a **CDP remote-debugging port** so
you can attach over the Chrome DevTools Protocol from elsewhere, and (3) a
**Playwright trace** (+ optional HAR) written on exit.

```bash
# On the VM (headless), bound to loopback:
npm run cdp:headless                       # 127.0.0.1:9222, persistent .secrets/cdp-profile
npm run cdp -- --login delta               # seed a Delta login into the profile first
npm run cdp -- --port 9333 --har           # custom port + capture a HAR

# Reach it from your laptop — SAFE path is an SSH tunnel (no open ports):
ssh -N -L 9222:127.0.0.1:9222 user@vm
# then connect locally with chromium.connectOverCDP('http://127.0.0.1:9222')
```

| Flag / env              | Meaning                                                     |
|-------------------------|-------------------------------------------------------------|
| `--port` / `CDP_PORT`   | DevTools Protocol port (default `9222`)                     |
| `--bind` / `CDP_BIND`   | bind address (default `127.0.0.1`; `0.0.0.0` exposes it)    |
| `--profile`             | persistent user-data-dir (default `.secrets/cdp-profile`)   |
| `--headless`/`--headed` | window mode (default from `HEADLESS`; headless on a VM)     |
| `--login delta`         | run the Delta auth loop once to seed the profile           |
| `--url`                 | page to open on startup                                     |
| `--no-trace`            | disable the Playwright trace                                |
| `--har`                 | also record a HAR of all traffic                           |

> **Security:** the remote-debugging port is unauthenticated full control of the
> browser and every session in it. Keep `--bind 127.0.0.1` and tunnel in over
> SSH. Only use `--bind 0.0.0.0` on a firewalled host — it prints a warning and
> adds `--remote-allow-origins` so external CDP clients can attach.

Trace/HAR land in `.scrapes/traces/` (gitignored). View a trace with
`npx playwright show-trace .scrapes/traces/cdp-terminal.zip`.
