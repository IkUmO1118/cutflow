# 実装設計書 SD-M1: M1(+M4)— 素材配置候補の生成(番号選択・人間承認)

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§4「素材」/ §7。
> cut 系(SD1〜SD5)が一巡し、母艦 D5 で parked だった **素材(M)** の最初の設計書。
> 本書はその **M1(挿入候補の提示)+ M4(話題アンカーの生成)** を、実装担当
> (弱いモデル想定)がそのまま着手できる粒度まで落とした設計書。**この2施策だけが対象**。
> M2(尺整合の自動補正)・M3(dangling→patch 橋渡し)は含めない(§0 非スコープ)。
>
> **前提となる確定方針(母艦 §2 原則4 / §6):** AI は**列挙された候補から番号で選ぶ**
> (時刻・ファイルパス・尺を LLM に生成させない)。素材・BGM・演出に AI を広げるときも
> cut と同じ番号選択方式を踏襲する。**素材配置は cut を一切触らない**独立軸。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **M4(話題アンカーの生成)**: 「素材を出したい瞬間」を**決定論的に列挙**する。
  アンカー = カット後タイムラインの **keep span**(`cutplan.json` の各 keep)を
  そのまま候補スロットにし、番号を振る。時刻は keep の実区間なので LLM が捏造しない。
- **M1(素材配置候補の提示)**: `materials.probe/index.json` の実在素材を番号付きで列挙し、
  各素材のメタ(kind・実尺・解像度・音声有無・OCR/transcribe プレビュー)を LLM に渡す。
  LLM は **(アンカー番号 × 素材番号)のペア**だけを返す。コードが `overlays.json` の
  `overlays[]`(区間表示=非タイムラインシフト)エントリへ変換し、**下書き**として書く。
- 生成物は**全て人間レビュー前提**。overlays は承認スコープ外(CLAUDE.md: overlays/
  transcript/bgm の編集は承認 hash を失効させない)なので、承認レコードには一切触れない。
  人間は editor / preview で見て、要らなければ消す。

**本書でやらないこと(混同禁止):**
- **`inserts[]`(タイムラインシフトを起こす挿入編集)は生成しない。** inserts は
  `at` 以降を尺ぶん後ろへずらし、cut のテンポ・出力尺・時刻写像に影響する。v1 は
  **`overlays[]`(区間に重ねるだけ・尺を動かさない)に限定**して安全に測る。inserts は
  M フォローアップ(別設計書)。理由は §2。
- **既存 overlays の尺整合の自動補正(M2)はしない。** ただし候補を**作る**ときの
  素材再生範囲は `materials.probe` の**実尺**から導く(LLM に尺を書かせない)=M2 の
  garbage-in をこの段でも構造的に防ぐ。既存要素の補正は別。
- **未使用/dangling の patch 橋渡し(M3)はしない。** materials の検出結果を配置提案へ
  繋ぐのは M3(別設計書)。本書は「素材を新規に置く候補」だけ。
- **cut / plan / cutplan.json は一切触らない。** アンカーは `cutplan.json` を**読む**だけ。
- **時刻・ファイルパス・素材尺を LLM に生成させない**(番号選択方式=母艦 原則4)。
- **自動で本番配置しない**(下書き。承認・採否は人間)。approvals.json に触れない。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **番号選択のみ(最重要・母艦 原則4)**: LLM 出力は `placements: [{anchorId, materialId,
   reason}]` **だけ**。時刻・`file`・`start`/`end`・再生範囲を LLM に書かせない。
   `anchorId`/`materialId` → 実区間・実ファイルへの変換と、存在しない番号の無視は
   **すべてコード側**(`plan-shorts` の `shortsFromSelection` と同じ堅牢さ)。
2. **cut 不変**: `cutplan.json` は読むだけ。keep span をアンカーにするので、cut の
   keep 集合が変わらない限りアンカー集合も安定。**承認 hash に一切影響しない**
   (overlays 編集は承認スコープ外)。
