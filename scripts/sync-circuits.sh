#!/usr/bin/env bash
set -euo pipefail

# Sync compiled Noir circuit artifacts from erc-xochi-zkp to xochi-sdk.
# Usage: ./scripts/sync-circuits.sh [path-to-erc-xochi-zkp]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SDK_CIRCUITS="${SDK_ROOT}/circuits"

ERC_REPO="${1:-${SDK_ROOT}/../erc-xochi-zkp}"

if [[ ! -d "${ERC_REPO}" ]]; then
  printf "Error: erc-xochi-zkp repo not found at %s\n" "${ERC_REPO}" >&2
  printf "Usage: %s [path-to-erc-xochi-zkp]\n" "$0" >&2
  exit 1
fi

CIRCUITS=(
  compliance
  compliance_signed
  risk_score
  risk_score_signed
  pattern
  attestation
  membership
  non_membership
)

printf "Syncing circuits from %s\n" "${ERC_REPO}"

copied=0
for name in "${CIRCUITS[@]}"; do
  # Try workspace target layout first, then per-circuit target
  src="${ERC_REPO}/circuits/${name}/target/${name}.json"
  if [[ ! -f "${src}" ]]; then
    src="${ERC_REPO}/circuits/target/${name}.json"
  fi

  if [[ ! -f "${src}" ]]; then
    printf "  SKIP  %s (not found)\n" "${name}"
    continue
  fi

  cp "${src}" "${SDK_CIRCUITS}/${name}.json"
  printf "  OK    %s\n" "${name}"
  copied=$((copied + 1))
done

printf "\nCopied %d/%d circuits\n" "${copied}" "${#CIRCUITS[@]}"

# Validate noir_version consistency
expected=""
for name in "${CIRCUITS[@]}"; do
  artifact="${SDK_CIRCUITS}/${name}.json"
  [[ -f "${artifact}" ]] || continue

  version=$(python3 -c "import json,sys; d=json.load(open('${artifact}')); print(d.get('noir_version','').split('+')[0])" 2>/dev/null || true)
  if [[ -z "${version}" ]]; then
    continue
  fi

  if [[ -z "${expected}" ]]; then
    expected="${version}"
    printf "\nNoir version: %s\n" "${expected}"
  elif [[ "${version}" != "${expected}" ]]; then
    printf "WARNING: %s has version %s (expected %s)\n" "${name}" "${version}" "${expected}" >&2
  fi
done

printf "Done.\n"
