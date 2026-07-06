# describe の機械可読な完全射影(`describe --json`)— 設計

*2026-07-07 / 診断レビュー「A. AI の知覚強化」項目の設計。実装は別担当(Sonnet)。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ A「AI の知覚強化(目・耳)」/ 項目
> 「**`describe` が非可逆な散文要約(発話36字切り捨て)で機械可読な完全射影が無い**」
> = severity **minor** / effort **S**。

---

## 背景とギャップ

`describe`(`src/stages/describe.ts` の `describe(dir): string`)は「AI の目」の一つ。
タイムライン(keep/カットの並び・各区間の発言・カット理由・演出・章・ショート)を
**人間可読の日本語散文**で返す。だがこの出力は**非可逆**:

- 発話は `quote()` で **36字に切り捨て**(`describe.ts:66-69`)。`「今日は whisper のベンチマ…」`
  の先で何を言っているか AI は復元できない。
- 章タイトルの並びだけ、meta のタイトルは `slice(0, 3)`(先頭3件だけ)。
- 演出は「素材 V2 元 0:22.3–0:27.9 slide-01.png」のように**主要フィールドだけ**を文にしている。
  `rect` / `opacity` / `fadeInSec` / `zooms` / `blurs` / `colorFilter` は散文に出ない。
- テロップの `pos` / `style` / `words` / `track` は文に出ない。

結果、AI が編集状態を正確に知るには結局 `cutplan.json` / `transcript.json` /
`overlays.json` … を**全部 Read で開く**しかない。`describe` の目的
「JSON 群を全部読まずに編集状態を把握する」が、正確さを要求した瞬間に崩れる。

**ゴール**:散文(人間向け・**現状不変**)に加えて、**この1本から編集状態の主要情報を
完全復元できる機械可読 JSON**(機械向け)を出せるようにする。発話・タイトルは
一切切り捨てない。時刻は「元収録秒(編集ファイルに書く値)」を verbatim で載せ、
`src/lib/timeline.ts` の写像で「出力秒」を併記する(元⇔出力の対応が describe の核心)。

## スコープ

**やること(今回)**
- `describe <dir> --json` を追加。stdout にパイプ可能な JSON を1本出す。
- 完全射影の JSON スキーマ(収録メタ・keep・カット+消える発言の全文・全テロップ全文・
  演出全フィールド・章・meta 全文・ショート全 ranges)を設計・実装。
- 既存の散文 `describe`(引数なし)を **1バイトも変えない**(golden test で機械的に固定)。

**やらないこと(スコープ外)**
- **射影 JSON を `plan` / `remeta` / `plan-shorts` の LLM プロンプトへ流し込むこと。**
  意思決定ループへの接続は Next テーマ(「カット判断ループに目耳を接続」)。今回は
  「AI が読める形にする」能力まで。`src/stages/plan.ts` は触らない。
- 射影 JSON を編集入力として受ける経路(書き戻し/編集 API)。B テーマ(action space)の担当。
- 描画解決(`captionStyleOf` / `captionPosOf` のトラック標準マージ)を適用すること。
  射影は**編集ファイル(元データ)の写像**であって render props のスナップショットではない
  (論点2-D)。

---

## 論点と決定

### 論点1:CLI 表面 → **決定: `describe <dir> --json` フラグ。別コマンドは作らない。所要時間行は `--json` のときだけ stderr へ逃がす**

**フラグか別コマンドか**

| 案 | 中身 | 判断 |
|---|---|---|
| **`describe --json`(採用)** | 既存 describe コマンドに直交フラグを1つ足す。`--json` なら JSON、無ければ従来の散文 | ディレクトリ解決(`resolveDir`)・ファイル読み込み規約・コマンド説明を共有。散文と JSON が同じコマンドに並ぶので、片方だけ古くなる drift がレビューで目に付く |
| `describe-json` / `project` 別コマンド | 独立コマンド | ファイル読み込み・timeline 構築・引数処理を別に持つことになり重複。frames の `--ocr` を「独立 `ocr` コマンドにしない」と決めたのと同じ理由(前例: `2026-07-06-readable-eyes-ocr-design.md` 論点3)で却下 |

**所要時間行の汚染(重要)**

`src/cli.ts:40-43` の `postAction` フックが**全コマンド共通で** `console.log(`(所要時間: X秒)`)`
を stdout に出す。describe の action は `console.log(describe(...))` なので、`--json` 時は

