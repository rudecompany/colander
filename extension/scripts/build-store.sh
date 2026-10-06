#!/usr/bin/env bash
# Builds one store package from extension/release.env, the same way in the release job and for
# AMO's reviewers, who rebuild the Firefox package from its sources zip:
#   chrome   dist/colanderextension-<version>-chrome.zip   Chrome Web Store, also for Brave and Opera
#   edge     dist/colanderextension-<version>-edge.zip     Edge Add-ons
#   firefox  dist/colanderextension-<version>-firefox.zip  addons.mozilla.org, with
#            dist/colanderextension-<version>-sources.zip  the sources AMO reviewers build from
# Store packages carry no manifest key. A WXT_COLANDER_* variable already set in the environment
# wins over release.env, so CI can check a store build against the development key.
set -euo pipefail
cd "$(dirname "$0")/.."

browser=${1:-}
case "$browser" in
chrome | edge | firefox) ;;
*)
	echo "usage: scripts/build-store.sh chrome|edge|firefox" >&2
	exit 2
	;;
esac

while read -r line; do
	name=${line%%=*}
	case "$name" in
	WXT_COLANDER_*) [ -n "${!name:-}" ] || export "$name=${line#*=}" ;;
	esac
done <release.env

if [ -z "${WXT_COLANDER_PUBLIC_KEYS:-}" ]; then
	echo "release.env has no WXT_COLANDER_PUBLIC_KEYS: set the production public keys first (docs/deploy.md step 7)." >&2
	exit 1
fi

export WXT_COLANDER_STORE_BUILD=1
rm -rf "dist/$browser-mv3"
pnpm exec wxt zip -b "$browser"
