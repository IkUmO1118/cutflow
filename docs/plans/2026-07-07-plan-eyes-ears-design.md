# plan に「目耳」を接続する(カット判断ループへ画像+音)設計

> 2026-07-08 P0 更新: コード上の未指定 fallback は互換のため全オフのままだが、
> 標準 `config.yaml` では `plan.perception` を明示し `audio/ocr` をオンにする。
> `plan` / `remeta` / `run` 実行時は今回の知覚状態を表示し、未指定 config では
> 警告して継続する。

- 対象: NLE ロードマップ NEXT「カット判断ループに目耳を接続(plan に画像+音)」(effort L)
- 診断: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`(読むだけ。**このファイルは触らない**)
- 前提リポジトリ規約: `CLAUDE.md`(全編集は平文 JSON / 時刻は元収録の秒 / LLM は番号選択のみ / 既定オフ・未使用時バイト等価が鉄則)
- 関連既存設計: `docs/plans/2026-07-06-readable-eyes-ocr-design.md`(`frames --ocr` の目。OCR 結果を plan に流すのは**本 Feature の宿題**として明記されていた)/ `docs/plans/2026-07-06-channel-rules-learning-design.md`(`renderRulesBlock` の「不在時バイト等価」パターン=本設計の型)

---

## 0. 問題の一行要約

カット判断 LLM(`plan` / `plan --cuts-only` / `remeta`)は、`numberSegments` が作る
`#id [開始-終了秒] 発話text` + brief + 尺**だけ**を見ている。detect が既に
`cuts.auto.json` に持っている無音マップも、`frames --ocr` で読める画面テキストも、
意思決定ループに入っていない。「目耳を与えた」を約束から実装へ動かす。

現状の唯一の LLM 入力経路(`src/stages/plan.ts`):

```
numberSegments(auto.keepSegments, transcript)  →  NumberedSegment[]
renderPrompt(dir, template, numbered, durationSec)  →  segmentLines = "#id [s-e] text"
complete(prompt, cfg)  →  text  →  parse  →  cutplan/chapters/meta
```

`auto.silences[]` も画面 OCR もこの経路に一切現れない。

---

## 1. スコープ規律(最初に線を引く)

**やる**: `plan` / `plan --cuts-only` / `remeta` の **LLM 入力に、発話テキスト以外の
知覚を1回添える**こと。具体的には
(a) detect が既に持つ無音・間の情報(`cuts.auto.json` 由来。**新規計測なし**)、
(b) 画面 OCR テキスト(`frames --ocr` の既存プリミティブ `buildScreenStill` +
`runOcr` を区間代表フレームに1回だけ再利用)。

**やらない(本 Feature の外)**:
- 画像マルチモーダル(`complete` に image を送る)→ 論点3で不採用を決定。次段の種だけ残す。
- エージェントループ化(観測→再カット→再観測の複数ショット)→ 別 Feature。plan は
  従来どおり **1ショット**のまま。
- `plan-shorts`(ショート選定)への知覚接続 → 別トラック。`plan-shorts.md` は触らない。
- detect への新規音量計測(区間 RMS/ラウドネス)の追加 → 論点2で不採用。detect が
  今持つ情報だけで表現する。
- `words[].confidence`(誤認識ヒント)の利用 → words は「描画専用の補助データ」
  (CLAUDE.md)。カット判断への流用は結合を増やすだけなので本 Feature では見送り(§9 将来)。

---

## 2. 決定サマリ(decisions.md 形式)