```
{ …JSON… }
(所要時間: 0.0秒)      ← これが JSON の後ろに混じり、パイプ/JSON.parse を壊す
```

となり **汚す**。対処を比較:

| 案 | 中身 | 判断 |
|---|---|---|
| (a) 所要時間を**全コマンド** stdout→stderr へ | 診断行は本来 stderr が筋 | 既存の全コマンドの stdout バイトが変わる(行が消える)。散文 describe を含む「既存挙動不変」の血裏が広がりすぎる。**却下** |
| (b) **`describe --json` のときだけ stderr へ**(採用) | フックで `actionCommand.name()==="describe" && actionCommand.opts().json` を判定し、その時だけ `console.error` | 影響は `describe --json` の1経路のみ。**他の全コマンドと散文 describe の stdout は1バイトも変わらない**。`describe --json > out.json` が純 JSON になり、所要時間は端末(stderr)に残る |
| (c) 汚したまま「消費側で末尾を剥がせ」と文書化 | 何も変えない | 「パイプ可能な JSON」を謳えない。**却下** |

**決定: (b)**。commander 13 の `postAction` は `(thisCommand, actionCommand)` を受ける
ので、`actionCommand`(=実行された `describe` サブコマンド)から `name()` と `opts().json`
を読める。フックを次のように最小変更する:

```ts
program.hook("postAction", (_thisCommand, actionCommand) => {
  const sec = ((Date.now() - commandStartedAt) / 1000).toFixed(1);
  const line = `(所要時間: ${sec}秒)`;
  // JSON 射影はパイプ可能な純 JSON を stdout に出すので、診断行だけ stderr へ逃がす。
  // 他コマンド・散文 describe の stdout は従来どおり console.log(=不変)
  if (actionCommand.name() === "describe" && actionCommand.opts().json === true) {
    console.error(line);
  } else {
    console.log(line);
  }
});
```

action 側:

```ts
program
  .command("describe <dir>")
  .description("編集状態の要約。既定は散文、--json で機械可読な完全射影(元秒⇔出力秒つき)")
  .option("--json", "機械可読な完全射影を JSON で標準出力に出す(発話・タイトルを切り捨てない)")
  .action((dir: string, opts: { json?: boolean }) => {
    const abs = resolveDir(dir);
    if (opts.json === true) console.log(JSON.stringify(describeJson(abs), null, 2));
    else console.log(describe(abs));           // ← 現状のまま(バイト不変)
  });
```

### 論点2:JSON スキーマ(完全射影)の形

「非可逆でない」= この JSON 単体から編集状態の主要情報を復元できること。次の設計規則を敷く。

**規則 A(全文主義)**:発話 `text`・タイトル・概要欄・テロップ `style`/`words` は
**verbatim で全部**。`quote()` も `slice(0,3)` も使わない。**これが本項目の主目的**。

**規則 B(元秒 verbatim + 出力秒併記)**:元収録秒(`start`/`end` 等)はファイルの値を
そのまま載せる(丸めない)。**元秒 start/end を持つ全要素に、その `out`(出力秒射影)を
必ず併記する**。keep はマージ済みで連続なので `outStart`/`outEnd`(単一)。
テロップ・zoom・blur・wipe 等は挿入で割れたりカットで消えたりするので `out: Interval[]`
(`remapInterval` の結果。カット内なら `[]`)。章は `snapToOutput`(単一 or null)。
写像は必ず `src/lib/timeline.ts` の関数を使い、自前計算しない。

**規則 C(容器は常在・任意フィールドは元ファイルに追従)**:トップレベルの構造キー
(`keeps` / `cuts` / `captions` / `overlays.*` / `chapters` / `shorts` …)は**どの任意
ファイルが無くても常に存在**(無ければ `[]` / `null`)。一方で要素内の**任意 passthrough
フィールド**(`caption.pos` / `style` / `words`、`zoom.easeSec` 等)は**元ファイルに
在るときだけ載せる**(無いものを `null` で捏造せず、ファイルの忠実な上位集合にする)。
AI 消費側は「トップレベルの形は不変・要素の任意フィールドは在れば読む」で扱える。