3. **素材メタは実測から(garbage-in を消す)**: 素材の kind・実尺・解像度・音声・OCR/
   transcribe は `materials.probe/index.json` から取る。**存在しないファイルを配置候補に
   出さない**(present:false=dangling は候補から除外)。素材の再生範囲は実尺で cap。
4. **opt-in / 非破壊**: 既存 `overlays.json` があるときは `--force` 必須。実行前に
   `overlays.json` を `backups/<日時>/` へ退避してから上書き(`plan`/`plan-shorts` と同じ作法)。
   `--force` なしはエラーで止まる。
5. **前提知覚の欠如は優雅に拒否**: `materials.probe/index.json` が無い/古いときは
   **例外を投げず**「先に `materials <dir> --all` を実行せよ」と告げて exit 1。
   W0 の words 警告と同じ思想(静かに劣化させない)。素材が0件でも同様に告知して終了。
6. **書く前に検査(all-or-nothing)**: 組み立てた overlays 下書きを、**書き込み前に**
   `validate` と同じ overlays 検査(`stages/validate.ts` の overlays 節)へ通す。
   1つでも不正(壊れた rect・尺超過・dangling file)なら**1バイトも書かない**
   (`apply` の思想)。全部 valid なら全書き込み。

## 2. 設計判断(なぜこの形か)

- **なぜ `overlays[]` 限定で `inserts[]` を後回しか**: inserts はタイムラインを尺ぶん
  ずらす(`at` 以降の keep・素材・テロップの時刻写像が動く)。cut のテンポ設計・出力尺・
  ショートの ranges に波及し、測定(D7)で cut 施策の効果と混ざる。overlays は既存映像の
  **上に重ねるだけ**で尺・時刻写像を動かさないため、cut と直交して単独評価できる。
  母艦の「1施策=1測定単位・効果を混ぜない」に整合。
- **なぜアンカー = keep span か(M4 の実体)**: 「素材が欲しい瞬間」を LLM に自由に
  言わせると時刻捏造の温床になる。カット後に**実際に残っている keep 区間**をスロットに
  すれば、時刻は常に実在の区間で、番号選択の安全網がそのまま効く。話題境界の細分化
  (章・大きな画面変化での分割)は将来の改善余地として §7 に回す(v1 は keep span 粒度)。
- **なぜ承認に触れないか**: overlays の編集は承認 hash を失効させない設計
  (CLAUDE.md)。素材配置は cut 決定を変えないので、承認済み cutplan の上に素材下書きを
  足しても承認は生きたまま。ここを跨ぐと承認モデルが壊れるので**絶対に approvals.json を
  書かない**。
- **なぜ `plan-shorts` を雛形にするか**: 「detect/既存の候補に番号 → LLM は番号集合だけ
  返す → コードが実体へ変換 → 下書き(未承認)を書く → 既存ありは --force+backup」という
  骨格が完全に一致する。パーサの堅牢さ・番号存在検証・backup 作法を流用できる。

## 3. 変更点の全体像(新規3 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/materialAnchors.ts`(新規・純関数) | keep span → アンカー候補 / 素材メタ → numbered list / placements → overlays 変換 |
| B | `src/stages/planMaterials.ts`(新規) | LLM 呼び出し・`renderMaterialsPrompt`(2リスト)・応答パース・`validateDocs` 検査付き下書き書き込み(fs 側) |
| B' | `src/stages/plan.ts`(1行変更) | `readRules` を `export function readRules` にする(B の `renderMaterialsPrompt` が rules 注入で再利用。**同名の重複実装を作らない**) |
| C | `prompts/plan-materials.md`(新規) | LLM プロンプト(番号選択の出力形式・素材/アンカーの提示形式) |
| D | `src/cli.ts` | `plan-materials <dir>` コマンド登録(`--force`・backup・非対話配慮) |
| E | `src/lib/config.ts` + `config.yaml` | `planMaterials` 設定(候補上限・最小 span 尺・既定 overlay 見た目) |
| F | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンドの説明・コマンド一覧へ追加 |
| G | テスト | `test/materialAnchors.test.ts`(純関数)+ パーサの堅牢性 |

