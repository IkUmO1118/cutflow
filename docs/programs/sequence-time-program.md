# シーケンス時間母艦 — 「元収録1本がマスタークロック」を脱し、出力(シーケンス)時間を第一級の番地にする

> 状態: **IMPLEMENTED(S0/S1/S2/S4)/ S3 は訂正中(2026-08-02)**。FrameWright の
> 「**すべての編集ファイルが元収録の秒で番地付けされる**」という単一時間軸の前提を、
> 本物の NLE と同じ **二層構造(Source 領域 / Sequence 領域)** へ作り替えること。
> 起点はユーザーからの4件の要望(§2)で、調査の結果**4件すべてが同一の構造的原因に
> 還元される**ことが判明した。
>
> **最重要の一線**: これは cut 判断のオーサリングモデルの変更**ではない**。
> transcript / detect / plan-* が元収録の秒で考えることは**正しく、不変**。
> 作るのは、その下流にある「合成」の領域が自分の番地を持てるようにする層。
> `cutplan.json` をクリップ列へ作り替える案は**非目標**(§7)。

関連文書:
`AGENTS_CONTRACT.md`(編集ファイル/生成物境界・承認境界) / `CLAUDE.md`(運用) /
`docs/usage.md`(ユーザー向け仕様) / `docs/decisions.md`。
交差する母艦: `docs/programs/render-engine-replacement-program.md`(描画エンジン。
本母艦は**その上のデータモデル層**で、`describeFrame`/`compositor` の画像対応は
既に完成済み=本母艦はそれを使う側) / `docs/programs/edit-authoring-program.md`
(生成の単位。本母艦が新設する番地を将来 plan-* が使う)。

現行コード錨:
`src/lib/timeline.ts`(唯一の source→output 射影) /
`src/lib/renderProps.ts:688-741`(`buildBgm`) /
`src/lib/insertMix.ts`(挿入込みの音声ベッド) /
`src/lib/approval.ts`(承認 hash) /
`src/stages/describe.ts`(`MappedInterval`=既存の二軸射影) /
`editor/client/App.tsx`(source↔output 変換の唯一の境界)。

枝分かれ plan(すべて `docs/plans/2026-08-02-sequence-*`):

| 段 | plan | 状態 | 出荷されるもの |
|---|---|---|---|
| S0 | `2026-08-02-sequence-s0-timeline-integrity-design.md` | IMPLEMENTED | 時間軸の一貫性(既存バグ4件+軸の不一致2件) |
| S1 | `2026-08-02-sequence-s1-audio-sequence-time-design.md` | IMPLEMENTED | 要望(2)(3) 完全解決。`timebase` の初出 |
| S2 | `2026-08-02-sequence-s2-still-clips-design.md` | IMPLEMENTED | 要望(4) 根本解決。スチルが一級クリップに |
| S3 | `2026-08-02-sequence-s3-source-independent-project-design.md` / 訂正: `2026-08-02-sequence-s3-fix-slides-as-overlays-design.md` | SUPERSEDED-IN-PART | 要望(1) 映像なしプロジェクト。時間モデルは訂正中 |
| S4 | `2026-08-02-sequence-s4-unified-addressing-design.md` | IMPLEMENTED | 番地契約の統一・軸事故の回帰固定 |

---

## 0. 他エージェント向け: 現在地と次の一手

- **現在地(2026-08-02)**: S0/S1/S2/S4 は実装・focused commit 済み。S3 は
  「スライド = inserts[]」が誤りだったため訂正中。実スライドショーの render
  ゲート完走は、背景だけの区間が残る構成でも成功するため、スライドショーの
  正しさを保証していなかった。
- **次の一手**: 本母艦の不変条件を回帰テストで維持する。新しい document
  timebase の適用先や plan-* の出力秒対応は、実害を記録して別 plan で扱う。
- **絶対に飛ばしてはいけない前提**: S0 の T1(`validate` の挿入認識)は S1 の
  検証規則が乗る土台、S0 の T3(ベース音声バグ)は挿入を使う全機能の前提。
