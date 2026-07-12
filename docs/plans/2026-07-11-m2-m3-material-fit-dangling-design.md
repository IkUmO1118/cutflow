# 実装設計書 SD-M2: M2(尺整合)+ M3(dangling→patch)— 素材の不整合検出と修正パッチ橋渡し

> 親ドキュメント: `docs/programs/edit-precision-program.md`(母艦)§4「素材」/ §7。
> 前段: **SD-M1**(`2026-07-11-m1-material-placement-candidates-design.md`)= 素材を**新規に置く**候補生成。
> 本書はその続きで、**既に置かれている素材参照の不整合を検出し、修正案を `apply` パッチとして
> 差し出す**。実装担当(弱いモデル想定)がそのまま着手できる粒度に落とす。**M2 + M3 だけが対象**。
>
> **前提となる確定方針(母艦 §2 原則4 / §6):** AI は候補を**生成**するが自動適用しない。
> 修正は `apply`(validate/assert ゲート付き・all-or-nothing)を通してのみ収録フォルダへ入る。
> 本書は「壊れている/無駄がある箇所」を**検出**し、`apply` が食える**パッチ下書き**を書くまで。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **M2(尺整合の検出と補正提案)**: `materials.probe/index.json` の**実尺**(`probe.durationSec`)と、
  `overlays.json` の `overlays[]`(再生尺 = `end - start`)・`inserts[]`(`durationSec`)が
  宣言している尺を突き合わせ、**素材が足りず最後のフレームで停止する(尺超過)**・
  **素材の大半が使われない(尺不足)**を検出する。補正は `startFrom` / `durationSec` /
  overlay の `end` を動かす **`apply` の `set` op** として提示する。
- **M3(dangling の修正提案)**: `used:true, present:false` の**参照先ファイルが無い**素材を検出し、
  ① 参照を削除する `remove` op / ② `materials/` に実在する未使用ファイルへ**貼り替える**
  候補(名前類似での提案)を提示する。
- **M3(unused の橋渡し)**: `used:false, present:true` の**一度も参照されない**素材を列挙し、
  **SD-M1(`plan-materials`)へ誘導**する(本書は配置候補を**作らない**=M1 の責務。重複実装禁止)。
- 出力は**すべて `apply` パッチ下書き**(`material-fit.suggested.json`)+ stdout レポート。
  収録フォルダの編集ファイルには**一切書かない**(人間が `apply --patch` で当てる)。

**本書でやらないこと(混同禁止):**
- **素材の新規配置候補を作らない**(それは SD-M1)。本書は**既存参照**の整合と、未使用素材の**告知**まで。
- **自動で `apply` を実行しない。** 下書きパッチを書くだけ。適用は人間が `apply --patch` で行う
  (`apply` は validate ゲート・all-or-nothing・backup を持つ既存の安全網)。
- **cut / cutplan.json / approvals.json は一切触らない。** 読むのは overlays/bgm/materials.probe だけ。
- **時刻・尺・ファイルパスを LLM に生成させない。** M2 の補正値は `probe.durationSec` からの**算術**、
  M3 の貼り替え候補は**実在ファイル名の集合**からの選択。LLM を使うのは dangling 貼り替えの
  「どの候補が妥当か」を選ぶ段だけ(番号選択方式)で、v1 は**決定論だけでも成立**する(§2)。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **収録フォルダへ直接書かない**: 本コマンドが書くのは `material-fit.suggested.json`(パッチ下書き)
   と stdout だけ。編集ファイル(overlays.json 等)の変更は**必ず `apply` を経由**する。
   `rules.suggested.md` と同じ「使い捨ての下書き」カテゴリ(再実行で黙って上書き)。
2. **パッチは @id 宛先の `ops` 形式**: `apply` の `set`/`remove` は**要素の `@id` を宛先**にする
   (`src/lib/applyEdits.ts` の `compileOps`)。よって対象 overlay/insert に **id が振られている前提**。
   id 未採番なら ops で狙えないので、**「先に `id-stamp <dir>` を実行せよ」と告げて exit 1**
   (SD-M1 の「materials.probe 未生成なら告知」と同じ優雅な拒否)。`MaterialRef.id` が
   `buildReferences`(materials.ts:50)で拾われているのでこれを使う。
