# 実装設計書 SD-B1: B1(章×テンション区間割り)+ B3(切替点の意味化)— BGM 配置候補の番号選択生成

> 親ドキュメント: `docs/programs/edit-precision-program.md`(母艦)§4「BGM」/ §7。
> 演出(E)の型が固まった後の**BGM(B)最初の設計書**。実装担当(弱いモデル想定)がそのまま着手できる
> 粒度に落とす。**B1(章×テンションでの区間割り)+ B3(切替点の意味化)だけが対象**。
> B2(無音/被り回避)・B4(fallback 検出)は **SD-B2**(別書)。
>
> **前提となる確定方針(母艦 §2 原則4 / §6):** AI は**列挙された候補から番号で選ぶ**。BGM でこれが
> 意味するのは、**区間境界(いつ切り替えるか)を決定論で列挙し、曲(何を敷くか)は人間が用意した
> `materials/` の実ファイルから番号選択する**。時刻・ファイルパス・音量を LLM に書かせない。cut/素材/演出
> とは独立の軸。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **B3(切替点の意味化)= 決定論**: BGM を切り替える/区切る**アンカー**を機械的に列挙する。ソース:
  - **章境界**(`chapters.json` の各 `start`)。
  - **大きなカット境界**(`cutplan.json` の keep→cut→keep の跨ぎで、前後の間隔が大きい所)。
  各アンカーは「元収録の秒」の実時刻なので、LLM が捏造しない。これが BGM 区間の**切れ目候補**になる。
- **B1(章×テンションでの区間割り)= 番号選択**: 隣り合う切替アンカーで挟まれた**区間スロット**を番号付きで
  列挙し、各スロットに `chapters.json` のタイトル(章の意味)と長さを添えて LLM に渡す。人間が `materials/` に
  置いた**曲候補**(実ファイル)も番号付きで渡す。LLM は **(区間スロット番号 × 曲番号 or 無音)** のペアだけを
  返す。コードが `bgm.json` の `tracks[]`(`{start, end, file}`)へ変換し、**下書き**として書く。
- 生成物は**全て人間レビュー前提**。bgm は承認スコープ外(CLAUDE.md: bgm 編集は承認 hash を失効させない)
  なので approvals.json に触れない。

**本書でやらないこと(混同禁止):**
- **時刻・ファイルパス・音量を LLM に生成させない。** 区間境界は切替アンカー由来、曲は実ファイル集合から。
  LLM 出力は番号ペアだけ(母艦 原則4)。
- **無音/被り回避・duck・fallback 検出はしない**(SD-B2)。本書は「どの区間にどの曲」まで。音量は cfg 既定
  (`volumeDb` 省略=config の `render.bgm.volumeDb`)。av.probe は読まない。
- **曲を自動生成・DL しない。** 曲は人間が `materials/`(または収録直下の `bgm.*`)に置いたものだけ。
  無ければ「BGM 候補ファイルが無い」と告知して終了(SD-M1 の素材0件と同じ)。
- **cut / cutplan.json / approvals.json を触らない。** cutplan/chapters は**読む**だけ。
- **自動で本番配置しない**(下書き。採否は人間)。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **番号選択のみ(最重要)**: LLM 出力は `assignments: [{slotId, file: number|null, reason}]` **だけ**
   (`file` は曲番号、`null`=その区間は無音)。時刻・ファイル名・volumeDb を LLM に書かせない。番号→実体への
   変換と存在しない番号の無視は**すべてコード側**(SD-M1 の `placementsToOverlays` と同じ堅牢さ)。
2. **区間境界は切替アンカー由来**: `tracks[].start`/`end` は切替アンカー(章境界・大カット境界)の実時刻から。
   LLM 値を混ぜない。隣接スロットが同じ曲番号なら**連結**して1トラックにする(無駄な切れ目を作らない)。
3. **曲は実在ファイルから**: 候補は `materials/` の音声ファイル ∪ 収録直下の `bgm.*` の**実在集合**。
   存在しないパスを `tracks[].file` に化けさせない(validate は bgm file の実在をエラーで検査=validate.ts:807-815)。
4. **cut 不変**: cutplan.json は読むだけ。承認 hash に影響しない(bgm は承認スコープ外)。
5. **opt-in / 非破壊**: 既存 `bgm.json` があるときは `--force` 必須。実行前に `bgm.json` を `backups/<日時>/` へ
   退避してから上書き(`plan-shorts` と同じ作法)。`--force` なしはエラーで停止。