| # | 論点 | 決定 | 理由(要約) |
|---|---|---|---|
| D1 | 接続する知覚の優先順位 | **音特徴(a)+ 画面OCR(b)を本 Feature に入れる。画像(c)は不採用** | 「安い勝ちから」。a は決定論・追加依存ゼロ。b は既存 OCR プリミティブの再利用で、開発系チャンネルは画面=文字なので c より費用対効果が高い |
| D2 | 音特徴の表現 | detect の既存情報のみ。区間ごとに **`len`(区間長)/ `gapBefore`(直前に落ちた素材秒)/ `silenceWithin`(区間内に残った無音秒)** の3つを記述的に添える。新規音量計測はしない | LLM に算術をさせない・番号選択の材料になる形。RMS 計測は ffmpeg 追加パス+新コードでコスト高、効果は「間」より小さい |
| D3 | 画像/OCR の接続方式 | plan 内で **区間代表フレーム1枚**(source 秒の中点)を `buildScreenStill`+`runOcr` で OCR。既存 `frames/*.ocr.json` は**使わない**(鶏卵・座標系違い)。macOS 非対応時は優雅に劣化(空→ブロック省略) | plan 時点で frames は未実行(frames は cutplan を要求、cutplan は plan の出力)。区間数ぶんの Vision は重いので上限・行数キャップで制御 |
| D4 | プロンプト差し込み | `{{segments}}` は**一切変えない**。新プレースホルダ `{{perception}}` を **`{{rules}}` の直後(同一行・区切りなし)** に置き、`renderPerceptionBlock` が不在時 `""`・存在時 `"\n…\n"` を返す(`renderRulesBlock` と 1:1 の型) | 「未使用時バイト等価」を `renderRulesBlock` の実証済み機構で担保。`{{segments}}` を触らないので回帰リスク最小 |
| D5 | config と既定 | `plan.perception.{audio, ocr, ocrMaxSegments, ocrMaxLines}` を新設。**全て既定オフ**。`loadConfig` は `plan` を defaulting で埋めない(省略=オフ=バイト等価) | 既定オフ・未使用時バイト等価が鉄則。audio は「安全な最初の opt-in」として推奨(決定論・依存なし) |
| D6 | 決定論とコスト | **両方とも既定オフ**。audio 有効化は決定論・追加依存なし(推奨)。ocr 有効化は ffmpeg+Vision の区間数ぶんの追加時間+macOS 依存+軽微な非決定性を伴うと明記 | バイト等価保証を最優先。安く確実な audio を「まず入れる opt-in」と位置づけ、ocr は明示的な選択に |

**画像(マルチモーダル)を入れない判断の明文化(D1 の詳細)**:
`src/lib/llm.ts` の `complete` は backend 2種。既定は **claude-cli**(`claude -p`。
サブスク範囲・BYO-AI の差別化の要)。api backend は Anthropic messages の content
ブロックに image を足せるが、**claude-cli は画像添付が難しい**。ここに image を
入れると「既定 backend では使えない二層機能」になり、backend 非依存の `complete`
設計と BYO-AI の思想に反する。加えて区間数ぶんの画像はトークン・レイテンシ・
非決定性を押し上げる。開発系チャンネルは画面の主役がコード/エラー=文字で、
**OCR テキストが画像の意味内容をほぼ代替する**。ゆえに画像は本 Feature の外。
将来やるなら §9 の seam に沿って `complete(prompt, cfg, {images?})` を足す。

---

## 3. config スキーマ案

`src/lib/config.ts` の `Config` に追加(すべて省略可):

