# 実装設計書 SD-E1: E1(演出アンカー候補)+ E2(種別選択器)— zoom/blur/annotation の番号選択生成

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§4「演出トラック」/ §7。
> 素材(M)の型が固まった後の**演出(E)最初の設計書**。実装担当(弱いモデル想定)がそのまま
> 着手できる粒度に落とす。**E1(演出アンカーの候補化)+ E2(演出種別の選択器)だけが対象**。
> E3(座標視覚検証)・E4(zoom 相互作用)・E5(密度ガード)は **SD-E2**(別書)。
>
> **前提となる確定方針(母艦 §2 原則4 / §6):** AI は**列挙された候補から番号で選ぶ**。
> 演出でこれが特に重要なのは、**座標(rect / from-to)を LLM に書かせると必ず的を外す**から
> (母艦 §3.4「座標は valid だが対象を外す」)。**矩形は知覚が検出した実在領域から取り、LLM は
> 「どのアンカーに・どの種別を」だけを選ぶ**。cut / 素材とは独立の軸。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **E1(演出アンカーの候補生成)**: カット後タイムラインを走査し、「演出したい瞬間 × その対象矩形」を
  **決定論的に列挙**する。ソースは3つ:
  - **画面 OCR**(`frames/*.ocr.json` の `lines[].box`。出力px座標)→「寄る/隠す/指す」対象の実矩形。
  - **動き**(`av.probe/motion.json` の `sceneScore`・`frozen`)→ 大きな画面変化=寄る/指す候補時刻。
  - **transcript**(発話)→ そのアンカーの意味づけ(C8 と同じ「実残存語」)。
  各アンカーは `{ id, start, end, rect, source, text }` で、**rect は知覚由来の実座標**(LLM は触らない)。
- **E2(演出種別の選択器)**: LLM に (アンカー番号 × 種別) を選ばせる。種別は
  **`zoom`(詳細を見せる)/ `blur`(隠す)/ `annotation`(注視誘導=box)/ `none`(何もしない)**。
  コードが選択を `overlays.json` の `zooms[]` / `blurs[]` / `annotations[]`(box)エントリへ変換し、
  **下書き**として書く。座標はアンカーの rect、時刻はアンカーの実区間。
- 生成物は**全て人間レビュー前提**。overlays は承認スコープ外なので approvals.json に触れない。

**本書でやらないこと(混同禁止):**
- **座標・時刻を LLM に生成させない。** rect はアンカー(OCR box / scene region)から、start/end も
  アンカーから。LLM 出力は番号と種別だけ(母艦 §3.4「座標を書かせると外す」の直接対策)。
- **arrow / spotlight は v1 で生成しない。** annotation は **box(囲み)に限定**する(arrow は from/to の
  2点、spotlight は dim 等パラメタが増え、番号選択で安全に決めにくい)。box は rect 1つ=アンカー矩形を
  そのまま使えて最も安全。arrow/spotlight は §7。
- **zoom の相互作用チェック・座標視覚検証・密度ガードはしない**(SD-E2)。本書は候補を**作る**まで。
  ただし**書く前検査**で validate の zoom 重なり禁止・blur 画面外エラーは通す(§1-6)。
- **cut / cutplan.json / approvals.json を触らない。** アンカーは cutplan を**読む**だけ。
- **自動で本番配置しない**(下書き。採否は人間)。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **番号+種別選択のみ(最重要)**: LLM 出力は `decisions: [{anchorId, effect: "zoom"|"blur"|"annotation"|"none",
   reason}]` **だけ**。`rect`・`start`・`end`・色・強度を LLM に書かせない。番号→実体への変換と存在しない
   番号の無視は**すべてコード側**(SD-M1 の `placementsToOverlays` と同じ堅牢さ)。
2. **rect は知覚由来**: zoom.rect / blur.rect / box.rect は、選ばれたアンカーの `rect`(OCR box または
   scene 変化領域)から取る。**LLM 値を混ぜない**。rect が無いアンカー(発話のみ由来)は zoom/blur/box の
   対象にできない → そのアンカーは種別 `none` 相当として扱う(または候補から除外)。
