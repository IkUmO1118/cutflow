# P1 実装分解

*2026-07-09 / 実装担当: gpt-5.4 想定*

仕様の正本:

- `docs/plans/2026-07-09-p1-ai-workflow-observation-retrieval-design.md`

この文書は仕様を再定義せず、実装をレビュー可能な単位へ分ける。型、上限値、
API payload、セキュリティ境界で疑義がある場合は仕様の正本を優先する。

---

## 1. 分割方針

P1 は6つの直列スライスで実装する。各スライスは単独の PR とし、後続スライスの
未実装を理由にテストを skip しない。

```text
S1 Snapshot kernel
  -> S2 Deterministic review
    -> S3 GUI integration
      -> S4 Task-level editing
        -> S5 Local retrieval
          -> S6 Optional VLM
```

この順序にする理由:

1. S1 は未保存 candidate を安全に描画する基盤で、S2 と S3 の前提になる。
2. S2 でモデル非依存の観測契約を完成させ、GUI と VLM を薄い consumer にする。
3. S3 までで P1 の主要価値である保存前比較を先に利用可能にする。
4. S4 は proposal の作り方を変えるが、レビュー基盤には依存させない。
5. S5 は read-only の独立機能だが、AI prompt 接続は S4 後の方が責務を整理しやすい。
6. S6 は optional enhancement であり、最後まで未実装でも deterministic workflow は成立する。

原則として、複数スライスを1つの PR にまとめない。特に S1-S3 と S6 を同時に実装すると、
描画不具合、観測不具合、provider 不具合を切り分けられなくなる。

---

## 2. 共通実装ルール

全スライスで次を守る。

- TypeScript ESM、strict mode、既存命名規則に従う。
- editable JSON、generated artifact、approval の境界は `AGENTS_CONTRACT.md` を優先する。
- `approvals.json` は書かない。
- recording 内の既存 generated artifact を fixture として手編集しない。
- write path は `planApply` / `applyEdits` を迂回しない。
- API と MCP の入力は境界で schema validation し、内部型の cast で済ませない。
- source time と output time を変数名、型、serialized field で区別する。
- optional 処理の失敗で、それ以前の決定論的な結果を捨てない。
- 各スライス完了時に `npm test` と `npm run typecheck` を実行する。

各 PR の説明には次を含める。

- 対象スライス
- ユーザーから見える変更
- 不変条件への影響
- 実行したコマンド
- UI または render 変更時の screenshot / frame
- 後続へ残した明示的な TODO

---

## 3. S1: Snapshot Rendering Kernel

### 目的

ディスク上の編集 JSON と、メモリ上の candidate JSON を同一経路で Remotion props に変換し、
candidate を recording folder へ保存せず still 描画できるようにする。

### 依存

なし。最初に実装する。

### 主な対象

- 新規 `src/lib/renderSnapshot.ts`
- 新規または共通型配置先の `src/lib/review.ts`
- 変更 `src/stages/frames.ts`
- 新規 `test/renderSnapshot.test.ts`
- 既存 frames 関連 test

### 実装手順

1. 正本設計の `EditSnapshot` を schema として定義する。
2. recording から現在の snapshot を読む関数と、validated candidate docs から snapshot を
   組み立てる関数を分離する。
3. `buildSnapshotRenderProps(snapshot, manifest, options)` を純粋な変換コアとして追加する。
4. media path 解決は recording root 配下に制限し、candidate 内の path traversal を拒否する。
5. `frames.ts` の既存処理を新コアへ移し、CLI の引数、出力先、OCR、戻り値を維持する。
6. test 用に candidate snapshot を直接渡せる still render entry point を追加する。
7. temporary editable JSON は一切作らない。

### 非対象

- selection slicer
- before/after bundle
- editor API
- VLM

### 必須テスト

- disk snapshot と同じ snapshot から従来同等の props ができる。
- candidate caption text が PNG に反映され、disk transcript は変化しない。
- candidate cut plan で source/output mapping が変化する。
- blur、annotation、material overlay が candidate 側から反映される。
- 不正 schema と recording root 外 media path を拒否する。
- 既存 `frames` の CLI test が無変更で通る。

### 完了条件

