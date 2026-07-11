# 実装設計書 SD-E2: E3(座標視覚検証)+ E4(zoom 相互作用)+ E5(密度ガード)— 演出の検品

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§4「演出トラック」/ §7。
> 前段: **SD-E1**(`2026-07-11-e1-e2-effect-anchor-candidates-design.md`)= zoom/blur/annotation を**作る**。
> 本書はその続きで、作られた(または人間が書いた)演出を**検品する**。実装担当(弱いモデル想定)が
> そのまま着手できる粒度に落とす。**E3(座標の視覚検証)+ E4(zoom 相互作用)+ E5(密度ガード)が対象**。
>
> **前提となる確定方針(母艦 §3.4):** 「座標が valid でも対象を外している」が演出の最大の失敗。
> 検品は**まず決定論**(重なり・密度・画面外・zoom 追従ズレ)で機械検出し、**次に VLM**(あれば)で
> 「隠せているか/指せているか/邪魔でないか」を見る。VLM が無くても決定論チェックは必ず成立する。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **E4(zoom と固定px演出の相互作用チェック)= 決定論**: `blurs`/`annotations` は出力px固定で zoom に
  追従しない(types.ts / CLAUDE.md)。**既存の validate は blur×zoom の時間重なりのみ警告**
  (`validate.ts:611-618`)。本書は **annotation×zoom の時間重なり**も同じ警告に昇格し、さらに
  「zoom 中に固定px演出があると、隠したい/指したい場所がズレる」を**具体的な補正候補**
  (zoom を外す / rect を広げる / annotation を zoom 後へずらす)として出す。
- **E5(演出密度ガード)= 決定論**: 単位時間あたりの演出本数が多すぎる / annotation の表示尺が長すぎる /
  見せ場(brief/chapters)以外での多用を検出する。`validate`(または新 `effect-check`)の警告にする。
- **E3(座標の視覚検証)= 決定論 + VLM**: 追加/変更した zoom/blur/annotation の **before/after still を
  必ず撮り**(既存 `frames` 経路)、決定論で「字幕(caption pos)・既存演出・素材 rect との重なり」を
  チェックし、VLM(`ai.routes.vision`)があれば still を見せて「秘匿箇所を覆えているか/指す先が合って
  いるか/邪魔でないか」を問う。**VLM 不在時は決定論チェックだけで完結**(優雅に劣化)。
- 出力は**検品レポート**(stdout + 機械可読 `effect-check.json`)と、必要なら**補正候補の `apply` パッチ下書き**。
  収録フォルダの編集ファイルには**書かない**(補正は人間が `apply` で当てる)。

**本書でやらないこと(混同禁止):**
- **演出を新規生成しない**(それは SD-E1)。本書は既存の zooms/blurs/annotations を**検品**するだけ。
- **自動補正しない。** 補正候補は `apply` パッチ下書きとして出すだけ(適用は人間)。
- **座標を LLM に書かせない。** 補正候補の rect/時刻は決定論の算術(zoom rect から blur rect を広げる等)。
  VLM は「合っている/いない」の**判定**に使い、座標を**生成**させない(母艦 原則4)。
- **cut / cutplan.json / approvals.json を触らない。**

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **決定論が主・VLM は従**: E3 の一次判定はすべて決定論(座標の重なり・画面内・zoom 追従)。VLM は
   「決定論では分からない意味(この blur は本当にキーを覆っているか)」の**二次確認**で、**失敗しても
   決定論レポートは成功させる**(母艦「VLM review は optional lane。失敗しても deterministic を成功」)。
2. **VLM 不在で優雅に劣化**: `ai.routes.vision` が未設定 / `OPENAI_API_KEY` 空のときは VLM をスキップし、
   「VLM 未実行(決定論のみ)」を明示してレポートを返す(exit 0)。**沈黙で劣化させない**。
3. **収録フォルダへ直接書かない**: 出力は `effect-check.json`(機械可読)+ stdout + 任意の
   `effect-fix.suggested.json`(apply パッチ下書き)。編集ファイルの変更は `apply` 経由。
4. **補正値は決定論の算術**: 「blur rect を zoom 領域に合わせて広げる」「annotation を zoom 終端の後ろへ
   ずらす」等はすべて既存 rect/区間からの計算。LLM/VLM に数値を書かせない。
5. **座標系の一致を守る**: caption `pos`・zoom/blur/annotation `rect`・OCR box(本編 screenRegion)は
   同じ出力px座標系(CLAUDE.md)。重なり判定はこの前提で行う。ショート経路の座標系は別なので**本編のみ**
   対象(zoom/blur/annotation はショートに継承されない=types.ts)。