3. **cut 不変**: cutplan.json は読むだけ。アンカー時刻は keep 区間内の実時刻。承認 hash に影響しない。
4. **知覚メタは実測から**: OCR box・sceneScore は既存の知覚生成物(`frames --ocr` / `av`)から取る。
   **知覚が無い/古いときは告知して exit 1**(§1-6)。存在しない領域を演出対象に化けさせない。
5. **opt-in / 非破壊**: 既存 `overlays.json` の `zooms`/`blurs`/`annotations` があるときは `--force` 必須。
   実行前に `overlays.json` を `backups/<日時>/` へ退避してから上書き(`plan-shorts` と同じ作法)。
   **他フィールド(overlays[]/inserts/wipeFull/captionTracks/layerOrder/colorFilter/hideCaption)は保持**し、
   `zooms`/`blurs`/`annotations` 配列だけ差し替え。
6. **書く前に検査(all-or-nothing)**: 組んだ演出下書きを、**書き込み前に**純関数
   `validateDocs(dir, docs, [])`(`stages/validate.ts`)へ通す。zoom の**重なり禁止(エラー)**・
   blur の**画面外(エラー)**・annotation の型/座標検査は既存が効く。`errors` が空のときだけ書く。
   1つでも不正なら1バイトも書かない(SD-M1 と同じ思想)。

## 2. 設計判断(なぜこの形か)

- **なぜ「アンカー×種別」の2段か**: 母艦 §3.4.2 の示唆「演出は『何をするか』と『どこへ置くか』を
  分ける必要がある」の直接実装。対象矩形(どこ)は知覚が決め、種別(何を)だけ LLM が選ぶ。
  こうすると座標のハルシネーションが構造的に起きない。
- **なぜ rect を知覚から取るか**: 母艦 §3.4 が繰り返す最大の失敗が「座標 valid だが対象外」。
  OCR box は「その瞬間に画面のどこに何の文字があるか」の実座標で、`frames --ocr` の box は
  **本編 screenRegion 出力px**=zoom/blur/annotation の rect と同じ座標系(CLAUDE.md)。無変換で使える。
- **なぜ annotation を box 限定か**: box は rect 1つで表せてアンカー矩形を直接使える。arrow は from/to の
  2点(「どこから指すか」は知覚に無い)、spotlight は dim/feather を決める必要があり、番号選択の枠に
  収まりにくい。安全優先で box に絞り、arrow/spotlight は検証基盤(SD-E2)が入ってから。
- **なぜ zoom の重なり禁止をここで守るか**: validate は zoom 区間の重なりを**エラー**にする
  (`validate.ts:562-570`)。複数アンカーに zoom が付くと衝突しうるので、`decisionsToOverlays` 側で
  zoom は時間衝突しないよう間引く(先着優先)。blur/annotation は重なり可(validate はエラーにしない)。
- **なぜ `plan-shorts`/SD-M1 を雛形にするか**: 「知覚から候補に番号 → LLM は番号+種別だけ返す →
  コードが実体へ変換 → 下書き → 既存ありは --force+backup」の骨格が完全一致。

## 3. 変更点の全体像(新規3 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/effectAnchors.ts`(新規・純関数) | OCR/motion/transcript → 演出アンカー候補 / decisions → zooms・blurs・annotations 変換 |
| B | `src/stages/planEffects.ts`(新規) | 知覚生成物を読む・`renderEffectsPrompt`(アンカー1リスト)・応答パース・`validateDocs` 検査付き下書き書き込み |
| C | `prompts/plan-effects.md`(新規) | LLM プロンプト(番号+種別選択の出力形式・アンカー提示形式・種別の使い分け) |
| D | `src/cli.ts` | `plan-effects <dir>` コマンド登録(`--force`・backup) |
| E | `src/lib/config.ts` + `config.yaml` | `planEffects` 設定(候補上限・最小 scene score・zoom rect の最小サイズ) |
| F | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンド説明・一覧追加・`plan-effects.raw.txt` を GENERATED_FILES へ |
| G | テスト | `test/effectAnchors.test.ts`(純関数)+ パーサ堅牢性 |

