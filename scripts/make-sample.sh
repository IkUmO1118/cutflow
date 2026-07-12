#!/usr/bin/env bash
# CutFlow 「触って分かる」サンプル生成スクリプト(A12 / SD-A4)。
#
# OBS も whisper モデル(≈1.5GB)も無しで、editor→approve→render を体験できる
# 収録フォルダを用意する。ffmpeg で数秒のサンプル動画を合成し、ingest で
# manifest を作り、字幕(transcript.json)とカット案(cutplan.json)を手書きする。
#
# 承認境界は壊さない: このスクリプトは approvals.json を書かない。approved:false の
# まま止め、ユーザー自身に `approve`(人間の操作)を促す。
#
# 使い方:  npm run sample   （= bash scripts/make-sample.sh）
# 片付け:  rm -rf examples/sample
# 非mac/最小構成: CUTFLOW_CONFIG=config.minimal.yaml npm run sample
set -euo pipefail

# --- 0. リポジトリ直下へ移動(どこから叩かれてもよいように) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SAMPLE_DIR="examples/sample"
DUR=10  # 合成クリップの秒数

# config を差し替えたいとき(非mac 等)は CUTFLOW_CONFIG=config.minimal.yaml
CONFIG_ARGS=()
if [[ -n "${CUTFLOW_CONFIG:-}" ]]; then
  CONFIG_ARGS=(--config "$CUTFLOW_CONFIG")
fi

# --- 1. 前提チェック(doctor の精神で、欠けていたら親切に落ちる) ---
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✖ ffmpeg が見つかりません。先に  brew install ffmpeg  を実行してください。" >&2
  echo "  (環境全体の確認は  node src/cli.ts doctor )" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✖ node が見つかりません。Node.js 23.6+ を入れてから再実行してください。" >&2
  exit 1
fi

# --- 2. サンプルフォルダを作り直す(使い捨て。既存は黙って消す) ---
echo "▶ サンプルフォルダを用意: $SAMPLE_DIR"
rm -rf "$SAMPLE_DIR"
mkdir -p "$SAMPLE_DIR"

# --- 3. ffmpeg でサンプル動画を合成(動き=testsrc2 / 可聴音=sine 440Hz) ---
#   ingest は音声トラックを必須にするため、必ず音声を入れる。
#   plain レイアウトなので出力解像度=この 1280x720 がそのまま最終解像度になる。
echo "▶ サンプル動画を合成中(${DUR}秒 / 1280x720 / 30fps)..."
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=${DUR}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${DUR}" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest \
  "$SAMPLE_DIR/raw.mp4"

# --- 4. ingest(manifest.json + マイク音声抽出)。whisper は呼ばない ---
echo "▶ ingest(manifest 生成)..."
node src/cli.ts "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" ingest "$SAMPLE_DIR" --layout plain

# --- 5. 字幕(transcript.json)を手書き。whisper の代わりに2件だけ ---
#   words は付けない(karaoke/語境界カット非対象)。validate は words 無しを
#   warn のみで通す(exit 0)。
cat > "$SAMPLE_DIR/transcript.json" <<'JSON'
{
  "language": "ja",
  "segments": [
    { "start": 0.5, "end": 3.5, "text": "CutFlow のサンプル動画" },
    { "start": 6.5, "end": 9.5, "text": "この字幕は最終レンダーで焼き込まれます" }
  ]
}
JSON

# --- 6. カット案(cutplan.json)を手書き。keep/cut/keep で「実際に切れる」を見せる ---
#   approved は false のまま(承認は人間の操作。approvals.json は書かない)。
#   keep は時系列順・重なり無し・duration 内(0–4, 6–10)。4–6 の cut が最終動画から消える。
cat > "$SAMPLE_DIR/cutplan.json" <<'JSON'
{
  "approved": false,
  "segments": [
    { "action": "keep", "start": 0,  "end": 4,  "reason": "イントロ(残す)" },
    { "action": "cut",  "start": 4,  "end": 6,  "reason": "サンプルのカット(この2秒が最終動画から消える)" },
    { "action": "keep", "start": 6,  "end": 10, "reason": "本編(残す)" }
  ]
}
JSON

# --- 7. 整合性チェック(壊れた JSON を配らない。words 無し warn は想定内=exit 0) ---
echo "▶ validate..."
node src/cli.ts "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" validate "$SAMPLE_DIR"

# --- 8. 次の一手を提示(script は承認・render しない) ---
cat <<EOF

✅ サンプル収録を用意しました: $SAMPLE_DIR
   （合成 raw.mp4 / manifest.json / transcript.json / cutplan.json。approved:false）

次の3ステップで editor→render を体験できます:

  1) 編集を触る（ブラウザで開く。Ctrl+C で終了）
       node src/cli.ts editor $SAMPLE_DIR

  2) 承認する（承認は人間の操作。preview/GUI で確認したうえで）
       node src/cli.ts approve $SAMPLE_DIR
       # 端末が対話的なら y/N を聞かれます。承認レコードは approvals.json に記録されます。

  3) 最終レンダー（初回は Remotion が headless Chrome を取得するため数分）
       node src/cli.ts render $SAMPLE_DIR
       # => $SAMPLE_DIR/final.mp4

片付け:  rm -rf $SAMPLE_DIR
EOF