3. **補正値は実測からの算術のみ**: `durationSec`/`startFrom`/`end` の提案値は
   `probe.durationSec`・現在の `start`/`end`・`startFrom` からの計算で一意に出す。
   LLM に数値を書かせない(母艦 原則4)。
4. **dangling 貼り替えは実在ファイル集合から**: 貼り替え候補は `index.materials.filter(m => m.present && !m.used)`
   の**実在・未使用ファイル**だけ。存在しないパスを提案に化けさせない。名前類似(編集距離/共通部分列)
   で上位数件に絞り、確信が無ければ「remove か手動貼り替え」を第一候補にする。
5. **cut / 承認不変**: cutplan.json / approvals.json を読まない・書かない。overlays 編集は
   承認スコープ外(CLAUDE.md)なので、生成したパッチを人間が `apply` しても承認 hash は生きたまま。
6. **前提知覚の欠如は優雅に拒否**: `materials.probe/index.json` が無い/古いときは例外を投げず
   「先に `materials <dir>` を実行せよ」と告げて exit 1。overlays.json / bgm.json が無い場合は
   「検出対象なし」で正常終了(exit 0)。

## 2. 設計判断(なぜこの形か)

- **なぜ直接編集せずパッチ下書きか**: M2/M3 は**既存要素の修正**なので、SD-M1 の「新規追加を
  validateDocs して書く」経路とは性質が違う。修正の適用は「全部 valid なら全部・1つでもダメなら
  ゼロ書き込み」を既に持つ `apply` に委ねるのが最小実装で最も安全(検査・backup・approved 保護を
  再実装しない)。母艦 §3.5 の「`apply`+検査が安全網」をそのまま使う。
- **なぜ M2 は決定論か**: 尺超過/尺不足は `probe.durationSec` と宣言尺の**大小比較**で機械的に決まる。
  LLM を挟むと非決定性が入り測定が濁る(`memory/precision-measurement-nondeterminism-wall.md`)。
  M2 は snapshot/diff で正しく測れる決定論施策として設計する。
- **なぜ M3 の unused は M1 へ丸投げか**: 未使用素材に「どこへ置くか」は SD-M1 の話題アンカー×素材
  マッチングそのもの。ここで再実装すると二重管理になる。M3 は**未使用を検出して M1 を指さす**だけ。
- **なぜ dangling 貼り替えに LLM を使わない(v1)か**: 貼り替え先は「名前が近い実在ファイル」で
  ほぼ決まる(`materials/demo.mp4` が消えて `materials/demo-v2.mp4` がある等)。決定論の名前類似で
  上位を出し、人間が選ぶ。LLM 選択は confidence が割れたときの将来拡張(§7)。

## 3. 変更点の全体像(新規2 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/materialFit.ts`(新規・純関数) | 尺整合検出 / dangling・unused 分類 / 補正 `EditOp[]` 生成 / 名前類似での貼り替え候補 |
| B | `src/stages/materialFit.ts`(新規) | index.json / overlays / bgm を読み、A を呼び、`material-fit.suggested.json`(ApplyPatch)を書く(fs 側) |
| C | `src/cli.ts` | `material-fit <dir>` コマンド登録(id-stamp 前提の告知含む) |
| D | `src/lib/config.ts` + `config.yaml` | `materialFit` 設定(尺超過/尺不足のしきい値・名前類似の上限) |
| E | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンド説明・コマンド一覧へ追加・`material-fit.suggested.json` を GENERATED_FILES へ |
| F | テスト | `test/materialFit.test.ts`(純関数:検出・分類・補正 op・貼り替え候補) |

**5点セット判断**: `overlays.json`/`bgm.json` の**スキーマは不変**(既存フィールドしか触らない)。
`ApplyPatch` の形式も既存(`src/types.ts` の `ApplyPatch`/`EditOp`)。よって `types.ts`/`schemas/*` は
**変更不要**。**CLI コマンドが増える**ので `AGENTS_CONTRACT.md` のコマンド一覧 + `material-fit.suggested.json`
を GENERATED_FILES へ追加し、`test/agentsMd.test.ts` の網羅ピンを更新(片方だけだと `npm test` が落ちる)。