**5点セット判断**: `overlays.json` の**スキーマは不変**(既存 `zooms`/`blurs`/`annotations` フィールドしか
書かない)。`types.ts`/`schemas/*` は変更不要。`validate.ts` の演出検査は既存を流用。**CLI コマンドが増える**ので
`AGENTS_CONTRACT.md` のコマンド一覧 + `plan-effects.raw.txt`(GENERATED_FILES)+ `test/agentsMd.test.ts` を更新。

### A. `src/lib/effectAnchors.ts`(新規・純関数)

```ts
import type { CutPlan, Overlays, Region, Transcript } from "../types.ts";

/** 演出を置ける候補。rect は知覚由来の実矩形(LLM は触らない)。 */
export interface EffectAnchor {
  id: number;                       // 1始まりの通し番号
  start: number;                    // 元収録の秒(アンカー時刻の前後に窓を張る)
  end: number;                      // 元収録の秒
  rect?: Region;                    // 出力px。OCR box / scene 変化領域。無い(発話のみ)アンカーもある
  source: "ocr" | "motion" | "speech";
  text: string;                     // OCR テキスト or 実残存発話(意味づけ)
}

/** LLM が返す1判断。番号+種別だけ(座標・時刻・色は含めない)。 */
export interface EffectDecision {
  anchorId: number;
  effect: "zoom" | "blur" | "annotation" | "none";
  reason: string;
}

/** OCR サイドカー・motion レポート・transcript から演出アンカーを決定論生成する。
 *  - OCR 由来: frames/out<秒>s.ocr.json の各 line を、box が十分大きいものだけ採用
 *    (小さすぎる文字は演出対象にしない)。rect=line.box、text=line.text、source="ocr"。
 *  - motion 由来: motion.json の sceneScore が cfg.minSceneScore 超のタイル時刻。
 *    rect は無し(画面全体の変化=種別 zoom/annotation の対象にはできないが「ここで何か起きる」
 *    合図)。frozen 区間も候補(長い静止=退屈カット/寄り どちらの判断材料にもなる)。
 *  - speech 由来: 長い keep 内で強調語がある区間(v1 は簡易でよい)。rect 無し=種別 none 寄り。
 *  time 窓は cfg.anchorWindowSec。重複時刻はマージ。id は1始まり。 */
export function buildEffectAnchors(
  cutplan: CutPlan,
  transcript: Transcript,
  ocrSidecars: OcrSidecar[],
  motion: MotionLike | null,
  cfg: EffectPlacementCfg,
): EffectAnchor[] {
  return []; // ← 実装する
}

/** decisions(番号+種別)を overlays の zooms/blurs/annotations へ変換する純関数。
 *  - 存在しない anchorId は捨てる(番号選択の安全網)。
 *  - effect==="none" は何も生成しない。
 *  - rect が無いアンカーへ zoom/blur/annotation が来たら**捨てる**(座標が無いので安全に置けない)。
 *  - zoom: { start, end, rect }。**時間衝突する zoom は先着優先で間引く**(validate は zoom 重なりをエラー)。
 *          rect が cfg.minZoomRect より小さいと拡大しすぎるので、最小サイズへ広げる or 捨てる。
 *  - blur: { start, end, rect, type, strength }(type/strength は cfg 既定)。
 *  - annotation: box のみ { type:"box", start, end, rect }(色・太さは省略=既定)。 */
export function decisionsToOverlays(
  decisions: EffectDecision[],
  anchors: EffectAnchor[],
  cfg: EffectPlacementCfg,
): Pick<Overlays, "zooms" | "blurs" | "annotations"> {
  return {}; // ← 実装する
}

export interface OcrSidecar { atSec: number; lines: { text: string; box: Region }[]; }
export interface MotionLike { motion: { sourceSec: number; sceneScore: number }[]; frozen: { outSec: number; lenSec: number }[]; }

export interface EffectPlacementCfg {
  maxDecisions: number;        // 1回で作る演出の上限(出しすぎ防止)
  anchorWindowSec: number;     // アンカー時刻の前後に張る窓(zoom/blur の表示尺)
  minSceneScore: number;       // motion アンカーにする sceneScore 下限
  minOcrBoxAreaPx: number;     // OCR box をアンカーにする最小面積(小さい文字を除外)
  minZoomRect: { w: number; h: number }; // zoom rect の最小サイズ(拡大しすぎ防止)
  defaultBlurStrength: number; // blur の既定強度(0..1)
}
```

