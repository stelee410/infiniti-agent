#!/usr/bin/env bash
set -euo pipefail

BROKER_URL="${BROKER_URL:-https://amp.linkyun.co}"
AGENT_ID="${AGENT_ID:-30bc8485-c1af-4fad-b83b-5915c8673632}"
AGENT_ADDRESS="${AGENT_ADDRESS:-steve-pm@stelee.amp.linkyun.co}"
API_KEY="${AMP_API_KEY:-}"
POLL_SECONDS="${POLL_SECONDS:-10}"

# Optional fallback: read API key from SOUL.md if env is not set
if [[ -z "$API_KEY" && -f "SOUL.md" ]]; then
  API_KEY="$(grep -Eo 'amk_[A-Za-z0-9]+' SOUL.md | head -n1 || true)"
fi

if [[ -z "$API_KEY" ]]; then
  echo "[error] API key not found. Set AMP_API_KEY, or keep key in SOUL.md." >&2
  exit 1
fi

echo "[info] Polling inbox for ${AGENT_ADDRESS} every ${POLL_SECONDS}s..."

while true; do
  inbox_json="$(curl -fsS "${BROKER_URL}/messages/inbox/${AGENT_ADDRESS}?agent_id=${AGENT_ID}" \
    -H "X-API-Key: ${API_KEY}" || true)"

  if [[ -z "$inbox_json" ]]; then
    echo "[warn] Failed to fetch inbox. Retry in ${POLL_SECONDS}s..." >&2
    sleep "$POLL_SECONDS"
    continue
  fi

  has_unread="$(printf '%s' "$inbox_json" | node -e '
let s="";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(s);
    const unread = Array.isArray(data) && data.some(m => m && m.is_read === false);
    process.stdout.write(unread ? "1" : "0");
  } catch {
    process.stdout.write("0");
  }
});
')"

  if [[ "$has_unread" == "1" ]]; then
    echo "[info] Unread email detected -> running: infiniti-agent --cli \"check\""
    infiniti-agent --cli "check" || echo "[warn] infiniti-agent exited with non-zero status" >&2
  fi

  sleep "$POLL_SECONDS"
done
