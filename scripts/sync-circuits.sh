#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted node programs use JS template literals
set -euo pipefail

# Sync compiled Noir circuit artifacts from ERC-8262 to xochi-sdk.
# Usage: ./scripts/sync-circuits.sh [path-to-ERC-8262]
#
# Every artifact must exist and be compiled with EXPECTED_NOIR_VERSION from
# src/noir-version.ts. Debug data (`file_map`, `debug_symbols`) is stripped:
# it embeds the full Noir sources with absolute build paths, and noir_js only
# uses it for a best-effort call stack (assert messages decode from `abi`).
# Artifacts are staged and validated first; circuits/ is only written when all
# of them pass, so a failed sync never leaves a partial or mixed set behind.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SDK_CIRCUITS="${SDK_ROOT}/circuits"
NOIR_VERSION_TS="${SDK_ROOT}/src/noir-version.ts"

ERC_REPO="${1:-${SDK_ROOT}/../ERC-8262}"

if [[ ! -d "${ERC_REPO}" ]]; then
  printf "Error: ERC-8262 repo not found at %s\n" "${ERC_REPO}" >&2
  printf "Usage: %s [path-to-ERC-8262]\n" "$0" >&2
  exit 1
fi

expected_version=$(node -e '
const src = require("fs").readFileSync(process.argv[1], "utf8");
const m = src.match(/export const EXPECTED_NOIR_VERSION = "([^"]+)";/);
if (!m) {
  console.error(`Error: EXPECTED_NOIR_VERSION not found in ${process.argv[1]}`);
  process.exit(1);
}
console.log(m[1]);
' "${NOIR_VERSION_TS}")

CIRCUITS=(
  compliance
  compliance_signed
  compliance_multi_signed
  risk_score
  risk_score_signed
  pattern
  attestation
  membership
  non_membership
)

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

printf "Syncing circuits from %s (expecting Noir %s)\n" "${ERC_REPO}" "${expected_version}"

failed=0
for name in "${CIRCUITS[@]}"; do
  # Try the per-circuit target first, then the workspace target
  src="${ERC_REPO}/circuits/${name}/target/${name}.json"
  if [[ ! -f "${src}" ]]; then
    src="${ERC_REPO}/circuits/target/${name}.json"
  fi

  if [[ ! -f "${src}" ]]; then
    printf "  SKIP  %s (not found)\n" "${name}" >&2
    failed=$((failed + 1))
    continue
  fi

  # Validates noir_version and writes the artifact minus debug data, keeping
  # the remaining keys in order and the minified single-line format.
  if node -e '
const fs = require("fs");
const [src, dest, expected] = process.argv.slice(1);
const artifact = JSON.parse(fs.readFileSync(src, "utf8"), (key, value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
    throw new Error(`${src}: integer at key "${key}" exceeds 2^53 and would lose precision`);
  }
  return value;
});
if (typeof artifact.noir_version !== "string" || artifact.noir_version === "") {
  console.error(`    ${src}: missing or non-string noir_version`);
  process.exit(1);
}
const version = artifact.noir_version.split("+")[0];
if (version !== expected) {
  console.error(`    ${src}: compiled with Noir ${version}, expected ${expected}`);
  process.exit(1);
}
delete artifact.file_map;
delete artifact.debug_symbols;
fs.writeFileSync(dest, JSON.stringify(artifact));
' "${src}" "${STAGING}/${name}.json" "${expected_version}"; then
    printf "  OK    %s\n" "${name}"
  else
    printf "  FAIL  %s (%s)\n" "${name}" "${src}" >&2
    failed=$((failed + 1))
  fi
done

if [[ "${failed}" -ne 0 ]]; then
  printf "\nError: %d/%d circuits failed; %s left unchanged\n" \
    "${failed}" "${#CIRCUITS[@]}" "${SDK_CIRCUITS}" >&2
  exit 1
fi

for name in "${CIRCUITS[@]}"; do
  cp "${STAGING}/${name}.json" "${SDK_CIRCUITS}/${name}.json"
done

printf "\nSynced %d/%d circuits (Noir %s)\n\n" "${#CIRCUITS[@]}" "${#CIRCUITS[@]}" "${expected_version}"
printf "Verify the synced artifacts with:\n"
printf "  npm run drift-check\n"