**生成 item の最小 valid 形**(`types.ts` の各型に一致):

```ts
// zoom(重ならないこと):
{ start: 30.0, end: 33.0, rect: { x: 400, y: 120, w: 900, h: 500 } }
// blur(type/strength 省略可=既定 blur/0.5):
{ start: 45.0, end: 48.0, rect: { x: 100, y: 600, w: 320, h: 40 }, type: "blur", strength: 0.5 }
// annotation は box に限定(色・太さ省略=既定):
{ type: "box", start: 12.0, end: 15.0, rect: { x: 500, y: 200, w: 400, h: 120 } }
```

- `id` は付けなくてよい(任意。人間が editor で id-stamp する)。`keyframes`/`easeSec`/`color` 等は書かない(既定)。
- rect が画面外にはみ出す blur は validate が**エラー**にする → `decisionsToOverlays` で出力解像度内へ
  clamp する(cfg に outW/outH を渡す。renderProps の解像度から取る)。annotation のはみ出しは警告どまり
  だが、box も clamp して素直に画面内へ収める。

### B. `src/stages/planEffects.ts`(新規)

`plan-shorts.ts` / SD-M1 と同じ骨格:
1. `cutplan.json` / `transcript.json` を読む。`frames/*.ocr.json` と `av.probe/motion.json` を読む。
   **どちらも無い(=知覚が未生成)なら** 「先に `frames <dir> --every N --ocr` と `av <dir>` を実行せよ」と
   告げて exit 1(§1-4)。OCR/motion のどちらか一方でもあれば続行。
2. `buildEffectAnchors` で番号付きアンカーを作る。0件なら告知して終了。
3. **`renderEffectsPrompt`(新規)でアンカー1リストのプロンプトを組む**(SD-M1 の `renderMaterialsPrompt`
   と同じ作法。`readRules`(plan.ts から export 済み=SD-M1 で対応)と brief を注入):

   ```ts
   function renderEffectsPrompt(dir: string, anchors: EffectAnchor[]): string {
     const lines = anchors
       .map((a) => {
         const box = a.rect ? `[${a.rect.x},${a.rect.y} ${a.rect.w}x${a.rect.h}]` : "(領域なし)";
         return `#${a.id} [${a.start.toFixed(1)}-${a.end.toFixed(1)}] ${a.source} ${box} ${a.text || ""}`.trim();
       })
       .join("\n");
     const rules = readRules(dir);            // plan.ts から export(SD-M1 で対応済み)
     const brief = existsSync(join(dir, "brief.md")) ? readFileSync(join(dir, "brief.md"), "utf8") : "(見せ場リストなし)";
     const template = readFileSync(join(repoRoot, "prompts", "plan-effects.md"), "utf8");
     return template
       .replaceAll("{{anchors}}", () => lines)
       .replaceAll("{{rules}}", () => rules)
       .replaceAll("{{brief}}", () => brief);
   }
   ```

4. `completeWithJsonSchema(prompt, cfg, { name, strict, schema }, "other")` で `{ decisions: [...] }` を得る。
   **`purpose` は `"other"`**(union に `plan-effects` は無い。v1 は llm.ts の型面を触らない=SD-M1 と同判断)。
   schema は `{ decisions: [{ anchorId:int, effect:enum["zoom","blur","annotation","none"], reason:string }] }` を
   `strict: true`。生応答は `plan-effects.raw.txt` へ。
5. `parseDecisions`(SD-M1 の parse と同じ堅牢さ: 最初の`{`〜最後の`}`、壊れた要素は握りつぶし後段検証へ)。
6. `decisionsToOverlays` で `zooms`/`blurs`/`annotations` を組み、既存 overlays の**他フィールドは保持**して
   この3配列だけ差し替え。
7. **書き込み前に** `validateDocs(dir, docs, [])`(§1-6)。`errors` が空のときだけ `guardRerun`/
   `backupEditableFiles` で backup → `overlays.json` を書く。1つでもあれば書かず stdout に出して exit 1。
8. stdout に要約(何秒へ zoom/blur/box を、理由付きで)。

> **中間生成物の登録**: `plan-effects.raw.txt` を `GENERATED_FILES` に追加(plan.raw.txt と同カテゴリ)。

### C. `prompts/plan-effects.md`(新規)

`prompts/plan-shorts.md` に倣う。骨子:
- 役割:「編集済みタイムラインのアンカー(演出候補)ごとに、**必要なものだけ**種別を選ぶ。
  多くは `none`。演出は見せ場・秘匿・注視誘導が要る所だけ」。
- 入力提示: アンカー一覧(`#id [start-end] source [x,y wxh] text`)。**座標は既に決まっている**旨を明記。
- 種別の使い分け:`zoom`=画面の詳細を大きく見せる / `blur`=秘匿情報(APIキー・PII)を隠す /
  `annotation`(box)=「ここを見ろ」の囲み / `none`=何もしない(既定・大半はこれ)。