**規則 D(元データの射影であって render props ではない)**:テロップの `pos`/`style` は
**セグメント個別指定のみ verbatim**。トラック標準(`overlays.captionTracks`)との
マージ解決(`captionStyleOf`/`captionPosOf`)は**しない**。トラック標準は
`overlays.captionTracks` として別途丸ごと載せるので、必要なら消費側が解決できる。
これで「編集状態(=ファイルに何が書いてあるか)」を歪めない。

**規則 E(決定論)**:キー順はオブジェクトリテラルの構築順で固定。`Set`/`Map` を出力に
使わない(散文の `[...new Set(bgm files)]` のような dedup は JSON では素の配列で持つ)。
派生値(`durationSec` 等の減算結果)は浮動小数ノイズを避けるため round2(timeline の
`round2` と同精度)。passthrough は無加工。`JSON.stringify(obj, null, 2)`(2スペース整形・
diff/Read しやすい)。同じ入力 → 同じバイト。

#### トップレベル・キー(10 + スキーマ版)

1. `schemaVersion` — number(現在 `1`)。将来スキーマを変えたら上げる。AI 消費側の安定化用
2. `source` — 収録メタ(manifest 射影)
3. `summary` — 承認・尺・件数のサマリ
4. `keeps` — keep 区間(元秒 + 出力秒 + 尺)
5. `cuts` — カット区間(元秒 + 理由 + **消える発言の全文**)
6. `captions` — 全テロップ(全文・track・pos・style・words・所属 keep・元秒/出力秒)
7. `overlays` — 演出(materials/inserts/wipeFull/zooms/blurs/hideCaption/colorFilter/layerOrder/captionTracks)
8. `chapters` — 章(元秒 + 出力秒スナップ + title)
9. `meta` — タイトル案(全件)・概要欄(全文)
10. `bgm` — BGM 配置(bgm.json の tracks / フォールバック / なし)
11. `shorts` — ショート(全 ranges + ショート内出力尺 + profile + approved + captionTracks)

#### TypeScript 型定義案

> 置き場所は `src/stages/describe.ts`(論点3で単一ファイルに決定)。`export` して
> cli.ts / テストから参照可能にする。TS 制約(Node 23 type stripping):enum・namespace・
> パラメータプロパティは使わない。`interface … extends …` は型のみで実行時に消えるので可
> だが、可読性優先で共通片は `MappedInterval` を合成する形にする。

