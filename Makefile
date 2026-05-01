# Route Manager — one-command local dev (Netlify Dev + Vite + all functions).
#
#   make dev
#
# Open http://localhost:3000 (not :5173). Netlify proxies Vite on 5173 and serves
# /.netlify/functions on the same origin. Amadeus uses the test API (netlify.toml
# dev.environment AMADEUS_HOSTNAME=test); put Amadeus *test* app keys in .env.
#
# Requires: Node.js, npx netlify-cli. Optional: Docker for Postgres (DB-backed endpoints).

.DEFAULT_GOAL := dev

.PHONY: dev dev-server help db-up db-down test-integration-search pull-amadeus-env local-search-integration \
	build release-patch release-minor release-major release-rc release-push current-version

# Full stack: Postgres (if Docker available) + Netlify dev
dev: db-up
	npx netlify dev

# Same as historical npm script: Netlify only — use if you do not run Docker
dev-server:
	npx netlify dev

db-up:
	@if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then \
		echo "Starting Postgres (docker compose)…"; \
		docker compose up -d; \
	else \
		echo "Skipping Postgres (docker not found or no docker-compose.yml). DB-backed endpoints may fail until DB is up."; \
	fi

db-down:
	@if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then \
		docker compose down; \
	fi

# Integration: JFK→LAX via HTTP (requires `make dev` on :3000 or set BASE_URL to a deploy)
test-integration-search:
	node scripts/integration-search-flight.mjs

# Pull AMADEUS_* from Netlify into .env (needs NETLIFY_AUTH_TOKEN)
pull-amadeus-env:
	node scripts/pull-amadeus-from-netlify.mjs

# Pull keys (if needed) + invoke search-flights in-process (no netlify dev)
local-search-integration:
	npm run local:search-integration

# --- Build & release -------------------------------------------------------
#
# Release flow (tag-gated CI in .github/workflows/deploy-netlify.yml):
#   make release-patch   # 1.0.0 → 1.0.1 → tag v1.0.1   → prod  on push
#   make release-minor   # 1.0.0 → 1.1.0 → tag v1.1.0   → prod  on push
#   make release-major   # 1.0.0 → 2.0.0 → tag v2.0.0   → prod  on push
#   make release-rc      # 1.0.0 → 1.0.1-rc.0 → tag     → gamma on push
#
# All `release-*` targets bump version + commit + tag locally, then call
# release-push to publish the tag (and trigger CI). Push to main alone
# (no tag) deploys to alpha. Breakglass: GitHub Actions → "Run workflow"
# → choose env. Run `make current-version` to see what's in package.json.

build:
	npm run build

current-version:
	@node -p "require('./package.json').version"

release-patch:
	@$(MAKE) _release BUMP=patch

release-minor:
	@$(MAKE) _release BUMP=minor

release-major:
	@$(MAKE) _release BUMP=major

release-rc:
	@$(MAKE) _release BUMP="prerelease --preid=rc"

# Internal: bump npm version (creates commit + tag), then push both.
# Aborts if working tree is dirty so a release never silently includes WIP.
_release:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree is dirty — commit or stash before releasing."; \
		git status --short; \
		exit 1; \
	fi
	npm version $(BUMP) -m "release: v%s"
	@$(MAKE) release-push

release-push:
	git push --follow-tags

help:
	@echo "Dev:"
	@echo "  make dev         - Postgres (optional) + netlify dev → http://localhost:3000"
	@echo "  make dev-server  - netlify dev only (no docker)"
	@echo "  make db-up       - docker compose up -d"
	@echo "  make db-down     - docker compose down"
	@echo ""
	@echo "Test:"
	@echo "  make test-integration-search - POST search-flights JFK→LAX (needs BASE_URL, default :3000)"
	@echo "  make pull-amadeus-env        - NETLIFY_AUTH_TOKEN → .env from Netlify site"
	@echo "  make local-search-integration - pull + in-process Amadeus search (no netlify dev)"
	@echo ""
	@echo "Build & release:"
	@echo "  make build           - tsc + vite build"
	@echo "  make current-version - print package.json version"
	@echo "  make release-patch   - bump patch → tag → push (deploys to prod)"
	@echo "  make release-minor   - bump minor → tag → push (deploys to prod)"
	@echo "  make release-major   - bump major → tag → push (deploys to prod)"
	@echo "  make release-rc      - bump prerelease (rc.N) → tag → push (deploys to gamma)"