**5点セット判断**: `overlays.json` の**スキーマは不変**(既存 `overlays[]` フィールドしか
書かない)。よって `src/types.ts` のコメント / `schemas/overlays.schema.json` /
`schemas/examples/overlays.max.json` は**変更不要**。`validate.ts` の overlays 検査は
既存を**流用**(新検査を足すなら追随)。**ただし CLI コマンドが増える**ので
**`AGENTS_CONTRACT.md` のコマンド一覧 + `test/agentsMd.test.ts` の網羅ピンは必ず更新**
(コマンド名を追加しないと `npm test` が落ちる)。

### A. `src/lib/materialAnchors.ts`(新規・純関数)

fs 非依存。plan-shorts の `numberSegments` と同じ「番号 → 実体」変換の純関数群。

```ts
import type { CutPlan, Interval, Overlays, Transcript } from "../types.ts";
import type { MaterialEntry, MaterialsIndex } from "./materials.ts";

/** 素材を出せるスロット。keep span をそのままアンカーにする(時刻は実在) */
export interface MaterialAnchor {
  id: number;                 // 1始まりの通し番号
  start: number;              // 元収録の秒(keep.start)
  end: number;                // 元収録の秒(keep.end)
  transcriptText: string;     // この span に実際に残る発話(候補の意味づけ。C8 と同じ思想)
}

/** LLM に見せる素材候補(materials.probe の実測メタだけ) */
export interface MaterialChoice {
  id: number;                 // 1始まりの通し番号
  file: string;               // 収録フォルダ相対
  kind: "video" | "image";    // present:false / "unknown" / "audio" は除外済み(MaterialKind は video|image|audio|unknown)
  durationSec?: number;       // 動画のみ。実尺(overlay の再生範囲 cap に使う)
  hasAudio?: boolean;
  ocrPreview?: string[];      // 素材内の画面文字(あれば)
  transcribePreview?: string; // 素材音声の発話(あれば)
}

/** LLM 応答の1配置。番号だけ(時刻・file は含めない) */
export interface Placement {
  anchorId: number;
  materialId: number;
  reason: string;
}

/** cutplan の keep span を時系列に並べてアンカー化。minSpanSec 未満の span は
 *  素材を置くには短すぎるので除外(タイル性は不要=アンカーは飛び飛びでよい)。
 *  transcriptText は candidateText(C8)と同じく「span 内に中点が入る語」だけを連結。 */
export function buildAnchors(
  cutplan: CutPlan,
  transcript: Transcript,
  minSpanSec: number,
): MaterialAnchor[] {
  // 実装ヒント:
  // - keeps = cutplan.segments.filter(s => s.action === "keep")、時系列順
  // - end - start >= minSpanSec のものだけ採用、1始まりで id を振る
  // - transcriptText は collectWords(transcript) から mid∈[start,end) の語を連結
  //   (words 無しなら overlap segment の全文にフォールバック)
  return []; // ← 実装する
}

/** materials.probe を LLM 候補へ。present:false(dangling)と kind:"unknown" は除外。
 *  参照済み(used:true)も候補に含めてよい(同じ素材を別区間へ再利用しうる)。 */
export function buildMaterialChoices(index: MaterialsIndex): MaterialChoice[] {
  // 実装ヒント: index.materials.filter(m => m.present && (m.kind==="video"||m.kind==="image"))
  // durationSec は m.probe?.durationSec、ocrPreview は m.ocr?.preview、
  // transcribePreview は m.transcribe?.preview。id は1始まり。
  return []; // ← 実装する
}

/** placements(番号ペア)を overlays[] エントリへ変換する純関数。
 *  - 存在しない anchorId / materialId は捨てる(番号選択の安全網)。
 *  - overlay の start/end はアンカーの実区間(LLM は触れない)。
 *  - 動画素材で実尺 < span 尺なら、end を start+実尺へ詰める(尺超過を作らない=M2 の芽)。
 *    画像素材は span いっぱい表示(尺の概念なし)。
 *  - 既定の見た目は cfg(volume=0 無音・fit=contain・rect は既定 PIP or 全画面)。
 *  - 同一 anchor に複数配置が来たら時間が重ならないよう間引く(先着優先)。 */
export function placementsToOverlays(
  placements: Placement[],
  anchors: MaterialAnchor[],
  choices: MaterialChoice[],
  cfg: MaterialPlacementCfg,
): NonNullable<Overlays["overlays"]> {
  return []; // ← 実装する
}

export interface MaterialPlacementCfg {
  minSpanSec: number;      // アンカーにする keep span の最小尺
  maxPlacements: number;   // 1回の生成で作る overlay の上限(出しすぎ防止)
  defaultVolume: number;   // 既定 0(無音。素材音を被せない)
  defaultFit: "contain" | "cover";
  defaultRect?: { x: number; y: number; w: number; h: number }; // 省略=全画面
}
```