- **触ってはいけない一線**:
  - `cutplan.json` を「クリップ列」へ作り替えない(§7 非目標)
  - plan-* の LLM プロンプトに出力秒を持ち込まない(§4 の分業)
  - 承認 hash のペイロード形を、§6 の決定を経ずに変えない
  - 既存収録の**バイト等価**(`timebase` を書かない限り全経路が導入前と同一)

---

## 1. 問題の実体 — 「原像が無い出力時間」

FrameWright の時間モデルは1本の射影で成り立っている。

```
元収録(raw.mkv)  ─── 唯一のメディア・唯一の時間軸
      │
      ├── cutplan.json      keep/cut       ┐
      ├── transcript.json   テロップ        │ すべて「元収録の秒」
      ├── overlays.json     素材・演出      │ で番地付けされる
      └── bgm.json          BGM            ┘
      │
      ▼  buildTimelineModel(keeps, inserts)     src/lib/timeline.ts:85
   出力タイムライン(= 導出量。誰も直接指せない)
```

射影の実体 `remapInterval(start, end, timeline)`(`src/lib/timeline.ts:197`)は
**部分関数**である。`timeline.entries` は keep 由来の区間しか持たず、挿入クリップは
`place()` が `outCursor += p.durationSec`(`timeline.ts:102`)するだけで
**entries を1件も生まない**。

> **原像(preimage)を持たない出力時間が存在する。そしてそれを指す語彙が無い。**

`describeFrame.ts:141-155` の `baseSourceTimeAt()` が挿入中に `null` を返すのは、
この事実を描画側が正しく表現している証拠。設計として意図的で、正しい。
**欠けているのは、その領域を番地付けする手段の方**。

## 2. 4つの要望と、その共通原因

| # | 要望 | 直接の症状 | 共通原因 |
|---|---|---|---|
| (1) | 画像だけ+音声ファイルで動画を作りたい | `findSource` が mkv/mp4/mov を要求して入口で throw | 出力を構成するのに元収録の映像が要る |
| (2) | intro/ending を挿入すると BGM がその区間で消える | `remapInterval` が挿入をまたいで連結しない | BGM が source 秒で番地付けされている |
| (3) | 挿入クリップに BGM を当てられない | どんな値を書いても像に入らない | 挿入区間に**番地が無い** |
| (4) | 画像の表示時間を伸ばして動画を長くしたい | overlay 画像は出力を伸ばせない。insert 画像は伸ばせるが無音 | スチルが「尺を持つクリップ」として認識されていない |

**(2) は写像のバグ、(3)(4)(1) は語彙の欠落。** 対症療法((2) だけ直す)では
(3)(4)(1) は1ミリも進まない。逆に語彙を入れれば (2) は自然に消える。

## 3. 他の NLE のモデル — 借りる設計

Premiere Pro / Final Cut Pro / DaVinci Resolve / Avid はすべて同じ二層構造を持つ。

| | NLE | FrameWright(現状) |
|---|---|---|
| マスタークロック | **シーケンス**が自前の fps・解像度・尺を持つ | **元収録1本**。出力尺は導出量 |
| メディア | 複数・対等。「元収録」という特権は無い | `manifest.source` が唯一絶対 |
| トラック | V1..Vn / A1..An が独立。音声は映像から導出されない | 実質 V1 のみ。BGM も V1 の source 秒で指定 |
| クリップ | `(media, in, out)` を**シーケンス上の位置**へ配置。source 時間はクリップ内部にしか存在しない | 全ドキュメントがグローバルな source 軸を共有 |
| 静止画 | 固有の out 点が無い。**既定尺**を与え、端をドラッグで無制限に伸縮 | 尺の概念が無い。overlay は出力を伸ばせない |
| 二つのモニタ | **Source Monitor**(素材の時間)と **Program Monitor**(シーケンスの時間)を明確に分ける | Source Monitor しか無い |

**借りるのは最後の行だけ。** FrameWright に足りないのは Program Monitor —
すなわち「シーケンスの時間で物を指す」という語彙である。

