# Route Manager — one-command local dev (Netlify Dev + Vite + all functions).
#
#   make dev
#
# Open http://localhost:3000 (not :5173). Netlify proxies Vite on 5173 and serves
# /.netlify/functions on the same origin. Flight search uses Kiwi's public,
# credential-less API, so no search keys are needed.
#
# Requires: Node.js, npx netlify-cli. Optional: Docker for Postgres (DB-backed endpoints).

.DEFAULT_GOAL := dev

.PHONY: dev dev-server help db-up db-down test-integration-search\
	build deploy-alpha deploy-gamma deploy-prod _deploy release-patch release-minor release-major release-rc release-push current-version

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



# --- Build & release -------------------------------------------------------
#
# CI is off: deploys are manual from a clean checkout, with your own
# `netlify login` (no tokens in GitHub).
#   make deploy-alpha | deploy-gamma | deploy-prod
#
# `release-*` targets still bump version + commit + tag + push; they no
# longer deploy anything. Run `make current-version` to see package.json.

build:
	npm run build

ALPHA_SITE := b26b3133-30c1-46f3-b976-59ab7c928b57
GAMMA_SITE := 9112939a-1227-46fe-9cbb-64ae8a304054
PROD_SITE  := d7e43b0c-8075-4c35-8439-536bf792adde

deploy-alpha:
	@$(MAKE) _deploy SITE=$(ALPHA_SITE) ENV=alpha

deploy-gamma:
	@$(MAKE) _deploy SITE=$(GAMMA_SITE) ENV=gamma

deploy-prod:
	@$(MAKE) _deploy SITE=$(PROD_SITE) ENV=prod

# Internal: build + deploy the committed tree. Refuses a dirty tree so a
# deploy always matches a commit.
_deploy:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree is dirty — commit or stash before deploying."; \
		git status --short; \
		exit 1; \
	fi
	npm ci --no-audit --no-fund
	cd netlify/functions && npm ci --no-audit --no-fund
	npx netlify deploy --build --prod --site $(SITE) --message "$(ENV) $$(git rev-parse --short HEAD)"

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
	@echo ""
	@echo "Build & release:"
	@echo "  make build           - tsc + vite build"
	@echo "  make deploy-alpha    - build + deploy committed tree to alpha (also gamma/prod)"
	@echo "  make current-version - print package.json version"
	@echo "  make release-patch   - bump patch → tag → push (no deploy while CI is off)"
	@echo "  make release-minor   - bump minor → tag → push (no deploy while CI is off)"
	@echo "  make release-major   - bump major → tag → push (no deploy while CI is off)"
	@echo "  make release-rc      - bump prerelease (rc.N) → tag → push (no deploy while CI is off)"
