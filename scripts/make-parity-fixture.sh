#!/usr/bin/env bash
# G1 画素ゲート用の parity フィクスチャ収録を生成する(合成 raw.mp4 + 素材 + ingest)。
#
# scripts/make-sample.sh の書き方(前提チェック→生成→ingest→validate→次の一手)をなぞる。
# 手書きの編集JSON(cutplan.json/transcript.json/overlays.json)は
# このスクリプトが触らない領域(test(engine): G1 フィクスチャの編集 JSON(12シーン)を追加 の
# コミットで別途用意される。golden の素になるため、再実行しても勝手に変えてはならない)。
#
# 使い方: bash scripts/make-parity-fixture.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FIXTURE_DIR="test/fixtures/engine/parity-project"
CONFIG="test/fixtures/engine/parity.config.yaml"
DUR=24

# --- 0. 前提チェック(doctor の精神で、欠けていたら親切に落ちる) ---
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✖ ffmpeg が見つかりません。先に  brew install ffmpeg  を実行してください。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✖ node が見つかりません。Node.js 23.6+ を入れてから再実行してください。" >&2
  exit 1
fi

mkdir -p "$FIXTURE_DIR/materials"

# drawtext(freetype)が使えないビルドもあるため、事前に確認して劣化させる
DRAWTEXT_OK=1
if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -q " drawtext "; then
  DRAWTEXT_OK=0
  echo "⚠ drawtext フィルタが使えないため時刻の焼き込みを省略します(ffmpegビルドにfreetype無し)" >&2
fi

# --- 1. フィクスチャ映像を合成(左=画面キャプチャ testsrc2 / 右=カメラ smptebars) ---
echo "▶ フィクスチャ映像を合成中(${DUR}秒 / 1920x540 / 30fps)..."
if [[ "$DRAWTEXT_OK" -eq 1 ]]; then
  FILTER_COMPLEX="[0:v][1:v]hstack=inputs=2,drawtext=text='%{pts\\:hms}':fontsize=36:fontcolor=white:x=20:y=20[v]"
else
  FILTER_COMPLEX="[0:v][1:v]hstack=inputs=2[v]"
fi
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=960x540:rate=30:duration=${DUR}" \
  -f lavfi -i "smptebars=size=960x540:rate=30:duration=${DUR}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${DUR}" \
  -filter_complex "$FILTER_COMPLEX" \
  -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -shortest \
  "$FIXTURE_DIR/raw.mp4"

# --- 2. 素材(materials/)を合成。シーン#5(素材overlay)/#6(インサート)で使う ---
echo "▶ 素材(materials/)を合成中..."
if [[ "$DRAWTEXT_OK" -eq 1 ]]; then
  ffmpeg -y -v error -f lavfi -i "color=size=320x180:color=orange:duration=1,drawtext=text='MATERIAL':fontsize=28:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2" \
    -frames:v 1 "$FIXTURE_DIR/materials/still.png"
else
  ffmpeg -y -v error -f lavfi -i "color=size=320x180:color=orange:duration=1" \
    -frames:v 1 "$FIXTURE_DIR/materials/still.png"
fi
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=5" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=5" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest \
  "$FIXTURE_DIR/materials/clip.mp4"

# --- 3. ingest(manifest 生成。obs-canvas。JSON編集ファイルには触れない) ---
echo "▶ ingest(manifest 生成)..."
node src/cli.ts --config "$CONFIG" ingest "$FIXTURE_DIR" --layout obs-canvas

# --- 4. 整合性チェック(cutplan.json/transcript.json が無ければ validate は
#         「ファイルがありません」で落ちる。T-4 の編集JSON追加後にのみ通る想定) ---
echo "▶ validate..."
if node src/cli.ts --config "$CONFIG" validate "$FIXTURE_DIR"; then
  cat <<EOF

✅ フィクスチャの準備ができています: $FIXTURE_DIR
EOF
else
  cat <<EOF >&2

⚠ validate がエラーで止まりました。cutplan.json/transcript.json/overlays.json/
  編集JSONがまだ無い場合は想定内です(このスクリプトは編集JSONを書きません。
  test(engine): G1 フィクスチャの編集 JSON(12シーン)を追加 で用意されます)。
EOF
fi
