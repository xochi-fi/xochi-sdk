#!/usr/bin/env bash
# Builds the Oxide L2 Broadcaster artifact `exit` needs (--broadcaster-artifact) from the Noir
# sources vendored in contracts/oxide, then refuses it unless its contract class is the class of
# the deployment's l2Broadcaster instance (releases.json dep-v6
# 0x1baa4519...77f9: node_getContract currentContractClassId = original class
# 0x24f2762a...78ae, read 2026-11-03 on aztec-mainnet.drpc.org). zk.money publishes no compiled
# artifact (xochi#760); the source is public.
#
#   npm run build:broadcaster
#
# Writes contracts/oxide/broadcaster_contract/target/broadcaster_contract-Broadcaster.json
# (gitignored). Same inputs and flags as pxe-bridge scripts/build-oxide-token.sh:
#   - sources at zkmoney-public 8fd19841 (vendor/oxide/noir-projects/{broadcaster_contract,
#     oxide_lib}), byte for byte;
#   - the aztec-up 6.0.0 toolchain;
#   - upstream's flags (noir-projects/bootstrap.sh): aztec compile --silence-warnings
#     --inliner-aggressiveness 0;
#   - git dependencies by tag (aztec-node v6.0.0, sha256 v0.2.1, noir_base64 v0.5.1). A tag
#     can move; the class check below catches that. `exit` checks the class again against the
#     live instance on the pinned node before using the artifact.
# HARDWARE_CONCURRENCY=1: bb derives verification keys one per thread otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

AZTEC_TOOLCHAIN_VERSION="6.0.0"
PACKAGE="broadcaster_contract"
DIR="contracts/oxide/$PACKAGE"
ARTIFACT="$DIR/target/$PACKAGE-Broadcaster.json"

unset NARGO BB BB_BINARY_PATH
export AZTEC_VERSIONED=1

for tool in node aztec; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool not found on PATH. Install the toolchain: aztec-up install $AZTEC_TOOLCHAIN_VERSION && aztec-up use $AZTEC_TOOLCHAIN_VERSION" >&2
    exit 1
  }
done
found="$(aztec --version 2>/dev/null | tail -1 || true)"
if [ "$found" != "$AZTEC_TOOLCHAIN_VERSION" ]; then
  echo "aztec --version reports '${found:-nothing}'; the Broadcaster was built with $AZTEC_TOOLCHAIN_VERSION." >&2
  exit 1
fi

rm -f "$ARTIFACT" "$ARTIFACT.bak"
(cd "$DIR" && HARDWARE_CONCURRENCY=1 aztec compile --silence-warnings --inliner-aggressiveness 0 --package "$PACKAGE")
rm -f "$ARTIFACT.bak"

node dist/broadcaster-artifact.js "$ARTIFACT"