6. **既存 validate と二重化しない**: zoom の重なり禁止(エラー)・blur 画面外(エラー)・blur×zoom 重なり
   (警告)は**既に validate にある**。本書が足すのは **annotation×zoom 重なり警告(E4)**・**密度警告(E5)**・
   **still ベースの視覚チェック(E3)**。既存検査を再実装せず、`validate.ts` に追記 or `effect-check` で補完する。

## 2. 設計判断(なぜこの形か)

- **なぜ E4/E5 を validate 側の決定論にするか**: これらは「壊れてはいないが品質が低い」の典型で、
  座標や本数から機械的に判定できる。既存 validate は blur×zoom 重なりを既に警告しており、annotation×zoom と
  密度はその自然な拡張。決定論なので snapshot/diff で測れる(非決定性の壁を回避)。
- **なぜ E3 を独立コマンド `effect-check` にするか**: still 撮影(headless Chrome)と VLM 呼び出しは重く、
  `validate`(数ミリ秒で回す軽量ゲート)に混ぜられない。`frames --captions` のような「監査モード」の演出版として
  独立させ、opt-in で回す。決定論の座標重なりは validate と effect-check の両方で共有ロジックを使う。
- **なぜ補正を apply パッチ下書きにするか**: SD-M2 と同じ。既存要素の修正は `apply`(検査・backup・
  approved 保護)に委ねるのが最小で安全。VLM が「ズレている」と言っても、直すのは決定論の算術+人間の承認。
- **なぜ VLM を判定専用にするか**: 母艦 原則4。VLM に rect を書かせると座標ハルシネーションが再発する。
  VLM は「この still で API キーは隠れているか(yes/no + 理由)」だけを返し、rect の修正は決定論が出す。

## 3. 変更点の全体像(新規2 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/effectCheck.ts`(新規・純関数) | 座標重なり判定 / zoom×固定px演出の相互作用 / 密度ガード / 補正 `EditOp[]` 生成 |
| B | `src/stages/effectCheck.ts`(新規) | overlays/知覚を読む・still 撮影(frames 経路再利用)・VLM 呼び出し・`effect-check.json` 書き込み |
| C | `src/stages/validate.ts`(追記) | **annotation×zoom 時間重なり警告(E4)** と **演出密度警告(E5)** を追加(blur×zoom の既存警告に並べる) |
| D | `src/cli.ts` | `effect-check <dir>` コマンド登録(`--no-vlm` で決定論のみ) |
| E | `src/lib/config.ts` + `config.yaml` | `effectCheck` 設定(密度しきい値・annotation 最大尺・VLM 使用可否) |
| F | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンド・`effect-check.json` / `effect-fix.suggested.json` を GENERATED_FILES へ |
| G | テスト | `test/effectCheck.test.ts`(純関数)+ `test/validate` の新警告ピン |

**5点セット判断**: スキーマ不変(既存 overlays フィールドしか読まない・書かない)。`types.ts`/`schemas/*` は
変更不要。ただし **`validate.ts` に警告を足す**ので `test/validate*.test.ts` を追随(既存の blur×zoom 警告の
テストに annotation×zoom・密度を並べる)。**CLI コマンドが増える**ので `AGENTS_CONTRACT.md` + `test/agentsMd.test.ts` を更新。

### A. `src/lib/effectCheck.ts`(新規・純関数)

```ts
import type { Overlays, Region, Zoom, BlurRegion, Annotation, EditOp } from "../types.ts";

export interface EffectWarning {
  kind: "annotation-zoom-overlap" | "blur-zoom-overlap" | "density" | "annotation-too-long"
      | "caption-overlap" | "vlm-mismatch";
  refId?: string;             // 対象要素の @id(あれば)
  startSec: number;
  endSec: number;
  message: string;
  suggestion?: EditOp;        // 決定論の補正候補(apply の set/remove)。無いこともある
}

/** rect どうしの重なり率(0..1。交差面積 / 小さい方の面積)。決定論。 */
export function rectOverlapRatio(a: Region, b: Region): number { return 0; }
/** 時間区間の重なり(境界共有は重なり扱いしない)。 */
export function timeOverlaps(aS: number, aE: number, bS: number, bE: number): boolean { return false; }

/** E4: zoom と固定px演出(blur/annotation)の時間重なりを検出。
 *  - blur×zoom は validate が既に警告するが、ここでは補正候補まで出す
 *    (zoom rect が blur rect を含むなら「blur rect を zoom 領域へ広げる」set、
 *     含まないなら「annotation/blur を zoom 終端の後ろへずらす」set)。
 *  - annotation×zoom は新規(validate は annotation の zoom 重なりを警告しない=types.ts)。 */
export function checkZoomInteraction(overlays: Overlays): EffectWarning[] { return []; }

/** E5: 密度ガード。単位窓 densityWindowSec に演出が maxPerWindow 超で重なる /
 *  annotation の表示尺が maxAnnotationSec 超 / 見せ場(highlightSpans)外での多用。 */
export function checkDensity(overlays: Overlays, highlightSpans: {start:number;end:number}[], cfg: EffectCheckCfg): EffectWarning[] { return []; }

/** E3(決定論の一次判定): caption pos・素材 rect との重なりを検出。
 *  captionRects/overlayRects は呼び出し側が transcript/overlays から出力px で組んで渡す。 */
export function checkVisualOverlap(overlays: Overlays, captionRects: {refId?:string;start:number;end:number;rect:Region}[], cfg: EffectCheckCfg): EffectWarning[] { return []; }

/** 警告のうち suggestion を持つものを apply パッチ(ops)へ束ねる。 */
export function buildEffectFixPatch(warnings: EffectWarning[]): { ops: EditOp[] } { return { ops: [] }; }

export interface EffectCheckCfg {
  densityWindowSec: number;   // 密度判定の窓(既定 5)
  maxPerWindow: number;       // 窓内の演出上限(既定 3)
  maxAnnotationSec: number;   // annotation 表示尺の上限(既定 8)
  minRectOverlapRatio: number;// 「重なり」とみなす rect 交差率(既定 0.3)
  useVlm: boolean;            // VLM 二次確認を使うか(既定 true・route 不在なら自動 false)
}
```

