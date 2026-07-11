# 実装設計書 SD3: X4 — 編集の積極度を明示する(safe / balanced / aggressive・balanced 既定)

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§7 の SD3。
> 関連: SD1(`2026-07-11-d7-w0-implementation-design.md`)/ SD2(`2026-07-11-c1-word-candidate-grid-design.md`)。
> 本書は **X4(母艦 §4「横断」)= 確定方針 D4=balanced 既定** を、実装担当(弱いモデル想定)が
> そのまま着手できる粒度まで落とした設計書。**X4 だけが対象**。C1・C2・H1/H2・H6 は含めない。
>
> **前提となる確定方針(母艦 §6):** 積極度の既定 = **balanced(D4)**。「迷ったら残す」固定を
> やめ、rules / brief / `targetOutDurationSec` から `safe / balanced / aggressive` の編集モードを
> 判断 LLM に渡す。スコープ = cut に集中(D5)。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **プロンプトの「判断基準」1行を、固定文ではなく編集モード別の文に差し替える。**
  現状 3 テンプレ(`plan.md:24` / `plan-cuts.md:25` / `plan-cuts-critique.md:35`)に
  ハードコードされている `- 迷ったら残す。過剰カットより冗長の方がまし(…)` を、
  `{{editMode}}` プレースホルダに置き換え、`safe / balanced / aggressive` の3モードで
  中身を切り替える。
- **既定を balanced にする(D4)。** モード無指定時は balanced。`safe` を選ぶと現状と
  **完全にバイト等価**の文に戻る(=回帰の逃げ道・下記 §1-3)。
- **モードを rules / brief / config / targetOutDurationSec から決める** 決定論の
  純関数 `resolveEditMode` を足す。
- **単発 `plan` にも `targetOutDurationSec` を surface する。** 現状この目標尺は
  `plan.loop`(反復モード)経由でしか LLM に渡らない(`planLoop.ts:76-81 summarizeTarget`)。
  X4 では単発 completion のプロンプトにも「目標の出力尺」を1行足す(設定されている時だけ)。

**本書でやらないこと(混同禁止):**
- **候補格子は一切触らない。** X4 は `plan` の**プロンプト文言だけ**を変える。候補の
  細分化(C1/C7/C8)は SD2 の領分で、**別に測る**(格子の効果と積極度の効果を混ぜない=
  母艦 §7 SD3 行・D6)。X4 は C1 が有効か無効かに**依存しない**(どちらでも独立に効く)。
- **番号選択方式は維持。** LLM 出力は今と同じ `cuts: [{id, reason}]`。apply も tool ループも無い(H1/H6=SD4/SD5)。
- **assertions / 目標尺の新スキーマは作らない。** 目標尺は既存 `plan.loop.targetOutDurationSec`
  を**読むだけ**(新設フィールドを増やさない。理由は §3-C)。
- **rules.md 本体は書き換えない。** モード指定は rules/brief 内の**マーカー1行を読む**だけ。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **`safe` は現状とバイト等価**(最重要の逃げ道): `editMode=safe` かつ
   `targetOutDurationSec=null` のとき、3テンプレの `{{editMode}}` 展開結果が
   **現状の固定行と1文字も違わない**。これが「X4 導入前=safe」を保証し、回帰基準線
   (`baseline`/`after-w0`/`after-c1`)を X4 導入後も `safe` で再現できる根拠になる。
2. **既定は balanced(意図的な挙動変更)**: C1/W0 と違い、X4 は**既定の出力を変える**のが
   目的。無指定 → balanced → プロンプトが変わる → cut が変わりうる。**これはバグではなく
   D4 の実装**。「opt-in でバイト等価」は X4 には**適用しない**(適用するのは §1-1 の
   `safe` 経路だけ)。この一点が SD1/SD2 と設計思想が違う所なので実装時に混同しない。
3. **決定論**: `resolveEditMode` は同じ入力(config・rules・brief)に対し同じモードを返す
   純関数。LLM 呼び出し・時刻・乱数に依存しない。
