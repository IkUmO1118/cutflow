# cutflow — AIネイティブ NLE 診断

*初版 2026-07-06 / 実装反映版 2026-07-08*

> この版は 2026-07-06 時点の診断を、現行実装に合わせて全面更新したもの。7/6 版で「不足」とした項目のうち、`approved` のコード強制、stable id / `@id`、`apply`、MCP、フル解像度 still + OCR、語単位 timestamp、rules / learn、annotation、blur / mosaic、caption anim / karaoke、frames server、素材知覚などは既に実装済み。以降の評価は **現在のコードベース** に対するもの。

---

## 総合判定:「Composer / Agent 以前」ではもうない

土台だけの段階は越えた。現在の cutflow は、**video-as-code + 検証トライアド + 承認境界 + 安全な編集 API + MCP** まで持っている。つまり「良い型を持つ JSON リポジトリに盲目な一発生成ボタン」ではなく、**AI が安全に読めて・指せて・編集できる編集基盤** には到達している。

ただし、まだ「動画編集の Cursor」と言い切るには足りない。最大の不足は基盤ではなく、**製品化された協調体験** だ。とくに:

- GUI 内から AI に指示する導線
- AI 編集の常用ワークフロー
- 実 A/V を使った自己検証ループ
- 差分レビューの常態化
- 長尺・複数収録を跨ぐ記憶と検索

この意味で現在地は、**Agent 基盤はあるが、日常運用の UX がまだ薄い AI 編集環境** である。

### スコアカード(現時点)

| 軸 | 合目 | 一言 |
|---|---|---|
| 人間の手編集(GUI) | **8 / 10** | Player・波形・undo/redo・直接ドラッグ・blur/annotation・ショート切替まで揃った |
| 編集表現力(映像合成) | **5.5 / 10** | blur/annotation/caption anim で前進。ただし速度変更・キーフレーム基盤は未着手 |
| AI の知覚(目・耳) | **5.5 / 10** | 語単位 transcript、system audio transcript、OCR、素材 probe あり。だが実動画/実音の検証は弱い |
| AI 協調レイヤ | **6 / 10** | `apply` / MCP / stable id / diff review あり。GUI 内 AI 指示とエージェント体験が未完成 |

> 別軸:「データ所有 × 持ち込み AI」は依然として旗として強い。ただし **BYO-AI の実体はまだ Claude 偏重** で、LLM バックエンドは `claude-cli` / Anthropic API の2系統に留まる。

---

## 核心的発見: ボトルネックは「安全に編集できるか」から「AI 編集をどう製品化するか」へ移った

7/6 版の核心は「plan が盲目で聾」「承認が紳士協定」「行動層が生 JSON 手書き」だった。これはもう現状には当てはまらない。

現在の事実は次のとおり:

- **承認ゲートはコード強制** — `render` は `approvals.json` のハッシュ一致だけを認め、boolean `approved` にはフォールバックしない。
- **AI の安全な action space がある** — `apply` は validate 前置のアトミック適用で、`approved` 変更を拒否し、MCP からも同じ経路を使う。
- **安定アドレッシングがある** — `id-stamp` と `@id` 解決があり、cut/caption/overlay/blur/chapter/bgm/short/thumbnail text まで指せる。
- **目と耳は接続され始めている** — plan は opt-in で audio feature / system speech / OCR をプロンプトに流し込める。
- **差分レビューもゼロではない** — GUI は外部変更に対して three-way diff と conflict resolution を持つ。

その代わり、いま本当に詰めるべきは次の3点だ。

1. **AI を GUI の中でどう働かせるか**
2. **AI が編集結果をどう自己検証するか**
3. **この基盤を「1本仕上げる製品体験」にどう束ねるか**

---

## 人間編集 × AI 編集(GUI)の現在地

### 人間編集

GUI は 7/6 時点よりさらに「本物の NLE」に近づいた。