6. **前提の欠如は優雅に拒否/告知**: `chapters.json` が無いときは章境界アンカーが作れないので、大カット境界だけで
   区間割りする(章が無くても動く。ただし区間の意味づけは薄くなる旨を stdout で告知)。曲候補が0件なら
   「BGM 候補ファイルが無い」と告知して終了(exit 1)。
7. **書く前に検査(all-or-nothing)**: 組んだ `bgm.json` 下書きを、**書き込み前に**純関数
   `validateDocs(dir, docs, [])`(`stages/validate.ts`)へ通す。bgm の file 実在・span・fade の検査は
   既存が効く(validate.ts:793-846)。`errors` が空のときだけ書く。1つでも不正なら1バイトも書かない。

## 2. 設計判断(なぜこの形か)

- **なぜ切替アンカー = 章境界 + 大カット境界か**: BGM の切れ目は「話の区切り」に置くのが自然。章は既に
  人間/plan が付けた意味境界(`chapters.json`)で、大カット境界は「場面が飛ぶ」所。どちらも実時刻なので
  LLM に時刻を書かせずに区間を作れる。母艦 B3「章境界・大きなカット境界を BGM 切替アンカーの候補に」の直実装。
- **なぜ曲を番号選択か**: 曲ファイルのパスを LLM に書かせると存在しないパスや typo が入る。人間が置いた
  実ファイルだけを候補にして番号で選ばせれば、validate の file 実在エラーに引っかからない。母艦 B1
  「曲は人間が用意した `materials/` から選択」の直実装。
- **なぜ音量を触らないか**: 音量/duck は av.probe の被り解析が要る(SD-B2)。本書で volumeDb を LLM に決めさせると
  非決定 + garbage-in。既定(config の `render.bgm.volumeDb`)に任せ、調整は SD-B2 に分離して測定を混ぜない。
- **なぜ `plan-shorts`/SD-M1 を雛形にするか**: 「決定論でアンカー/スロットに番号 → LLM は番号ペアだけ返す →
  コードが実体へ変換 → 下書き → 既存ありは --force+backup → 書く前 validateDocs」の骨格が完全一致。

## 3. 変更点の全体像(新規3 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/bgmSlots.ts`(新規・純関数) | 切替アンカー生成(章/大カット)/ 区間スロット化 / 曲候補列挙 / assignments → tracks 変換 |
| B | `src/stages/planBgm.ts`(新規) | chapters/cutplan/曲ファイルを読む・`renderBgmPrompt`(スロット+曲の2リスト)・応答パース・`validateDocs` 検査付き下書き書き込み |
| C | `prompts/plan-bgm.md`(新規) | LLM プロンプト(番号選択の出力形式・スロット/曲の提示形式・テンションの考え方) |
| D | `src/cli.ts` | `plan-bgm <dir>` コマンド登録(`--force`・backup) |
| E | `src/lib/config.ts` + `config.yaml` | `planBgm` 設定(大カット境界のしきい値・最小区間尺・スロット上限) |
| F | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンド説明・一覧追加・`plan-bgm.raw.txt` を GENERATED_FILES へ |
| G | テスト | `test/bgmSlots.test.ts`(純関数)+ パーサ堅牢性 |

**5点セット判断**: `bgm.json` の**スキーマは不変**(既存 `tracks[]` フィールドしか書かない=start/end/file、
volumeDb 等は既定に任せる)。`types.ts`/`schemas/*` は変更不要。`validate.ts` の bgm 検査は既存を流用。
**CLI コマンドが増える**ので `AGENTS_CONTRACT.md` のコマンド一覧 + `plan-bgm.raw.txt`(GENERATED_FILES)+
`test/agentsMd.test.ts` を更新。

### A. `src/lib/bgmSlots.ts`(新規・純関数)