```ts
export interface DescribeProjection {
  schemaVersion: number;                  // 1
  source: SourceInfo;
  summary: Summary;
  keeps: KeepEntry[];
  cuts: CutEntry[];
  captions: CaptionEntry[];
  overlays: OverlaysProjection;
  chapters: ChapterEntry[];
  meta: { titles: string[]; description: string };   // 全件・全文(slice しない)
  bgm: BgmProjection;
  shorts: ShortEntry[];
}

export interface SourceInfo {
  file: string;                           // manifest.source
  durationSec: number;
  layout: "obs-canvas" | "plain";         // manifestLayout(manifest)
  video: {
    width: number; height: number; fps: number;
    screenRegion: Region;
    cameraRegion?: Region;                // obs-canvas かつ存在時のみ(規則C)
  };
  audio: { micWav: string; systemStream: number | null };
}

export interface Summary {
  approved: boolean;                      // cutplan.approved
  outDurationSec: number;                 // keep 合計 + 挿入尺(= 現行 describe の outDur)
  keptSec: number;
  cutSec: number;                         // durationSec - keptSec(round2)
  keepCount: number;
  captionCount: number;                   // transcript.segments.length
}

export interface KeepEntry {
  index: number;                          // 0始まり。caption.keepIndex が参照するキー
  start: number; end: number;             // 元秒(verbatim)
  durationSec: number;                    // 派生(round2)
  outStart: number; outEnd: number;       // 出力秒(toOutputTime。keep は連続なので単一)
}

export interface CutEntry {
  start: number; end: number;             // 元秒(keep 間の gap 境界。収録頭/末尾も含む)
  durationSec: number;                    // 派生(round2)
  reasons: string[];                      // この gap に重なる cut record の reason(空可)
  lostCaptions: LostCaption[];            // ここで完全に消える発言(全文)
}
export interface LostCaption {
  start: number; end: number;             // 元秒
  text: string;                           // 全文(切り捨てなし)
  track: number;                          // captionTrack() 解決済み
}

export interface CaptionEntry {
  index: number;                          // transcript.segments の並び順(0始まり)
  start: number; end: number;             // 元秒(verbatim)
  text: string;                           // 全文(切り捨てなし)
  track: number;                          // captionTrack(s)(既定1)
  pos?: CaptionPos;                       // セグメント個別のみ・verbatim(規則D)
  style?: CaptionStyle;                   // セグメント個別のみ・verbatim(規則D)
  words?: WordTiming[];                   // verbatim
  out: Interval[];                        // 出力秒(remapInterval。カット内は [])
  keepIndex: number | null;              // 所属 keep の index(見えない=null)
  visible: boolean;                       // out.length > 0
}

export interface OverlaysProjection {
  materials: MaterialEntry[];             // overlays.overlays[](全件)
  inserts: InsertEntry[];                 // overlays.inserts[](全件・存在フラグ付き)
  wipeFull: MappedInterval[];             // 元秒 + out
  zooms: ZoomEntry[];
  blurs: BlurEntry[];
  hideCaption: MappedInterval[];
  colorFilter: ColorFilter | null;        // 無ければ null(全編一律・区間なし)
  layerOrder: LayerId[] | null;           // 省略時 null(既定順は書かない=ファイル忠実)
  captionTracks: CaptionTrackDef[];       // verbatim(空配列可)。規則D の解決材料
}

// 元秒区間 + その出力秒射影。演出の 元秒 interval に一律で付ける
export interface MappedInterval { start: number; end: number; out: Interval[]; }

export interface MaterialEntry {          // overlays.overlays の1件
  start: number; end: number; file: string;
  track: number;                          // overlayTrack(o)(旧 layer も解決)
  fit?: "contain" | "cover";
  startFrom?: number; volume?: number; opacity?: number;
  fadeInSec?: number; fadeOutSec?: number; rect?: Region;   // すべて在れば載せる
  exists: boolean;                        // join(dir,file) の存在(散文の ⚠ 相当)
  out: Interval[];                         // 元秒 start/end の出力秒射影
}

export interface InsertEntry {            // overlays.inserts の1件(全件を載せる)
  at: number; file: string; durationSec: number;
  startFrom?: number; fit?: "contain" | "cover"; volume?: number;
  fadeInSec?: number; fadeOutSec?: number;
  exists: boolean;                        // 存在しない insert は timeline に入らない
  out: Interval | null;                   // insertSpans の該当 span(exists 時のみ非 null)
}

export interface ZoomEntry extends MappedInterval { rect: Region; easeSec?: number; }
export interface BlurEntry extends MappedInterval {
  rect: Region; type?: BlurType; strength?: number;
}

export interface ChapterEntry {
  start: number;                          // 元秒(verbatim)
  out: number | null;                     // snapToOutput(カット内でスナップ先も無ければ null)
  title: string;                          // 全文
}

export interface BgmProjection {
  source: "bgm.json" | "fallback" | "none";
  tracks?: Bgm["tracks"];                 // source==="bgm.json" のとき verbatim
  file?: string;                          // source==="fallback" のとき bgm.mp3 等の実ファイル名
}

export interface ShortEntry {
  name: string;
  profile: string;                        // 既定 "vertical"(s.profile ?? "vertical")
  approved: boolean;
  ranges: Interval[];                     // verbatim(元秒)
  mergedRanges: KeepEntry[];              // mergeIntervals(ranges) + ショート内 out 秒
  outDurationSec: number;                 // ショートの出力尺
  captionTracks?: CaptionTrackDef[];      // verbatim(在れば)
}
```

補足:
- `mergedRanges` の出力秒は**ショート専用の timeline**(そのショートの `mergeIntervals(ranges)`
  から `buildTimeline(mergedRanges, [])` で組む。本編 `cutplan` とは無関係)で計算する。
  型は `KeepEntry` と同型(index/start/end/durationSec/outStart/outEnd)で流用。
- `inserts` は**全件**載せる(存在しないファイルの insert も編集状態としては存在するため)。
  ただし timeline に入るのは存在するものだけ。マッピング手順:
  `filtered = inserts.filter(exists)` → `spans = insertSpans(keeps, filtered)` →
  各 original insert が存在すれば `filtered` 中の位置を引いて対応 span を `out` に載せる。
  存在しなければ `out: null`。散文(`describe.ts:59-61`)が `filtered` しか見ないのに対し、
  JSON は上位集合として全件を持つ(=より完全)。