- Remotion Player + proxy による即時プレビュー
- 波形・スナップ・ズーム可能タイムライン
- undo/redo、`⌘K` 分割、複数選択
- プレイヤー上の直接ドラッグ配置
- blur / mosaic の矩形編集
- annotation(box/arrow/spotlight) の配置
- ショート切替
- 未保存 draft、自動退避、validate 保存ゲート
- preview / render 起動
- 外部変更時の diff review

人間編集の弱点は、もはや基礎操作ではない。残るのは **コピー&ペースト、リップル/ロール、時刻直接入力、marker/in-out、thumbnail/meta/chapters など GUI 面の網羅性** だ。

### AI 編集

AI 編集の足場はかなりできている。

- MCP server あり
- `describe` / `validate` / `frames` / `materials` / `assert` の読取系 tool あり
- `apply` / `id-stamp` の安全編集 tool あり
- `approved` と承認レコードは AI から変更不可
- stable id と `@id` 指定あり

未達は **体験の最終段** である。

| ギャップ | severity | effort |
|---|---|---|
| **GUI から LLM コマンドを起動できない**。AI 指示チャネルがターミナル外へ出ていない | blocker | L |
| **diff review はあるが AI 編集の主経路になっていない**。外部変更レビュー止まりで、AI 提案の常設 UI ではない | major | M |
| `meta` / `chapters` / `thumbnail` / 一部設定編集は依然 GUI 外 | major | M |
| エージェントの観測→修正→再観測の製品フローが薄い | major | L |

---

## 6テーマの不足(効き順・現状反映)

### A. AI の知覚強化(目・耳)

このテーマは 7/6 版から大きく前進した。

- **完了**: フル解像度 still (`frames --full-res`) と OCR
- **完了**: 語単位 timestamp / confidence (`transcript.words`)
- **完了**: システム音声の別 transcript (`transcript.system.json`)
- **完了**: plan への opt-in 知覚注入(audio/system/OCR)
- **完了**: 素材 probe / representative frame / OCR / transcribe

残課題:

- **plan の知覚は opt-in で、既定の主経路になっていない** — `major` / M
- **音の知覚が特徴量中心で、実波形・音質・感情・SFX の理解は浅い** — `major` / L
- **AI が実 A/V を再生・試聴して検証できない** — `blocker` / L
- **複数収録・長尺横断の意味検索がない** — `major` / L

診断更新:

> もう「片耳しかない」は不正確。正しくは **耳と目は付き始めたが、まだ低帯域で、自己検証まで繋がっていない**。

### B. AI の行動インターフェース(MCP / 編集API / 差分・適用・undo)

このテーマは基盤としてはかなり達成済み。

- **完了**: MCP server
- **完了**: `apply` による検査付きアトミック適用
- **完了**: `approved` 書換拒否
- **完了**: stable ID / `@id`
- **完了**: describe/validate/frames/materials/assert を tool 化

残課題:

- **高水準プリミティブがまだ薄い** — `apply` は安全だが、意味的にはまだ「汎用 patch」に近い。`cut this span`, `add caption here`, `insert material here` などの task-level tool には達していない — `major` / M
- **GUI からこの action space を直接使えない** — `blocker` / L
- **checkpoint / branch / edit session の明示化が弱い** — `minor` / M

診断更新:

> 「行動層が生 JSON 手書きで安全網ゼロ」は撤回。正しくは **安全網はあるが、道具がまだ低水準**。

### C. 編集表現力(NLE パリティ)

ここも 7/6 版より改善している。

- **完了**: annotation(arrow / box / spotlight)
- **完了**: blur / mosaic
- **完了**: caption anim / karaoke
- **完了**: color filter

ただし天井を決める根本課題は依然そのまま:

- **速度変更・フリーズフレームが無い** — `blocker` / XL
- **汎用キーフレーム基盤が無い** — `blocker` / XL
- **トランジション、マスク、トラッキング、マルチカム、オートリフレームが無い** — `major` / L〜XL
- **blur が zoom 追従しない** — 実装済みだが制約が validate warning にも現れている — `major` / M

診断更新:

> もう「注釈グラフィック皆無」「領域ぼかし無し」は誤り。正しくは **演出の語彙は増えたが、時間変化の基盤が無い**。

