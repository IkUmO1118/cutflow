# P3: `run` の再定義 — 「パイプラインの入口」から「AI に初版を作らせるボタン」へ

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: **P2 landing 必須**(プロジェクト作成と `ingest` が `run` の外に出ている
ことが、この段の前提そのもの)。

---

## 1. 何を変えるのか

```
現在: run = ingest → transcribe → detect → plan          src/cli.ts:1930-1979
新:   run =          transcribe → detect → plan
```

`ingest` はプロジェクト作成時(P2 の `/api/base-media` / `ingest` コマンド)に
済んでいる。`run` に残るのは**知覚と生成**、すなわち「AI に初版を作らせる」だけ。

`run` の末尾にある `idStamp` と `autoZoomIfFresh`(`cli.ts:1966-1978`)は
**そのまま残す**(どちらも生成の後始末で、ingest とは無関係)。

### 後方互換

`ingest` が未実行のフォルダで `run` を叩いたときは、**現行どおり ingest から
始める**。つまり:

```ts
if (!existsSync(join(abs, "manifest.json"))) {
  await timed("ingest", () => ingest(abs, findSource(abs), cfg, layout, tracks));
}
```

これで既存ユーザーの `run` の使い方(収録直後に1発叩く)は壊れない。
`--layout` / `--mic-track` / `--system-track` フラグも**残す**
(この分岐でのみ意味を持つ)。ヘルプ文面に「manifest が無いときだけ効く」と書く。

## 2. 本題 — bootstrap 生成物と人間の編集を区別する

### 2.1 問題

`guardRerun`(`src/cli.ts:229-260`)は「**ファイルが存在すれば手編集がある**」と
みなして `--force` を要求する。ところが P2 以降、`bootstrapProjectWithLayout` が
**必ず** `transcript.json`(空)と `cutplan.json`(全編 keep)を先に書く。

結果、**プロジェクトを開いた直後に `run` を叩くと必ず `--force` を要求される。**
そして `--force` は `backups/` への退避を伴う破壊的操作として案内されるため、
「初版を作るだけ」の操作が毎回この文面を踏むことになる。これは
編集器ファーストの体験を根本から損なう。

### 2.2 決定 — `generatedBy` マーカーを編集ファイルに持たせる

`bootstrap` が書いた初期値であることを、**書いたファイル自身に記録する**。

```ts
// src/types.ts
export interface CutPlan {
  approved: boolean;
  /** このファイルを書いた主体。"bootstrap" は editor / CLI が「開くために」
   *  決定論的に作った初期値であることを示す(人間の編集でも LLM の生成物でも
   *  ない)。**人間 / AI が内容を編集したら消える**(= 消えていることが
   *  「手編集がある」の証拠)。省略時は「不明 = 手編集とみなす」で、
   *  既存収録は従来どおり保護される */
  generatedBy?: "bootstrap";
  segments: CutPlanSegment[];
}

export interface Transcript {
  language: string;
  model: string;
  generatedBy?: "bootstrap";   // 同上
  segments: TranscriptSegment[];
}
```

**省略時が「手編集とみなす」なので、既存収録はバイト等価**(母艦 §8-1)。

### 2.3 マーカーの寿命 — 誰が消すのか

マーカーは「まだ誰も触っていない」ことを表す。以下のすべてで**消す**:

| 書き手 | 措置 |
|---|---|
| `bootstrapProject`(`emptyTranscript` / `initialCutplan`) | **付ける** |
| GUI の保存(`saveProject`) | 消す |
| `apply`(`planApply`) | 消す |
| `transcribe` / `detect` / `plan` / `remeta` の書き込み | 消す(生成物で置き換わるため) |
| 人間の直接編集(Write/Edit) | **消せない** — §5 の落とし穴 |

「消す」の実装は、**書き込みの共通経路で `delete doc.generatedBy` を1回行う**のが
確実。`src/lib/applyEdits.ts` の書き込み関数と `editor/server.ts` の
`saveProject` が該当する。

### 2.4 `guardRerun` の変更

```ts
function guardRerun(dir, outputs, force, cmd): void {
  const existing = outputs.filter((f) => {
    const p = join(dir, f);
    if (!existsSync(p)) return false;
    return !isBootstrapArtifact(p);   // ← 追加
  });
  // …以降は現行どおり…
}

/** bootstrap が書いた初期値のままか。JSON が読めない/generatedBy が無いときは
 *  false(= 手編集とみなす。安全側に倒す) */
function isBootstrapArtifact(path: string): boolean;
```

`chapters.json` / `meta.json` は bootstrap が書かないので、この判定は
`transcript.json` / `cutplan.json` にだけ効く。

**退避の対象は変えない。** `--force` が実際に走るときは、現行どおり
`EDITABLE_FILES` 全部を `backups/` へ退避する(bootstrap 生成物が混ざっていても
退避されるだけで害はない)。

## 3. エディタからの実行