```ts
import type { Bgm, Chapters, CutPlan } from "../types.ts";

/** BGM の切れ目候補(元収録の秒)。source で由来が分かる。 */
export interface BgmAnchor {
  timeSec: number;
  source: "chapter" | "cut" | "start" | "end";
  label: string;              // 章タイトル or "大カット" など(スロットの意味づけ)
}

/** 隣り合うアンカーで挟まれた区間スロット。ここに曲 or 無音を割り当てる。 */
export interface BgmSlot {
  id: number;                 // 1始まりの通し番号
  start: number;              // 元収録の秒(アンカー時刻)
  end: number;                // 元収録の秒(次アンカー時刻)
  label: string;              // 章タイトル等(LLM への意味づけ)
  keepSec: number;            // この区間で実際に流れる尺(カット控除後。visibleSec 相当)
}

/** LLM に見せる曲候補(実在ファイルだけ)。 */
export interface BgmChoice {
  id: number;                 // 1始まりの通し番号
  file: string;               // 収録フォルダ相対(materials/xxx.mp3 or bgm.mp3)
  durationSec?: number;       // 分かれば(ffprobe。無くてもよい=ループ再生前提)
}

/** LLM 応答の1割り当て。番号だけ(file は曲番号 or null=無音)。 */
export interface BgmAssignment {
  slotId: number;
  file: number | null;
  reason: string;
}

/** 章境界 + 大カット境界から切替アンカーを決定論生成。
 *  - 章境界: chapters.chapters[].start(あれば)。
 *  - 大カット境界: cutplan の keep→cut→keep で、cut の尺が cfg.bigCutSec 以上の所。
 *  - 先頭(0)と末尾(総尺)も端アンカーに含める。近接アンカーは cfg.minSlotSec でマージ。 */
export function buildBgmAnchors(cutplan: CutPlan, chapters: Chapters | null, totalSec: number, cfg: BgmSlotCfg): BgmAnchor[] {
  return []; // ← 実装する
}

/** アンカー列を区間スロットへ。minSlotSec 未満のスロットは前後へ吸収。keepSec は
 *  timeline の写像(カット控除後の可視尺)で計算(既存 visibleSec を使う)。 */
export function anchorsToSlots(anchors: BgmAnchor[], cutplan: CutPlan, cfg: BgmSlotCfg): BgmSlot[] {
  return []; // ← 実装する
}

/** materials/ の音声ファイル ∪ 収録直下 bgm.* を曲候補へ(実在集合)。id は1始まり。 */
export function buildBgmChoices(audioFiles: string[]): BgmChoice[] {
  return []; // ← 実装する
}

/** assignments(番号ペア)を bgm.tracks[] へ変換する純関数。
 *  - 存在しない slotId / file 番号は捨てる(番号選択の安全網)。
 *  - file===null(無音)のスロットは track を作らない(覆わない区間=無音。types.ts Bgm の仕様)。
 *  - **隣接スロットが同じ file 番号なら連結**して1トラックへ(start は最初、end は最後)。
 *  - track の start/end はスロットの実時刻(LLM は触れない)。volumeDb 等は付けない(既定に任せる)。 */
export function assignmentsToTracks(assignments: BgmAssignment[], slots: BgmSlot[], choices: BgmChoice[]): NonNullable<Bgm["tracks"]> {
  return []; // ← 実装する
}

export interface BgmSlotCfg {
  bigCutSec: number;      // 「大カット境界」とみなす cut 尺の下限(既定 3.0)
  minSlotSec: number;     // BGM スロットの最小尺(これ未満は前後へ吸収。既定 8.0)
  maxSlots: number;       // スロット上限(区切りすぎ防止。既定 12)
}
```

**生成 track の最小 valid 形**(`types.ts` の `Bgm["tracks"][number]`。**必須は `start`/`end`/`file`**):

```ts
{ start: 0, end: 45.2, file: "materials/calm.mp3" }          // 冒頭〜45秒は calm
{ start: 45.2, end: 120.0, file: "materials/upbeat.mp3" }    // 45秒〜2分は upbeat
// 45.2〜のスロットを無音にしたいときは track を作らない(覆わない=無音)
```

- `id` は付けなくてよい(任意。人間が editor で id-stamp)。`volumeDb`/`startFrom`/`fadeInSec`/`fadeOutSec` も
  **書かない**(v1 は既定。音量/フェード調整は SD-B2 と人間の仕事)。fade を1つも付けないと切替が硬いが、
  v1 は「どこにどの曲」を測ることに集中し、遷移の滑らかさは後段(§7)。

### B. `src/stages/planBgm.ts`(新規)

`plan-shorts.ts` / SD-M1 と同じ骨格:
1. `cutplan.json` を読む(必須)。`chapters.json` を読む(無ければ章アンカー無しで続行=§1-6)。曲候補は
   `materials/` 走査で音声拡張子(`classifyKind`==="audio")∪ 収録直下 `bgm.mp3/m4a/wav` を集める。0件なら
   「BGM 候補ファイルが無い」で exit 1。
