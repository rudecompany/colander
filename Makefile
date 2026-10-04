# Colander: one entry point for building, testing and running everything locally.
# The JavaScript side is a pnpm workspace, with the Cloudflare Worker (the whole backend) in api/.

DEV_KEY ?= testdata/dev-signing.key
DEV_URL ?= http://localhost:8787
EXTENSION_ID ?= nninnogmbhfebflkcgghlmjmplmpodlc

.PHONY: setup build web extension extension-zip test test-api test-web test-extension e2e fixtures seed dev deploy-dry smoke keygen clean

setup:
	pnpm install --frozen-lockfile

build: web extension

web:
	PUBLIC_EXTENSION_ID=$(EXTENSION_ID) pnpm -C web build

extension:
	pnpm -C extension build

extension-zip:
	pnpm -C extension zip

test: test-api test-web test-extension

# The Store migration guard, type checks, the Worker's Vitest suite inside workerd, and dry-run deploys.
test-api:
	node scripts/wrangler-guard.ts api/wrangler.jsonc
	pnpm -C api check
	pnpm -C api test
	pnpm -C api deploy:dry

test-web:
	pnpm -C packages/shared check
	pnpm -C packages/shared test
	pnpm -C web check
	pnpm -C web test

test-extension:
	pnpm -C extension check
	pnpm -C extension test
	pnpm -C extension test:e2e

# Full stack: the Worker under wrangler dev, the built website and the built extension together in
# Chromium. COLANDER_E2E_BASE_URL runs the edge specs against a deployed origin instead.
e2e:
	pnpm -C e2e test

# Regenerate the signed cross-language fixtures (never edit them by hand).
fixtures:
	node testdata/contract/generate.mjs

# The Worker under wrangler dev on http://localhost:8787, with local Durable Objects and R2, the
# development key and the built website. Sign-in links print here. Then run `make seed` once.
dev: web api/.dev.vars
	pnpm -C api dev

# Local secrets for wrangler dev with the published development key. Git ignores the file, and an
# existing one is never overwritten.
api/.dev.vars:
	printf 'COLANDER_DEV=1\nPUBLIC_URL=$(DEV_URL)\nIP_SALT=dev-ip-salt\nOPS_TOKEN=dev-ops-token\nCOLANDER_SIGNING_KEY=%s\n' "$$(cat $(DEV_KEY))" > $@

# Fictional demo data in the running `make dev` Worker: the seed, a scoring pass with its
# publications, then the watchdog cron, which schedules the recurring jobs. A seeded Store answers
# 409; delete api/.wrangler to start over.
seed:
	curl -fsS -X POST $(DEV_URL)/__dev/seed && echo
	curl -fsS -X POST $(DEV_URL)/__dev/settle && echo
	curl -fsS '$(DEV_URL)/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*' && echo

# Builds and checks both Worker environments without uploading anything.
deploy-dry: web
	pnpm -C api deploy:dry

# Contract smoke test against a running origin (docs/deploy.md); against staging set the
# CF_ACCESS_* variables, and SMOKE_FLAGS passes flags such as --mutating.
SMOKE_URL ?= http://localhost:8787
SMOKE_KEYS ?= $(shell cat testdata/dev-signing.pub)
smoke:
	COLANDER_BASE_URL=$(SMOKE_URL) COLANDER_PUBLIC_KEYS=$(SMOKE_KEYS) node scripts/smoke.ts $(SMOKE_FLAGS)

# A new Ed25519 signing key, offline: make keygen KEY=production-signing.key
keygen:
	@test -n "$(KEY)" || (echo "usage: make keygen KEY=<path>" && exit 2)
	node scripts/keygen.ts $(KEY)

clean:
	rm -rf api/dist web/build extension/dist extension/.output e2e/.run