### A. `src/lib/materialFit.ts`(新規・純関数)

fs 非依存。`materials.ts` の型(`MaterialEntry`/`MaterialRef`/`MaterialsIndex`)を入力に取る。

```ts
import type { MaterialEntry, MaterialRef, MaterialsIndex } from "./materials.ts";
import type { EditOp } from "../types.ts";

/** 尺不整合の1件。ref は overlay/insert のどれか。suggested は補正候補(適用は apply)。 */
export interface FitFinding {
  refId: string;                 // 対象要素の @id(無い要素はここに来ない=呼び出し側で除外)
  as: "overlay" | "insert";
  file: string;
  kind: "overrun" | "underrun";  // overrun=素材が足りず停止 / underrun=素材の大半が未使用
  materialDurationSec: number;   // probe.durationSec(実尺)
  declaredSec: number;           // overlay: end-start / insert: durationSec
  startFrom: number;             // 現在の頭出し(省略時 0)
  suggestion: EditOp;            // apply の set op(下記ルール)
  reason: string;                // 人間向けの一言(stdout・patch コメント用)
}

/** overlay/insert 参照ごとに実尺と宣言尺を突き合わせて不整合を出す純関数。
 *  - overrun: startFrom + declaredSec > materialDurationSec + eps
 *      → 素材が declaredSec を賄えず末尾フレームで停止。
 *        insert は {set durationSec = materialDurationSec - startFrom}、
 *        overlay は {set end = start + (materialDurationSec - startFrom)} を提案。
 *  - underrun: materialDurationSec - startFrom > declaredSec * underrunRatio
 *      → 素材の大半が未使用(宣言尺が実尺よりかなり短い)。
 *        情報提示のみ(尺を延ばすと編集意図を壊すので、既定は set を出さず reason だけ。
 *        cfg.suggestUnderrunExtend=true のときだけ延長 set を出す)。
 *  画像素材(kind==="image" / probe.durationSec 無し)は尺の概念が無いので除外。 */
export function detectFit(
  index: MaterialsIndex,
  cfg: MaterialFitCfg,
): FitFinding[] {
  return []; // ← 実装する
}

/** dangling(used:true, present:false)と unused(used:false, present:true)を分類。 */
export interface DanglingFinding {
  file: string;                  // 参照されているが実在しないファイル
  refs: MaterialRef[];           // これを指す参照(@id 付きは remove op を出せる)
  replacements: string[];        // 名前類似で選んだ実在・未使用ファイル(貼り替え候補・上位数件)
  removeOps: EditOp[];           // @id を持つ参照への {op:"remove", target:"@id"}
}
export interface UnusedFinding {
  file: string;                  // 実在するが未参照
  kind: MaterialEntry["kind"];
}

export function classifyReferences(index: MaterialsIndex, cfg: MaterialFitCfg): {
  dangling: DanglingFinding[];
  unused: UnusedFinding[];
} {
  // 実装ヒント:
  // - dangling = materials.filter(m => m.used && !m.present)
  // - unused   = materials.filter(m => !m.used && m.present && m.kind !== "unknown")
  // - replacements = 未使用 present ファイル名を nameSimilarity で降順、上位 cfg.maxReplacements。
  // - removeOps は ref.id があるものだけ(無い参照は「id-stamp が要る」と reason に書く)。
  return { dangling: [], unused: [] }; // ← 実装する
}

/** ファイル名の類似度(0..1)。拡張子・ディレクトリを除いた basename の
 *  共通部分列 or 編集距離ベース。決定論。LLM を使わない。 */
export function nameSimilarity(a: string, b: string): number {
  return 0; // ← 実装する
}

/** FitFinding[] + DanglingFinding[] を apply が食う ApplyPatch(ops のみ)へ束ねる。
 *  underrun で set を出さないものは含めない(reason だけ stdout に出す)。 */
export function buildFitPatch(fits: FitFinding[], danglings: DanglingFinding[]): { ops: EditOp[] } {
  return { ops: [] }; // ← 実装する
}

export interface MaterialFitCfg {
  overrunEpsSec: number;      // overrun 判定の許容誤差(既定 0.1)
  underrunRatio: number;      // underrun 判定倍率(実尺が宣言尺の何倍で「大半未使用」か。既定 2.0)
  suggestUnderrunExtend: boolean; // underrun で延長 set を出すか(既定 false)
  maxReplacements: number;    // dangling 貼り替え候補の上限(既定 3)
}
```