4. **モード未知値は安全側へ**: config / マーカーに `safe|balanced|aggressive` 以外の文字列が
   来たら、**警告のうえ既定(balanced)へフォールバック**(例外は投げない)。
5. **cut 判断だけに効く**: モード文は「カットの判断基準」セクションの1行だけを差し替える。
   章立て・タイトル・概要欄の指示(plan.md の他セクション)や brief/rules の本文は不変。

## 2. モード別の文言(実装の実体)

`{{editMode}}` は「## カットの判断基準」の**最後の箇条書き1行**を置き換える
(前の3行「言い直しは後を残す/脱線はカット/エラーは見せ場」はモード非依存で不変)。
各モードの展開は**箇条書き行そのもの**(先頭 `- ` 込み)を返す:

| モード | `{{editMode}}` の展開(先頭 `- ` 込み) |
|---|---|
| `safe` | `- 迷ったら残す。過剰カットより冗長の方がまし(人間が後から調整できる)` |
| `balanced` | `- 明確な冗長・言い直し・脱線は積極的に切ってテンポを作る。見せ場と説明の要点は必ず残す。判断がつかない中間的な区間は残す` |
| `aggressive` | `- 冗長・重複・長い沈黙・脱線はためらわず切る。テンポを最優先。見せ場(上の見せ場リスト)だけは必ず残し、それ以外は「残す理由があるか」で判断する` |

> **`safe` の文字列は現状 3 テンプレの当該行と完全一致でなければならない**(§1-1)。
> 実装時はテンプレの既存行をコピーして `safe` の定数にする(手打ちしない)。

**目標尺の追加行(`targetOutDurationSec` が非 null の時だけ、モード文の直後に1行足す):**

```
- 目標の出力尺は約 {N} 秒。冗長を削ってこの尺に近づける(見せ場は優先して残す)
```

`{N}` は `targetOutDurationSec.toFixed(0)`。null の時は**何も足さない**(=§1-1 の
バイト等価が保たれる)。

## 3. 変更点の全体像(新規1 + 変更4 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/editMode.ts`(新規) | `EditMode` 型・モード別文言・`resolveEditMode`・`renderEditModeBlock` の純関数群 |
| B | `prompts/plan.md` / `plan-cuts.md` / `plan-cuts-critique.md` | 当該1行を `{{editMode}}` に置換 |
| C | `src/lib/config.ts` | `plan.editMode` 設定型 + `unknownKeys` 許可追加 + 既定 balanced |
| D | `src/stages/plan.ts`(`renderPrompt`) | `{{editMode}}` を埋める。モードは rules/brief/config から解決、目標尺を surface |
| E | `config.yaml` + `docs/usage.md` | `plan.editMode` 追記・既定 balanced の明記 |
| F | テスト | `test/editMode.test.ts` 新規 + safe バイト等価の固定 |

**5点セット判断**: 収録フォルダの JSON スキーマ(cutplan / cuts.auto 等)は**不変**。
変えるのは `config.yaml` のスキーマ(`plan.editMode`)だけ。よって
`schemas/*.schema.json`(収録 JSON 用)・`AGENTS_CONTRACT.md`(ファイル分類・CLI 不変)は
**変更不要**。触るのは config 型・config 検証・docs/usage.md・prompts・plan.ts・editMode.ts・テスト。

### A. `src/lib/editMode.ts`(新規)