**借りないもの**: マルチトラック UI、クリップのドラッグ&ドロップ編集モデル、
非破壊トリム、リンクされた A/V クリップ。FrameWright の強み(JSON が正・
承認 hash・AI の脳・宣言的な区間指定)はこれらと直交しており、明け渡さない。

## 4. 目標アーキ — 二層と、その間の分業

```
┌──────────────────────────────────────────────────────┐
│ Source 領域(元収録の秒)  = Source Monitor            │  ← 不変
│   whisper / transcript / detect / cutplan.segments    │
│   plan / remeta / plan-shorts / plan-materials /      │
│   plan-effects / plan-bgm / autozoom                  │
│   「収録の何を残すか」を判断する領域                    │
├──────────────────────────────────────────────────────┤
│           compileSequence()  ← buildTimelineModel      │
├──────────────────────────────────────────────────────┤
│ Sequence 領域(出力の秒)  = Program Monitor  ★新設    │
│   V1 クリップ列(keep 由来 + 挿入 + スチル)            │
│   音声トラック(BGM)                                   │
│   「出来上がりをどう組むか」を指す領域                  │
└──────────────────────────────────────────────────────┘
```

### 分業の原則(この母艦の全段が守る)

1. **cut 判断は Source 領域に閉じる。** transcript が source 秒である以上、
   「どこを切るか」の判断も source 秒であるべき。**LLM に出力秒を書かせない。**
   plan-* が番号選択方式(`prompts/plan-shorts.md:5-6` 他)なのは正しい設計で、
   本母艦は一切触らない。
2. **合成は Sequence 領域で指せる。** 元収録に原像を持たない要素(挿入・スチル・
   スライド・intro/ending の BGM)は、**Sequence 領域でしか正しく指せない**。
3. **番地の宣言は要素ごと。** ドキュメント単位ではなく要素単位に
   `timebase?: "source" | "output"` を持たせる。省略時 `"source"` =
   **既存収録は全経路でバイト等価**。

### 語彙は既存のものを再利用する(新語を作らない)

`axis: "source" | "output"` は**既にコードベースに存在する**:

| 場所 | 形 |
|---|---|
| `src/lib/review.ts:16-35` | `ReviewTimeAxis = "source" \| "output"`、`ReviewRange.axis`、`ReviewFrameRequest.axis` |
| `src/stages/frames.ts:66` | `FrameRequest.axis: "source" \| "output"`(CLI `--out`) |
| `src/stages/framesServe.ts:83-86` | 同上を HTTP へ露出 |
| `src/stages/editorAi.ts:613,626` | LLM ツールスキーマに `axis: { enum: ["source","output"] }` |
| `src/mcp/tools.ts:349` | `framewright_frames` の `out` |

**これは request 層にしか存在しない。本母艦はこれを document 層へ降ろす。**
値は必ず `"source"` / `"output"`(`"sequence"` という新語は作らない)。
フィールド名は `timebase`(document 層)、`axis`(request 層)で使い分ける。

### 既存の二軸射影を再利用する

`src/stages/describe.ts:585-591` の `MappedInterval` が既に正準形:

```ts
/** 元秒区間 + その出力秒射影。演出の元秒 interval に一律で付ける。 */
export interface MappedInterval {
  id?: string;
  start: number;   // source
  end: number;     // source
  out: Interval[]; // output(挿入で割れると複数)
}
```

`src/stages/assert.ts` と `src/lib/review.ts` は既に生ドキュメントではなく
`DescribeProjection` を消費している。**Sequence 領域の正準表現はここを拡張して作る**
(S4)。ゼロから作らない。

## 5. フェーズ

### S0 — 時間軸の一貫性(前提整地・機能追加ゼロ)
plan: `docs/plans/2026-08-02-sequence-s0-timeline-integrity-design.md`

調査で発見した**既存の不整合**を潰す。新機能は1つも足さない。

- **T1**: `validate` の時刻写像が挿入を無視している(`validate.ts:350`
  `buildTimeline(playbackKeeps)`)。`render`/`frames`/`describe`/editor は
  挿入込みなので、**同じプロジェクトで4つの異なる出力秒が計算されている**