#### 例(bench 相当・抜粋)

```jsonc
{
  "schemaVersion": 1,
  "source": {
    "file": "2026-07-02 17-26-36.mkv", "durationSec": 300.0, "layout": "obs-canvas",
    "video": { "width": 3840, "height": 1080, "fps": 30,
               "screenRegion": { "x": 0, "y": 0, "w": 1920, "h": 1080 },
               "cameraRegion": { "x": 1920, "y": 0, "w": 1920, "h": 1080 } },
    "audio": { "micWav": "audio/mic.wav", "systemStream": 1 }
  },
  "summary": { "approved": false, "outDurationSec": 210.5, "keptSec": 205.5,
               "cutSec": 94.5, "keepCount": 3, "captionCount": 42 },
  "keeps": [
    { "index": 0, "start": 0, "end": 40, "durationSec": 40, "outStart": 0, "outEnd": 40 }
  ],
  "cuts": [
    { "start": 40, "end": 50, "durationSec": 10, "reasons": ["言い直し"],
      "lostCaptions": [
        { "start": 41.2, "end": 47.8, "track": 1,
          "text": "えーっと、今日は whisper のベンチマークを取り直そうと思っていて…(全文・36字で切れない)" }
      ] }
  ],
  "captions": [
    { "index": 0, "start": 1.0, "end": 3.0, "text": "こんにちは", "track": 1,
      "out": [{ "start": 1.0, "end": 3.0 }], "keepIndex": 0, "visible": true }
  ],
  "overlays": { "materials": [ /* … */ ], "inserts": [], "wipeFull": [],
    "zooms": [], "blurs": [], "hideCaption": [],
    "colorFilter": null, "layerOrder": null, "captionTracks": [] },
  "chapters": [ { "start": 0, "out": 0, "title": "導入" } ],
  "meta": { "titles": ["案1", "案2", "案3", "案4"], "description": "…全文…" },
  "bgm": { "source": "bgm.json", "tracks": [ /* verbatim */ ] },
  "shorts": [
    { "name": "short-1", "profile": "vertical", "approved": true,
      "ranges": [{ "start": 35.08, "end": 45.08 }],
      "mergedRanges": [{ "index": 0, "start": 35.08, "end": 45.08,
                         "durationSec": 10, "outStart": 0, "outEnd": 10 }],
      "outDurationSec": 10 }
  ]
}
```

### 論点3:既存 describe との実装共有 → **決定: 中間データ構造を1つ(`loadDescribeInputs`)だけ共有し、散文レンダラと JSON ビルダは別関数。全部 `describe.ts` の1ファイルに置く**

**共有の粒度**

| 案 | 中身 | 判断 |
|---|---|---|
| (A) 完全共有 | 「1つの中間モデル」を作り、散文と JSON の2レンダラに分ける | 散文はモデルを作りながら逐次 `lines.push` する密結合。中間モデルを挟むと**散文の生成コードを全面的に書き換え**ることになり、バイト等価の担保が難しい。過剰 |
| (B) **入力ローダのみ共有**(採用) | ファイル読み込み + timeline 構築 + 派生(keeps/cutRecords/inserts/timeline/keptSec/outDur)を `loadDescribeInputs(dir)` に切り出し、`describe()`(散文)と `describeJson()`(JSON)が**同じ入力構造**から各々出力する。純関数の `overlaps` / keep 所属判定も共有 | 重複は「読み込み+timeline セットアップ」だけに限定。散文の**文生成ロジックは無改造**(入力を struct から destructure するだけの機械的置換)。CLAUDE.md が警告する読み込み規約の drift(bgm=null を必須と誤解する旧バグ)を**1箇所に集約して再発防止**。ソロ保守で二重管理を避ける主旨に合致 |
| (C) 完全分離 | `describeJson` が読み込みを独自複製 | 読み込み規約が2箇所に分裂 → bgm-null バグ型の drift を招く。**却下** |

**決定: (B)**。`describe.ts` 内に次を持つ(新規モジュールは作らない=ソロ保守で1ファイルが追いやすい。
cli.ts は既に `describe.ts` から import しており、散文と JSON が同ファイルで並ぶと drift がレビューで露見する):

