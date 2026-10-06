#!/usr/bin/env bash
# Checks the store packages scripts/build-store.sh made, for CI and the release job: one version,
# no manifest key anywhere, the Edge package the same as the Chrome one, and the Firefox manifest
# with its AMO ID, Firefox 140, consent kinds, a sidebar closed at install and an event page.
set -euo pipefail
cd "$(dirname "$0")/../dist"

manifest() { unzip -p "$(ls ./*-"$1".zip)" manifest.json | jq -S .; }
fail() {
	echo "::error::$1" >&2
	exit 1
}

chrome=$(manifest chrome)
edge=$(manifest edge)
firefox=$(manifest firefox)

for m in "$chrome" "$edge" "$firefox"; do
	jq -e 'has("key") or has("externally_connectable") | not' <<<"$m" >/dev/null || fail "A store package carries a manifest key or externally_connectable."
done
[ "$(jq -r .version <<<"$chrome")" = "$(jq -r .version <<<"$firefox")" ] || fail "The Chrome and Firefox packages have different versions."
[ "$chrome" = "$edge" ] || fail "The Edge manifest differs from the Chrome manifest: $(diff <(echo "$chrome") <(echo "$edge") || true)"
jq -e '.side_panel.default_path == "sidepanel.html" and .minimum_chrome_version == "137" and (.permissions | index("sidePanel"))' <<<"$chrome" >/dev/null ||
	fail "The Chrome manifest lost its side panel or minimum Chrome version."
jq -e '
	.browser_specific_settings.gecko.id == "colander@getcolander.com"
	and .browser_specific_settings.gecko.strict_min_version == "140.0"
	and .browser_specific_settings.gecko.data_collection_permissions == {required: ["none"], optional: ["websiteContent", "authenticationInfo"]}
	and .sidebar_action.open_at_install == false
	and (.background.scripts | length) == 1
	and (.background | has("service_worker") | not)
	and (has("minimum_chrome_version") or has("side_panel") | not)
	and (.permissions | index("sidePanel") | not)
' <<<"$firefox" >/dev/null || fail "The Firefox manifest is not the one AMO expects: $firefox"
echo "Store packages check out: $(jq -r .version <<<"$chrome") for Chrome, Edge and Firefox."