```ts
export interface Config {
  // …既存…
  /** カット判断 LLM(plan / plan --cuts-only / remeta)へ発話テキスト以外の
   * 知覚を添える設定。省略可(古い config.yaml との互換。省略時は全項目オフ=
   * plan の LLM 入力・plan.raw.txt が現状とバイト等価)。plan-shorts は対象外 */
  plan?: {
    perception?: {
      /** 無音・間の注記(区間長 / 直前に落ちた素材秒 / 区間内無音秒)を
       *  プロンプトに添える。省略時 false。決定論・追加依存なし(推奨の opt-in) */
      audio?: boolean;
      /** 各区間の代表フレームの画面 OCR テキストをプロンプトに添える。
       *  省略時 false。macOS + Apple Vision が必要(無い環境は自動で劣化=
       *  OCR 部分を省いて続行)。区間数ぶんの ffmpeg クロップ+Vision が走る */
      ocr?: boolean;
      /** OCR をかける区間数の上限(コスト制御)。省略時 DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS(40)。
       *  区間数がこれを超える場合は尺の長い区間を優先して上限まで */
      ocrMaxSegments?: number;
      /** 1区間あたりプロンプトに載せる OCR 行数の上限。省略時
       *  DEFAULT_PERCEPTION_OCR_MAX_LINES(6) */
      ocrMaxLines?: number;
    };
  };
}

export const DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS = 40;
export const DEFAULT_PERCEPTION_OCR_MAX_LINES = 6;

/** plan.perception を既定値で解決する純関数(省略時は全オフ)。
 *  loadConfig は cfg.plan を書き換えない(省略=オフ=バイト等価を守る) */
export function resolvePerceptionCfg(cfg: Config): {
  audio: boolean; ocr: boolean; ocrMaxSegments: number; ocrMaxLines: number;
} {
  const p = cfg.plan?.perception ?? {};
  return {
    audio: p.audio ?? false,
    ocr: p.ocr ?? false,
    ocrMaxSegments: p.ocrMaxSegments ?? DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: p.ocrMaxLines ?? DEFAULT_PERCEPTION_OCR_MAX_LINES,
  };
}
```

`loadConfig` は `cfg.plan` に一切触れない(`cfg.ocr ??= {}` のような defaulting を
**入れない**)。省略された config は `resolvePerceptionCfg` が全オフに解決する。

`config.yaml` には既定オフのコメント例だけ足す(値は書かない=挙動不変):

```yaml
# plan(カット判断 LLM)へ発話以外の知覚を添える(既定オフ)。
# plan:
#   perception:
#     audio: true        # 無音・間の注記(決定論・追加依存なし。まずこれから)
#     ocr: false         # 画面OCRテキスト(macOS/Apple Vision 必要・区間数ぶん重い)
#     ocrMaxSegments: 40
#     ocrMaxLines: 6
```

---

## 4. 音特徴の表現(D2 の定義)

`numberSegments` の出力 `NumberedSegment[]`(`{id, start, end, text}`)と
`cuts.auto.json` の `silences[]` だけから、区間ごとに次を計算する(純関数):

| フィールド | 定義 | 何のヒントか |
|---|---|---|
| `len` | `end - start` | 区間の尺。極端に短い区間=断片の手掛かり |
| `gapBefore` | `start - prevSeg.end`(先頭は 0) | 直前に落ちた素材の秒数。大きい=直前で長く切られている(話題の切れ目・脱線の除去痕) |
| `silenceWithin` | `Σ overlap(silence, [start,end])` | 区間内に残った無音の合計。大きい=言い淀み・間(pad で吸収されて keep に残った無音) |

- すべて `cuts.auto.json` + `numberSegments` の既存データから計算でき、**detect への
  新規計測を要しない**。
- `gapBefore` は「連続する keep の間に落ちた素材」で、silences への正確な帰属
  (pad 分のズレ)を避けられる堅牢な量。`silenceWithin` は overlap 積算で pad の
  境界曖昧さに影響されない。
- **LLM に算術はさせない**。値はこちらで秒に丸め、記述文として渡す(番号選択の材料)。
- `remeta` では numbered が「cutplan の merge 済み keep」になるので、`gapBefore` は
  章と章の間に落ちた素材秒=章立ての手掛かりとして自然に効く。

プロンプト内の表現(`{{perception}}` ブロックの一部。`{{segments}}` には**入れない**):

```
## 各区間の音の特徴(秒)

#1 尺5.2 / 直前カット0.0 / 内無音0.0
#3 尺6.5 / 直前カット2.1 / 内無音0.8
…
```

丸めは小数第1位。値が全て 0 の区間も、番号の連続性のため省略しない(または
「特徴なし」の区間は省略して行数を減らす—実装は「全ゼロ行は出さない」を推奨。
どちらでもバイト等価不変条件には無関係=ブロック全体が opt-in なので)。