**補正 op の最小形**(`apply` の `set` 仕様=`src/lib/applyEdits.ts` / docs/usage.md「apply」):

```ts
// insert の尺超過を実尺に詰める:
{ op: "set", target: "@ins_a1b2c3", field: "durationSec", value: 12.4 }
// overlay の尺超過を end で詰める:
{ op: "set", target: "@mat_a1b2c3", field: "end", value: 27.7 }
// dangling 参照の削除:
{ op: "remove", target: "@mat_a1b2c3" }
```

- `field` は**ドット区切りの末端1フィールドのみ**(`apply` は中間欠落・配列添字を拒否する)。
- `approved` は `set` の対象にできない(`apply` が拒否)。本書はそもそも触らない。
- `@id` の無い要素は `set`/`remove` で狙えない → finding からは除外し、stdout で「id-stamp 要」と告知。

### B. `src/stages/materialFit.ts`(新規)

1. `materials.probe/index.json` を読む(無ければ §1-6 に従い「先に materials を実行」で exit 1)。
   `overlays.json` / `bgm.json` を読む(無ければ検出対象なしで正常終了)。
2. **overlays/inserts の要素に id が1つも無いなら** 「先に `id-stamp <dir>`(ops の宛先に @id が要る)」
   と告げて exit 1(bgm は M2/M3 の対象外=触らない)。
3. `detectFit` / `classifyReferences` を呼ぶ。
4. `buildFitPatch` で `{ ops }` を組み、`material-fit.suggested.json` へ**そのまま書く**
   (`ApplyPatch` 互換 JSON。人間が `apply --patch material-fit.suggested.json --dry-run` で確認 → 適用)。
5. stdout に人間向けレポート:
   - 尺超過/尺不足の各 finding(file・現状尺・実尺・提案・reason)。
   - dangling(参照先が無い + 貼り替え候補 + remove 可否)。
   - unused(実在するが未参照 → 「`plan-materials <dir>` で配置候補を出せる」と誘導)。
   - 末尾に `apply --patch material-fit.suggested.json` の実行手順を1行。
6. **本コマンドは overlays.json 等を1バイトも書かない**(パッチ下書きと stdout だけ)。

> **中間生成物の登録**: `material-fit.suggested.json` は「使い捨ての下書き」(次回実行で黙って上書き。
> `rules.suggested.md` と同カテゴリ)。`src/lib/files.ts` の `GENERATED_FILES` に追加し、
> CLAUDE.md / AGENTS_CONTRACT の中間生成物一覧へ並べる。

### C. `src/cli.ts`

`material-fit <dir>` を追加(LLM を使わないので `--force`/backup は不要=収録ファイルを書かないため):
- 引数なし(全 finding を出す)。将来 `--json`(機械可読出力)は §7。
- id 未採番時の exit 1 告知は B-2。

### D. `src/lib/config.ts` + `config.yaml`

`resolveMaterialFitCfg(cfg)` を追加(未指定は既定):

```yaml
# 素材の尺整合・dangling 検出(material-fit)。要 materials <dir> の事前実行。
# 出力は apply パッチ下書き(material-fit.suggested.json)で、適用は人間が apply で行う。
materialFit:
  overrunEpsSec: 0.1        # 尺超過判定の許容誤差(秒)
  underrunRatio: 2.0        # 実尺が宣言尺の何倍で「大半未使用」とみなすか
  suggestUnderrunExtend: false  # 尺不足で延長 set を出すか(既定は reason のみ)
  maxReplacements: 3        # dangling 貼り替え候補の上限
```

### E. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `material-fit` の使い方(前提 = `materials` と `id-stamp`、出力 = apply パッチ下書き、
  適用は人間の `apply --patch`、cut/承認非干渉)を1節。