- 出力形式: `{ "decisions": [{ "anchorId": N, "effect": "zoom|blur|annotation|none", "reason": "..." }] }`。
  **座標・時刻・色を書かない**旨を明記。
- ガイド: 演出の乱発を避ける(母艦 E5 の思想を先取り)/ `rules.md` を尊重。
- **プレースホルダは `{{anchors}}` / `{{rules}}` / `{{brief}}`**(`renderPrompt` の `{{segments}}` は使わない)。

### D. `src/cli.ts`

`plan-shorts` に倣って `plan-effects <dir>`:
- `--force`(既存 zooms/blurs/annotations 上書き時に必須)。
- 承認は絡まない(演出は承認スコープ外)。

### E. `src/lib/config.ts` + `config.yaml`

`resolveEffectPlacementCfg(cfg)`(未指定は既定):

```yaml
# 演出(zoom/blur/annotation)候補の自動生成(plan-effects)。
# 要 frames --ocr / av の事前実行。生成物は下書きで、採否は人間。cut/承認に触れない。
planEffects:
  maxDecisions: 6          # 1回で作る演出の上限
  anchorWindowSec: 3.0     # アンカー時刻の前後に張る表示窓
  minSceneScore: 0.4       # motion アンカーにする sceneScore 下限
  minOcrBoxAreaPx: 8000    # OCR box をアンカーにする最小面積(小さい文字を除外)
  minZoomRect: { w: 480, h: 270 }  # zoom rect の最小サイズ(拡大しすぎ防止)
  defaultBlurStrength: 0.5
```

### F. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `plan-effects` の使い方(前提 = `frames --ocr` / `av`、番号+種別選択、座標は知覚由来、
  下書き・人間承認、cut/承認非干渉、--force+backup)を1節。
- `AGENTS_CONTRACT.md`: コマンド一覧に `plan-effects`、中間生成物へ `plan-effects.raw.txt`。
  **`test/agentsMd.test.ts` がピン留めするので揃える**。

## 4. テスト(`test/effectAnchors.test.ts` 新規)

- **buildEffectAnchors**: OCR box が小さすぎる行を除外(minOcrBoxAreaPx)/ sceneScore 下限で motion アンカー /
  rect がある/無いアンカーの source 別付与 / id が1始まり連番 / cut span からはアンカーを作らない。
- **decisionsToOverlays(核)**:
  - 存在しない anchorId を捨てる。
  - rect の無いアンカーへの zoom/blur/annotation を捨てる(座標が無いので置けない)。
  - effect="none" は何も生成しない。
  - **時間衝突する zoom を先着優先で間引く**(validate の zoom 重なりエラーを未然に防ぐ)。
  - zoom rect が minZoomRect 未満→拡大 or 除外。
  - blur/box の rect が出力解像度外→ clamp。
  - maxDecisions で打ち切り。
