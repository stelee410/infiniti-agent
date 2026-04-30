#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://192.3.16.77:8080/v1/images/generations"
API_KEY="sk-a4d42e6d27ccfaba4300580b38af99b46fa58db4c1d5e1f1af2d442987ffe631"
MODEL="gpt-image-2"
SIZE="1024x1536"
OUT_DIR="/Users/stelee/Dev/infiniti-agent/infiniti-agent/real2d-expressions"

STYLE="An anime portrait of a beautiful young woman in the 1980s-90s Hojo Tsukasa City Hunter aesthetic. Classic Japanese anime style with soft shading, detailed expressive eyes with highlights, elegant facial features, semi-realistic proportions, stylish urban look, slightly windswept dark hair, warm color palette. Clean headshot portrait, true alpha-transparent PNG background, no checkerboard, no solid background box, no scenery, centered composition, high quality illustration."

declare -a FILES=(exp01.png exp02.png exp03.png exp04.png exp05.png exp06.png exp_open.png)
declare -a EXPRESSIONS=(
  "neutral calm expression, relaxed eyes, natural gaze, mouth closed, subtle relaxed lips, no strong emotion"
  "happy cheerful expression, bright smile, smiling eyes, lifted cheeks, warm friendly look, same pose and framing"
  "sad melancholy expression, downturned mouth corners, sad eyebrows raised at the inner ends, soft droopy eyes, quiet sorrowful look, no tears"
  "angry expression, furrowed brows pointing downward toward the center, intense gaze, frowning or tight pressed lips, serious tense face"
  "surprised expression, wide open eyes, eyebrows raised high, small open mouth or rounded surprised lips, alert startled look"
  "eyes closed peacefully, relaxed expression, mouth closed, calm serene face, soft relaxed eyebrows, gentle peaceful mood"
  "natural speaking open mouth, jaw slightly lowered, lips parted in a clear talking shape, teeth slightly visible if natural, eyes open, otherwise neutral calm face"
)

for i in "${!FILES[@]}"; do
  FILE="${FILES[$i]}"
  EXP="${EXPRESSIONS[$i]}"
  echo "=== Generating $FILE ==="
  
  FULL_PROMPT="${STYLE} Modify only the facial expression to: ${EXP}."
  
  BODY=$(jq -n \
    --arg model "$MODEL" \
    --arg prompt "$FULL_PROMPT" \
    --arg size "$SIZE" \
    '{model:$model, prompt:$prompt, size:$size, n:1, response_format:"b64_json"}')
  
  RESP=$(curl -sS "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$BODY")
  
  B64=$(echo "$RESP" | jq -r '.data[0].b64_json // empty')
  if [ -z "$B64" ]; then
    echo "ERROR: failed to generate $FILE"
    echo "$RESP" | head -c 500
    exit 1
  fi
  echo "$B64" | base64 --decode > "$OUT_DIR/$FILE"
  echo "Saved $OUT_DIR/$FILE ($(wc -c < "$OUT_DIR/$FILE") bytes)"
  sleep 2
done

echo ""
echo "=== Done! All 7 real2d expression PNGs generated ==="
ls -lh "$OUT_DIR"/exp*.png
