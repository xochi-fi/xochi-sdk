#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_FORK_URL:?set ANVIL_FORK_URL to a read-only upstream RPC}"
: "${REGISTRY_CANONICAL_SLOT:?set the reviewed canonical-rollup storage slot}"

PORTAL="0xcb99c58fe81ae6b2cb4835e46f7b703745879042"
EXPECTED_ROLLUP_VERSION="2070860440"
FORK_RPC="${FORK_RPC:-http://127.0.0.1:8545}"
FORK_PORT="${FORK_PORT:-8545}"
ALTERNATE_ROLLUP="${ALTERNATE_ROLLUP:-0x0000000000000000000000000000000000000001}"
DRILL_CALLER="${DRILL_CALLER:-0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266}"
OBSERVATIONS="${OBSERVATIONS:-freeze-observations.jsonl}"
LOG_FILE="$(mktemp -t xochi-freeze-anvil.XXXXXX)"
unset ETH_RPC_URL

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

anvil --silent --fork-url "$ANVIL_FORK_URL" --port "$FORK_PORT" >"$LOG_FILE" 2>&1 &
ANVIL_PID=$!
for _ in {1..60}; do
  if cast chain-id --rpc-url "$FORK_RPC" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
cast chain-id --rpc-url "$FORK_RPC" >/dev/null

registry="$(cast call "$PORTAL" 'REGISTRY()(address)' --rpc-url "$FORK_RPC")"
pinned_rollup="$(cast call "$PORTAL" 'ROLLUP()(address)' --rpc-url "$FORK_RPC")"
rollup_version="$(cast call "$PORTAL" 'ROLLUP_VERSION()(uint256)' --rpc-url "$FORK_RPC")"
rollup_version="${rollup_version%% *}"
before_canonical="$(cast call "$registry" 'getCanonicalRollup()(address)' --rpc-url "$FORK_RPC")"
before_frozen="$(cast call "$PORTAL" '$frozen()(bool)' --rpc-url "$FORK_RPC")"
if [[ "$rollup_version" != "$EXPECTED_ROLLUP_VERSION" || "${before_canonical,,}" != "${pinned_rollup,,}" || "$before_frozen" != "false" ]]; then
  printf 'fork precondition failed\n' >&2
  exit 1
fi

slot_value="$(cast pad --len 32 "$ALTERNATE_ROLLUP")"
cast rpc anvil_setStorageAt "$registry" "$REGISTRY_CANONICAL_SLOT" "$slot_value" \
  --rpc-url "$FORK_RPC" >/dev/null
after_override="$(cast call "$registry" 'getCanonicalRollup()(address)' --rpc-url "$FORK_RPC")"
if [[ "${after_override,,}" != "${ALTERNATE_ROLLUP,,}" ]]; then
  printf 'canonical-rollup override did not take effect\n' >&2
  exit 1
fi

cat >"$OBSERVATIONS" <<JSON
{"schema":"xochi.oxide.portal-observation.v1","phase":"not-canonical","portal":"$PORTAL","rollupVersion":"$rollup_version","pinnedRollup":"$pinned_rollup","canonicalRollup":"$after_override","frozen":false,"metrics":{"xochi_oxide_portal_frozen":0,"xochi_oxide_rollup_canonical":0,"xochi_oxide_portal_rollup_version_match":1}}
JSON
cast send "$PORTAL" 'freeze()' --rpc-url "$FORK_RPC" --unlocked --from "$DRILL_CALLER" >/dev/null
after_frozen="$(cast call "$PORTAL" '$frozen()(bool)' --rpc-url "$FORK_RPC")"
if [[ "$after_frozen" != "true" ]]; then
  printf 'portal did not freeze on the fork\n' >&2
  exit 1
fi
cat >>"$OBSERVATIONS" <<JSON
{"schema":"xochi.oxide.portal-observation.v1","phase":"frozen","portal":"$PORTAL","rollupVersion":"$rollup_version","pinnedRollup":"$pinned_rollup","canonicalRollup":"$after_override","frozen":true,"metrics":{"xochi_oxide_portal_frozen":1,"xochi_oxide_rollup_canonical":0,"xochi_oxide_portal_rollup_version_match":1}}
JSON
printf 'F1-F2 fork freeze observations written\n'
