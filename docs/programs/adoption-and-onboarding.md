# 導入・普及プログラム — クローンから稼働、そして定着まで

> 状態: **稼働中の作業母艦**(初版 2026-07-12)。単発の feature 設計ではなく、
> 「CutFlow を多くのユーザーに実際に使ってもらう」ための **activation(初回稼働)と
> retention(定着)の摩擦を継続的に潰す**取り組みを管理する生きたドキュメント。
> 施策は §4 のバックログで状態管理し、意思決定は §6 に追記する。
>
> **前提となる方針**(2026-07-12): 機能面(video-as-code / 承認境界 / エージェント編集 /
> キーフレーム / 速度変更)はもう「使われない理由」ではない(`docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> ・精度母艦・審美眼母艦)。**次に効くのは新機能ではなく「稼働に到達する導線」**。
> 出発点の診断は `docs/reviews/2026-07-12-adoption-onboarding-diagnosis.md`。

関連母艦:
- `edit-precision-program.md`(精度母艦) — 編集判断の精度。
- `aesthetic-judgment-and-style-learning.md`(審美眼母艦) — 判断品質とスタイル学習。
- **本書(導入母艦)** — 上2つが上げた「編集の質」を、そもそもユーザーが**体験に到達**
  できるようにする層。3つは直交する(質・審美・到達)。

---

## 1. 目的とスコープ

**目的**: 「クローン → 初レンダー → 2本目を撮る」までの脱落を最小化する。技術的に
できることと、ユーザーが**実際に到達できる**ことの差を埋める。

**スコープ**(利用ライフサイクル全体):

1. **発見**(clone 前の第一印象) 2. **導入**(依存・設定) 3. **設定**(config・収録前提)
4. **収録**(実データを持つまで) 5. **編集ループ**(editor / AI / 承認 / render)
6. **回復**(失敗時の自己解決) 7. **更新・保守**(git pull・設定ドリフト・ディスク)

**スコープ外**: 新しい編集能力(精度母艦・審美眼母艦・`docs/next-features-design.md`)。
本書は**既存能力への到達性**に閉じる。

---

## 2. 中心命題と原則

> **中心命題**: CutFlow の堀(video-as-code / local-first / agent-editable / approval-gated)は
> 本物だが、**堀に辿り着く前に、暗黙の前提・macOS 既定・未パッケージで脱落する**。
> 直すべきは能力ではなく **activation の設計**。

**原則**(全施策に効く設計指針):

1. **失敗は前段で・明示的に**。「使う段で初めて分かる暗黙失敗」を「最初の1コマンドの
   明示チェックリスト」へ(A1 `doctor` が背骨)。
2. **既定で最大母集団が動く**。macOS 既定で非 mac が壊れる状態を消す。既定 config は
   「何も編集せず最初のプレビューまで到達」できること。
3. **本製品の読者はエージェントを持つ**。セットアップ自体を AI に委任できる導線を一級に
   する(A5 `SETUP_WITH_AI.md`)。
4. **非破壊・承認境界を壊さない**。導入系スクリプト/エージェントは環境構築のみ。
   `approve`/`render`/`plan --force` に触れない(`AGENTS_CONTRACT.md` §5)。
5. **既存の単一の出所を再利用**。掃除・分類は `src/lib/files.ts`(`GENERATED_FILES` /
   `fileRole`)を正にし、二重定義を作らない。

---

## 3. 摩擦の全景(ライフサイクル別・実装接地)

`◆`=前回診断で既出 / `★`=本調査で新規に特定。severity は blocker/major/minor。

### 3.1 発見(clone 前)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | README が日本語のみ・デモ動画/GIF・スクショ・比較(vs Descript/CapCut)が無い | `README.md` | major |
| ◆ | 最難関(OBS 拡張キャンバス)を前面に出し、plain の "今すぐ試せる" を埋もれさせている | `README.md` / getting-started | minor |

### 3.2 導入(依存・パッケージ)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ◆ | **環境プリフライトが無い**(ffmpeg/whisper/model/node/chrome を見る単一コマンド不在。`ai doctor` は AI のみ) | `src/stages/aiDoctor.ts` | **blocker** |
| ◆ | **非 mac 既定破綻**: `preview.videoEncoder: videotoolbox` → 非 mac ffmpeg に無く初手 `editor`(proxy 生成)で失敗 | `config.yaml` / `videoEncode.ts` | **blocker**(非mac) |
| ◆ | Node ≥ 23.6 ハード要件が未強制(LTS 勢は TS 構文エラーで即死) | `package.json engines` | major |
| ◆ | 未パッケージ(`bin` 無し=`npx`/global 不可、毎回 `node src/cli.ts`) | `package.json` | major |
| ◆ | whisper モデル ≈1.5GB 手動 curl(検証・再開・進捗なし) | getting-started | major |
| ★ | **`.env.example` が陳腐化**: 旧 `llm.backend` を案内・`OPENAI_API_KEY` 欠落。OpenAI ユーザーが雛形をコピーしても動かない | `.env.example` | major |
| ★ | whisper モデルの階層案内が無い(まず small で即試す→本番 large の導線なし) | getting-started | minor |

### 3.3 設定(config・収録前提)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | **config.yaml が 333 行**・最小スターターや「まず触るのはここだけ」が無く初回が過負荷 | `config.yaml` | major |
| ★ | **収録トラックの脆さ**: OBS の音声トラック割当が既定(1=mic,2=system)でないと `ingest` が「マイクトラックが見つかりません」で停止。自動検出・誘導なし | `src/stages/ingest.ts:58` | major |
| ◆ | 既定 provider が `claude` CLI 前提(未導入は `plan` で停止)。API 切替は config 手編集 | getting-started | major |

### 3.4 収録(実データを持つまで)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | **OBS 拡張キャンバスの初期設定が明記 "約30分"**。plain で回避できるが、README/guide がその近道を主導線にしていない | `docs/recording-guide.md` | major |
| ★ | 「インストール済み」と「編集できる収録が手元にある」の間が遠い(触って価値を見るまでの谷) | — | major |

### 3.5 編集ループ(editor / AI / 承認 / render)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | **エージェント編集(headline 差別化)の結線が未整備**: MCP ホスト設定の copy-paste(`claude_desktop_config` 等)が README/usage に無く、設計 plan に埋もれる | `docs/usage.md` のみ | major |
| ★ | 承認境界の deny ルール(`.claude/settings.json`)が "推奨・任意" で手作業。AI 安全保証がターンキーでない | `CLAUDE.md`「権限設定」 | minor |
| ◆ | editor は CLI 起動 + localhost。非 CLI 層にはハードル(double-click 起動なし) | `editor/server.ts` | minor |
| ★ | 初 render で headless Chrome を自動 DL(数分の沈黙)。事前告知が導線上に無い | `docs/render-chunk-cache.md` 他 | minor |

### 3.6 回復(失敗時の自己解決)

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | **エラー・ドキュメント・config コメント・プロンプトが日本語のみ**。非日本語話者はエラーを読めない=グローバル普及の天井 | 全域 | major(global) |
| ◆ | 失敗が中盤に出る(前段で検知されない)ため、原因の切り分けがユーザー任せ | §3.2 A1 と同根 | major |

### 3.7 更新・保守

| # | 摩擦 | 出所 | sev |
|---|---|---|---|
| ★ | **ディスク掃除コマンドが無い**。収録ごとに proxy/cut/render.chunks/frames/shorts が累積するが `clean`/`gc` 不在 | `src/cli.ts`(grep 空) | major |
| ★ | 更新 = `git pull` のみ・バージョン表示や config スキーマ・マイグレーションが無い(古い config は警告するが自動追随しない) | — | minor |

---

## 4. 施策バックログ(効き順・状態管理)

状態: `todo` / `in-progress` / `done` / `parked`。**上ほど効いて安い**。効き=activation への
寄与、コスト=実装規模(S/M/L)。ブラッシュアップのたびにここを更新する。

| # | 施策 | 対応する摩擦 | 効き | コスト | 状態 |
|---|---|---|---|---|---|
| A1 | **`cutflow doctor`(+`--json`)** — 環境プリフライト。node/ffmpeg/encoder整合/whisper/model/provider を1コマンドで検査。必須欠落=exit1、収録/AI系=warn。既存 `run()`/`loadConfig()`/`aiDoctor` を束ねる読み取り専用ステージ | 3.2 / 3.6 | ★★★ | S | todo |
| A2 | **非 mac 既定 `libx264` 自動選択** — `videoEncode.ts` で `process.platform !== "darwin"` かつ既定時に libx264(明示設定は尊重)。非 mac 初手破綻の恒久修正 | 3.2 | ★★★ | S | todo |
| A3 | **Node バージョンガード + `.nvmrc`** — `cli.ts` 冒頭で <23.6 を人間可読に落として exit1(TS 構文エラーの前に) | 3.2 | ★★ | S | todo |
| A4 | **`bin` フィールド + shebang** — `"bin": {"cutflow": "src/cli.ts"}` で `npm link`→`cutflow <cmd>`。将来 `npx cutflow@latest` | 3.2 | ★★ | S | todo |
| A5 | **AI 委任セットアップ `SETUP_WITH_AI.md`** — リポジトリをエージェントに渡せば doctor 緑まで自動。安全境界(承認/render に触れない)明記 | 3.2 / 3.3 | ★★★ | S | **done**(2026-07-12) |
| A6 | **`.env.example` 刷新** — 旧 `llm.backend` 除去・`ai.provider` 前提・`OPENAI_API_KEY` 追加・provider 別の必要キーを併記 | 3.2 | ★★ | S | todo |
| A7 | **最小 config スターター** — `config.minimal.yaml`(or config 冒頭に「まず触るのはここだけ」節)。recordingsDir/provider/layout の3点に絞る | 3.3 | ★★ | S/M | todo |
| A8 | **`scripts/setup.sh`(bootstrap)** — Node チェック→(mac)brew→モデル DL(確認付き)→npm install→`doctor`。非対話 `--yes`(CI 用) | 3.2 | ★★ | M | todo |
| A9 | **`cutflow clean <dir>`** — 中間生成物/キャッシュを安全削除(分類は `files.ts` の `GENERATED_FILES`/`fileRole` 由来。編集ファイル・`approvals.json` は絶対に触れない)。`--dry-run`/`--cache-only` | 3.7 | ★★ | S/M | todo |
| A10 | **エージェント編集の結線** — MCP ホスト設定 copy-paste(`mcp <dir>` を Claude Desktop/Code へ)+ `.claude/settings.json` 承認 deny テンプレ + README/usage への昇格 | 3.5 | ★★ | S | todo |
| A11 | **README を plain 先頭へ** — 「スマホ/画面録画で今すぐ試せる」を主導線に、OBS 拡張キャンバスは発展として格下げ。収録タックスを最初に見せない | 3.1 / 3.4 | ★★ | S | todo |
| A12 | **触って分かるデモ** — 同梱の数秒サンプル収録(or 生成スクリプト)で OBS/DL 無しに `editor`→`render` を体験 | 3.4 | ★★ | M | todo |
| A13 | **収録トラック頑健化** — `ingest` が mic/system トラックを自動推定し、不一致時は「見つかった N トラックのどれが mic か」を提示して誘導(黙って停止しない) | 3.3 | ★★ | S/M | todo |
| A14 | **whisper モデル階層ガイド** — `base/small` で即試す→`large-v3-turbo` で本番、の2段導線。DL 進捗/検証 | 3.2 | ★ | S | todo |
| A15 | **更新・マイグレーション** — `cutflow --version`・config スキーマ版・古い config の自動追随/警告の一元化 | 3.7 | ★ | M | todo |
| A16 | **i18n 基盤** — エラー/README/docs の英語化。グローバル dev-YouTuber へ広げるなら P0、日本語圏特化なら park(§6 D-A1 で確定) | 3.6 | ★★(global) | L | parked |
| A17 | **非 CLI 起動** — editor の double-click / 最小アプリ化(macOS `.app` / `open` ラッパ) | 3.5 | ★ | L | parked |
| A18 | **配布** — `npm publish`(postinstall で doctor 案内)/ Docker(Linux+libx264+whisper の再現環境) | 3.2 | ★ | L | parked |

**最大の非対称性**: A1・A2 は **severity=blocker なのにコスト=S**。ここが最大レバレッジ。

---

## 5. 測定(activation は再現シナリオで測る)

ローカル OSS はテレメトリを取れない。代わりに**再現可能な受け入れシナリオ**を基準線にする。

- **fresh-clone 受け入れ(プラットフォーム別)**: クリーン環境(VM/コンテナ)で
  `git clone → (SETUP_WITH_AI or setup.sh) → doctor` が緑 → `editor <sample>` が
  **手による config 編集ゼロ**で開く。**mac と Linux の両方**で成立を必須にする(A2 の合否)。
- **time-to-first-render**: クローンから `final.mp4`(同梱サンプル)まで。モデル DL・
  Chrome DL を除く実作業時間を基準線にし、施策で悪化させない。
- **段別ドロップ潰しの追跡**: 診断 §1 の 8 ステップ表の各失敗モードを、どの A## が
  閉じたかを §6 に記録する(A1→3/4/5段の暗黙失敗、A2→7段、A3→1段…)。
- **doctor カバレッジ**: doctor が検査する項目数 / 実際に起きた初回失敗のうち doctor が
  事前検知できた割合。未検知の失敗が出たら doctor に項目を追加(生きた基準)。
- **エージェント委任の成否**: `SETUP_WITH_AI.md` を素のエージェントに渡し、doctor 緑まで
  人間の介入回数を数える(0〜1 を目標)。`doctor --json` の有無で堅牢さが変わる(A1↔A5)。
- **非破壊の担保**: A8/A9(スクリプト・掃除)は編集ファイル・`approvals.json` を1バイトも
  触らないことを実測(`files.ts` 分類との一致テスト)。

---

## 6. 意思決定・作業ログ(追記していく)

- **2026-07-12(診断 + 初期成果物)**: 導入診断を実施(`docs/reviews/2026-07-12-adoption-onboarding-diagnosis.md`)。
  最大の非対称性 = 「blocker(A1 プリフライト不在 / A2 非mac既定破綻)なのに直し易さ S」。
  **成果物2点を作成**: (1) 導入診断レビュー、(2) `SETUP_WITH_AI.md`(A5=done)。
- **2026-07-12(母艦起票 + 追加摩擦の特定)**: 利用ライフサイクル全体を実装接地で再走査し、
  診断で未カバーの摩擦を追加特定(§3 の `★`): **`.env.example` 陳腐化**(旧 `llm.backend`・
  `OPENAI_API_KEY` 欠落)、**config 333行に最小スターター無し**、**`clean`/`gc` コマンド不在**
  (キャッシュ累積)、**MCP ホスト結線が設計 plan に埋もれる**(headline 差別化の導線欠落)、
  **収録 OBS 設定 "約30分" タックス**と micTrack 脆弱性、**日本語のみ**(global 天井)。
  → A6–A18 をバックログ化。**方針 = activation-first**(A1–A5 を最初の束)。
- **2026-07-12(未確定の分岐)**: **D-A1 = 対象母集団**(日本語圏特化 vs グローバル)が
  **i18n(A16)を park↔P0 に分ける唯一の未決事項**。他の施策(A1–A15)は D-A1 に依存しないため、
  ロードマップは D-A1 未決のまま着手可能。D-A1 が「グローバル」なら A16 を SD-A6 から前倒しする。

---

## 7. 実装設計書ロードマップ(実装に入る順序)

「1設計書=独立着手・独立に受け入れ判定できる単位」。各 SD は精度母艦 §7 と同じ4部形式
(背景/変更/検証/リスク)で、Opus 設計 → Sonnet 実装 → コーディネータ実測のリレー
([[opus-sonnet-relay-workflow]])。**各ゲートで実測検証**(fresh-clone 受け入れ §5)。
各コマンド追加時は**5点セット**(types / validate / usage.md / `schemas/`(必要時)/
`AGENTS_CONTRACT.md`+`test/agentsMd.test.ts`)を揃える。

| SD | ねらい | 中身(施策) | 前提 | 状態 | 受け入れ基準 |
|---|---|---|---|---|---|
| **SD-A0** | **fresh-clone が動く下地** | A1 `doctor(+json)` + A2 非mac既定 + A3 Nodeガード/.nvmrc + A4 bin/shebang + A6 `.env.example` | — | **次の一手** | mac/Linux の素環境で手編集ゼロに `editor` 到達・`doctor` が状態を正しく報告(§5 fresh-clone) |
| **SD-A1** | **AI 委任の製品化** | A5(done)を `doctor --json` に接地 + README からの導線化 | SD-A0 | todo | 素エージェントが fresh-clone を doctor 緑まで介入0〜1で到達 |
| **SD-A2** | **設定の最小化と収録の頑健化** | A7 最小 config スターター + A13 収録トラック自動推定/誘導 | SD-A0 | todo | 既定 OBS 割当でなくても `ingest` が停止せず誘導 / 初回に触る設定が3点に収まる |
| **SD-A3** | **掃除とディスク** | A9 `cutflow clean`(`files.ts` 由来・非破壊) | SD-A0 | todo | 収録あたりキャッシュ削除・編集/`approvals.json` 不可侵を実測 |
| **SD-A4** | **触って分かる入口** | A11 README plain 先頭 + A12 同梱サンプル→即render + A14 モデル階層 | SD-A0 | todo | OBS/大DL 無しで clone→render を体験できる |
| **SD-A5** | **エージェント編集の結線** | A10 MCP ホスト設定 copy-paste + 承認 deny テンプレ | SD-A0 | todo | Claude Desktop/Code から `mcp <dir>` を copy-paste で接続できる |
| **SD-A6** | **配布・i18n(母集団次第)** | A16 i18n / A17 非CLI起動 / A18 npm・Docker | D-A1 確定 | **parked** | D-A1=グローバルなら A16 前倒し |

**着手順の理由**: SD-A0 が severity 最大 × コスト最小で、他の全 SD の土台(doctor が受け入れ
測定の基盤)。以降 A1(委任)→A2/A3/A4(並行可)→A5(差別化の導線)。SD-A6 は D-A1
(対象母集団)確定まで park。**次の実装単位は SD-A0。**

- 出発点の診断: `docs/reviews/2026-07-12-adoption-onboarding-diagnosis.md`
- AI 委任セットアップ(実物): `SETUP_WITH_AI.md`
- ファイル分類の単一の出所: `src/lib/files.ts`(`GENERATED_FILES` / `fileRole`)
- 機械可読契約: `AGENTS_CONTRACT.md`