```ts
export type EditMode = "safe" | "balanced" | "aggressive";

export const DEFAULT_EDIT_MODE: EditMode = "balanced";

/** safe は現状 3 テンプレの当該行と完全一致でなければならない(バイト等価の逃げ道)。
 *  実装時はテンプレの既存行をコピーすること(手打ち禁止)。 */
const MODE_LINE: Record<EditMode, string> = {
  safe: "- 迷ったら残す。過剰カットより冗長の方がまし(人間が後から調整できる)",
  balanced:
    "- 明確な冗長・言い直し・脱線は積極的に切ってテンポを作る。見せ場と説明の要点は必ず残す。判断がつかない中間的な区間は残す",
  aggressive:
    "- 冗長・重複・長い沈黙・脱線はためらわず切る。テンポを最優先。見せ場(上の見せ場リスト)だけは必ず残し、それ以外は「残す理由があるか」で判断する",
};

const MODE_VALUES: readonly string[] = ["safe", "balanced", "aggressive"];

/** 文字列を EditMode に正規化。未知値は null(呼び出し側でフォールバック)。 */
export function asEditMode(v: unknown): EditMode | null {
  return typeof v === "string" && MODE_VALUES.includes(v) ? (v as EditMode) : null;
}

/** rules / brief 本文からモード指定マーカーを1つ拾う純関数。
 *  受理する行の形(前後空白可): 「編集モード: aggressive」「edit-mode: safe」等。
 *  複数あれば最後の一致を採用(rules ブロックは収録固有が後ろ=自然に優先される)。
 *  無ければ null。 */
export function editModeMarker(text: string): EditMode | null {
  const re = /(?:編集モード|edit[-_ ]?mode)\s*[:：]\s*(safe|balanced|aggressive)/gi;
  let mode: EditMode | null = null;
  for (const m of text.matchAll(re)) mode = m[1].toLowerCase() as EditMode;
  return mode;
}

/** 優先順位: brief マーカー > rules マーカー > config.plan.editMode > 既定(balanced)。
 *  未知の config 値は warn して既定へ。 */
export function resolveEditMode(args: {
  configMode: unknown;      // config.plan.editMode(未設定なら undefined)
  rules: string;            // renderPrompt が持つ rules ブロック(channel+収録連結)
  brief: string;            // brief.md 本文(無ければ既定メッセージ)
  warn?: (msg: string) => void;
}): EditMode {
  const fromBrief = editModeMarker(args.brief);
  if (fromBrief) return fromBrief;
  const fromRules = editModeMarker(args.rules);
  if (fromRules) return fromRules;
  if (args.configMode === undefined || args.configMode === null) return DEFAULT_EDIT_MODE;
  const cfg = asEditMode(args.configMode);
  if (cfg) return cfg;
  args.warn?.(`plan.editMode の値 "${String(args.configMode)}" は未対応です(safe/balanced/aggressive)。balanced を使います`);
  return DEFAULT_EDIT_MODE;
}

/** {{editMode}} の展開文字列を作る。目標尺があればモード行の直後に1行足す。 */
export function renderEditModeBlock(
  mode: EditMode,
  targetOutDurationSec: number | null,
): string {
  const lines = [MODE_LINE[mode]];
  if (targetOutDurationSec !== null) {
    lines.push(
      `- 目標の出力尺は約 ${targetOutDurationSec.toFixed(0)} 秒。冗長を削ってこの尺に近づける(見せ場は優先して残す)`,
    );
  }
  return lines.join("\n");
}
```

> **なぜ rules/brief の「本文」からマーカーを読むのか**: 母艦 X4 は
> 「rules/brief/targetOutDurationSec から積極度を渡す」と定める。config だけだと
> チャンネル/収録ごとの上書きができない。マーカー1行方式なら rules.md 本体を
> コードで書き換えず(=CLAUDE.md の「rules は人間が手で書く」を守る)、既存の
> rules 優先順位(収録固有が後ろ=後勝ち)にそのまま乗れる。

### B. プロンプトテンプレ(3ファイル・同一変更)

`plan.md:24` / `plan-cuts.md:25` / `plan-cuts-critique.md:35` の
```
- 迷ったら残す。過剰カットより冗長の方がまし(人間が後から調整できる)
```
を、各ファイルとも
```
{{editMode}}
```
の1行に置き換える(先頭 `- ` は付けない=モード文が箇条書き記号ごと供給する)。
**前の3行(言い直し/脱線/エラー)は変更しない。**

### C. `src/lib/config.ts`