2. `buildBgmAnchors` → `anchorsToSlots` でスロット、`buildBgmChoices` で曲候補(いずれも番号付き)。
3. **`renderBgmPrompt`(新規)で2リスト(スロット+曲)プロンプトを組む**(SD-M1 の `renderMaterialsPrompt`
   と同じ作法。`readRules`(plan.ts から export 済み=SD-M1 で対応)と brief を注入):

   ```ts
   function renderBgmPrompt(dir: string, slots: BgmSlot[], choices: BgmChoice[]): string {
     const slotLines = slots
       .map((s) => `#${s.id} [${s.start.toFixed(1)}-${s.end.toFixed(1)}] 可視${s.keepSec.toFixed(0)}s ${s.label || ""}`.trim())
       .join("\n");
     const choiceLines = choices
       .map((c) => `#${c.id} ${c.file}${c.durationSec ? ` (${c.durationSec.toFixed(0)}s)` : ""}`)
       .join("\n");
     const rules = readRules(dir);
     const brief = existsSync(join(dir, "brief.md")) ? readFileSync(join(dir, "brief.md"), "utf8") : "(見せ場リストなし)";
     const template = readFileSync(join(repoRoot, "prompts", "plan-bgm.md"), "utf8");
     return template
       .replaceAll("{{slots}}", () => slotLines)
       .replaceAll("{{choices}}", () => choiceLines)
       .replaceAll("{{rules}}", () => rules)
       .replaceAll("{{brief}}", () => brief);
   }
   ```

4. `completeWithJsonSchema(prompt, cfg, { name, strict, schema }, "other")` で `{ assignments: [...] }` を得る。
   **`purpose` は `"other"`**(union に `plan-bgm` は無い=SD-M1 と同判断)。schema は
   `{ assignments: [{ slotId:int, file:int|null, reason:string }] }` を `strict: true`(`file` は
   `{ type: ["integer","null"] }`)。生応答は `plan-bgm.raw.txt` へ。
5. `parseAssignments`(SD-M1 の parse と同じ堅牢さ)。
6. `assignmentsToTracks` で `tracks[]` を組み、`bgm.json`(= `{ tracks }`)を作る。
7. **書き込み前に** `validateDocs(dir, docs, [])`(§1-7)。`errors` が空のときだけ `guardRerun`/
   `backupEditableFiles` で backup → `bgm.json` を書く。1つでもあれば書かず stdout に出して exit 1。
8. stdout に要約(どの区間にどの曲/無音を、理由付きで)。

> **中間生成物の登録**: `plan-bgm.raw.txt` を `GENERATED_FILES` に追加(plan.raw.txt と同カテゴリ)。

### C. `prompts/plan-bgm.md`(新規)

`prompts/plan-shorts.md` に倣う。骨子:
- 役割:「編集済みタイムラインの各区間(スロット)に、手持ちの曲から**雰囲気の合うもの**を割り当てる。
  静かにすべき区間は無音(null)でよい。全区間を無理に曲で埋めない」。
- 入力提示: スロット一覧(`#id [start-end] 可視Ns 章タイトル`)+ 曲一覧(`#id ファイル名 (尺)`)。
- テンションの考え方:章の役割(導入=静か / 山場=盛り上げ / まとめ=落ち着き)に曲の雰囲気を合わせる。
  同じ雰囲気が続く隣接スロットは同じ曲でよい(コードが連結する)。
- 出力形式: `{ "assignments": [{ "slotId": N, "file": M or null, "reason": "..." }] }`。**番号だけ**。
  時刻・ファイル名・音量を書かない旨を明記。
- ガイド: 曲の乱れ替えを避ける / `rules.md`(BGM の型・トーン)を尊重。
- **プレースホルダは `{{slots}}` / `{{choices}}` / `{{rules}}` / `{{brief}}`**(`renderPrompt` の
  `{{segments}}` は使わない)。

### D. `src/cli.ts`

`plan-shorts` に倣って `plan-bgm <dir>`:
- `--force`(既存 bgm.json 上書き時に必須)。承認は絡まない(bgm は承認スコープ外)。

### E. `src/lib/config.ts` + `config.yaml`

```yaml
# BGM 配置候補の自動生成(plan-bgm)。曲は人間が materials/ or bgm.* に置いたものだけ。
# 生成物は下書き(bgm.json)で、採否は人間。cut/承認に触れない。音量/duck は SD-B2。
planBgm:
  bigCutSec: 3.0     # 「大カット境界」とみなす cut 尺の下限(切替アンカー)
  minSlotSec: 8.0    # BGM スロットの最小尺(これ未満は前後へ吸収)
  maxSlots: 12       # スロット上限(区切りすぎ防止)
```

### F. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `plan-bgm` の使い方(前提 = 曲を materials/ に置く・任意で chapters、番号選択、
  区間は切替アンカー由来、下書き・人間承認、cut/承認非干渉、音量は SD-B2、--force+backup)を1節。