---

## 5. 画面 OCR の接続方式(D3 の定義)

### 5.1 なぜ既存 `frames/*.ocr.json` を使わないか

`frames` は `cutplan.json` を要求する(`renderFrames` が読む)。`cutplan.json` は
`plan` の**出力**。つまり plan 実行時点で frames は基本まだ走っておらず、
`frames/*.ocr.json` は存在しない(鶏卵)。さらに frames の OCR は**出力秒**キーで、
plan が扱うのは**元収録秒**の `keepSegments`。座標系・キー空間が違う。したがって
plan は **自前で** 代表フレームを OCR する(既存プリミティブを再利用するだけ)。

### 5.2 手順(`src/lib/perception.ts` の新関数)

区間ごとに:
1. 代表 source 秒 = `clamp((seg.start + seg.end) / 2)`(中点)。純関数
   `representativeSourceTime(seg)` に切り出してテスト可能にする。
2. `buildScreenStill(dir, manifest, sourceSec, tmpPng)`(既存)でフル解像度
   screenRegion を tmp に1枚クロップ。
3. `runOcr(tmpPng, manifest.video.screenRegion, {languages: cfg.ocr?.languages, warn})`
   (既存)で Vision OCR。**戻り値 null(非対応環境・失敗)は投げずにスキップ**。
4. tmp PNG は使用後に削除(`frames.ts` の `ocrFrame` と同じ tmp+finally パターン)。
5. 先頭 `ocrMaxLines` 行だけを採用し `text` に連結。

コスト制御:
- OCR は `ocrMaxSegments` 区間まで(超過時は `len` の大きい順に上限まで選ぶ)。
- 1区間1枚(中点)だけ。frames の `--captions`/`--every` のような多点は撮らない。
- **キャッシュは v1 では持たない**(plan の再実行は規約で禁止=稀。dev 反復のみ)。
  持つなら別 Feature。→ `files.ts` に新しい生成物を足さない(分類変更ゼロ)。

優雅な劣化(必須):
- macOS 以外 / swift 系なし / Vision 失敗 → `runOcr` が null → その区間は OCR なし。
- source 秒が挿入クリップ内で画面の生映像が無い場合は起こりにくい(plan 段では
  overlays.inserts が無いことが多い)が、`buildScreenStill` は元収録を直接クロップ
  するので常に生ピクセルが得られる=挿入の考慮は不要(frames と違い timeline 逆写像
  を通さない)。
- 全区間で OCR が空 → OCR ブロックは出さない(§6 の空判定)。

プロンプト内の表現(`{{perception}}` ブロックの一部):

```
## 各区間の画面テキスト(OCR。開発系は画面が主役)

#3 画面: "npm test" / "FAIL src/foo.test.ts" / "Expected 2 received 3"
#7 画面: "git commit -m ..."
(記載のない区間は画面テキストなし)
```

---

## 6. プロンプトテンプレ拡張(D4 の核・バイト等価の担保)

### 6.1 `renderPerceptionBlock`(`renderRulesBlock` と同型の純関数)

```ts
// src/lib/perception.ts
export function renderPerceptionBlock(
  audio: SegmentAudioFeature[] | null,
  ocr: SegmentOcr[] | null,
): string {
  const aLines = audio && audio.length ? formatAudio(audio) : null;
  const oLines = ocr && ocr.some(o => o.text) ? formatOcr(ocr) : null;
  if (!aLines && !oLines) return "";          // ← 不在時は "" (バイト等価の核)
  const parts = ["## AI 向け知覚情報(発話以外の手掛かり)"];
  if (aLines) parts.push(aLines);
  if (oLines) parts.push(oLines);
  return `\n${parts.join("\n\n")}\n`;         // ← 存在時のみ前後 \n
}
```