```ts
interface DescribeInputs {
  dir: string;
  manifest: Manifest; cutplan: CutPlan; transcript: Transcript;
  overlays: Overlays; bgm: Bgm | null; chapters: Chapters; meta: Meta;
  shorts: Shorts | null;
  keeps: Interval[]; cutRecords: PlanSegment[]; inserts: InsertSpan-ish[];
  timeline: TimelineEntry[]; keptSec: number; outDur: number;
}
function loadDescribeInputs(dir: string): DescribeInputs { /* 現 describe.ts:31-64 を移設 */ }

// 純関数(現 describe.ts:71-80 を関数化。両方が呼ぶ)
function overlaps(s: {start:number;end:number}, start: number, end: number): boolean
function keepIndexOf(s: {start:number;end:number}, keeps: Interval[], timeline: TimelineEntry[]): number | null

export function describe(dir: string): string       // 散文。中身の文生成は現状のまま
export function describeJson(dir: string): DescribeProjection   // 新規
```

- `quote()` は **散文専用のまま**(JSON は全文なので絶対に共有しない)。
- `describe()` の改修は「先頭の読み込み〜派生ブロックを `const inp = loadDescribeInputs(dir)` +
  destructure に差し替え、`overlaps`/`keepIndexOf` をローカル定義から共有関数呼び出しに置換」
  の**機械的リファクタのみ**。文を組む部分(`lines.push(...)`)は一字も変えない。
- バイト等価は論点直下の golden test で機械的に固定する(下記タスク1)。

### 論点4:安定性・決定論 → **決定: キー順=リテラル構築順で固定 / 元秒 verbatim・出力秒は timeline 由来 / 派生は round2 / 容器は常在・任意フィールドは在れば載せる / `stringify(…, null, 2)`**

- **キー順**:`buildProjection` がオブジェクトリテラルを構築する順=出力順(V8 は挿入順を保持)。
  配列は元ファイルの並び順(transcript.segments 順・overlays 配列順)を保つ。ソートしない。
- **数値**:元秒(start/end/at/rect 等)はファイル値を**無加工**。出力秒は `timeline.ts`
  の関数(内部で `round2`)由来。派生の `durationSec`/`cutSec`/`outDurationSec` は減算後に
  **round2**(timeline と同精度。`39.99999` 化を防ぐ)。`describe.ts` にローカル `round2`
  を1つ持つ(timeline の `round2` は未 export のため。同義の2行関数)。
- **空配列/欠落**:トップレベル構造キーは常在(`[]`/`null`)。要素内の任意 passthrough は
  在るときだけ(規則C)。`bgm` は `{source:"none"}`(tracks/file 無し)まで必ず出す。
- **整形**:`JSON.stringify(projection, null, 2)`。改行・インデント固定で Read と diff がしやすい。
  `Set`/`Map`/`Date.now()` 等の非決定要素を出力に混ぜない。

---

## `describe.ts` 改修方針(散文不変の担保)

1. **golden test を先に入れる**(タスク1)。現行 `describe()` の出力を、全ファイルを揃えた
   リッチ fixture に対して1回取り、`test/fixtures/describe.golden.txt` として固定。
   以後どのコミットでもこの1本が緑=散文バイト不変の機械的証明。
2. リファクタ(タスク2)は golden とパイプライン既存 `test/describe.test.ts` を**両方緑のまま**
   進める。文生成コードは触らない(読み込み/派生の抽出と純関数化だけ)。
3. `describeJson`/`buildProjection`(タスク3)は**新規コードのみ**で `describe()` を触らない
   ので、散文への影響は構造的にゼロ。
4. CLI 配線(タスク4)は `--json` 経路の追加とフックの分岐のみ。`--json` 無しの stdout は不変。

---

## タスク分解(1タスク = 1コミット・小さく直列)

### タスク1:散文 golden test を追加(バイト不変の錠前)
- **(a) 変更ファイル**:`test/describe.test.ts`(リッチ fixture ビルダ + golden 比較を追加)、
  `test/fixtures/describe.golden.txt`(新規・現行コードの出力を貼る)。**src は触らない**。
- **中身**:全ファイル(manifest/cutplan/transcript/overlays/bgm.json/chapters/meta/shorts)を
  揃えた fixture を作る。**36字超の発話**(切り捨て検証用)・track2 + pos/style/words 付き
  テロップ・存在素材と欠落素材・insert・wipeFull・zoom・blur・colorFilter・4件以上のタイトル・
  カット内で消える発言・スナップする章を含める(タスク3/5 でも再利用する“全部入り” fixture)。
  現行 `describe()` の出力を golden として固定。
