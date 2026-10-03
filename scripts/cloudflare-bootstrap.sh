#!/usr/bin/env bash
# One-time Cloudflare setup for Colander, run by the owner (docs/deploy.md, step 7).
#
#   pnpm install && pnpm -C api exec wrangler login && scripts/cloudflare-bootstrap.sh
#
# It reads the R2 bucket bindings of both environments from api/wrangler.jsonc, then for each
# bucket: creates it with the enam location hint if it is missing, sets its lifecycle rules, and
# for the backup buckets sets a 7-day bucket lock. Lifecycle and lock rules are replaced as a
# whole, so running the script again changes nothing that is already right.
# Last, it prints every Worker secret to set, per environment, as exact commands.
set -euo pipefail

cd "$(dirname "$0")/.."
LOCATION=enam

wrangler() { pnpm --silent -C api exec wrangler "$@"; }

if ! wrangler whoami --json >/dev/null 2>&1; then
	echo "Wrangler is not logged in. Run: pnpm -C api exec wrangler login" >&2
	exit 1
fi

# "<env> <worker name> <binding> <bucket>" for every R2 binding, read with Wrangler's own parser.
# shellcheck disable=SC2016 # the JavaScript template literal is meant for node, not the shell
bindings=$(node --input-type=module -e '
	import { createRequire } from "node:module";
	import { pathToFileURL } from "node:url";
	const entry = createRequire(pathToFileURL("api/package.json")).resolve("wrangler");
	const { experimental_readRawConfig } = await import(pathToFileURL(entry).href);
	const { rawConfig: c } = experimental_readRawConfig({ config: "api/wrangler.jsonc" });
	const s = c.env?.staging;
	if (!s) throw new Error("api/wrangler.jsonc has no env.staging");
	for (const [env, name, cfg] of [["production", c.name, c], ["staging", s.name ?? `${c.name}-staging`, s]]) {
		const r2 = cfg.r2_buckets ?? [];
		for (const binding of ["LISTS", "BACKUPS"]) {
			const b = r2.find((x) => x.binding === binding);
			if (!b?.bucket_name) throw new Error(`api/wrangler.jsonc ${env} has no R2 binding ${binding}`);
		}
		for (const b of r2) console.log(env, name, b.binding, b.bucket_name);
	}
')

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Incomplete multipart uploads (the backup dump uses them) are aborted after a day.
cat >"$tmp/lists-lifecycle.json" <<'JSON'
{"rules": [{"id": "abort-multipart-1d", "enabled": true, "conditions": {"prefix": ""},
  "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}}]}
JSON
# Backups expire after 90 days.
cat >"$tmp/backups-lifecycle.json" <<'JSON'
{"rules": [{"id": "expire-90d", "enabled": true, "conditions": {"prefix": ""},
  "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 7776000}},
  "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}}]}
JSON
# No backup can be deleted or overwritten for 7 days after it is written, not even by this account.
cat >"$tmp/backups-lock.json" <<'JSON'
{"rules": [{"id": "retain-7d", "enabled": true, "condition": {"type": "Age", "maxAgeSeconds": 604800}}]}
JSON

while read -r env worker binding bucket; do
	echo "== $env ($worker): $binding -> $bucket"
	if wrangler r2 bucket info "$bucket" >/dev/null 2>&1; then
		echo "   bucket exists"
	else
		wrangler r2 bucket create "$bucket" --location "$LOCATION"
	fi
	case "$binding" in
	BACKUPS)
		wrangler r2 bucket lifecycle set "$bucket" --file "$tmp/backups-lifecycle.json" --force
		wrangler r2 bucket lock set "$bucket" --file "$tmp/backups-lock.json" --force
		;;
	*)
		wrangler r2 bucket lifecycle set "$bucket" --file "$tmp/lists-lifecycle.json" --force
		;;
	esac
done <<<"$bindings"

prod_worker=$(awk '$1 == "production" { print $2; exit }' <<<"$bindings")
staging_worker=$(awk '$1 == "staging" { print $2; exit }' <<<"$bindings")

cat <<EOF

R2 is ready. Now set the Worker secrets. Each command creates the Worker as an empty draft if it
does not exist yet, and deploys a new version when it does. Values are read from stdin, so they
never appear in your shell history or in a process list. Run from the repository root.

Production (Worker $prod_worker):
  pnpm -C api exec wrangler secret put COLANDER_SIGNING_KEY < /path/to/offline/production-signing.key
  pnpm -C api exec wrangler secret put STRIPE_SECRET_KEY         # Stripe live secret key, sk_live_...
  pnpm -C api exec wrangler secret put STRIPE_WEBHOOK_SECRET     # signing secret of the live webhook, whsec_...
  pnpm -C api exec wrangler secret put YOUTUBE_API_KEY           # YouTube Data API v3 key
  pnpm -C api exec wrangler secret put RESEND_API_KEY            # Resend key, the automatic mail fallback
  pnpm -C api exec wrangler secret put CF_ANALYTICS_TOKEN        # API token with Zone > Analytics > Read on getcolander.com
  openssl rand -base64 32 | pnpm -C api exec wrangler secret put IP_SALT
  ops=\$(openssl rand -hex 32)
  printf %s "\$ops" | pnpm -C api exec wrangler secret put OPS_TOKEN
  printf %s "\$ops" | gh secret set OPS_TOKEN --env production --repo rudecompany/colander
  unset ops

Staging (Worker $staging_worker): the same names with --env staging, a separate test signing key,
Stripe test mode, and its own OPS_TOKEN.
  pnpm -C api exec wrangler secret put COLANDER_SIGNING_KEY --env staging < /path/to/staging-signing.key
  pnpm -C api exec wrangler secret put STRIPE_SECRET_KEY --env staging      # sk_test_...
  pnpm -C api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env staging  # test-mode webhook secret
  pnpm -C api exec wrangler secret put YOUTUBE_API_KEY --env staging
  pnpm -C api exec wrangler secret put RESEND_API_KEY --env staging
  pnpm -C api exec wrangler secret put CF_ANALYTICS_TOKEN --env staging     # same token works for both
  openssl rand -base64 32 | pnpm -C api exec wrangler secret put IP_SALT --env staging
  ops=\$(openssl rand -hex 32)
  printf %s "\$ops" | pnpm -C api exec wrangler secret put OPS_TOKEN --env staging
  printf %s "\$ops" | gh secret set OPS_TOKEN --env staging --repo rudecompany/colander
  unset ops

Check the result with: pnpm -C api exec wrangler secret list [--env staging]
EOF
