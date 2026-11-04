#!/usr/bin/env bash
set -euo pipefail

: "${XOCHI_RECIPIENT_PASSPHRASE:?read from op://<vault>/<recipient>/passphrase}"
: "${XOCHI_RECIPIENT_BACKUP:?path to the independently transferred encrypted backup}"
: "${XOCHI_RECIPIENT_DATA_DIR:?path to a new encrypted data directory}"
: "${XOCHI_AZTEC_NODE_URL:?recipient-selected Aztec node URL}"
: "${XOCHI_OXIDE_TOKEN_ARTIFACT:?path to the independently verified OxideToken artifact}"

if [[ -e "$XOCHI_RECIPIENT_DATA_DIR" ]]; then
  printf 'restore destination already exists\n' >&2
  exit 1
fi
if [[ ! -r "$XOCHI_RECIPIENT_BACKUP" || ! -r "$XOCHI_OXIDE_TOKEN_ARTIFACT" ]]; then
  printf 'restore input is unreadable\n' >&2
  exit 1
fi

xochi-recipient diagnostics --backup "$XOCHI_RECIPIENT_BACKUP"
install -d -m 700 "$XOCHI_RECIPIENT_DATA_DIR"
xochi-recipient restore \
  --data-dir "$XOCHI_RECIPIENT_DATA_DIR" \
  --backup "$XOCHI_RECIPIENT_BACKUP" \
  --node-url "$XOCHI_AZTEC_NODE_URL" \
  --oxide-token-artifact "$XOCHI_OXIDE_TOKEN_ARTIFACT"
xochi-recipient balance \
  --data-dir "$XOCHI_RECIPIENT_DATA_DIR" \
  --node-url "$XOCHI_AZTEC_NODE_URL" \
  --oxide-token-artifact "$XOCHI_OXIDE_TOKEN_ARTIFACT"
xochi-recipient operations --data-dir "$XOCHI_RECIPIENT_DATA_DIR"
printf 'independent restore completed; inspect any unresolved journal before moving funds\n'