### B. `src/stages/effectCheck.ts`(新規)

1. `overlays.json` を読む(演出が0件なら「検品対象なし」で正常終了)。`cutplan`/`transcript` を読み、
   caption の出力px矩形と素材 rect を組む(既存の renderProps / timeline 写像を再利用)。
   brief.md / chapters.json から見せ場区間(highlightSpans)を作る(E5 用。無ければ空)。
2. **決定論チェック(常に実行)**: `checkZoomInteraction` / `checkDensity` / `checkVisualOverlap` を回す。
3. **still 撮影(E3)**: 各演出の表示中間の時刻で `frames` 経路(既存)を呼び、before(演出無しの合成)/
   after(演出込みの合成)の PNG を撮る。v1 は after のみでもよい(合成込みの見た目を撮れれば足りる)。
   `frames-serve` が起動中なら自動的に速い(CLAUDE.md)。
4. **VLM 二次確認(opt-in・優雅に劣化)**: `cfg.useVlm && ai.routes.vision が有効` のときだけ、after still を
   `completeWithJsonSchema`(vision route)へ渡し「この演出は目的(隠す/指す/見せる)を満たすか」を
   `{ ok: bool, reason: string }` で問う。**route 不在/失敗はスキップし「VLM 未実行」を記録**(exit 0 維持)。
   purpose は既存 union の `"vision-review"` を使う(演出検品は視覚レビューの一種)。
5. `effect-check.json`(機械可読: 警告一覧・VLM 実行有無・撮った still パス)を書く。suggestion を持つ警告が
   あれば `effect-fix.suggested.json`(apply パッチ下書き)も書く。stdout に人間向け要約。
6. **編集ファイルは1バイトも書かない**(検品と下書きだけ)。

> **中間生成物の登録**: `effect-check.json`(検品結果)・`effect-fix.suggested.json`(パッチ下書き。
> 使い捨て)を `GENERATED_FILES` に追加。撮った still は既存 `frames/` の扱いに準じる。

### C. `src/stages/validate.ts`(追記)

既存の blur×zoom 重なり警告(`validate.ts:611-618`)の隣に、決定論で軽いものだけ足す:
- **annotation×zoom 時間重なり警告**: annotation 区間が zoom 区間と時間で重なるとき
  「annotation は zoom に追従しないため指す位置がズレることがあります」。blur と同文体・同レベル(警告)。
- **密度警告(軽量版)**: `densityWindowSec` 窓に演出が `maxPerWindow` 超で重なるとき警告
  (詳細な見せ場判定は effect-check 側。validate は本数だけ見る軽量版)。

> validate は数ミリ秒で回る軽量ゲートなので、**still 撮影・VLM を絶対に持ち込まない**。座標算術だけ。

### D. `src/cli.ts`

`effect-check <dir>`:
- `--no-vlm`(決定論のみ。CI や VLM 未設定環境向け。route 不在時は自動でこれと同じ)。
- `--range <a-b>`(出力秒で検品範囲を絞る。任意・v1 省略可)。

### E. `src/lib/config.ts` + `config.yaml`

```yaml
# 演出の検品(effect-check)。決定論チェックは常時、VLM は route があるときだけ。
effectCheck:
  densityWindowSec: 5.0     # 密度判定の窓(秒)
  maxPerWindow: 3           # 窓内の演出上限
  maxAnnotationSec: 8.0     # annotation 表示尺の上限
  minRectOverlapRatio: 0.3  # 「重なり」とみなす rect 交差率
  useVlm: true              # VLM 二次確認(ai.routes.vision 不在なら自動で無効)
```