- `AGENTS_CONTRACT.md`: コマンド一覧に `material-fit` を追加。中間生成物一覧へ `material-fit.suggested.json`。
  **`test/agentsMd.test.ts` がピン留めするので両方揃える**。

## 4. テスト(`test/materialFit.test.ts` 新規)

- **detectFit**: overrun(startFrom+宣言>実尺)で insert→durationSec 詰め・overlay→end 詰めの op /
  underrun(実尺≫宣言)で既定は set を出さず reason のみ、`suggestUnderrunExtend` で延長 op /
  画像素材(durationSec 無し)は除外 / eps 内は不整合なし。
- **classifyReferences**: dangling(used&!present)と unused(!used&present)を正しく仕分ける /
  kind unknown は unused から除外 / dangling に @id ある参照は removeOps、無い参照は removeOps に出さない /
  replacements が present&!used から名前類似上位。
- **nameSimilarity**: `demo.mp4`↔`demo-v2.mp4` が `demo.mp4`↔`intro.png` より高い / 決定論(同入力同出力)。
- **buildFitPatch**: underrun の非提案が ops に混ざらない / ops が `apply` の EditOp 形に一致
  (set は field/value、remove は target のみ)。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(素材参照を持つ収録1本を用意。overlay/insert に id を振る):
  1. `node src/cli.ts materials <dir>` で index.json を作る。
  2. `node src/cli.ts id-stamp <dir>`(overlays に @id が無ければ)。
  3. わざと尺超過を仕込む(短い素材を長い insert.durationSec で参照)→ `material-fit <dir>` が overrun を検出し
     `material-fit.suggested.json` に `set durationSec` op を書く。
  4. `node src/cli.ts apply <dir> --patch material-fit.suggested.json --dry-run` が「durationSec: 旧→新」を出し
     validate を通る。適用後 `validate <dir>` がクリーン。
  5. 参照先ファイルを消す→ dangling として検出、貼り替え候補 or remove op が出る。
  6. `materials.probe` 未生成→「先に materials」で exit 1(例外でない)。id 未採番→「先に id-stamp」で exit 1。
- **完了報告は実測ログ付き**(母艦の運用)。
- **測定の注意**: M2(尺整合)は**決定論**なので snapshot/diff で正しく測れる
  (`memory/precision-measurement-nondeterminism-wall.md` の「決定論なら関数直叩きで確定」)。
  dangling 貼り替えの妥当性(名前類似の当否)は人間が `material-mismatch` タグで scorecard に記録。

## 6. 受け入れ基準

- 収録フォルダの編集ファイルを1バイトも書かない(出力は `material-fit.suggested.json` と stdout だけ)。
- 補正値がすべて実尺からの算術で、LLM 生成値を含まない。
- 生成パッチが `apply --patch` で検査を通り、当てると尺超過が消える(overrun ゼロ)。
- dangling 貼り替え候補が実在・未使用ファイルだけ(存在しないパスを提案しない)。
- unused は M1 へ誘導するのみ(配置候補を本書では作らない)。
- id 未採番/materials.probe 未生成で例外を投げず告知して停止。
- cutplan.json / approvals.json を読まない・書かない。
- `AGENTS_CONTRACT.md` にコマンド・中間生成物追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **dangling 貼り替えの LLM 選択**: 名前類似が割れる(複数の近い候補)ときに、transcript の話題や
  素材 OCR を根拠に LLM が番号選択で1件選ぶ経路。v1 は決定論のみ。
- **bgm の尺整合**: 本書は overlay/insert だけ。bgm.tracks の startFrom/尺整合は将来 SD-B 側の
  `bgm-fit`(SD-B2)と統合しうる(素材尺 vs 区間尺)。
- **inserts の尺補正が cut テンポへ波及する点**: insert.durationSec を縮めると出力尺・時刻写像が動く
  (overlay と違う)。M2 の insert 補正は「素材が足りない事故の解消」に限り、テンポ目的の尺変更はしない。
- **`--json` 機械可読出力**: MCP / スクリプトから食える構造化出力(SD-M1 の describe --json と同じ発想)。
</content>
</invoke>
