# CutFlow 導入・オンボーディング診断 — クローンから稼働までの導線

*2026-07-12 / 対象: 現行 main*

> 前提: 機能面(AI ネイティブ NLE としての知覚・行動・承認境界)は成熟した
> (`docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`、精度母艦、審美眼母艦)。
> 本書は別軸 —— **「多くのユーザーに使われる」ために、クローンから初レンダーまでの
> activation(初回稼働)導線がどれだけ細いか** —— を実装接地で診断し、直す順に並べる。

---

## 0. 結論(一言)

**機能は十分。詰まっているのは「稼働に到達するまで」。** 現状の導線は

1. **暗黙的**(何が要るか・何が壊れているかを一箇所で教える手段が無い)、
2. **macOS 既定に固定**(既定 config が非 mac で初手 `editor` から壊れる)、
3. **未パッケージ**(`npx`/グローバルコマンドが無く、`cd` して `node src/cli.ts`)

の3点で細い。これは3つの具体物で大きく解ける:

- **(1) `cutflow doctor`** — 環境プリフライト(§4.1)。中盤で出る暗黙失敗を、最初の1コマンドの明示チェックリストに変える。**最優先・低コスト・全ユーザーに効く。**
- **(2) AI 委任セットアップ `SETUP_WITH_AI.md`** — このリポジトリの読者はほぼ Claude Code 等のエージェントを持つ。**リポジトリをエージェントに渡せば自動で環境を整える**プロンプト(§4.2 / 実物は別ファイル)。本製品の対象読者に最も刺さる導線。
- **(3) パッケージ化** — `bin` フィールド / `setup.sh` / Node バージョンガード / 非 mac 既定の自動選択(§4.3)。

---

## 1. 現状の導線を段ごとに解剖(クローン → 初レンダー)

| # | ステップ | 前提(暗黙含む) | 失敗モードと現在地 |
|---|---|---|---|
| 0 | `git clone` | git | OK |
| 1 | Node 実行系 | **Node ≥ 23.6**(TS type-stripping) | Node 20/22 LTS だと `node src/cli.ts` が **TS 構文エラーで即死**。`package.json` の `engines` は宣言のみで**強制も警告もしない** |
| 2 | `npm install` | npm | OK(ネイティブビルド無し) |
| 3 | 外部バイナリ | `ffmpeg` / `whisper-cli` を PATH に | 未導入だと**使う段(ingest/transcribe)で初めて失敗**。事前検知が無い |
| 4 | whisper モデル | `~/Models/whisper/ggml-large-v3-turbo-q5_0.bin`(**≈1.5GB 手動 curl**) | パス不一致・DL 失敗は `transcribe` 段まで露見しない |
| 5 | AI provider | 既定 `claude-code` = `claude` CLI + ログイン | 未導入だと `plan` 段で「コマンド 'claude' が見つかりません」。`ai doctor` はあるが**任意・存在を知らないと使わない** |
| 6 | 収録を置く | `~/Movies/cutflow/<dir>/` に動画1本 | plain 既定でスマホ/画面録画も可(**良い**)。ただし README は OBS 拡張キャンバスを前面に出し、心理的ハードルを上げている |
| 7 | `editor <dir>` | — | **初回に `proxy.mp4` を生成**。既定 `videoEncoder: videotoolbox` は **macOS 専用**。非 mac は**ここで ffmpeg エラー**(初手で詰む) |
| 8 | 編集 → 承認 → `render` | Remotion | 初 render で **headless Chrome を自動 DL(数分・無警告の沈黙時間)** |

**導線の性質**: 失敗が **前段に出ず中盤に出る**(3→ingest、4→transcribe、5→plan、7→proxy)。ユーザーは「どこまで正しく、何が足りないか」を一望できない。

---

## 2. 致命的な摩擦(効き順 = severity × 母集団影響 × 直し易さ)

| 順 | 摩擦 | severity | 母集団への影響 | 直し易さ | 出所(実測) |
|---|---|---|---|---|---|
| A | **環境プリフライトが無い**(部分失敗が中盤に出る) | blocker | 全員 | **易(S)** | `ai doctor` は AI のみ。ffmpeg/whisper/model/node/chrome を見る単一コマンドが無い |
| B | **非 mac 既定破綻**(`videotoolbox`) | blocker(非mac) | Linux/Windows 全員 | **易(S)** | `config.yaml` `preview.videoEncoder: videotoolbox` → `videoEncode.ts` は `libx264` 明示時以外 `h264_videotoolbox` |
| C | **Node ≥ 23.6 ハード要件**(未強制) | major | LTS 勢 | 易(S) | `package.json engines` 宣言のみ。実行時ガード無し |
| D | **未パッケージ**(`npx`/global 無し) | major | 全員(体験) | 中(M) | `package.json` に `bin` フィールド無し。`node src/cli.ts` 直叩き固定 |
| E | **whisper モデル 1.5GB 手動 curl** | major | 全員 | 中(M) | 手順書に curl 一行。検証・再開・進捗が無い |
| F | 既定 provider が `claude` CLI 前提 | major | claude CLI 非導入者 | 易(S) | 既定 `claude-code`。API 切替は config 手編集 |
| G | README が最難関(OBS 拡張キャンバス)を前面に | minor | 新規の心理 | 易(S) | plain 既定なのに README は拡張キャンバスを前提として提示 |
| H | 「動くのを見る」までが遠い | major | 評価/採用転換 | 中(M) | 同梱サンプル→即レンダーのデモ経路が無い。OBS 収録して初めて価値が見える |