### F. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `effect-check` の使い方(決定論+任意 VLM、出力=検品レポートと apply パッチ下書き、
  補正は人間の `apply`、VLM 不在で優雅に劣化)を1節。E4/E5 の validate 新警告も演出節へ追記。
- `AGENTS_CONTRACT.md`: コマンド一覧に `effect-check`、中間生成物へ `effect-check.json`/`effect-fix.suggested.json`。
  **`test/agentsMd.test.ts` がピン留めするので揃える**。

## 4. テスト

`test/effectCheck.test.ts`(純関数):
- **rectOverlapRatio / timeOverlaps**: 既知の矩形/区間で正しい率・真偽。
- **checkZoomInteraction**: blur/annotation が zoom と時間重なり→警告 / zoom rect が blur を含む→「広げる」
  suggestion、含まない→「ずらす」suggestion / 重ならない→警告なし。
- **checkDensity**: 窓内に本数超→警告 / annotation 尺超→警告 / 見せ場内は同本数でも緩い(highlightSpans で抑制)。
- **checkVisualOverlap**: caption pos と box が重なる→ caption-overlap 警告。
- **buildEffectFixPatch**: suggestion を持つ警告だけ ops に入る / ops が apply の EditOp 形。

`test/validate`(追記):
- annotation×zoom 重なりで**警告**(エラーにしない)/ 重ならなければ警告なし。
- 密度超で警告 / 既存の zoom 重なり**エラー**・blur 画面外**エラー**・blur×zoom 警告が壊れていない
  (回帰。`npm test` の validate ピンに追随)。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(演出を持つ収録1本。SD-E1 の `plan-effects` 出力 or 手書き):
  1. わざと zoom と blur を同時刻に重ねる→ `effect-check <dir>` が blur-zoom-overlap を検出し
     「rect を広げる/ずらす」suggestion を `effect-fix.suggested.json` に書く。
  2. `node src/cli.ts apply <dir> --patch effect-fix.suggested.json --dry-run` が検査を通る。
  3. annotation を zoom に重ねる→ **新警告** annotation-zoom-overlap が出る(validate でも effect-check でも)。
  4. 5秒窓に演出を4本詰める→ density 警告。
  5. VLM 未設定(`--no-vlm` or route 不在)→「VLM 未実行(決定論のみ)」でレポートが出て exit 0。
  6. `effect-check.json` の still パスを Read で開き、演出が実際に効いた絵になっていることを目視。
- **完了報告は実測ログ付き**。
- **測定の注意**: E4/E5 の決定論警告は snapshot で固定できる。E3 の VLM 判定は非決定的なので、
  「決定論警告が正しく出るか」をテストで固定し、VLM の当否は人間が `effect-mismatch` タグで scorecard に記録。

## 6. 受け入れ基準

- annotation×zoom 重なりが**警告**として出る(既存 blur×zoom と同レベル。エラーにしない)。
- 密度超・annotation 尺超が警告として出る。
- 補正候補がすべて決定論の算術で、LLM/VLM 生成値を含まない。生成パッチが `apply` で検査を通る。
- VLM 不在/失敗で例外を投げず「VLM 未実行」を明示して決定論レポートを返す(exit 0)。
- `effect-check` が編集ファイルを1バイトも書かない(検品と下書きだけ)。
- 既存 validate のエラー(zoom 重なり・blur 画面外)・警告(blur×zoom)が壊れない(回帰)。
- `cutplan.json` / `approvals.json` を読まない・書かない。
- `AGENTS_CONTRACT.md` にコマンド追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **E6(レビューイベント化)/ E7(検品ループ戻し)= SD-E3**: 本書の警告・still を `reviewEvents` へ
  流し込み、人間の検品 UI と提案ループ(planLoop)へ戻す。本書は「検品する」まで、SD-E3 が「戻す」。
- **arrow / spotlight の視覚検証**: SD-E1 が box 限定なので本書も box/blur/zoom 中心。arrow の「指す先が
  合っているか」の VLM 検証は arrow 生成(SD-E1 §7)と対で起こす。
- **before/after clip(静止画でなく動画)**: v1 は still。ズームのイージングや annotation の点滅は
  clip で見た方が分かる。X5(レビューを映像イベント中心に)と合流する拡張。
- **VLM の rect 提案化の誘惑を断つ**: VLM は判定専用に留める設計を維持する(座標生成は決定論)。
  「VLM に直させる」は母艦 原則4 に反するので、拡張時も rect は決定論が出し VLM は yes/no に徹する。
</content>