`renderRulesBlock` と完全に同じ契約: **両方 null/空 → `""`**、存在時のみ
`"\n…\n"`。呼び出し側はこの値を `{{perception}}` に `replaceAll` するだけ。

### 6.2 テンプレへの配置(バイト等価の要点)

現状 `plan.md` の該当箇所:

```
{{brief}}
{{rules}}
## カットの判断基準
```

`{{rules}}` が `""` のとき `<brief>\n\n## カットの判断基準`(空行1つ)。
これを崩さずに `{{perception}}` を足すには、**`{{rules}}` と同じ物理行に、区切り
なしで隣接**させる:

```
{{brief}}
{{rules}}{{perception}}
## カットの判断基準
```

各プレースホルダは `""` か `"\n…\n"` のどちらかしか返さないので:

| rules | perception | 結果(brief と次見出しの間) |
|---|---|---|
| `""` | `""` | 空行1つ(**現状とバイト等価**) |
| `"\nR\n"` | `""` | `R` ブロック(現状の rules だけと等価) |
| `""` | `"\nP\n"` | `P` ブロックのみ |
| `"\nR\n"` | `"\nP\n"` | `R` → `P` の順で両方 |

→ **新しい物理行を増やさない**ので、`test/rules.test.ts` の
`BRIEF_DEFAULT\n\n## カットの判断基準` 回帰ガードはそのまま緑のまま(=perception
既定オフのバイト等価をこの既存テストが自動で守る)。

同じ差し込みを `prompts/plan.md` / `prompts/plan-cuts.md` / `prompts/meta.md` の3枚に。
**`prompts/plan-shorts.md` には足さない**(スコープ外。`renderPrompt` は共有だが
`{{perception}}` が無いテンプレでは `replaceAll` が no-op)。

### 6.3 `renderPrompt` の拡張(後方互換シグネチャ)

```ts
export function renderPrompt(
  dir: string,
  templateFile: string,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string = "",     // ← 追加。既定 "" で既存 4引数呼び出しは不変
): string {
  // …既存…
  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{perception}}", () => perception);  // ← 追加
}
```

- 第5引数を省略した既存呼び出し(`planShorts.ts` の `renderPrompt(dir,
  "plan-shorts.md", numbered, auto.originalDurationSec)`、`rules.test.ts`)は
  `perception=""` になり **完全にバイト等価**。
- `replaceAll` を**関数形式**にするのは既存踏襲(`$&` 等の特殊トークン混入対策)。

---

## 7. plan / remeta 側の配線

`plan()`(`src/stages/plan.ts`):

```ts
const numbered = numberSegments(auto.keepSegments, transcript);
// …
const pc = resolvePerceptionCfg(cfg);
const audio = pc.audio ? computeAudioFeatures(numbered, auto.silences) : null;
const ocr = pc.ocr
  ? await computeSegmentOcr(dir, readManifest(dir), numbered, pc, warn)
  : null;
const perception = renderPerceptionBlock(audio, ocr);
const prompt = renderPrompt(dir, templateFile, numbered, auto.originalDurationSec, perception);
```

- `pc.audio` も `pc.ocr` も false のとき `audio=null, ocr=null` →
  `renderPerceptionBlock(null,null) === ""` → renderPrompt はバイト等価 →
  `complete` へ渡す prompt が現状と同一 → **`plan.raw.txt` も同一**。
- `ocr` 経路のみ manifest.json を読む(plan は現状 manifest を読んでいない)。
  audio だけなら manifest 不要。

`remeta()`: 同じく `resolvePerceptionCfg` を見る。numbered は cutplan の merge 済み
keep。silences は `cuts.auto.json` から読む(remeta は現状 auto を読んでいないので、
`pc.audio` が真のときだけ読む。無ければ audio=null に劣化=バイト等価)。

---

## 8. タスク分解(1タスク=1コミット)

### タスク1: config スキーマ + `resolvePerceptionCfg`(挙動変化なし)