- **(b) テスト方針**:このコミット時点では現行コードなので `assert.equal(describe(dir), golden)`
  が**自明に緑**。以降のリファクタの回帰検出器になる。
- **(c) 壊してはいけない**:既存 `test/describe.test.ts` の2ケース(任意ファイル欠落で落ちない /
  必須欠落でエラー)は不変。

### タスク2:入力ローダ + 純関数を抽出し `describe()` をその上に載せ替え(挙動不変)
- **(a) 変更ファイル**:`src/stages/describe.ts`。
- **中身**:`loadDescribeInputs(dir)`(現 31-64 行の読み込み+派生を移設)、`overlaps`/
  `keepIndexOf` を関数化(現 71-80)。`describe()` は先頭ブロックを `loadDescribeInputs` 呼び出し +
  destructure に差し替え、`overlaps`/`keepIndexOf` を共有関数呼び出しに置換。**`lines.push` の
  文生成は一切変更しない**。`quote()` は据え置き。
- **(b) テスト方針**:タスク1の golden + 既存 `test/describe.test.ts` が**両方緑**であること。
  `npm run typecheck` 緑。
- **(c) 壊してはいけない**:散文 stdout のバイト等価(golden)。任意ファイル欠落時の
  フォールバック(bgm=null 等)の挙動。

### タスク3:射影の型 + `buildProjection` + `describeJson` + JSON 単体テスト
- **(a) 変更ファイル**:`src/stages/describe.ts`(型 export・`buildProjection(inp)`・
  `describeJson(dir)=buildProjection(loadDescribeInputs(dir))`)、`test/describeJson.test.ts`(新規)。
  **CLI からはまだ未参照**(次タスクで配線)。
- **中身**:論点2の型と規則(A〜E)どおりに射影を構築。timeline.ts の
  `toOutputTime`/`remapInterval`/`snapToOutput`/`insertSpans`/`mergeIntervals` を使う。
  inserts の全件×span マッピング(論点2補足)、shorts のショート専用 timeline を実装。
- **(b) テスト方針**:タスク1の“全部入り” fixture を再利用し `describeJson(dir)` を検証:
  - **全文主義**:36字超の発話が `captions[].text` と `cuts[].lostCaptions[].text` に
    **切り捨てなしで一致**(`text.length > 36` かつ `!text.includes("…")` を明示チェック)。
  - **タイトル全件**:`meta.titles.length === 4`(slice されない)。
  - **元⇔出力写像**:ある keep の `outStart` が `toOutputTime(start)` と一致、カット内テロップの
    `out === []` かつ `keepIndex === null` かつ `visible === false`、境界をまたぐテロップの
    `out` が期待どおり。章の `out` が `snapToOutput` と一致(スナップ先なしは null)。
  - **容器常在**:overlays/bgm/shorts が無い最小 fixture でも全トップレベルキーが存在し
    `[]`/`null`/`{source:"none"}` になる(既存 `test/describe.test.ts` の最小 fixture を流用)。
  - **決定論**:`JSON.stringify(describeJson(dir)) === JSON.stringify(describeJson(dir))`
    (同一入力→同一バイト)。`schemaVersion === 1`。
- **(c) 壊してはいけない**:`describe()`(散文)は無改修=golden 緑。typecheck 緑。

### タスク4:`describe --json` を CLI に配線 + 所要時間行を stderr へ逃がす + 実データ検証
- **(a) 変更ファイル**:`src/cli.ts`(describe コマンドに `--json` option・action 分岐・
  postAction フックの stderr 分岐)。
- **中身**:論点1のコード。
- **(b) テスト方針**:主検証は**実データ**(bench)。中立 cwd から絶対パスで実行
  (`MEMORY.md` llm-command-verify-neutral-cwd に倣い repo 直下の文脈汚染を避ける):
  - `node src/cli.ts describe <bench> --json > /tmp/proj.json` が**純 JSON**
    (`node -e "JSON.parse(fs.readFileSync('/tmp/proj.json'))"` が通る=所要時間行が混ざらない)。
    所要時間は stderr に出る(`2>/dev/null` で消える)ことを確認。
  - `node src/cli.ts describe <bench>`(`--json` 無し)の stdout が導入前と一致(散文不変)。
    末尾に `(所要時間: …秒)` が**stdout に残る**(他コマンドと同じ)ことを確認。
  - 射影内の既知の値を transcript.json / cutplan.json と突き合わせ(発話全文・keep 秒・
    ショート ranges が一致)。