- candidate still を editable JSON の write なしで生成できる。
- `git diff` または mtime 検査で recording の editable files が不変である。
- S2 が server や AI provider を介さず snapshot renderer を呼べる。

### 引き渡し

S2 に公開する API は snapshot の構築、validation、render props 生成、still 生成だけとする。
review 固有の selection や artifact index を S1 に持ち込まない。

---

## 4. S2: Deterministic Review Bundle

### 目的

selection/playhead と before/after snapshot から、bounded still/clip と
structure/motion/sound/OCR を含む `ReviewBundle` を生成する。

### 依存

S1 完了。

### 主な対象

- 新規 `src/lib/reviewObservation.ts`
- 新規 `src/stages/review.ts`
- 変更 `src/stages/av.ts` または parser helper
- 変更 `src/lib/files.ts`
- 変更 `src/cli.ts`
- 新規 `test/review.test.ts`
- 新規 `test/reviewObservation.test.ts`

### 実装手順

1. `ReviewSpec`、`ReviewFrameRequest`、`ReviewClipRequest`、`ReviewBundle` を schema 化する。
2. selection IDs、source range、playhead の優先順位を持つ selection slicer を純関数で実装する。
3. pad、duration、frame count を正本設計の上限で clamp する。
4. before と after を同じ normalized request から描画する。
5. review clip は still と独立した optional artifact とし、失敗を warning に変換する。
6. A/V probe の実行と parse を分離し、review range に必要な値だけ bundle へ正規化する。
7. structure diff、motion、sound、OCR を deterministic observation として集約する。
8. artifact を `review.probe/<review-id>/` に保存し、atomic に index を更新する。
9. `review.probe/` を generated directory として分類する。
10. CLI または stage-level entry point で bundle を JSON 出力できるようにする。

### 非対象

- editor の HTTP endpoint と UI
- task-level editing
- VLM note

### 必須テスト

- source range、selected IDs、playhead から期待する bounded range を作る。
- source/output time mapping を混同しない。
- before/after が同じ frame request を共有する。
- frame 上限、clip 30秒上限、recording 境界を守る。
- clip failure 時も still、structure、利用可能な observation を返す。
- OCR 非対応時は `skipped`、実行失敗は structured warning になる。
- review 実行前後で editable files と approval の内容・mtimeが不変である。
- artifact index の partial write を残さない。

### 完了条件

- モデル、editor server、GUI なしで `ReviewBundle` を生成できる。
- bundle だけで before/after artifact と各 warning の根拠を追跡できる。
- S3 が stage API を1回呼ぶだけで比較結果を得られる。

---

## 5. S3: Editor Review Integration

### 目的

GUI AI proposal の採否状態から candidate snapshot を組み立て、保存前に比較を生成・表示する。

### 依存

S2 完了。S4 には依存しない。既存 raw patch proposal で完成させる。

### 主な対象

- 変更 `editor/server.ts`
- 変更 `editor/client/apiTypes.ts`
- 変更 `editor/client/App.tsx`
- 変更 `editor/client/DiffReview.tsx`
- 変更 `editor/client/widgets.tsx`
- 変更 `src/stages/editorAi.ts`
- editor server / AI workflow tests

### 実装手順

1. legacy `string[]` を受理しつつ、structured `review.frames` を正規形へ変換する。
2. `POST /api/ai/review` の request/response schema を追加する。
3. server は client payload を直接信用せず、base docs と accepted hunks から candidate を再構築する。
4. candidate に `approved: true` が混入しても無効化し、approval file は変更しない。
5. review job を既存 heavy job lock と統合する。
6. DiffReview に「比較を生成」、進捗、before/after、warning、clip の表示を追加する。
7. hunk 採否または proposal が変わったら、bundle hash と candidate hash の不一致で stale 表示する。
8. stale bundle を非表示にせず、比較対象が古いことを明示する。
9. 保存と保存後 verification は既存フローを維持する。

### 非対象

- GUI 上の VLM toggle
- retrieval UI
- task proposal

### 必須テスト