- `AGENTS_CONTRACT.md`: コマンド一覧に `plan-bgm`、中間生成物へ `plan-bgm.raw.txt`。
  **`test/agentsMd.test.ts` がピン留めするので揃える**。

## 4. テスト(`test/bgmSlots.test.ts` 新規)

- **buildBgmAnchors**: 章 start がアンカーになる / 大カット(cut 尺 ≥ bigCutSec)がアンカー、小カットは無視 /
  先頭0・末尾総尺を含む / 近接アンカーが minSlotSec でマージ / chapters null でも大カットだけで動く。
- **anchorsToSlots**: minSlotSec 未満のスロットが前後へ吸収 / keepSec がカット控除後の可視尺 / id 連番 /
  maxSlots で打ち切り。
- **buildBgmChoices**: 音声ファイルだけ候補(動画/画像を除外)/ bgm.mp3 と materials/*.mp3 の和 / id 連番。
- **assignmentsToTracks(核)**:
  - 存在しない slotId / file 番号を捨てる(番号選択の安全網)。
  - file===null のスロットは track を作らない(無音)。
  - **隣接スロットの同一 file 番号を連結**(start=最初/end=最後、余計な切れ目を作らない)。
  - track の start/end がスロットの実時刻(LLM 値を混ぜない)。volumeDb 等を付けない。
- **parseAssignments の堅牢性**: コードフェンス混在から JSON を拾う / assignments 欠如→空 /
  slotId が数値でない・file が int でも null でもない要素を落とす。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(章立て済み + `materials/` に曲を数点置いた収録1本):
  1. `node src/cli.ts plan-bgm <dir>`(bgm.json 無し)→ 下書きが書かれる。`describe --json` の bgm 射影に
     区間×曲が出ることを確認。
  2. `node src/cli.ts validate <dir>` がエラー無し(bgm file 実在・span・fade)。
  3. `node src/cli.ts av <dir>` の sound レポート(BGM spans)に配置が反映されることを確認(描画の裏取り)。
  4. 曲候補0件のフォルダ→「BGM 候補ファイルが無い」で exit 1(例外でない)。
  5. 既存 bgm.json があるフォルダで `--force` 無し→エラー停止、`--force`→ backup 後上書き。
  6. chapters.json 無しでも大カット境界だけで区間割りが動く(告知付き)。
- **完了報告は実測ログ付き**。
- **測定の注意**: `plan-bgm` の LLM 出力(曲選び)は非決定的。**単発 diff で選曲品質を採点しない**。
  決定論部分(アンカー生成・スロット化・連結・番号安全網)はテストで固定し、選曲の当否(区間と曲の雰囲気の
  一致)は人間が preview で聴いて `bgm-mismatch` タグで scorecard に記録
  (`memory/precision-measurement-nondeterminism-wall.md`)。

## 6. 受け入れ基準

- LLM 出力が番号ペアだけで、時刻・ファイル名・音量を含まない(プロンプト+スキーマで強制)。
- 生成 `tracks[].file` が実在ファイルだけ(validate の bgm file エラーを一切出さない)。
- 区間境界が切替アンカー(章/大カット)の実時刻で、隣接同曲が連結される。無音区間は track を作らない。
- `cutplan.json` / `approvals.json` に一切書き込まない。
- 既存 bgm.json は `--force` 必須+実行前 `backups/` 退避。
- 曲候補0件で例外を投げず告知して停止。chapters 無しでも動く。
- 書き込み前検査で1つでも不正なら1バイトも書かない(all-or-nothing)。
- `AGENTS_CONTRACT.md` にコマンド追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **B2(無音/被り回避)/ B4(fallback 検出)= SD-B2**: 本書は「どの区間にどの曲」まで。av.probe の無音・
  mic/system RMS 被りを見て音量/duck/切替を調整し、全編1曲 fallback を検出するのは SD-B2。本書の
  volumeDb 既定任せはそこで精緻化される。
- **フェード(遷移の滑らかさ)**: v1 は fade を付けない硬い切替。区間端の `fadeInSec`/`fadeOutSec` を
  決定論(区間尺に応じた既定)で足す拡張。切替アンカーが章/大カットなら場面が切れているので短い fade で足りる。
- **テンションの数量化**: v1 は章タイトルの文字情報で LLM に雰囲気を推させる。将来 av.probe の loudness 包絡や
  話速をスロットに添えると、テンション判断の帯域が上がる(C4 delivery signals の BGM 版)。
- **H(ハーネス)との接続**: 将来 pull 型知覚を BGM へ広げるなら、判断 LLM に曲の試聴(transcribe/波形)を
  tool として引かせる経路がありうる。本書は単発 completion。
</content>