- `Config["plan"]` に任意フィールド追加(`loop` の並びの近くに):
  ```ts
  /** カット判断の積極度。safe=現状とバイト等価 / balanced=既定(明確な冗長は切る) /
   *  aggressive=テンポ最優先。省略時 balanced(D4)。rules/brief のマーカー行が優先。 */
  editMode?: "safe" | "balanced" | "aggressive";
  ```
- **`plan` の `unknownKeys` 許可リストに `"editMode"` を追加**(現状 `plan` 直下の許可は
  `perception`/`loop`/`candidates` 等。`config.ts:538` 近辺の `plan.loop` 検証とは別に、
  `plan` 直下を検査している箇所を探して `editMode` を足す。**足し忘れると
  「plan.editMode は未対応です」で validate が落ちる**)。
- 目標尺は**新設しない**。単発 plan は `cfg.plan?.loop?.targetOutDurationSec ?? null` を
  そのまま読む(§3-D)。「loop 設定なのに単発でも使う」点は docs/usage.md に明記する。

### D. `src/stages/plan.ts`(`renderPrompt` の配線)

`renderPrompt`(`plan.ts:789`)に編集モードを注入する。現状 rules と brief を
関数内で読んでいる(`plan.ts:807-812`)ので、**その直後**でモードを解決して
`{{editMode}}` を埋める。目標尺を渡すため引数を1つ増やす:

```ts
export function renderPrompt(
  dir: string,
  templateFile: string,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string = "",
  editModeCfg: { configMode?: unknown; targetOutDurationSec: number | null } =
    { configMode: "safe", targetOutDurationSec: null }, // ← 既定はバイト等価(safe/目標なし)
): string {
  // ...(既存: template 読み込み・segmentLines・brief・rules は不変)...
  const mode = resolveEditMode({
    configMode: editModeCfg.configMode,
    rules,
    brief,
    warn: (m) => console.error(`[plan] ${m}`),
  });
  const editModeBlock = renderEditModeBlock(mode, editModeCfg.targetOutDurationSec);

  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{perception}}", () => perception)
    .replaceAll("{{editMode}}", () => editModeBlock);
}
```

- **既定引数を `{configMode:"safe", targetOutDurationSec:null}` にする**理由:
  `renderPrompt` を editModeCfg 無しで呼ぶ既存箇所・テストが**そのままバイト等価**に
  なる(§1-1)。実際の plan 経路だけが本物のモード/目標尺を渡す。
- **本物を渡す呼び出し箇所**(cfg を持っている所で editModeCfg を構築して渡す):
  - `plan.ts:418`(単発 cuts-only)
  - `plan.ts:469`(loop 内の再生成)
  - `plan.md`(full plan)を render している箇所(`templateFile` が `plan.md` の経路)
  - `renderCritiquePrompt`(`plan.ts:824`)→ 内部の `renderPrompt` 呼び出しに転送
  いずれも `editModeCfg = { configMode: cfg.plan?.editMode, targetOutDurationSec: cfg.plan?.loop?.targetOutDurationSec ?? null }`。
  **cfg がその関数に届いていない場合は引数で cfg(または解決済み editModeCfg)を通す**
  (最小の引数追加で伝播させる。グローバル状態にしない)。
- **remeta / plan-shorts は触らない**(cut 判断ではない)。

### E. `config.yaml` + `docs/usage.md`

- `config.yaml` の `plan:` に追記(**既定 balanced を明示**):
  ```yaml
  plan:
    editMode: balanced   # カットの積極度: safe(現状維持=ほぼ切らない) / balanced(既定・明確な冗長は切る) / aggressive(テンポ最優先)
                         # rules.md / brief.md に「編集モード: aggressive」の行があればそちらが優先
    # loop:
    #   targetOutDurationSec: null   # 目標出力尺(秒)。設定すると単発 plan でもプロンプトに「目標尺」行が入る
  ```
- `docs/usage.md`: 編集モードの3値・既定 balanced・rules/brief マーカーでの上書き・
  `safe` が導入前と等価であること・`targetOutDurationSec` が(loop 設定だが)単発 plan の
  プロンプトにも surface されることを1段落で追記。

