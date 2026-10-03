# Colander: one entry point for building, testing and running everything locally.
# The JavaScript side is a pnpm workspace; the server is a Go module in server/.

DEV_DB ?= data/dev.db
DEV_KEY ?= server/testdata/dev-signing.key
EXTENSION_ID ?= nninnogmbhfebflkcgghlmjmplmpodlc

.PHONY: setup build server web extension extension-zip test test-server test-web test-extension e2e fixtures seed dev docker clean

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

test: test-server test-web test-extension

test-server:
	cd server && test -z "$$(gofmt -l .)" && go vet ./... && go test -race ./...

test-web:
	pnpm -C packages/shared check
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

docker:
	docker build --build-arg PUBLIC_EXTENSION_ID=$(EXTENSION_ID) -t colander .

clean:
	rm -rf dist web/build extension/.output