**`placementsToOverlays` が返す overlay item の最小 valid 形**(`types.ts` の
`Overlays["overlays"][number]` に一致させる。**必須は `start`/`end`/`file` の3つだけ**、
他は任意):

```ts
// 全画面表示・無音の最小例(rect 省略=全画面)
{ start: 12.30, end: 15.80, file: "materials/demo.mp4", fit: "contain", volume: 0 }
// PIP(ワイプ)にするなら rect を付ける(cfg.defaultRect):
{ start: 12.30, end: 15.80, file: "materials/demo.mp4", fit: "contain", volume: 0,
  rect: { x: 640, y: 40, w: 600, h: 338 } }
```

- `id` は**付けなくてよい**(任意フィールド。番号は cut と違い overlays には不要。
  人間が editor で触るときに id-stamp される)。`track`/`opacity`/`startFrom`/
  `fadeInSec`/`fadeOutSec` も**書かない**(v1 は既定のまま)。余計なキーを足すと
  validate の未知キー警告や検査対象が増えるので、上の3〜5フィールドに絞る。
- `volume` は既存 validate 上 `0〜2`。画像素材に `volume`/`startFrom` を書くと
  validate が「無視される」警告を出すので、**画像素材には volume/startFrom を付けない**
  (`placementsToOverlays` 側で kind により出し分ける)。

> **タイル性は不要**: cut の候補格子(C1)と違い、アンカーは「素材を置ける飛び飛びの
> スロット」なので隙間があってよい。overlays は既存映像に重なるレイヤーで、覆っていない
> 区間はベース映像がそのまま出る(=何も起きない)だけ。ここが inserts との安全性の差。

### B. `src/stages/planMaterials.ts`(新規)

`plan-shorts.ts` と同じ骨格:
1. `cutplan.json` / `transcript.json` を読む。`materials.probe/index.json` を読む
   (無ければ §1-5 に従い exit 1 で告知)。素材候補が0件なら告知して終了。