## 4. テスト(`test/editMode.test.ts` 新規)

純関数中心に固定する:
- **safe バイト等価(最重要)**: `MODE_LINE.safe` が、リポジトリの 3 テンプレの当該行と
  **完全一致**する(テストで 3 ファイルを読み、当該行を抽出して定数と照合。将来テンプレを
  触っても safe がズレたら落ちる=回帰の逃げ道を守る)。
- **既定 balanced**: `resolveEditMode({configMode: undefined, rules:"", brief:""})` → `"balanced"`。
- **config 反映**: `configMode:"aggressive"` → `"aggressive"`。未知値 `"foo"` → warn 呼ばれ `"balanced"`。
- **マーカー優先**: `brief` に `編集モード: safe`、config が aggressive → `"safe"`(brief > config)。
  `rules` に `edit-mode: aggressive`、config が safe → `"aggressive"`(rules > config)。
  brief と rules 両方 → brief 勝ち。
- **マーカー後勝ち**: rules に safe→aggressive の2行 → `editModeMarker` は `"aggressive"`。
- **renderEditModeBlock**: 目標尺 null → 1行(モード行のみ)。非 null(例 600)→ 2行目に
  `約 600 秒` を含む。
- **プレースホルダ配線**: `renderPrompt(..., {configMode:"safe", targetOutDurationSec:null})` の
  出力に `{{editMode}}` が残らず、safe 行がそのまま入る(=導入前と同一のプロンプト)。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```

- 実測(W0 済みの words 付き収録1本。中立 cwd から絶対パスで走らせる=`llm-command-verify-neutral-cwd`):
  1. `config.yaml` の `plan.editMode: safe` にして `plan --cuts-only` → 生成プロンプト・結果が
     **X4 導入前と一致**(safe=バイト等価。`plan.raw.txt` のプロンプト部で確認)。
  2. `balanced`(既定)で `plan --cuts-only --force`(手編集が無い前提。ある場合は避ける)→
     cut が safe より積極的になることを `describe` で確認。
  3. `aggressive` で更に切れ幅が増えること、ただし **brief の見せ場が残る**ことを確認。
  4. `plan.loop.targetOutDurationSec` を設定 → 単発 plan のプロンプトに「目標尺」行が入る
     ことを `plan.raw.txt` で確認。
  5. `after-x4` スナップショット(SD1 Part A)を取り、`after-c1`(または `baseline`)と diff。
     **X4 の効果は C1 と分けて評価する**(格子固定・モードだけ変えた差分を見る)。
- **完了報告は実測ログ付き**(母艦の運用: 完了報告は必ず実測検証)。

## 6. 受け入れ基準

- `plan.editMode: safe` + 目標尺 null で、3テンプレ経由のプロンプトが X4 導入前と**バイト等価**。
- 無指定で `balanced`(既定変更が効いている)。
- rules/brief のマーカー行が config を上書きする(優先順位どおり)。
- 未知モード値で例外を投げず warn+balanced にフォールバック。
- `targetOutDurationSec` 設定時、単発 plan のプロンプトに目標尺行が入る。
- `npx tsc --noEmit` と `npm test`(safe バイト等価テスト含む)が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- X4 で「積極度」を明示できる。C1(SD2)の細かい格子と**独立**に効くので、
  回帰では **格子固定・モード可変** と **モード固定・格子可変** の両方向で切り分けて測る。
- 次は **SD4(H1 pull 型知覚 + H2 検証主経路化)**: 判断 LLM に `frames`/`describe`/`av` を
  tool として握らせ、単発 completion を検証ループに置き換える。X4 の editMode は
  そのループの**方針入力**としてそのまま生きる(モード文はプロンプトのままでよい)。
- R0 を「直接」越える apply 分割は **SD5(H6)**。X4 は行動空間を広げも狭めもせず、
  **同じ行動空間の中で判断の寄せ方を変える**だけ(軸 B の施策=母艦 §3.5 の表)。