- malformed candidate、上限超過、unknown IDs を 4xx にする。
- endpoint 呼出しで editable JSON と approval が変化しない。
- concurrent heavy job を既存規則どおり拒否する。
- accepted hunks の変更で stale になる。
- legacy `review.frames: string[]` が正規化される。
- review 失敗後も proposal の採否と保存操作を継続できる。

### 完了条件

- caption、cut、blur の提案を保存前に before/after still で比較できる。
- review の成否が save の可否を暗黙に変更しない。
- ここまでを P1 の最小リリース候補として出せる。

---

## 6. S4: Task-Level Editing

### 目的

頻出編集を schema-backed `EditIntent` として表現し、決定論的 compiler で既存
`ApplyPatch` へ落とす。

### 依存

S3 完了を推奨するが、コード上は S1-S3 と疎結合に保つ。

### 主な対象

- 新規 `src/lib/editIntent.ts`
- 変更 `src/stages/editorAi.ts`
- 変更 `src/mcp/tools.ts`
- 変更 `prompts/editor-ai-propose.md`
- 新規 `test/editIntent.test.ts`
- editor AI / MCP tests

### 実装順

1. `set-range-action`
2. `trim-pauses`
3. `set-caption-text`
4. `add-blur`
5. `add-annotation`
6. `place-material`

最初の PR をさらに小さくする必要がある場合、1-3を S4a、4-6を S4b としてよい。
ただし schema union と compiler entry point は S4a で確定させ、S4b で破壊的変更しない。

### 実装手順

1. intent ごとの discriminated union schema を定義する。
2. compiler context に現在 docs、manifest、ID allocator、selection を明示的に渡す。
3. compiler は side effect のない `ApplyPatch` を返す。
4. segment split/merge、ID 維持、境界 clamp の規則を intent ごとに実装する。
5. compiler 出力を必ず `planApply` に通し、失敗を intent 単位の診断へ変換する。
6. `cutflow_edit` MCP tool に dry-run と明示 write mode を実装する。
7. editor AI response を `tasks | patch fallback` union にする。
8. prompt は tasks 優先とし、表現不能な操作だけ raw patch を許す。

### 必須テスト

- range 中央、複数 segment、境界一致で cut 結果が安定する。
- trim pauses の threshold と minimum duration を守る。
- 既存 ID を可能な限り維持し、新規 ID が衝突しない。
- intent から approval を変更できない。
- material path traversal と未知 overlay target を拒否する。
- MCP dry-run は write せず、write mode は `planApply` 後だけ保存する。
- raw patch fallback の既存 proposal が引き続き動く。

### 完了条件

- AI が range cut の低水準 segment JSON を生成する必要がない。
- 同じ docs と intent から byte-equivalent な patch が得られる。
- GUI proposal と MCP が同じ compiler を使う。

---

## 7. S5: Local Recording and Material Retrieval

### 目的

`recordingsDir` 配下の recording/material metadata、OCR、transcript をローカル索引化し、
API key なしで候補を検索する。

### 依存

S4 完了後に AI prompt へ接続する。index/search core 自体は独立。

### 主な対象

- 新規 `src/lib/retrieval.ts`
- 新規 `src/stages/retrievalIndex.ts`
- 新規 `src/stages/retrievalSearch.ts`
- 変更 `src/cli.ts`
- 変更 `src/mcp/tools.ts`
- 変更 `editor/server.ts`
- 新規 `test/retrieval.test.ts`

### 実装手順

1. index document schema と version を定義する。
2. NFKC、ASCII token、日本語2/3-gram tokenizer を純関数で実装する。
3. title、file、OCR、transcript、kind に固定 weight を持つ deterministic scorer を実装する。
4. recording ごとの source fingerprint で incremental rebuild する。
5. index を `<recordingsDir>/.cutflow/retrieval-v1.json` へ atomic write する。
6. unreadable/broken recording は warning にし、全体 build を継続する。
7. CLI `index` / `search` と MCP `cutflow_search` を追加する。
8. search は path、recording ID、kind、根拠 snippet、score を返す。
9. GUI AI は検索意図がある場合だけ上位の bounded results を proposal prompt へ注入する。

### 非対象

- embedding、vector DB、外部 API
- material の copy/import
- 他 recording の編集
- watcher 常駐

### 必須テスト