> **最大の非対称性**: A と B は **severity=blocker なのに直し易さ=易(S)**。ここが最もレバレッジが高い。

---

## 3. 非対応環境マトリクス(現状の正直な姿)

| 機能 | macOS | Linux | Windows | 備考 |
|---|---|---|---|---|
| ingest / transcribe / detect | ✓ | ✓ | ✓ | ffmpeg + whisper.cpp はクロスプラットフォーム |
| proxy / preview(既定 encoder) | ✓ | **✗** | **✗** | 既定 `videotoolbox`。**非 mac は `libx264` を明示しないと初手で失敗** |
| render(Remotion) | ✓ | ✓ | ✓ | `hardwareAcceleration: if-possible` はソフトへ優雅に劣化 |
| 画面 OCR(`frames --ocr` / plan OCR) | ✓ | ✗(劣化) | ✗(劣化) | Apple Vision 専用。**非対応は警告して自動スキップ**(設計どおり) |
| editor の「Finder で開く」 | ✓ | 無視 | 無視 | `open` は失敗時サイレント no-op(実害なし) |

**含意**: OCR と VideoToolbox は本質的に mac 依存。だが **`videoEncoder` を非 mac で自動 `libx264` にするだけで、Linux/Windows は "OCR 抜きで普通に動く" に昇格**する(現状は "初手で壊れる")。TAM(潜在ユーザー数)を大きく広げる最小の一手。

---

## 4. 解決策(3本柱 + 補助)

### 4.1 `cutflow doctor` — 環境プリフライト(最優先)

**狙い**: 「使う段で初めて分かる暗黙失敗」を「最初の1コマンドで一望できる明示チェックリスト」へ。オンボーディングの単一の入口にする。

**チェック項目(実装接地)**:

| 区分 | 項目 | 方法 | 欠落時 |
|---|---|---|---|
| 必須 | Node ≥ 23.6 | `process.versions.node` | error(exit 1) |
| 必須 | `config.yaml` 読込 | `loadConfig()` | error |
| 必須 | ffmpeg | `ffmpeg -version` | error + `brew install ffmpeg` 案内 |
| 必須 | エンコーダ整合 | `ffmpeg -encoders` に `cfg.preview.videoEncoder` 相当があるか | error + 「非 mac は `preview.videoEncoder: libx264`」 |
| 収録時 | whisper-cli | `which cfg.whisper.bin` | warn(編集だけなら不要) |
| 収録時 | whisper モデル | `existsSync(expandHome(cfg.whisper.model))` | warn + DL コマンド提示 |
| AI 使用時 | provider 疎通 | **既存 `ai doctor` に委譲** | warn |
| 任意 | swiftc(OCR) | mac のみ `which swiftc` | info |
| 任意 | recordingsDir | 存在/作成可否 | info |
| 情報 | 初 render で Chrome を DL する旨 | 静的注記 | info |

**出力仕様**: 1 行 1 チェック(`✓ / ⚠ / ✗` + 対処ヒント)。**必須が1つでも欠ければ exit 1**、収録/AI 系の欠落は exit 0 の warn(編集だけなら動くため)。`--json` で機械可読(AI 委任セットアップが読む)。

**実装規模**: 小。既存の `run()`(exec)・`loadConfig()`・`aiDoctor` を束ねる 1 ステージ + CLI 結線。**5点セット**(types 不要 / `AGENTS_CONTRACT.md` のコマンド表 + `test/agentsMd.test.ts` / usage.md / doctor 自体の unit)を揃える。生成物なし(読み取り専用)なので承認境界・`GENERATED_FILES` に無関係。

### 4.2 AI 委任セットアップ(`SETUP_WITH_AI.md`)— ユーザーの明示要望

**設計思想**: 本製品の読者は **ほぼ全員が AI コーディングエージェント(Claude Code 等)を既に持つ**。ならばセットアップ自体をエージェントに委任できる。「クローン → リポジトリをエージェントに渡す → 自動で環境が整い、`doctor` が緑になる」を一級の導線にする。

**エージェントにさせること**(実物は同梱の [`SETUP_WITH_AI.md`](../../SETUP_WITH_AI.md)):

1. OS・Node・ffmpeg・whisper・モデル・AI provider を**検査してから**不足のみ導入(冪等)。
2. **大きな副作用(1.5GB モデル DL・brew install)は実行前に要約して確認**を取る。
3. 非 mac を検知したら `config.yaml` の `preview.videoEncoder` を `libx264` に寄せ、OCR 不可を明示。
4. provider を対話決定(claude-code / anthropic / openai / codex)。API なら `.env` を用意。
5. 最後に **`node src/cli.ts ai doctor`(将来は `cutflow doctor`)で緑を確認**し、スモークテストまで。

