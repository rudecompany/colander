# check=skip=SecretsUsedInArgOrEnv
# (COLANDER_SIGNING_KEY below is a file path inside the data volume, not a secret value.)
# One image: the Go server plus the built website it serves.
# docker build -t colander . && docker run -p 8787:8787 -v colander-data:/data colander
# First run: docker run --rm -v colander-data:/data colander keygen

FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
COPY extension/package.json extension/
RUN pnpm install --frozen-lockfile --filter @colander/web...
COPY packages ./packages
COPY web ./web
ARG PUBLIC_EXTENSION_ID=""
ARG PUBLIC_STORE_URL=""
RUN PUBLIC_EXTENSION_ID=$PUBLIC_EXTENSION_ID PUBLIC_STORE_URL=$PUBLIC_STORE_URL pnpm -C web build

FROM golang:1.25-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/colander ./cmd/colander && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/colander /colander
COPY --from=web /src/web/build /site
# The nonroot user owns /data so a fresh named volume is writable.
COPY --from=server --chown=65532:65532 /out/data /data
ENV COLANDER_ADDR=:8787 \
    COLANDER_DB=/data/colander.db \
    COLANDER_SIGNING_KEY=/data/signing.key \
    COLANDER_SITE_DIR=/site
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/colander"]
CMD ["serve"]
