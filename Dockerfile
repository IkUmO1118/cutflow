# CutFlow — Linux 再現環境(SD-A6 / A18 Docker スライス)。
# mac 非依存で「fresh-clone → doctor 緑 → preview/render」を再現するためのイメージ。
# 必須(doctor required): node>=23.6 / ffmpeg / ffprobe / config。
# whisper(bin/model)と AI provider は焼き込まない=doctor では warn / skip(想定内)。
#
# ビルド:  docker build -t cutflow .
# 動作確認: docker run --rm cutflow doctor --no-ai   # required ok, exit 0
# 収録編集: docker run --rm -v ~/Movies/cutflow:/recordings cutflow doctor /recordings/<dir>

# ベース: Node 24(>=23.6 を満たし型ストリッピング既定 ON。23 系は EOL のため不採用)。
# bookworm(Debian 12)= apt ffmpeg に libx264、Remotion/Chromium 依存が全部そろう。
# -slim でイメージを小さく保つ(必要ライブラリは下で明示インストール)。
FROM node:24-bookworm-slim

# --- OS 依存 ---
# ffmpeg: ffprobe と libx264 を同梱(A2 の非 mac 既定 libx264 が実際に効く土台)。
# fonts-noto-cjk: render の日本語テロップ字形(無いと豆腐になる)。
# lib*: @remotion/renderer の chrome-headless-shell が要求する Debian ランタイム依存。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      fonts-noto-cjk \
      libnss3 \
      libdbus-1-3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libxext6 \
      libxshmfence1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存を先に入れてレイヤーキャッシュを効かせる(package-lock.json があるので npm ci)。
# devDependencies も入れる(editor の esbuild バンドル / typecheck を動かすため)。
# render の Chromium は npm install では落ちない(初回 render 時に遅延 DL)。
COPY package.json package-lock.json ./
RUN npm ci

# アプリ本体。
COPY . .

# A2 パリティ: 既定 config が videoEncoder: videotoolbox を明示しているため、Linux
# イメージ内では libx264 を明示にして preview/render を通す(ソースの config.yaml は
# 不変。イメージ層の複製だけを変換)。これで doctor の encoder=ok・preview 手編集ゼロ。
RUN sed -i 's|^\([[:space:]]*\)videoEncoder: videotoolbox|\1videoEncoder: libx264|' config.yaml

# 任意: render の headless Chrome を焼き込んでオフライン render 可能にしたい場合は
# 次行を有効化(イメージが ~150MB 増える。既定は無効=初回 render 時に自動 DL)。
# RUN npx remotion browser ensure

# `docker run --rm cutflow <subcommand> ...` でサブコマンドを渡せる。
ENTRYPOINT ["node", "src/cli.ts"]
# 引数なし `docker run --rm cutflow` は AI 抜き doctor(最短の動作確認)。
CMD ["doctor", "--no-ai"]