2. `buildAnchors` / `buildMaterialChoices` で番号付き候補を作る。
3. **`renderMaterialsPrompt`(新規・下記)で2リスト(アンカー+素材)プロンプトを組む。**
   **`plan.ts` の既存 `renderPrompt` は流用しない**(重要): `renderPrompt` は
   `numbered: NumberedSegment[]` **1本**を `{{segments}}` に流すだけの関数で、
   アンカーと素材の**2リストを渡す口が無い**。よって専用関数を新設する:

   ```ts
   // planMaterials.ts 内(または materialAnchors.ts の純関数として切り出してテスト)
   // rules / brief 注入は plan.ts と揃える。readRules は現状 plan.ts の非公開関数
   // なので、plan.ts で `export function readRules` に変えて再利用する(小変更)。
   function renderMaterialsPrompt(
     dir: string,
     anchors: MaterialAnchor[],
     choices: MaterialChoice[],
   ): string {
     const anchorLines = anchors
       .map((a) => `#${a.id} [${a.start.toFixed(2)}-${a.end.toFixed(2)}] ${a.transcriptText || "(発言なし)"}`)
       .join("\n");
     const materialLines = choices
       .map((c) => {
         const dur = c.durationSec !== undefined ? `${c.durationSec.toFixed(1)}s` : "画像";
         const au = c.hasAudio ? "音声あり" : "音声なし";
         const ocr = c.ocrPreview?.length ? ` / 画面文字: ${c.ocrPreview.join(" ")}` : "";
         const tr = c.transcribePreview ? ` / 発話: ${c.transcribePreview}` : "";
         return `#${c.id} ${c.kind} ${dur} ${au}${ocr}${tr}`;
       })
       .join("\n");
     const rules = readRules(dir); // plan.ts から export して再利用
     const briefPath = join(dir, "brief.md");
     const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8")
       : "(見せ場リストなし)";
     const template = readFileSync(join(repoRoot, "prompts", "plan-materials.md"), "utf8");
     return template
       .replaceAll("{{anchors}}", () => anchorLines)
       .replaceAll("{{materials}}", () => materialLines)
       .replaceAll("{{rules}}", () => rules)
       .replaceAll("{{brief}}", () => brief);
     // ↑ replaceAll + 関数形式は plan.ts と同じ理由($& 等の誤解釈回避)
   }
   ```

4. `completeWithJsonSchema(prompt, cfg, { name, strict, schema }, "other")` で
   `{ placements: [...] }` を得る。**`purpose` は `"other"` を渡す**(既存 union は
   `"plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other"` で
   `"plan-materials"` は無い。v1 は llm.ts の型面を触らず `"other"` で済ませる。
   telemetry を分けたくなったら別途 union へ追加)。schema は
   `{ placements: [{ anchorId:int, materialId:int, reason:string }] }` を `strict: true` で。
   生応答は `plan-materials.raw.txt` へ(plan.raw.txt と同じ用途の中間生成物)。
5. `parsePlacements`(plan-shorts の parseResponse と同じ堅牢さ: 最初の`{`〜最後の`}`、
   壊れたフィールドは握りつぶし後段の番号検証に委ねる)。
6. `placementsToOverlays` で overlays[] を組む。**既存 `overlays.json` の他フィールド
   (`inserts`/`wipeFull`/`zooms`/`blurs`/`annotations`/`captionTracks`/`layerOrder`/
   `colorFilter`)は保持**し、`overlays[]` 配列だけ差し替え or 追記(既定は差し替え。
   `--append` で追記できるとなおよいが v1 は差し替えで可)。
7. **書き込み前に** `stages/validate.ts` の**純関数 `validateDocs(dir, docs, [])`**
   へ通す(§1-6)。組んだ overlays を既存 docs に merge した `LoadedDocs` を作り、
   `validateDocs` の返り値 `errors` が**空のときだけ**書く。overlays[] item の検査は
   既存の overlays 節が流用される(§A の下に最小 valid item を明示)。全 valid なら
   `guardRerun`/`backupEditableFiles` で `backups/` へ退避 → `overlays.json` を書く。
   1つでも `errors` があれば書かず、その `errors` を stdout に表示して exit 1。
8. stdout に要約(何区間へ何素材を、理由付きで)。

> **中間生成物の登録**: `plan-materials.raw.txt` は `plan.raw.txt` / `plan-shorts.raw.txt`
> と同じ「LLM 生応答の記録」。`src/lib/files.ts` の `GENERATED_FILES` に追加し、
> CLAUDE.md / AGENTS_CONTRACT の中間生成物一覧にも並べる(触るなリスト)。

### C. `prompts/plan-materials.md`(新規)

`prompts/plan-shorts.md` に倣う。骨子:
- 役割: 「編集済みタイムラインの各区間(アンカー)に、手持ち素材から**合うものだけ**を
  控えめに配置する。無理に全区間へ置かない」。
- 入力提示: アンカー一覧(`#id [start-end] 発話テキスト`)+ 素材一覧
  (`#id kind 実尺 音声有無 / 画面文字プレビュー / 発話プレビュー`)。