- 触る: `src/lib/config.ts` — `Config.plan?.perception`、`DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS`、
  `DEFAULT_PERCEPTION_OCR_MAX_LINES`、`resolvePerceptionCfg(cfg)`。`loadConfig` は
  `cfg.plan` に**触れない**。
- 触る: `config.yaml` — コメントの例のみ(値は書かない)。
- テスト: `test/config.test.ts` に追加 —
  (1) `plan` 省略の config で `resolvePerceptionCfg` が全オフ+既定値、
  (2) 部分指定(`audio: true` だけ)で他が既定、
  (3) `loadConfig` が `cfg.plan` を生成しない(省略時 `cfg.plan === undefined`)。
- 壊すな: 既存 `loadConfig` の defaulting(`whisper.wordTimestamps` / `ocr.languages`)は不変。

### タスク2: `src/lib/perception.ts`(音特徴・純関数)+ プロンプト配線(audio のみ)

- 触る(新規): `src/lib/perception.ts` —
  `SegmentAudioFeature`、`computeAudioFeatures(numbered, silences)`、
  `formatAudio(features)`、`renderPerceptionBlock(audio, ocr)`(ocr 引数は用意だけ、
  この時点では常に null で呼ぶ)。
- 触る: `prompts/plan.md` / `prompts/plan-cuts.md` / `prompts/meta.md` —
  `{{rules}}` の直後に区切りなしで `{{perception}}` を隣接(§6.2)。
- 触る: `src/stages/plan.ts` — `renderPrompt` に第5引数 `perception=""` 追加+
  `.replaceAll("{{perception}}", …)`。`plan()` / `remeta()` で
  `resolvePerceptionCfg` を見て audio を計算し `renderPerceptionBlock` を渡す
  (ocr はまだ null)。
- テスト: `test/perception.test.ts`(新規) —
  - `computeAudioFeatures`: `len`/`gapBefore`(先頭0・連続区間の落ち)/`silenceWithin`
    (overlap 積算・部分重なり)の数値ケース。
  - `renderPerceptionBlock(null,null) === ""`、audio ありで `"\n"` 始まり `"\n"` 終わり・
    見出しと `#id` を含む。
  - **バイト等価 golden**: `renderPrompt(recDir, "plan.md", numbered, 42)`(perception
    省略)が、テンプレ変更後も `## カットの判断基準` 直前が空行1つ=変更前と同一で
    あること。3テンプレ分を固定文字列 or 既存 `test/rules.test.ts` の regex ガードで担保。
- テスト(回帰): `test/rules.test.ts` は**修正なしで緑**であること
  (`{{perception}}` 隣接配置が空行を増やさない証明)。もし文言確認を足すなら
  「rules も perception も無いとき `{{perception}}` の残骸(`{{`)が出ない」を1件追加。
- 壊すな:
  - `{{segments}}` の内容・`numberSegments` は**一切変えない**。
  - 4引数の `renderPrompt` 呼び出し(`planShorts.ts` / 既存テスト)がバイト等価。
  - audio オフ時の `plan()` / `remeta()` の出力(`cutplan.json` / `plan.raw.txt` /
    `chapters.json` / `meta.json`)が現状と同一。

### タスク3: 画面 OCR 接続(opt-in・優雅な劣化)

- 触る: `src/lib/perception.ts` — `SegmentOcr`、
  `representativeSourceTime(seg)`(純関数)、
  `selectOcrTargets(numbered, maxSegments)`(純関数: `len` 降順で上限選抜、id 昇順で返す)、
  `computeSegmentOcr(dir, manifest, numbered, pc, warn)`(`buildScreenStill`+`runOcr`
  を代表フレームに適用、tmp 生成→finally 削除、`ocrMaxLines` で切り詰め)、
  `formatOcr(ocr)`。`renderPerceptionBlock` に OCR ブロックを合流(§6.1)。