- **T2**: `av --range` も挿入を無視している(`av.ts:129`)。`av --range 10-25` と
  `frames --out --t 10` が別の場所を指す
- **T3**: **【重大】挿入+カットでベース音声(セリフ)が壊れる**。
  `renderEngine.ts:143` が `videoIsSource:true` で props を作り直すため
  `baseSegments[].videoStart` が元収録秒になるが、`insertMix.ts:169` はその値で
  **カット後の `cut.mp4`** を索引する。カットがあると行き過ぎ、`len` が負になった
  区間が丸ごと無音
- **T4**: 挿入+可変速 keep で render が例外死(`insertMix.ts:58-62` が throw、
  受け手の try/catch は既に存在しない関数のコメントとして残るだけ)
- **T5**: 挿入の `at` 同値時の順序が `Array.prototype.sort` の安定性に暗黙依存
- **T6**: `thumbnail.t` が「keeps=全編ゆえ timeline が恒等写像」に暗黙依存

**出荷**: 時間軸が信頼できるようになる。S1 以降の全段の前提。

### S1 — 音声のシーケンス時間(`timebase` の初出)
plan: `docs/plans/2026-08-02-sequence-s1-audio-sequence-time-design.md`

BGM は**純粋に加算的で source 結合を持たない**ため、`timebase` の最初の適用先として最も安全。

- **A1**(既定の修正): source timebase のトラックは、射影した断片の
  **凸包(convex hull)** を1本のシーケンス span へコンパイルする。
  挿入をまたいでも切れない。`inserts` が空なら**証明可能にバイト等価**
  (`remapInterval` は cut 境界では既に連結するため。§S1 plan の補題1)
- **A2**(語彙の追加): `bgm.tracks[].timebase?: "source" | "output"`。
  `"output"` なら射影せず出力秒として直接使う。intro/ending/挿入内へ BGM を当てられる
- **A3**: `bgmSlots`/`plan-bgm` を挿入認識に(可視秒の正確化)

**出荷**: 要望(2)(3) が完全解決。

### S2 — スチルクリップ(尺を持つ一級クリップ)
plan: `docs/plans/2026-08-02-sequence-s2-still-clips-design.md`

要望(4)の**根本**。「画像 insert に大きい `durationSec` を書け」は対症療法で、
根本は「スチルが尺を持つクリップとして認識されていない」こと。

- **B1**: スチルを一級の clip kind として認識(`isImageFile` と `classifyKind` の
  乖離=`.tiff`/`.heic` を解消し単一の出所に)
- **B2**: **既定尺**(NLE パリティ。Premiere の "Still Image Default Duration" 相当)。
  画像 insert の `durationSec` を省略可にし、config から補う
- **B3**: 出力尺に対する検証(単一クリップが出力の大半を占める等の警告)。
  S0-T1 が供給する出力尺を使う
- **B4**: `materialFit` の JPEG 誤判定を修正(PNG は `png_pipe` で duration 欠落、
  **JPEG は `image2` で `0.04` を返す**ため全 JPEG が overrun 判定され、
  **尺を0へ潰す修正候補**が出力されている)
- **B5**: エディタでスチルクリップの右端をドラッグして尺を変える affordance
  (= 「引き伸ばす」の実体)
- **B6**: `describe` がスチルを動画クリップと区別して出す

**出荷**: 要望(4) が根本解決。

### S3 — 映像なしプロジェクト(スライドショー)
plan: `docs/plans/2026-08-02-sequence-s3-source-independent-project-design.md`

**朗報: 下層は既にメディア非依存**。`timeline.ts` は純粋な区間演算、
`describeFrame.ts:169` に `videoFile === ""` 分岐、`compositor.ts:98-124` に
`ImageCache` 完備。ブロッカーは入口と ffmpeg 経路の7箇所に限定される。

方式は **「音声ファイルを `manifest.source` にする」**。音声の尺が「元収録の秒」の
軸になり、whisper→transcript→テロップ、detect→plan のカット判断、`describe`、
`frames`、`apply`、承認 hash、エディタが**すべてそのまま動く**。
判別子は `manifest.layout: "stills"` の1つだけ(既存の `layout` 分岐に相乗り)。