- 出力形式: `{ "placements": [{ "anchorId": N, "materialId": M, "reason": "..." }] }`
  **番号だけ**。時刻・ファイル名を書かない旨を明記。
- ガイド: 話題と素材内容(OCR/発話)が一致するものを優先 / 装飾目的の乱貼りを避ける /
  `rules.md`(チャンネルの型)を尊重。
- **テンプレのプレースホルダは `renderMaterialsPrompt`(§B-3)に合わせて
  `{{anchors}}` / `{{materials}}` / `{{rules}}` / `{{brief}}` の4つ**。
  `renderPrompt` の `{{segments}}` は使わない(2リスト構成なので別トークン)。

### D. `src/cli.ts`

`plan-shorts` の登録箇所に倣って `plan-materials <dir>` を追加:
- `--force`(既存 overlays 上書き時に必須。無ければエラーで停止)。
- 非対話配慮は不要(plan-shorts と同じく承認は絡まない。ただし --force の破壊性は
  backup で担保)。
- `--append`(任意・v1 は省略可): 既存 `overlays[]` を消さず追記。

### E. `src/lib/config.ts` + `config.yaml`

`resolveMaterialPlacementCfg(cfg)` を追加(perception/candidates と同じ「未指定は既定」):

```yaml
# 素材(B-roll)配置候補の自動生成(plan-materials)。要 materials <dir> --all の事前実行。
# 生成物は下書き(overlays[])で、採否は人間。cut/承認には触れない。
planMaterials:
  minSpanSec: 3.0        # 素材を置けるアンカーにする keep span の最小尺
  maxPlacements: 8       # 1回で作る overlay の上限(出しすぎ防止)
  defaultVolume: 0       # 素材音は既定で被せない(0=無音)
  defaultFit: contain
  # defaultRect: { x: 640, y: 40, w: 600, h: 338 }  # 省略=全画面。指定で PIP(ワイプ)
```

### F. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `plan-materials` の使い方(前提 = `materials --all`、番号選択、下書き・
  人間承認、cut/承認非干渉、--force+backup)を1節追記。
- `AGENTS_CONTRACT.md`: コマンド一覧に `plan-materials` を追加。中間生成物一覧に
  `plan-materials.raw.txt` を追加。**`test/agentsMd.test.ts` がこれらをピン留めするので
  必ず両方揃える**(片方だけだと `npm test` が落ちる)。

## 4. テスト(`test/materialAnchors.test.ts` 新規)

純関数中心に固定する:
- **buildAnchors**: keep span だけをアンカー化(cut span は除外)/ minSpanSec 未満を除外 /
  id が1始まり連番 / transcriptText が span 内の語だけ(C8 と同じ非重複)。
- **buildMaterialChoices**: present:false(dangling)を除外 / kind unknown を除外 /
  used:true でも候補に残る / durationSec・ocrPreview・transcribePreview の引き回し。
- **placementsToOverlays(核)**:
  - 存在しない anchorId / materialId を捨てる(番号選択の安全網)。
  - overlay の start/end がアンカーの実区間と一致(LLM 値を混ぜない)。
  - 動画実尺 < span 尺 → end が start+実尺へ詰まる(**尺超過を作らない**)。
  - 画像素材 → span いっぱい。
  - 同一 anchor への重複配置が時間衝突しないよう間引かれる。
  - maxPlacements で打ち切られる。
