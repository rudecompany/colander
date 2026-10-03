# Colander: one entry point for building, testing and running everything locally.
# The JavaScript side is a pnpm workspace, with the Cloudflare Worker in api/. The Go server in
# server/ stays the reference implementation until the parity harness passes and it is deleted.

DEV_DB ?= data/dev.db
DEV_KEY ?= server/testdata/dev-signing.key
EXTENSION_ID ?= nninnogmbhfebflkcgghlmjmplmpodlc

.PHONY: setup build server web extension extension-zip test test-server test-api test-web test-extension e2e fixtures seed dev dev-api deploy-dry smoke keygen docker clean

setup:
	pnpm install --frozen-lockfile
	cd server && go mod download

build: web server extension

server:
	cd server && CGO_ENABLED=0 go build -trimpath -o ../dist/colander ./cmd/colander

web:
	PUBLIC_EXTENSION_ID=$(EXTENSION_ID) pnpm -C web build

extension:
	pnpm -C extension build

extension-zip:
	pnpm -C extension zip

test: test-server test-api test-web test-extension

test-server:
	cd server && test -z "$$(gofmt -l .)" && go vet ./... && go test -race ./...

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

# Full stack: the real server, the built website and the built extension together in Chromium.
e2e:
	pnpm -C e2e test

# Regenerate the signed cross-language fixtures (never edit them by hand).
fixtures:
	node testdata/contract/generate.mjs

# A local database full of fictional demo data.
seed:
	mkdir -p data
	cd server && COLANDER_DB=../$(DEV_DB) COLANDER_SIGNING_KEY=../$(DEV_KEY) go run ./cmd/colander seed-dev

# The server with the dev key and the built website on http://localhost:8787. Sign-in links print here.
dev: web
	@test -f $(DEV_DB) || $(MAKE) seed
	cd server && COLANDER_DEV=1 COLANDER_DB=../$(DEV_DB) COLANDER_SIGNING_KEY=../$(DEV_KEY) go run ./cmd/colander serve

# The Worker on http://localhost:8787 with local Durable Objects and R2 (wrangler dev).
dev-api: web
	pnpm -C api dev

# Builds and checks both Worker environments without uploading anything.
deploy-dry: web
	pnpm -C api deploy:dry

# Contract smoke test against a running origin (docs/deploy.md). Against the Go server add
# SMOKE_FLAGS=--spa-fallback; against staging set the CF_ACCESS_* variables.
SMOKE_URL ?= http://localhost:8787
SMOKE_KEYS ?= $(shell cat server/testdata/dev-signing.pub)
smoke:
	COLANDER_BASE_URL=$(SMOKE_URL) COLANDER_PUBLIC_KEYS=$(SMOKE_KEYS) node scripts/smoke.ts $(SMOKE_FLAGS)

# A new Ed25519 signing key, offline: make keygen KEY=production-signing.key
keygen:
	@test -n "$(KEY)" || (echo "usage: make keygen KEY=<path>" && exit 2)
	node scripts/keygen.ts $(KEY)

docker:
	docker build --build-arg PUBLIC_EXTENSION_ID=$(EXTENSION_ID) -t colander .

clean:
	rm -rf dist web/build extension/dist extension/.output e2e/.run