### D. 高速フィードバックループ

ここも改善済み。

- **完了**: `frames-serve` による常駐 frames server
- **完了**: `assertions.json` + `assert`
- **完了**: `av` probe
- **完了**: stale frame / stale approval への検知強化

残課題:

- **AI が見るのは still / OCR / probe であり、動画再生ではない** — `blocker` / L
- **音の主観評価(繋ぎ、間、ダッキング、テンポ)は人間終端** — `major` / L
- **AI の自己修正ループは plan-cuts に限定的** — `major` / M

### E. ローカル×持ち込み AI の運用基盤(ルール / 索引 / コンテキスト)

このテーマも大きく前進した。

- **完了**: `AGENTS_CONTRACT.md`
- **完了**: JSON Schema 群
- **完了**: `rules.md` の読込
- **完了**: `learn` による `rules.suggested.md` 生成

残課題:

- **rules は提案生成までで、自動反映や継続メモリはない** — `major` / M
- **収録横断の意味索引 / retrieval がない** — `major` / L
- **BYO-AI は理念先行で、実装は Anthropic 偏重** — `major` / M

診断更新:

> もう「機械可読契約が無い」「rules が無い」は誤り。正しくは **契約はあるが、マルチモデル運用基盤はまだ浅い**。

### F. ポジショニング / 差別化

ここは 7/6 版と本質的に同じ。

強い点:

- video-as-code
- local-first
- approval boundary
- MCP / agent-friendly editing
- Screen Studio と Descript の間にある「開発スクリーンキャスト × エージェント編集」の空白地帯

弱い点:

- **対話一発編集の製品化がまだ無い** — `table stakes` / L
- **BYO-AI の実体がまだ薄い**
- **エンジニア向け導入税が高い**

---

## ロードマップの再評価: 7/6 の Now / Next はかなり消化済み

### Now

| 項目 | 状態 | コメント |
|---|---|---|
| 読める目: フル解像度 still + OCR | **完了** | `frames --full-res --ocr` / plan OCR |
| 語/トークン単位タイムスタンプ | **完了** | `transcript.words` |
| チャンネル rules + 修正からの学習 | **完了** | `rules.md` + `learn` |
| `approved`・中間生成物の書込スコープをコード強制 | **完了** | approvals hash gate + `apply`/MCP 制限 |
| 領域ぼかし/モザイク | **完了** | blur / mosaic |
| テロップ登場/カラオケアニメ | **完了** | `style.anim` / `style.karaoke` |

### Next

| 項目 | 状態 | コメント |
|---|---|---|
| plan に画像+音を接続 | **概ね完了** | opt-in で audio/system/OCR を注入。既定主経路化は未完 |
| 編集 action space + MCP | **完了** | ただし高水準化の余地あり |
| 安定 ID / `@-mention` | **完了** | `id-stamp` / `resolveMention` |
| 機械可読契約(JSON Schema + AGENTS_CONTRACT) | **完了** | schema 群あり |
| 検査付きアトミック適用を CLI/AI に露出 | **完了** | `apply` + MCP |
| GUI に AI 編集の差分レビュー / accept-reject | **部分完了** | external change diff review はある。AI ワークフロー化は未完 |
| 対話一発編集の製品化 | **未着手** | ここが最大の空白 |
| 注釈グラフィック層 | **完了** | arrow / box / spotlight |

### Later

ほぼ未着手。

- 複数バックエンド + 本格 BYO-AI
- 汎用キーフレーム基盤
- 速度変更 / フリーズ
- 意味索引 / retrieval
- オートリフレーム / 透過 web camera
- 生成 AI materials plugin

---

## このロードマップを盲目的に進めてよいか

**そのまま盲目的に進めるのはよくない。**

理由は3つ。

1. **7/6 時点の「欠落一覧」を前提にすると、既に終わった基盤工事へ再投資してしまう**
   既に MCP / apply / approval gate / OCR / rules / blur / annotation まで入っている。ここを引き続き主戦場にすると、成果が UX に変換されない。