- **parseDecisions の堅牢性**: コードフェンス混在から JSON を拾う / decisions 欠如→空 /
  anchorId が数値でない・effect が enum 外の要素を落とす。
- **既存フィールド保持**: zooms/blurs/annotations 差し替え時に overlays[]/inserts/captionTracks 等が消えない。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(画面キャプチャを含む収録1本):
  1. `node src/cli.ts frames <dir> --every 10 --ocr` と `node src/cli.ts av <dir>` で知覚を作る。
  2. `node src/cli.ts plan-effects <dir>`(zooms/blurs/annotations 無し)→ 下書きが書かれる。
     `describe --json` の zooms/blurs/annotations 射影に出ることを確認。
  3. `node src/cli.ts validate <dir>` がエラー無し(zoom 重なり無し・blur 画面外無し)。
  4. `node src/cli.ts frames <dir> --t <演出区間の秒>` で zoom/blur/box が実際に効いて見えることを目視。
  5. 既存 overlays.json の演出があるフォルダで `--force` 無し→エラー停止、`--force`→ backup 後上書き。
  6. 知覚(OCR/motion)未生成のフォルダ→「先に frames --ocr / av」で exit 1(例外でない)。
- **完了報告は実測ログ付き**。
- **測定の注意**: `plan-effects` の LLM 出力は非決定的。**単発 diff で演出品質を採点しない**。
  決定論部分(アンカー生成・rect 由来・zoom 重なり間引き・clamp)はテストで固定し、演出の当否
  (種別選択・対象の妥当性)は人間が `frames`/preview で見て `effect-mismatch` タグで scorecard に記録
  (`memory/precision-measurement-nondeterminism-wall.md`)。座標の視覚検証は **SD-E2(E3)** の仕事。

## 6. 受け入れ基準

- LLM 出力が番号+種別だけで、座標・時刻・色を含まない(プロンプト+スキーマで強制)。
- 生成 zoom が互いに重ならない(validate の zoom 重なりエラーを一切出さない)。
- 生成 blur/box が出力解像度内に収まる(blur 画面外エラーゼロ)。
- rect の無いアンカーへ zoom/blur/annotation が化けない(テストで固定)。
- annotation は box のみ(arrow/spotlight を生成しない)。
- `cutplan.json` / `approvals.json` に一切書き込まない。既存 overlays の他フィールドを保持。
- 知覚未生成/アンカー0件で例外を投げず告知して停止。
- 書き込み前検査で1つでも不正なら1バイトも書かない。
- `AGENTS_CONTRACT.md` にコマンド追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **E3(座標の視覚検証)/ E4(zoom 相互作用)/ E5(密度ガード)= SD-E2**: 本書が作った演出下書きを
  before/after still + deterministic + VLM で検証し、字幕/UI/素材との重なり・zoom 追従ズレ・過剰密度を
  検出する。本書は「作る」まで、SD-E2 が「検品する」。
- **arrow / spotlight の生成**: box より座標・パラメタが多い。SD-E2 の視覚検証が入ってから、
  arrow は「OCR box → その手前の余白から指す」等の決定論規則で from/to を出す拡張として起こす。
- **zoom の rect 精密化**: v1 は OCR box をそのまま zoom rect にする。実際は「box を含む見やすい構図」へ
  少し広げる整形が要る(C9 の複数時点 OCR と合わせると精度が上がる)。
- **H(ハーネス)との接続**: 将来 pull 型知覚(H1)を演出へ広げるなら、判断 LLM に `frames --ocr` を
  tool として引かせ、迷ったアンカーだけ実画像を見て種別を選ぶ経路がありうる。本書は単発 completion。
- 演出の基盤が固まったら、母艦 §7 の残り **BGM(B)** も同じ番号選択方式で起こす(SD-B1)。
</content>