**安全境界(プロンプトに明記)**: セットアップは環境構築のみ。**承認(`approve`)・`render`・`plan --force` などユーザー資産に触れる操作はしない**(CLAUDE.md / AGENTS_CONTRACT の承認境界と整合)。

> `doctor --json` があると AI 委任は劇的に堅くなる(自然文パースでなく状態を読める)。**4.1 と 4.2 は対で効く。**

### 4.3 パッケージ化・スクリプト化

**(a) `bin` フィールド(即実施可)** — `package.json` に

```jsonc
"bin": { "cutflow": "src/cli.ts" }
```

`src/cli.ts` 先頭に shebang `#!/usr/bin/env -S node --experimental-strip-types`(または Node 23.6+ は不要)を足せば `npm link` で `cutflow <cmd>` が通る。将来 `npm publish` すれば `npx cutflow@latest ...`。**「`node src/cli.ts` を毎回打つ」体験を消す。**

**(b) Node バージョンガード(即実施可)** — `src/cli.ts` の最初で

```
Node < 23.6 → 「CutFlow は Node 23.6+ が必要です(現在 vX)。nvm 等で切替を」+ exit 1
```

TS 構文エラーの前に**人間可読で落とす**。`.nvmrc`(`23`)も置く。

**(c) 非 mac 既定の自動選択(即実施可・B の恒久修正)** — `videoEncode.ts` で `process.platform !== "darwin"` かつ設定が既定のとき `libx264` を選ぶ(明示設定は尊重)。**非 mac の初手破綻を消す。**

**(d) `scripts/setup.sh`(bootstrap)** — 対話は最小に、`doctor` を最後に呼ぶ薄いラッパ:

```
Node チェック → brew install ffmpeg whisper-cpp(mac)→ モデル DL(確認付き)→ npm install → node src/cli.ts doctor
```

CI からも叩けるよう非対話フラグ(`--yes`)を用意。**AI 委任(4.2)と二者択一ではなく併存**(手で最短導入したい層に `setup.sh`、エージェントを使う層に `SETUP_WITH_AI.md`)。

**(e) 将来**: `npm publish`(モデル・ffmpeg は同梱不可なので postinstall で `doctor` 案内)/ Docker(Linux + libx264 + whisper で "OCR 抜きの再現可能環境")/ サンプル収録同梱(§4.4 H)。

### 4.4 補助(採用転換の心理面)

- **G(README の順序)**: README の先頭を **plain(スマホ/画面録画で今すぐ試せる)** に。OBS 拡張キャンバスは "カメラワイプを使う人向けの発展" に格下げ。最難関を最初に見せない。
- **H(動くのを見るまでが遠い)**: **数秒の同梱サンプル収録**(または生成スクリプト)で `editor` → `render` を DL・OBS 無しで体験できる "触って分かる" 経路。評価→採用の転換率に直結。
- **デモ可視化**: README に 30 秒 GIF/動画 と、英語 README(グローバルな dev-YouTuber へ広げるなら)。

---

## 5. 実装ロードマップ(効き順・独立着手可)

| 順 | 施策 | 効き | コスト | 依存 |
|---|---|---|---|---|
| 1 | `cutflow doctor`(§4.1)+ `--json` | ★★★ | S | — |
| 2 | `SETUP_WITH_AI.md`(§4.2) | ★★★ | S(文書) | doctor があると堅い |
| 3 | 非 mac 既定 `libx264` 自動(§4.3c) | ★★★(非mac) | S | — |
| 4 | Node ガード + `.nvmrc`(§4.3b) | ★★ | S | — |
| 5 | `bin` フィールド + shebang(§4.3a) | ★★ | S | — |
| 6 | `scripts/setup.sh`(§4.3d) | ★★ | M | doctor |
| 7 | README を plain 先頭へ(§4.4 G) | ★★ | S | — |
| 8 | 同梱サンプル→即 render デモ(§4.4 H) | ★★ | M | — |
| 9 | npm publish / Docker(§4.3e) | ★ | L | 1–6 |

**次の一手**: 1(`doctor`)と 2(`SETUP_WITH_AI.md`)は対で効き、どちらも低コスト。3 は非 mac の TAM を一撃で開ける同コスト施策。**この 3 本を最初の束**にする。

---

## 6. まとめ

CutFlow の堀(video-as-code / local-first / agent-editable / approval-gated)は本物で、**機能はもう "使われない理由" ではない**。使われない理由は **「稼働に到達する前に、暗黙の前提と mac 既定と未パッケージで脱落する」** こと。

- **doctor** が "何が足りないか分からない" を消し、
- **AI 委任セットアップ** が "自分でやるのが面倒" を(本製品の読者に最適な形で)消し、
- **非 mac 既定修正 + パッケージ化** が "そもそも自分の環境で動かない/入れづらい" を消す。

いずれも severity は高く、コストは小さい。**次フェーズは新機能ではなく "activation(初回稼働)の設計"** に置くのが、"多くのユーザーに使われる" への最短路である。