- **parsePlacements の堅牢性**: コードフェンス/前後説明混在から JSON を拾う /
  placements 欠如→空 / anchorId・materialId が数値でない要素を落とす。
- **既存フィールド保持**: overlays[] 差し替え時に inserts/zooms/blurs 等が消えない
  (planMaterials の組み立て純関数を切り出して単体で確認、or 結合テスト)。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(素材を持つ収録1本。無ければ `materials/` に短い動画/画像を数点置く):
  1. `node src/cli.ts materials <dir> --all` で `materials.probe/index.json` を作る。
  2. `node src/cli.ts plan-materials <dir>`(overlays.json 無し)→ 下書きが書かれる。
     `describe <dir>` / `describe --json` の overlays 射影に配置が出ることを確認。
  3. `node src/cli.ts validate <dir>` がエラー無し(尺超過・dangling file が無い)。
  4. `node src/cli.ts frames <dir> --t <配置区間の秒>` で素材が実際に見えることを目視。
  5. 既存 overlays.json があるフォルダで `--force` 無し→エラー停止、`--force`→
     `backups/` へ退避後に上書き、を確認。
  6. `materials.probe` 未生成のフォルダ→「先に materials を実行」で exit 1(例外でない)。
- **完了報告は実測ログ付き**(母艦の運用: 完了報告は必ず実測検証)。
- **測定の注意(母艦の学び)**: `plan-materials` は LLM 出力=非決定的。**単発 diff で
  配置品質を採点しない**。決定論部分(アンカー生成・尺 cap・参照整合)はテストで固定し、
  配置の当否(話題と素材の一致)は人間が `frames`/preview で見て `material-mismatch` タグで
  scorecard に記録する(`memory/precision-measurement-nondeterminism-wall.md`)。

## 6. 受け入れ基準

- LLM 出力が番号ペアだけで、時刻・file・尺を含まない(プロンプト+スキーマで強制)。
- 存在しない番号・dangling 素材が配置に化けない(テストで固定)。
- 生成 overlay の尺が素材実尺を超えない(尺超過ゼロ)。
- `cutplan.json` / `approvals.json` に一切書き込まない(cut・承認不変)。
- 既存 overlays.json は `--force` 必須+実行前 `backups/` 退避。他フィールド保持。
- `materials.probe` 未生成/素材0件で例外を投げず告知して停止。
- 書き込み前検査で1つでも不正なら1バイトも書かない(all-or-nothing)。
- `AGENTS_CONTRACT.md` にコマンド追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **M2(尺整合の自動補正)**: 本書は「候補を作るとき」実尺で cap するだけ。**既存の**
  overlays/inserts の尺乖離を検出して `startFrom`/尺の補正候補を出すのは M2。
- **M3(dangling→patch 橋渡し)**: 未使用素材の配置提案・dangling 参照の修正提案を
  `apply` patch へ繋ぐ。本書は materials の**存在するもの**を新規配置するところまで。
- **inserts[](タイムラインシフト挿入)**: cutaway として尺を足す配置は、cut テンポ・
  出力尺・承認スコープ(inserts も承認 hash 非失効だが尺写像は動く)への影響を別途
  設計してから。v1 の overlays 限定で素材配置の基盤と測定を固めてから起こす。
- **アンカーの細分化**: v1 は keep span 粒度。章境界・大きな画面変化・話題転換での
  サブアンカー化は、cut の C1(語境界細分化)と同じ発想で将来改善できる。
- **H(ハーネス)との接続**: 将来 pull 型知覚(H1)を素材配置へ広げるなら、判断 LLM に
  `materials --frames/--ocr` を tool として引かせる経路がありうる。本書は単発 completion。
- 素材の基盤が固まったら、母艦 §7 の残り **BGM(B)/ 演出(E)** も同じ番号選択方式で起こす。
```