`POST /api/run` を足す。既存の `/api/preview` / `/api/render`
(`editor/server.ts:830-844`)と**完全に同じ配線**をコピーする
(ストリーミング進捗・エラー表示・多重起動の抑止)。

- ボタンの文言は「AI に初版を作らせる」(`run` という語を UI に出さない)
- `guardRerun` が `--force` を要求する状態(= 手編集がある)のときは、
  **ボタンを押した時点で確認ダイアログを出す**:
  「手編集した内容が AI の生成物で上書きされます。実行前に `backups/` へ
  退避します」。同意で `force: true` を渡す
- 実行中は cutplan / transcript が外から書き換わるので、
  **既存のホットリロード経路(`watch`)にそのまま乗る**。特別扱いは不要

## 4. 名前

`run` というコマンド名は残す(既存の全ドキュメント・ユーザーの手が覚えている)。
**別名は足さない**(`autoedit` / `draft` 等。コマンド表面を増やさない)。
説明文だけ変える:

```
run <dir>   AI に初版を作らせる(transcribe → detect → plan)
```

## 5. テスト

**新規**:
1. `bootstrapProjectWithLayout` が書く `transcript.json` / `cutplan.json` に
   `generatedBy: "bootstrap"` が入る
2. `guardRerun` が bootstrap 生成物だけのフォルダで `--force` を要求しない
3. `guardRerun` が `generatedBy` の無い `cutplan.json` では**従来どおり**
   `--force` を要求する(既存収録の保護 = バイト等価)
4. GUI 保存後 / `apply` 後に `generatedBy` が消える
5. `plan` が書いた `cutplan.json` に `generatedBy` が無い
6. `run` が manifest 有りのフォルダで `ingest` を呼ばない
7. `run` が manifest 無しのフォルダで `ingest` から始める(後方互換)

**5点セット**: `src/types.ts`(`CutPlan.generatedBy` / `Transcript.generatedBy`)/
`src/stages/validate.ts`(未知キーを弾く検査があるなら許可へ)/
`docs/usage.md` / `schemas/cutplan.schema.json` + `schemas/transcript.schema.json`
+ 各 `examples/*.max.json` / `AGENTS_CONTRACT.md`(`run` の定義が変わるため)。

## 6. 落とし穴

- **`generatedBy` が承認 hash に混入しないこと。**
  `src/lib/approval.ts` の `cutplanApprovalHash` は keep 集合だけを
  正規化して hash にしているので**構造上は安全**だが、
  「`approved: true` の cutplan に `generatedBy` を足しても hash が変わらない」
  回帰テストを1本置くこと
- **人間が直接 Write/Edit したときマーカーが消えない。**
  この場合 `guardRerun` が「bootstrap 生成物のまま」と誤判定し、
  `--force` 無しで上書きしてしまう。**これは実害**。緩和:
  `isBootstrapArtifact` は `generatedBy` の存在だけでなく
  **内容が bootstrap の初期値と一致するか**も見る:
  - `cutplan`: `segments` が1件で `action: "keep"` かつ `reason` が初期文言
  - `transcript`: `segments` が空
  両方を満たすときだけ「bootstrap 生成物」と判定する。**この二重判定を必ず実装する**
- **`validate` の未知キー検査**: 編集ファイルに未知のキーを許さない検査が
  あるなら、`generatedBy` を許可リストへ足す。`test/schema.test.ts` が
  `validate.ts` の許可キーをピン留めしているので、スキーマ側も同時に直す

## 7. 完了記録(2026-08-02)

- bootstrap の transcript/cutplan に `generatedBy:"bootstrap"` を付け、
  `isBootstrapArtifact` は sibling manifest の尺、approved、全 top-level/segment key、
  start/end/action/reason を初期形と完全照合する。欠落・破損・追加編集はすべて安全側。
- GUI 保存と `apply` の永続化境界で、触った文書から marker を除去する。
  AI/transcribe/plan の置換出力は marker を持たない。
- `runDraft` を CLI/API 共通 stage とし、manifest 有りは transcribe→detect→plan、
  manifest 無しだけ ingest から始める。id-stamp/autozoom は従来どおり末尾に維持。
- `/api/run`、heavy-job 多重抑止、`runNeedsForce`、上書き確認/backups force、進捗 toast、
  「AI に初版を作らせる」UI を実装した。
- schema/examples/docs/contract を追随し、generatedBy は cutplan approval hash に
  混入しないことを固定した。
- 主担当が独立に実測したゲート:
  - `npm run typecheck`: PASS
  - `npm test`: **2718 / 2718 PASS**
  - manifest 有無の dependency-injected run 順序、marker 完全一致/安全側判定: PASS
  - GUI/apply marker 除去、approval hash 不変、schema: PASS
  - 実サーバで既存 project が `runNeedsForce:true`、force無し `/api/run` が上書きを拒否
  - `node src/cli.ts run --help` の新しい定義と manifest 限定オプション文言を確認
  - `git diff --check`: PASS
- 次の一手は P4(inserts のタイムライン一級化)。