**訂正中**: 要望(1) の入口/ffmpeg 経路は landing 済みだが、スライドは
`inserts[]` ではなく全画面 `overlays[]` として扱う必要がある。`inserts[]` は
ripple で出力尺を伸ばすため、スライドショーではナレーションより動画が長くなる。
訂正 plan: `docs/plans/2026-08-02-sequence-s3-fix-slides-as-overlays-design.md`。

### S4 — 番地契約の統一(GATED)
plan: `docs/plans/2026-08-02-sequence-s4-unified-addressing-design.md`

**着手ゲート**: S0〜S3 がすべて landing し、実収録で1本以上の
スライドショーと1本以上の intro/ending 付き動画が完走していること。

- `describe --json` の射影に timebase 判別子を入れる(現状 `out` は無標で、
  出力秒で書かれた要素は `start === out[0].start` になり消費側が区別できない)
- 時刻を取る全 CLI/MCP 表面で軸を明示
- エディタで output timebase 要素を直接編集できるようにする
- 承認 hash の最終契約(§6)を確定

## 6. 未決の決定(着手前に潰す go/no-go)

- **[未決・最重要] 承認 hash と挿入の関係**。`src/lib/approval.ts:57-68` の
  ペイロードは keep 集合のみ(`[[s,e],...]`、非既定 speed があれば
  `{version:2, playback:[[s,e,speed]]}`)。**挿入には完全に盲目**。
  つまり承認後に 30秒の intro を足しても hash は変わらず render が通る。
  CLAUDE.md の「承認スコープは cut 決定のみ」とは整合するが、S2 で
  スチルが出力尺を自由に伸ばせるようになると「承認した動画」と
  「出来上がる動画」の乖離が大きくなる。
  選択肢: (a) 現状維持+ドキュメント明記 / (b) 出力尺を hash に含める
  (`version:3`。`version:2` という拡張前例あり) / (c) 出力尺の変化を
  render 時に警告するだけ。**S2 着手前に決める。**
- **[未決] S1-A1 の凸包ルールを config で無効化できるようにするか**。
  推奨は不要(挿入が無ければバイト等価なので、既存プロジェクトは影響を受けない)。
- **[未決] S3 の `preview`**。stills では ffmpeg trim/concat 経路が使えないため、
  低解像度のエンジン render に落とすか、`preview` 自体を stills では
  非対応にして editor プレビューへ誘導するか。
- **[却下・記録として残す] 挿入の出力秒アンカー(`inserts[].timebase:"output"`)**。
  S2 の検討中に出たが**採らない**。理由: intro は `at: 0`、ending は
  `at: manifest.durationSec` で既に表現でき、中間配置はむしろ source
  アンカーの方が「内容に貼り付く」ので正しい。出力秒アンカーを入れると
  「source アンカー挿入と output アンカー挿入が混在したときの配置順」という
  本質的に曖昧な問題が生まれる。要望(4)の根本は**アンカー軸ではなく
  スチルの尺の扱い**にあると診断した(S2)。将来必要になったら S4 で再起草する。

## 7. 非目標(この母艦がやらないこと)

- **`cutplan.json` をクリップ列へ作り替えない**。
  「NLE の V1 は `(media, in, out) @ position` のリスト」だからといって
  `cutplan.segments` をそれへ置き換えるのは**割に合わない**:
  承認 hash・`plan`/`plan --cuts-only` の番号選択・`detect`・`boundaryCheck`・
  エディタ・`shorts.ranges` がすべて「元収録の区間選択」を前提にしており、
  得られるものは §4 の分業で既に得られる。`cutplan` は Source 領域の
  オーサリング文書のままでよい。
- **plan-* の LLM プロンプトに出力秒を持ち込まない**(§4-1)。
- **マルチトラック編集 UI を作らない**。エディタのタイムラインは既に出力秒軸
  (`editor/client/model.ts:2-3`)で、S2-B5 が足すのはスチルのリサイズだけ。