2. **残るボトルネックは基盤ではなく製品導線**
   いま不足しているのは「AI に何ができるか」ではなく、**ユーザーがどう AI を使って1本を仕上げるか** だ。GUI 内指示、提案表示、差分承認、再観測、再提案までを1つの loop に束ねる必要がある。

3. **表現力の根本課題は別系統で重い**
   速度変更とキーフレームは、blur や annotation の延長ではない。ここは独立に設計判断が必要で、既存 Next を消化しても自然には解けない。

### 優先順位の組み替え提案

#### P0

1. GUI 内 AI 指示チャネル
2. AI 編集の常設 diff review フロー
3. `plan` 知覚経路の既定オン化または製品上の明示
4. 「対話一発編集」の workflow 化

#### P1

1. 高水準 editing tools
2. 実 A/V フィードバック
3. material / recording 横断の retrieval

#### P2

1. キーフレーム基盤
2. 速度変更
3. BYO-AI 拡張

---

## 主張の検証: 擁護し、突く

### Steelman

- 平文 JSON を source of truth にした判断は依然として本質的に正しい
- `validate / describe / frames / assert / av` は相当強い検証系になった
- approval を hash-bound record にしたのは正しい
- MCP と `apply` により、AI が安全に編集できる地盤はかなり整った
- 開発スクリーンキャスト特化という切り口はまだ有効

### 弱点

- **AI 指示の主戦場がまだターミナル**。GUI 内完結ではない
- **実 A/V 自己検証が弱い**。still/OCR/probe 止まり
- **差分レビューが AI 編集の主経路になっていない**
- **BYO-AI は旗ほど広くない**
- **速度変更 / キーフレーム基盤が無いので表現力の天井が低い**

---

## 競合地図: 依然として堀は「機能」ではなく「フォーマット」

7/6 版の結論は維持でよい。cutflow の堀は、Premiere や Descript と同じ機能表を埋めることではなく:

1. **video-as-code**
2. **local-first**
3. **agent-editable**
4. **approval-gated**

この組み合わせにある。

ただし、その堀を製品として成立させるには、競合の table stakes になった **「言えばやる」体験** を避けて通れない。今の cutflow は基盤で勝っているが、入り口体験ではまだ負ける。

---

## 編集表現力の現在地: 背骨はかなり太くなったが、時間変化が弱い

| 比較対象 | 合目 | 現在の見立て |
|---|---|---|
| vs Adobe Premiere | **4.5 / 10** | annotation/blur/caption anim で前進。ただし keyframe/speed/mask/mix が無い |
| vs CapCut | **5 / 10** | karaoke と自動系は前進。reframe/effects/speed curve が無い |
| vs Screen Studio | **6 / 10** | annotation/blur で接近。自動ズーム追従・透過 camera が無い |

**次の表現力の本丸は 2 つだけ**:

1. 汎用キーフレーム基盤
2. 速度変更

ここを後回しにして周辺機能を積んでも、上限は大きく変わらない。

---

## 結論: いま名乗るべきは「動画編集の Cursor の土台」ではなく「Agent-ready NLE」

cutflow はもう 7/6 版のような「盲目な一発生成ボタン付きリポジトリ」ではない。現在は:

- 安全な編集 API がある
- 承認境界がコードで強制される
- agent-friendly な addressing と MCP がある
- 目と耳が低帯域ながら接続され始めている

したがって、**基盤フェーズはかなり進んだ** と判断してよい。

ただし、次に勝負すべきは基盤追加ではない。必要なのは:

1. **GUI 内 AI 指示**
2. **AI 編集の差分承認フローの主経路化**
3. **実 A/V を使う再観測ループ**
4. **対話一発編集の製品化**
5. **キーフレーム / 速度変更という表現力の本丸**

> まとめると、今の cutflow は「AI ネイティブ NLE の前段」ではなく、**Agent-ready NLE の後半** にいる。盲目的に旧ロードマップを進めるより、ここからは **基盤の完成度を UX と製品フローへ変換する段階** に入るべきである。