- 触る: `src/stages/plan.ts` — `pc.ocr` 真のとき manifest を読み `computeSegmentOcr`
  を呼び `renderPerceptionBlock(audio, ocr)` に渡す。
- テスト: `test/perception.test.ts` に追加 —
  - `representativeSourceTime`: 中点。
  - `selectOcrTargets`: 上限超過時に長い区間優先・返りは id 昇順・上限以下は全件。
  - `formatOcr` / `renderPerceptionBlock`: OCR 空(全区間 text 空)→ OCR ブロックを
    出さない(=audio も無ければ `""`)。OCR ありで `#id 画面:` 行を含む。
  - 優雅な劣化: `computeSegmentOcr` は `runOcr` が null を返しても投げず、その区間を
    飛ばす(runOcr をスタブ/依存注入できる形にするか、macOS 以外では自然に null に
    なる経路を許容。純関数の `formatOcr` 側で「null/空を落とす」を保証すれば十分)。
- 壊すな:
  - `ocr` オフ時に **ffmpeg も Vision も一切呼ばれない**(バイト等価・追加レイテンシ0)。
  - `frames --ocr`(`src/stages/frames.ts` / `src/lib/ocr.ts` / `screenStill.ts`)は
    無改造・挙動不変(共有プリミティブを読むだけ)。
  - `files.ts` の分類は変えない(v1 は永続キャッシュを持たない=新生成物なし)。

### タスク4: ドキュメント同期

- 触る: `docs/usage.md` — plan の知覚設定(`plan.perception`)の節を追加。
- 触る: `CLAUDE.md` — 「動画の中身を知る方法」or plan の説明に、plan が opt-in で
  音特徴/画面OCR を LLM へ添える旨を1〜2行(表の追記は任意)。
- 触る(任意): `config.yaml` のコメント例(タスク1で入れていれば不要)。
- テスト: なし(ドキュメントのみ)。`npx tsc --noEmit` と `npm test` が緑であること。
- 壊すな: `docs/reviews/` は**触らない**。

---

## 9. 不変条件(実装子への契約)

1. **既定オフ = バイト等価**: `plan.perception` を書かない(または全 false)とき、
   `renderPrompt` の出力・`complete` に渡る prompt・`plan.raw.txt`・`cutplan.json` /
   `chapters.json` / `meta.json` は本 Feature 前と**1バイトも変わらない**。
   これを `test/rules.test.ts`(既存 regex)+ `test/perception.test.ts`(golden)で固定。
2. **`{{segments}}` 不可侵**: 知覚は `{{perception}}` ブロックにのみ入れる。
   `numberSegments` と segmentLines のコードは触らない。
3. **優雅な劣化**: OCR は非対応環境で投げない・plan 本体を止めない(`runOcr` の
   null を吸収)。
4. **LLM に算術なし**: 音特徴もこちらで秒に丸めて記述文で渡す(番号選択のみさせる)。
5. **1ショットのまま**: plan は従来どおり `complete` を1回。観測→再カットのループ化は
   しない。
6. **`plan-shorts` / `docs/reviews/` は不可侵**。

## 10. 将来の種(本 Feature ではやらない)

- 画像マルチモーダル: `complete(prompt, cfg, opts?: { images?: {path|base64}[] })`
  に拡張。api backend は content ブロックへ、claude-cli は非対応で warn しテキストへ
  フォールバック。plan は代表フレームの合成 still(`frames --full-res` 相当)を数枚
  だけ添える。backend 差の吸収と決定論の担保が前提。
- 区間音量(RMS/ラウドネス)計測: detect に astats/ebur128 の1パスを足し、
  `AutoCuts` に per-segment 音量を持たせて `computeAudioFeatures` に合流。
- `words[].confidence` による低確信区間フラグ(誤認識・言い直しの手掛かり)。
- OCR 結果の永続キャッシュ(source 秒+screenRegion フィンガープリント)。持つなら
  `files.ts` の `GENERATED_FILES` に登録し CLAUDE.md の一覧も追随。
```