- **`shorts.json` に挿入を導入しない**。現在5箇所で閉じられている
  (`render.ts:452-455` / `App.tsx:1361` / `describe.ts:1257` / `av.ts:118` /
  `Short` 型)。S1〜S4 のどの段でも開けない。必要になったら別母艦。
- **既存の描画意味論を変えない**。`describeFrame`/`compositor` は画像も
  「ベース映像なし」も既に正しく扱える。本母艦は**その手前**の層。

## 8. 全段が満たし続ける不変条件

1. **バイト等価**: `timebase` を1つも書かず、挿入も無いプロジェクトは、
   全コマンドの出力が本母艦の導入前と**バイト等価**。各 plan にこの回帰テストを置く。
2. **JSON が正**: 新しい番地はすべて既存の編集ファイル内のフィールドとして表現する。
   新しい「シーケンス文書」を作って第二の正を持たない。
3. **承認境界の不可侵**: `approvals.json` の書き手は `approve`/`unapprove` と
   GUI 保存だけ。本母艦のどの段もこれを増やさない。hash のペイロードを
   変える場合は §6 の決定を経る。
4. **Source 領域の不可侵**: whisper/detect/plan-* の入出力の時間軸を変えない。
5. **5点セットの追随**: スキーマを変えたら `src/types.ts` / `src/stages/validate.ts` /
   `docs/usage.md` / `schemas/*.schema.json` + `schemas/examples/<file>.max.json` /
   (ファイル分類・コマンドが変わったときのみ)`AGENTS_CONTRACT.md`。
   `test/schema.test.ts` と `test/agentsMd.test.ts` がピン留めしている。
6. **軸の単一性**: S0 以降、`buildTimeline` を挿入なしで呼ぶ箇所を新たに増やさない
   (ショートを除く。ショートは挿入を持たないため意図的に挿入なし)。

## 9. 意思決定ログ

- **2026-08-02(発足)**: ユーザーの4要望を調査し、**すべてが「原像を持たない
  出力時間に番地が無い」という単一の構造的原因に還元される**と診断。
  対症療法(BGM の穴だけ塞ぐ)ではなく、NLE の Source/Program 二層を
  借りる方向を採る。ユーザーの明示指示=「目先の解決策ではなく根本的な解決」。
- **2026-08-02**: 語彙は新設せず、既に request 層に存在する
  `"source" | "output"` を document 層へ降ろす方針を確定(§4)。
  `"sequence"` という第三の語は作らない(概念名としては散文で使う)。
- **2026-08-02**: `cutplan` のクリップ列化を**非目標**として明記(§7)。
  Source/Program の分業で必要な機能はすべて得られ、承認 hash と plan-* への
  破壊が割に合わないため。
- **2026-08-02**: 挿入の出力秒アンカーを**却下**(§6)。要望(4)の根本診断が
  「アンカー軸」ではなく「スチルの尺の扱い」であったため。
- **2026-08-02(訂正)**: S3 の「スライド = inserts[]」は誤りだったため差し戻す。
  inserts は ripple(出力尺を伸ばす)で、スライドショーでは尺はナレーションが
  決めるべきだった。要望(4)「画像を引き伸ばす」の理屈を要望(1)へ誤って
  持ち込んだのが原因。正しくは全画面 overlays[](出力尺を変えず span を覆う)。
  実装は plan に忠実で、insertMix の videoFile==="" 分岐は症状(音声のぶつ切り)
  だけを塞ぐ対症療法として入っていた。訂正 plan =
  `docs/plans/2026-08-02-sequence-s3-fix-slides-as-overlays-design.md`。
- **2026-08-02(訂正)**: S3-B7(design の hasCamera ゲート緩和)は
  describeBaseLayer の videoFile==="" 早期 return が背景画像ブロックより手前に
  あるため、背景**画像**には効いていなかった(効いていたのは backgroundColor
  のみ)。`src/engine/` を一度も変更しなかったことが見落としの原因。
- **未記入**: §6 の未決3件(承認 hash × 挿入 / A1 の config 化 / S3 の preview)は
  該当段の着手時に本ログへ結論を追記する。
