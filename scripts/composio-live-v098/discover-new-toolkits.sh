#!/bin/bash
# Discovery live 18 toolkit mới v0.96 (Team T4) qua helper connector.
# Không key thô: helper lấy surrogate từ connector custom.composio.
set -u
OUT="$(dirname "$0")/toolkits-live-2026-11-13.txt"
: > "$OUT"
for tk in stripe shopify box confluence gitlab calendly mailchimp twilio googledocs youtube linkedin reddit whatsapp pagerduty typeform sendgrid bitbucket freshdesk; do
  echo "=== $tk ===" >> "$OUT"
  python3 ~/workspace/custom-connectors/custom.composio/bin/composio.py list-tools --toolkit "$tk" --limit 1000 >> "$OUT" 2>&1
  echo "--- $tk done: $(tail -1 "$OUT")" >&2
done
echo "wrote $OUT"