- 日本語と ASCII の normalization、tokenization、stable ordering。
- weight と filter が固定 fixture に対して再現可能。
- unchanged recording を再解析しない。
- deleted recording/material が index から消える。
- broken JSON、permission error を warning にする。
- query/path による recording root 外参照を拒否する。
- MCP search と CLI search が同じ core result を返す。
- search 実行で recording 配下を変更しない。

### 完了条件

- API key なしで過去 recording の material/OCR/transcript を検索できる。
- AI へ渡した結果に recording と source の出所が残る。
- retrieval が候補提示だけで、編集や copy を実行しない。

---

## 8. S6: Optional VLM Review

### 目的

deterministic `ReviewBundle` の限定された still を画像対応 provider に渡し、意味的な
補足観測を追加する。既存 workflow の成立条件にはしない。

### 依存

S2 と S3 完了。最後に実装する。

### 主な対象

- 変更 `src/lib/llm.ts`
- 変更 `src/lib/config.ts`
- 変更 `src/stages/review.ts`
- 変更 `editor/server.ts`
- 変更 `editor/client/App.tsx`
- LLM capability / review tests
- config と privacy のドキュメント

### 実装手順

1. text generation と image-capable review の capability を分離する。
2. OpenAI/Anthropic API adapter だけを最初の対応対象にする。
3. CLI provider は unsupported capability として deterministic fallback する。
4. 最大4枚、downscale 済み still、固定 prompt、structured response schema を使う。
5. VLM response は `observations` と `uncertainties` だけを許可する。
6. patch、pass/fail、approval、pixel coordinate を schema で表現不能にする。
7. timeout、rate limit、schema failure を bundle warning に変換する。
8. config の既定値を `editor.aiReview.vlm: false` にする。
9. UI と docs に外部 API への画像送信を明示する。
10. temporary image は OS temp に置き、`finally` で削除する。

### 必須テスト

- capability false では provider call をせず deterministic bundle を返す。
- opt-in false では画像を送信しない。
- request の画像枚数、解像度、MIME、prompt が上限どおり。
- response schema が patch/pass/fail/approval/coordinate を受理しない。
- provider timeout と malformed response で deterministic result が残る。
- secret、absolute local path、不要な transcript 全文を request/log に含めない。
- temporary files が成功・失敗の両方で削除される。

### 完了条件

- VLM off、provider unsupported、provider failure のすべてで S3 の workflow が成立する。
- VLM note は deterministic warning と視覚的・型的に区別される。
- ユーザーが画像送信を明示的に opt-in した場合だけ provider call が起きる。

---

## 9. リリース境界

推奨するリリース境界は次の2つ。

### P1 Core

S1-S3。保存前 before/after と deterministic A/V review を提供する。ここで一度、
実メディア recording を使った手動 QA を行う。

### P1 Complete

S4-S6。高水準編集、横断 retrieval、optional VLM を追加する。S6 は設定既定 off のまま
リリースしてよい。

S5 や S6 の遅延を理由に P1 Core を巨大な feature branch に留めない。逆に S1-S3 の
不変条件と回帰テストが未完了のまま、S4 以降へ進まない。

---

## 10. gpt-5.4 への実装指示

各スライス開始時に、次の順でコンテキストを渡す。

1. `AGENTS.md`
2. `AGENTS_CONTRACT.md`
3. P1 詳細設計の対象セクション
4. この文書の対象スライス
5. 対象ファイルと既存 test

指示テンプレート:

```text
P1 の S<n> だけを実装してください。

仕様:
- docs/plans/2026-07-09-p1-ai-workflow-observation-retrieval-design.md の対象節
- docs/plans/2026-07-09-p1-implementation-slices.md の S<n>

要件:
- 後続スライスは実装しない
- 既存 API compatibility を維持する
- schema validation と不変条件を先にテスト化する
- 実装後に npm test と npm run typecheck を実行する
- 変更概要、テスト結果、残した TODO を報告する
```

S1-S3 は同じ担当セッションに連続投入せず、各スライスの diff とテスト結果をレビューしてから
次へ進む。S4 は変更量が大きい場合だけ S4a/S4b に分け、それ以外の再分割は実装中の
責務混在やレビュー量が明確になった時点で判断する。