- **(c) 壊してはいけない**:`--json` 無しの describe stdout(散文 + 所要時間行)。
  **他の全コマンドの stdout**(所要時間行は従来どおり stdout)。

### タスク5:ドキュメント同期
- **(a) 変更ファイル**:`CLAUDE.md`(「動画の中身を知る方法」に `describe --json`=機械可読な
  完全射影を追記。コマンド一覧に `--json` を追記)、`docs/usage.md`(describe の項に `--json` と
  射影スキーマの要点表)。
- **(b) テスト方針**:なし(doc)。記述とコード(型・キー名)の一致を目視。`validate` が無関係に通る。
- **(c) 壊してはいけない**:既存の describe 記述(散文の説明)を消さず、`--json` を**追加**する。

---

## 実装子が先に読むコード(シンボル名。行番号は先行マージでズレる)

- `src/stages/describe.ts` — `describe()` 本体・`quote()`(散文専用・JSON では使わない)・
  読み込み規約(`readRequired`/`readOptional`)・`overlaps`/`keepIndexOf`。抽出とビルダ追加の対象。
- `src/lib/timeline.ts` — `buildTimeline`/`toOutputTime`/`remapInterval`/`snapToOutput`/
  `insertSpans`/`mergeIntervals`。**出力秒は全部これ由来**(自前計算しない)。`round2` は未 export。
- `src/lib/shorts.ts` — `loadShorts(dir)`(shorts.json 読み込み。射影の `shorts` の入力)。
- `src/types.ts` — 全編集ファイルの型(`Manifest`/`CutPlan`/`Transcript`/`TranscriptSegment`/
  `Overlays`/`Bgm`/`Chapters`/`Meta`/`Shorts`/`CaptionPos`/`CaptionStyle`/`WordTiming`/`Region`/
  `LayerId`/`ColorFilter`/`BlurType`)。射影の passthrough 型はここから import。
  `captionTrack`/`overlayTrack`/`manifestLayout`/`hasCamera` の解決ヘルパもここ。
- `src/cli.ts` — describe コマンド定義(269-276)・`preAction`/`postAction` フック(37-43)・
  `resolveDir`。`--json` とフック分岐の対象。
- `test/describe.test.ts` — 既存の最小 fixture 2ケース(壊さない土台)。golden と最小容器テストで流用。
- `src/stages/frames.ts` / `docs/plans/2026-07-06-readable-eyes-ocr-design.md` — 「未使用時
  バイト等価で機能追加」「独立コマンドにしない」の前例(方針の手本)。

## 実測検証(bench 収録)

検証対象:`~/Movies/cutflow/2026-07-02-whisper-bench`(raw mkv + manifest/cutplan/transcript/
overlays/bgm.json/chapters/meta/shorts が一式・obs-canvas)。中立 cwd + 絶対パスで実行。

1. **純 JSON**:`describe <bench> --json > /tmp/proj.json 2>/dev/null` → `JSON.parse` が通る
   (所要時間行が stdout に混ざらない)。`2>&1` で見ると所要時間は stderr に出ている。
2. **散文不変**:`describe <bench>`(`--json` 無し)の stdout を導入前後で `diff` → 完全一致
   (末尾の所要時間行含め従来どおり stdout)。
3. **完全復元**:`proj.json` の `captions[].text` / `cuts[].lostCaptions[].text` に **36字超の
   発話が切り捨てなしで**現れる。`meta.titles` が meta.json と件数一致(slice されない)。
   `keeps`/`shorts[].ranges` が cutplan.json / shorts.json と数値一致。
4. **元⇔出力**:任意の keep の `outStart` を `describe`(散文)の「出力 …」表記と突き合わせて一致。
   カット内テロップが `out:[]`/`keepIndex:null`/`visible:false` になっている。
5. **不変の錠**:`npm run typecheck` と `npm test`(既存 + golden + JSON 単体)が緑。

「機械可読な完全射影ができた」と言える条件 = **手順3で発話・タイトルが無損失**かつ
**手順2で散文が1バイトも変わっていない**こと。
