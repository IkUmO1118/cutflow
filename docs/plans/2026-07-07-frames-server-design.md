# frames の stale-PNG 対策 + 常駐フレームサーバ — 設計

*2026-07-07 / 診断レビュー「D. 高速フィードバックループ」#3 の設計。実装は別担当(Sonnet)。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ D「高速フィードバックループ」/ 項目「`frames` の stale-PNG 罠 +
> 毎回コールド再バンドル」= severity **minor** / effort **S**。
>
> 2 つの**独立した**課題を扱う。片方だけでも価値が出るので、コミット・タスクを
> 完全に分離する(前半=stale-PNG 対策、後半=常駐サーバ)。**どちらも既存の
> `frames` 出力(既存フラグでの PNG・OCR サイドカー)を 1 バイトも変えない。**

---

## 背景とギャップ

`frames` は「AI の目」。AI は JSON を編集し、`frames` で撮り直した PNG を Read して
自分の編集結果を確認する(編集ループ: JSON 編集 → `validate` → `describe`/`frames`
→ 人間に preview)。ここに 2 つの摩擦がある。

### 課題1: stale-PNG 罠(effort 小・独立)

`frames` は実行のたびに `frames/*.png`(と `--ocr` の `*.ocr.json`)を**全削除して
撮り直す**。ファイル名が出力秒ベース(`out<sec>s.png`)で、cutplan 編集により時刻の
写像が変わると旧ファイルが別名のまま残って事故るため——という設計意図が
`frames.ts` 冒頭に明記されている。つまり「**撮り直せば正しい/撮り直さないと古い**」。

罠は `frames` の中ではなく外にある。**AI が JSON を編集したのに `frames` を呼ばず、
古い PNG を Read して編集前の絵を見る**ケース。`frames` 自身は毎回全再生成するので
安全なのに、`frames` を*経由しない*読み取りには何の歯止めもない。`CLAUDE.md` も
「編集したら必ず撮り直す」と注意書きするだけで、コードでは検出できていない。

### 課題2: 毎回コールド再バンドル(effort 中)

`frames()` は 1 回の呼び出しの中では bundle(@remotion/bundler の webpack)と
headless Chrome(openBrowser)を**1 回だけ**用意して全フレームで使い回している
(`frames.ts:206-216`)。しかし CLI は毎回新プロセスなので、**プロセスをまたぐ再利用が
無い**。微調整ループ(JSON 編集 → `frames --t 90` → 確認 → JSON 編集 → `frames --t 90`
…)は毎回 webpack バンドル + Chrome 起動 + composition 選択のコールドコストを払う。
AI の編集ループはまさにこの「同じ props 近傍で何度も撮り直す」形なので効きやすい。

---

## 課題1: stale-PNG 対策

### 論点1-A: 検出方式 → **決定: (a) 撮影時の入力フィンガープリントを `frames/index.json` に記録し、AI が普段から叩くコマンド(`validate` / `describe`)が「JSON と食い違い」を警告する**

比較:

| 案 | 中身 | 判定 |
|---|---|---|
| **(a)** | frames 実行時に、その撮影の入力(編集 JSON 群)の**内容ハッシュ**を `frames/index.json` に刻む。`validate`/`describe`(AI が編集後に必ず/最初に叩く)が現在の JSON のハッシュと突き合わせ、食い違えば「frames を撮り直せ」と警告 | **採用** |
| (b) | PNG のファイル名 or メタに撮影時ハッシュを埋める | **却下**。罠は「frames を*呼ばずに*古い PNG を読む」ケース。frames は既に全消し+再生成するので、名前にハッシュを足しても「読む側」には何も伝わらない。AI が自分でハッシュ照合しない限り無力=課題を解けていない |
| (c) | mtime だけで判定(index に mtime を記録) | **却下寄り**。git checkout・エディタの無変更再書き込み・touch で mtime は動く=偽陽性。小さい JSON なら**内容ハッシュ**が決定論的で正確。`proxyCache.ts` が raw 動画に mtime+size を使うのは巨大バイナリを毎回ハッシュできないからで、数 KB の JSON は素直に内容ハッシュでよい |

**決定と理由**

- 罠の本質は「**編集した/撮り直していない**の乖離を、AI が PNG を Read する前に気づけない」
  こと。したがって対策は **AI が編集直後に必ず通る地点で警告を出す**ことに尽きる。
- `CLAUDE.md` の編集ループは「JSON 編集 → **`validate`(必ず実行)** → `describe`/`frames`」。
  `validate` は編集後に**必ず**叩くよう義務づけられている最高トラフィックの地点で、
  ここで「frames が古い」と出れば、AI が古い PNG を Read するより手前で捕まえられる。
  `describe` は「JSON を全部読むより先にこれを見る」オリエンテーション地点なので、
  frames を見る直前の警告として自然。**両方に薄く出す**(共有ヘルパー 1 本+呼び出し 2 箇所)。
- (b) は「読む側に伝わらない」ため課題そのものを解けない。(c) は偽陽性で「オオカミ少年」化し、
  無駄な再バンドル(数十秒)を誘発するので内容ハッシュにする。

### 論点1-B: フィンガープリントに何を含めるか → **決定: 経路(本編/ショート)ごとに、その撮影の絵を決める編集 JSON 群の内容ハッシュだけ**

frames の絵を決める入力のうち、**AI が手編集するファイル**だけを対象にする(罠は
「AI が JSON を編集して撮り直さない」なので、それ以外は対象にしない)。

- 本編経路(`--short` なし): `cutplan.json` / `transcript.json` / `overlays.json`
- ショート経路(`--short <name>`): `shorts.json` / `transcript.json` / `overlays.json`
  (ショートは cutplan 非依存、overlays は colorFilter のみ継承だが、簡潔さのため
  overlays 全体をハッシュする=偽陽性は「撮り直しを促す」安全側なので許容)

**含めないもの(意図的)**:

- `manifest.json`(読み取り専用・編集で変わらない)。
- `config.yaml`(caption サイズ等は frames の絵に効くが、config 編集は稀で、かつ
  エディタ設定画面経由だと proxy 再生成が挟まる別経路。今回の罠=「JSON 手編集の
  撮り直し漏れ」からは外れるので**スコープ外**とし、**既知の限界として doc と警告文に
  明記**する。将来 config スライスのハッシュを足すのは容易)。
- proxy.mp4 / raw(`isProxyStale` が別途面倒を見ており、frames は実行時に自動再生成する)。

`frames/index.json` は撮影が何だったか(モード・`--short` 名・`--ocr`・`--full-res`・枚数)も
記録する。これは**古さ判定には使わない**が、`describe` が「今 frames/ に入っているのは
`--short intro` の `--every` 撮影・6 枚」のように**何の絵かを添える**のに使う(本編を
見ているつもりでショートの PNG を読む取り違えの予防。情報提供のみ)。

### 論点1-C: 検出の状態機械 → **決定: none / fresh / stale の 3 値。`index.json` 未生成は「未生成」で警告しない(proxy と同じ思想)**

- `frames/index.json` が無い(この機能導入前の frames、または未撮影)→ `none`。
  **警告しない**(古いと断言できない)。`isProxyStale` が「proxy 未生成 → 陳腐化ではない」
  とするのと同じ判断。
- 記録した各入力ファイルの現在の内容ハッシュが全て一致 → `fresh`(何も出さない)。
- 1 つでも食い違い(または記録済みファイルが今は消えている)→ `stale`。
  警告に**変わったファイル名**を列挙する(例: 「frames は cutplan.json より古い時点で
  撮影されています。frames を撮り直してください」)。

---

### 課題1 スキーマ / インターフェース

#### `frames/index.json`(frames が撮影後に書く。実行ごとに上書き。全消し対象外)

```jsonc
{
  "capturedAt": "2026-07-07T02:30:00.000Z",
  "shot": { "mode": "every", "short": null, "ocr": false, "fullRes": false, "count": 6 },
  "inputs": {
    "cutplan.json":   "sha256:ab12…",
    "transcript.json":"sha256:cd34…",
    "overlays.json":  "sha256:ef56…"
  }
}
```

- `props.json` と同じ位置づけ(中間生成物。`frames` 実行のたびに書き直す)。
- **`.png`/`.ocr.json` の全消しループの対象にはしない**(`props.json` と同様に生き残らせ、
  次回上書き)。frames.ts の削除ループは今も `.png`/`.ocr.json` だけ消す=変更不要。

#### 新規: `src/lib/framesIndex.ts`(純関数中心・単体テスト可能)

```ts
export interface FramesIndex {
  capturedAt: string;
  shot: { mode: string; short: string | null; ocr: boolean; fullRes: boolean; count: number };
  inputs: Record<string, string>; // ファイル名 → "sha256:<hex>"
}

// 純関数(テスト対象)
export function relevantInputs(shortName?: string): string[];        // 経路別の対象ファイル名
export function hashContent(content: string): string;               // "sha256:<hex>"
export function diffFingerprint(                                     // 食い違ったファイル名
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[];

// 不純な薄いシェル(bench で手動検証)
export type Freshness =
  | { state: "none" }
  | { state: "fresh"; shot: FramesIndex["shot"] }
  | { state: "stale"; changed: string[]; shot: FramesIndex["shot"] };
export function framesFreshness(dir: string): Freshness;            // index.json を読み現在と照合
export function writeFramesIndex(dir: string, shot: FramesIndex["shot"]): void; // frames が呼ぶ
```

- ハッシュは `node:crypto` の sha256(小さい JSON なので決定論的で十分安い)。
- `framesFreshness` は `relevantInputs`(記録された `inputs` のキー)ぶんだけ現在の内容を
  読んでハッシュし直し `diffFingerprint`。存在しないファイルは「変化」に数える。

#### 検出の露出(純粋コアは汚さない)

- **`validate`**: `src/stages/validate.ts` の **`validate(dir)`(fs を読む不純ラッパー・52 行目)**に
  `framesFreshness(dir)` を追加し、`stale` なら `result.warnings` に 1 件 push する。
  **単体テスト済みの純粋コア `validateDocs`(93 行目)は触らない**=既存テスト不変。
- **`describe`**: `describe(dir)` の末尾に `framesFreshness(dir)` の結果を 1〜2 行で添える
  (`stale` なら撮り直し勧告、`fresh`/`none` なら「frames/: `--short intro` の every 撮影・6 枚」等の
  現況 or 無表示)。
- 文言に「config 変更は検出対象外」の一言を含める(論点1-B の既知の限界)。

---

### 課題1 タスク分解(1 タスク = 1 コミット)

#### タスク A1: `framesIndex.ts` + frames が `index.json` を書く
- **変更**: `src/lib/framesIndex.ts`(新規)、`src/stages/frames.ts`(撮影後に `writeFramesIndex`)、
  `test/framesIndex.test.ts`(新規)。
- **中身**: 純関数(`relevantInputs`/`hashContent`/`diffFingerprint`)を実装。frames.ts は
  render ループ後、`props.json` を書くのと同じ並びで `writeFramesIndex(dir, shot)` を呼ぶ
  (`shot.count` は実際に撮った枚数=`unique.length`、`short`/`ocr`/`fullRes` は引数から)。
- **テスト**: `test/framesIndex.test.ts`(node --test)で純関数を固定 — `relevantInputs` の
  経路別集合、`diffFingerprint`(一致/1 件変化/ファイル欠落)、`hashContent` の決定論性。
  fs 依存(`framesFreshness`)は bench 手動検証に回す。
- **壊してはいけない**: `index.json` は**新規に書くだけ**でまだ誰も読まない=既存の
  frames 出力(PNG・OCR・stdout・全消し挙動)は完全に不変。`index.json` は全消しループの
  対象に**しない**(`.png`/`.ocr.json` のみ削除のまま)。

#### タスク A2: `validate` / `describe` に staleness 警告を配線
- **変更**: `src/stages/validate.ts`(`validate(dir)` ラッパーに 1 件 warning を足す)、
  `src/stages/describe.ts`(末尾に現況/勧告行)、必要なら `test/validate.test.ts` /
  `test/describe.test.ts` に「index が無ければ何も足さない(`none`)」の固定。
- **中身**: 両者から `framesFreshness(dir)` を呼ぶ。`stale` → 警告、`none`/`fresh` → describe は
  現況の 1 行(informational)・validate は無表示。
- **テスト**: `framesFreshness` が `none` を返すケース(index.json 無し)で validate の warnings が
  従来と変わらないことを単体で固定。`stale` 系の実挙動は bench 手動検証。
- **壊してはいけない**: **`validateDocs`(純粋コア)は無改造**=既存の validate 単体テスト群が緑。
  index.json が無い既存の収録では警告が 1 件も増えない(後方互換)。

#### タスク A3: ドキュメント同期
- **変更**: `CLAUDE.md`(中間生成物一覧に `frames/index.json`=撮影入力のフィンガープリント・
  古さ判定用を追加。`props.json` と同じ扱い。「編集したら撮り直す」節に「`validate`/`describe` が
  古い frames を警告する」を追記)、`docs/usage.md`(frames の項)。
- **テスト**: なし(doc)。`validate` が無関係に緑であることだけ確認。
- **壊してはいけない**: 記述とコードの一致。

---

## 課題2: 常駐フレームサーバ

### 論点2-A: サーバの形 → **決定: opt-in の常駐デーモン `frames-serve <dir>`(bundle+browser を暖める)+ `frames` の自動検出フォールバック。1 デーモン = 1 収録**

比較:

| 案 | 中身 | 判定 |
|---|---|---|
| **(a) 常駐 HTTP デーモン** | `frames-serve <dir>` が bundle+browser を保持。`frames <dir> --t …` は portfile を見てデーモンへ POST、無ければ従来の単発実行 | **採用**。AI の編集ループは**別プロセスの CLI 呼び出しの連続**なので、プロセスをまたいで暖まった bundle+browser を再利用するにはプロセス間チャネル(=ローカル HTTP)が要る。`editor/server.ts` の localhost スケルトンをほぼ流用できる |
| (b) 同一プロセスの watch/REPL(`frames --watch`) | 1 プロセスが bundle+browser を暖めたまま、ファイル変更 or プロンプトで撮り直す | **縮小案として併記**。HTTP・portfile・プロセス間プロトコルが不要で最小。ただし**同一プロセスに居続ける人間**向けで、AI のツール呼び出し(毎回別プロセス)には効かない。人間がターミナルで回すときだけ有効 |

**決定と理由**

- 効かせたい相手は **AI の編集ループ**で、それは `frames` CLI の逐次起動=毎回別プロセス。
  暖めた資産をまたいで使うにはプロセス間チャネルが必須なので **(a)**。
- `editor/server.ts` が既に `node:http` + `127.0.0.1` バインド + Host/Origin 検査 +
  `requestTimeout = 0` + 長時間ジョブの保留 + `open` 起動を実装済み。**この土台を流用**して
  frames 用の最小サーバを作る(SSE・アップロード・波形など editor 固有機能は要らない)。
- **1 デーモン = 1 収録**に絞る(最小)。`bundle({ publicDir: dir, symlinkPublicDir: true })` は
  dir 固有なので、別 dir を捌くには再バンドルが要る=収録ごとに別ポートのデーモンを立てる。
  複数収録の同時対応は今回スコープ外。

### 論点2-B: 何を暖め、何を毎リクエスト作り直すか → **決定: bundle + browser を暖め、config・JSON・props は毎リクエスト読み直す**

`frames()` のコストの内訳と扱い:

| 資産 | 依存 | 扱い |
|---|---|---|
| **bundle(serveUrl)** | `remotion/` のソースだけ(cfg・JSON・proxy には非依存) | **暖める**。remotion コードが変わらない限り有効 |
| **browser(openBrowser)** | なし | **暖める**。クラッシュ時のみ作り直す |
| composition(selectComposition) | props(=毎回変わる) | **毎リクエスト選び直す**(bundle+browser があれば軽い) |
| **config** | `config.yaml` | **毎リクエスト `loadConfig`**(caption サイズ等の編集を即反映) |
| props / keeps / overlays / captions | 編集 JSON | **毎リクエスト `buildRenderProps`**(単発と同じ・鮮度は常に最新) |
| proxy.mp4 | raw + 焼込設定 | **毎リクエスト `isProxyStale` 判定→必要なら再生成**(単発と同じロジックを共有)。served は publicDir symlink 経由で毎回ディスクから読むので再生成は自動で反映 |

**要点**: デーモンは**設定と JSON を毎回ディスクから読み直す**ので、**config 編集・JSON 編集は
常に最新の絵になる**(暖めるのは remotion コードにしか依存しない bundle と、無依存の browser だけ)。
単発実行と出る絵は同一。

### 論点2-C: 寿命・無効化 → **決定: bundle は remotion ソースの mtime で自動再バンドル、browser はクラッシュ時再生成、デーモンは Ctrl+C 終了(editor と同じ)**

- **bundle**: `MEMORY.md`「Remotion の webpack バンドルキャッシュが陳腐化する」の実例がある。
  デーモンはバンドル時に `remotion/` 配下の最大 mtime を記録し、リクエスト時にそれより新しい
  変更があれば**再バンドル**(必要なら `node_modules/.cache/webpack` を消してから=陳腐化回避)。
  frames の対象は JSON 微調整なので、remotion コード編集はまれ=通常は再バンドルしない。
  代替として `editor` の「サーバ再起動まで反映されない」流儀(`MEMORY.md` editor-bundle-restart)に
  倣い「remotion を触ったらデーモン再起動」と割り切る手もあるが、**自動 mtime 再バンドルの方が
  事故りにくい**ので採用(実装が重ければ「再起動してね」の警告表示にフォールバック可)。
- **browser**: renderStill が落ちたら 1 度だけ `openBrowser` し直してリトライ。恒常化はしない。
- **デーモン終了**: `editor` と同じく Ctrl+C。アイドルタイムアウト自動終了は将来の任意拡張として
  名前だけ残す(メモリを解放したい人向け)。

### 論点2-D: フォールバックと opt-in → **決定: portfile 検出。無ければ従来の単発実行と 1 バイトも変わらない**

- デーモンは起動時に `frames/.serve.json`(仮)へ `{ port, pid }` を書く(収録フォルダ内)。
- `frames <dir> …` CLI は: **portfile があり ping に応答**すれば、撮影リクエスト(モード・
  `--t/--captions/--every`・`--short`・`--ocr`・`--full-res`)を JSON で POST し、返ってきた
  `FrameShot[]` を**今と同じ体裁で** stdout に出す。**portfile が無ければ existsSync 1 回だけ
  余分に払って**、あとは**現在の in-process 経路そのまま**(bundle+browser を自前で用意して単発)。
- **opt-in・既定不変の担保**: デーモンは明示的に `frames-serve` を叩いたときだけ立つ。立っていなければ
  `frames` の挙動・出力・PNG バイト列・stdout は**現状と完全一致**(唯一の差は portfile の
  existsSync 1 回)。デーモン経由でも単発でも**同じ純粋コアが同じ props で同じ PNG を書く**ので
  出る絵は不変。

### 論点2-E: セキュリティ → **決定: `editor/server.ts` と同じ localhost 限定**

`127.0.0.1` バインド、Host/Origin 検査(`editor/server.ts:176-184` の正規表現を流用)、
`requestTimeout = 0`(proxy 再生成やレンダーで保留するため)。ローカル単一利用なので
スローロリス対策不要も editor と同じ。ポートは既定(例 4311・editor は 4310)+ portfile 記録。

---

### 課題2 スキーマ / インターフェース

#### CLI
```sh
node src/cli.ts frames-serve <dir>          # 常駐デーモン起動(bundle+browser 暖機)。Ctrl+C 終了
node src/cli.ts frames <dir> --t 90          # デーモンがあれば接続、無ければ従来の単発
node src/cli.ts frames <dir> --every 10 --ocr
```

#### デーモンのリクエスト/レスポンス(ローカル HTTP JSON)
```jsonc
// POST /frames  (body = 撮影リクエスト)
{ "mode": "times", "times": [90], "axis": "source",
  "short": null, "ocr": false, "fullRes": false }
// 200 レスポンス
{ "shots": [ { "requested": 90, "outSec": 66.93, "file": "…/frames/out66.93s.png",
               "note": "…", "ocrFile": null } ] }   // = FrameShot[] をそのまま
```
`FrameRequest` は既存の型(`src/stages/frames.ts` の discriminated union)をそのまま JSON 化。

#### 純粋コアの切り出し(タスク B1 で行う behavior-identical リファクタ)
現 `frames()` を 2 段に割る:
```ts
// bundle+browser を「注入」される撮影コア(単発もデーモンも共有)
async function renderFrames(
  dir, req, cfg, opts: { short?; ocr?; fullRes? },
  warm: { serveUrl: string; browser: Browser },
): Promise<FrameShot[]>;   // props 構築・proxy 陳腐化判定・全消し・render ループ・index 書込

// 従来の公開 API(単発)。warm を自前で用意して renderFrames に委譲=挙動不変
export async function frames(dir, req, cfg, short?, ocr?, fullRes?): Promise<FrameShot[]> {
  await ensureBrowser();
  const serveUrl = await bundle({ … });          // 今と同じ
  const browser = await openBrowser("chrome");
  try { return await renderFrames(dir, req, cfg, {short,ocr,fullRes}, {serveUrl, browser}); }
  finally { await browser.close({ silent: true }); }
}
```
デーモンは `serveUrl`/`browser` を**起動時に 1 回作って保持**し、リクエストごとに
`loadConfig()` + `renderFrames(...)` を呼ぶ(browser は close しない)。

---

### 課題2 タスク分解(1 タスク = 1 コミット)

> 課題1(A1〜A3)とは**別コミット系列**。B1 は挙動完全維持のリファクタ(安全網)で、
> これ単体を先に入れておくと B2/B3 が小さくなる。

#### タスク B1: `frames()` を warm 注入コアに分離(behavior-identical リファクタ)
- **変更**: `src/stages/frames.ts`(`renderFrames(...)` を切り出し、`frames()` はそれへ委譲)。
- **中身**: bundle/openBrowser の生成を `frames()` に残し、props 構築〜render ループ〜
  `writeFramesIndex` を `renderFrames` に移す。**公開シグネチャ `frames(dir,req,cfg,short?,ocr?,fullRes?)`
  は不変**。
- **テスト**: 実データ(bench)で `frames --t 90` / `--every 10` / `--captions` / `--short` /
  `--ocr` / `--full-res` の出力(PNG バイト・枚数・stdout・`.ocr.json`)がリファクタ前後で一致。
  `npm run typecheck` / `npm test` 緑。
- **壊してはいけない**: **全既存フラグの frames 出力が 1 バイトも変わらない**(純粋な内部分割)。

#### タスク B2: `frames-serve` デーモン(bundle+browser 暖機)
- **変更**: `src/stages/framesServe.ts`(新規・`editor/server.ts` の localhost スケルトン流用)、
  `src/cli.ts`(`frames-serve <dir>` コマンド追加)。
- **中身**: 起動時 `ensureBrowser` + `bundle` + `openBrowser` を 1 回。`POST /frames` で
  body を `FrameRequest`+opts にパースし、`loadConfig()`(毎回)→ `renderFrames(dir, req, cfg, opts, warm)`
  → `{shots}` を返す。remotion ソース mtime を記録し変化時に再バンドル(論点2-C)。
  browser クラッシュ時 1 回再生成。`frames/.serve.json` に `{port,pid}` を書き、終了時に消す。
  Host/Origin 検査・`127.0.0.1`・`requestTimeout=0`。
- **テスト**: HTTP・Remotion 依存で unit しにくいので**実データ検証が主**(下記「実測検証」)。
  純粋に切れる部分(リクエスト body → `FrameRequest` のパース/バリデーション、remotion mtime
  比較)は関数化して `test/framesServe.test.ts` で固定。
- **壊してはいけない**: デーモンは**新規コマンド**=既存 `frames`/`validate`/その他に影響ゼロ。

#### タスク B3: `frames` CLI のデーモン検出 + フォールバック(opt-in 配線)
- **変更**: `src/cli.ts`(frames の action)。必要なら小さな client ヘルパ
  `src/lib/framesClient.ts`(portfile 読み → ping → POST)。
- **中身**: frames action は req 組み立て後、`framesClient` で portfile を見る。**応答すれば** POST して
  返った `FrameShot[]` を**現行と同じ体裁**で echo。**無ければ**従来どおり `frames(...)` を呼ぶ。
- **テスト**: portfile 無しでの単発経路が現行と完全一致(bench で `--ocr` 有無・`--short` 込み)。
  デーモン経路は「単発と同一の PNG・stdout が出る」ことを bench で照合(下記手順3)。
- **壊してはいけない**: **デーモン未起動時の frames は現状と 1 バイトも変わらない**(portfile の
  existsSync 1 回だけ増える)。デーモン経由の出力も単発と一致。

#### タスク B4: ドキュメント + 任意 config
- **変更**: `CLAUDE.md`/`docs/usage.md`(`frames-serve` の説明・microloop の使い方・
  「remotion を触ったら再起動」注意・中間生成物 `frames/.serve.json`)。ポートを変えたいだけなら
  `config.yaml` に `frames.serve.port`(任意)を足す程度に留める(有効化フラグは config に置かない
  =opt-in は「明示起動」で担保。`--full-res`/`--ocr` と同じ思想)。
- **テスト**: なし(doc)。
- **壊してはいけない**: 記述整合。`frames.serve` を書いていない config が今までどおり読める。

---

## ソロ保守に見合う複雑さの上限(推奨する進め方)

- **課題1(A1〜A3)は無条件でやる価値**がある — effort 小・独立・既存挙動不変・AI の
  「編集前の絵を見る」実害を直接塞ぐ。まずこれを入れる。
- **課題2(B1〜B4)は「微調整ループの遅さが実際に効いているか」を測ってから**。
  B1(リファクタ)だけ先に入れておけば低リスクで、後から B2/B3 を足せる。もし常駐デーモンが
  重い/リスキーと判断したら、**縮小案 (b) `frames --watch`(同一プロセスで bundle+browser を
  暖めたまま、ファイル変更で撮り直す人間向けループ)** に落とす選択肢を残す。ただし (b) は
  AI のツール呼び出し(毎回別プロセス)には効かない点を承知の上で。
- webpack バンドルキャッシュの陳腐化(`MEMORY.md`)は常駐化で顕在化しやすいので、B2 の
  remotion mtime 再バンドルは**手を抜かない**(ここを省くと「計算は正しいのに絵が古い」の
  再来になる)。

---

## 実装子が先に読むコード(シンボル名。行番号は先行マージでズレる)

- `src/stages/frames.ts` — `frames()` 本体・全消しループ(`.png`/`.ocr.json`)・
  bundle/openBrowser の生成箇所(206-216)・`props.json` 書込。課題1は撮影後に index を書く、
  課題2は 206-216 を warm 注入に割る。
- `editor/server.ts` — `startEditor()`/`handle()` の localhost サーバ骨格(`node:http`・
  Host/Origin 検査 176-184・`requestTimeout=0`・長時間ジョブ保留・`spawn("open")`)。B2 の土台。
- `src/lib/proxyCache.ts` + `src/stages/proxy.ts` — `buildProxyCacheKey`/`proxyCacheKeyEquals`/
  `isProxyStale`。**フィンガープリント/陳腐化判定の前例**(JSON.stringify 一致・「未生成→false」の思想)。
  課題1のハッシュ照合・課題2の proxy 再生成判定の手本。
- `src/stages/validate.ts` — `validate(dir)`(不純ラッパー・52)と `validateDocs`(純粋コア・93)の
  分離。**警告は前者にだけ足す**(後者のテストを割らない)。
- `src/stages/describe.ts` — `describe(dir)`。末尾に frames 現況/勧告を添える。
- `src/lib/config.ts` — `loadConfig()`(デーモンが毎リクエスト呼ぶ・`??=` 既定付与)。
- `src/lib/exec.ts` — `run()`(外部コマンド。proxy 再生成等)。
- `remotion/index.ts` — bundle の entryPoint。B2 の mtime 監視対象(`remotion/**`)。
- `MEMORY.md` — remotion-webpack-bundle-cache-stale / editor-bundle-restart /
  llm-command-verify-neutral-cwd(検証は中立 cwd + 絶対パス)。

---

## 実測検証(bench 収録)

検証対象: `~/Movies/cutflow/2026-07-02-whisper-bench`(raw mkv + manifest/cutplan/transcript/
overlays/proxy 一式・obs-canvas)。**中立 cwd から絶対パスで**走らせる(`MEMORY.md`)。

### 課題1(stale-PNG)
1. `frames <bench> --every 10` → `frames/index.json` が出る。`inputs` に cutplan/transcript/
   overlays のハッシュ、`shot` に `{mode:"every", count:…}` が入る。
2. 直後に `validate <bench>` / `describe <bench>` → **警告なし**(fresh)。describe は現況行を出す。
3. `cutplan.json` を 1 箇所編集(keep をわずかにトリム)→ `validate <bench>` → **「frames が
   cutplan.json より古い」警告**が出る。`describe` も撮り直し勧告。
4. `frames <bench> --every 10` で撮り直す → 警告が消える(fresh に戻る)。
5. `--short intro`(shorts.json があれば)で撮影 → `describe` が「frames/ は `--short intro`」と
   現況を添える(取り違え予防)。
6. **既存不変**: index.json 導入前と `frames --every 10` の PNG バイト・枚数・stdout・全消し挙動が
   一致。index.json が無い他収録では validate/describe に警告が増えない。`npm run typecheck`/`npm test` 緑。

### 課題2(常駐サーバ)
1. `frames-serve <bench>` を起動(bundle+browser 暖機)。別ターミナルで
   `frames <bench> --t 90` を**続けて数回** → 2 回目以降が体感で速い(bundle+Chrome を再利用)。
   デーモンのログに「再バンドルなし・browser 再利用」が出る。
2. **出力一致**: デーモン経由の `frames --t 90` の PNG バイト・stdout が、デーモンを止めた単発の
   `frames --t 90` と一致(同じ props → 同じ絵)。`--ocr`/`--full-res`/`--short`/`--captions`/
   `--every` の各フラグでも一致。
3. **鮮度**: デーモンを立てたまま `transcript.json` のテロップ文言を編集 → `frames --t 90` の
   PNG に**編集が反映**される(毎リクエスト props 再構築の確認)。`config.yaml` の
   `render.captionFontSizePx` を変えて再撮影 → **反映**される(毎リクエスト loadConfig の確認)。
4. **bundle 無効化**: デーモンを立てたまま `remotion/Main.tsx` を触る → 次の `frames` で
   **再バンドルが走り**、変更が絵に出る(`MEMORY.md` の陳腐化を踏まないこと)。
5. **フォールバック / opt-in**: デーモンを止める(portfile 消える)→ `frames --t 90` が
   従来の単発経路で成功し、出力が現行と完全一致。**デーモン未起動時に挙動・出力が変わらない**ことが
   opt-in 担保の核。
6. `npm run typecheck` / `npm test` 緑(B2/B3 で追加した純関数テスト含む)。

「速くなった」の判定 = 手順1で 2 回目以降が明確に短縮、かつ手順2・3・5 で**出る絵と鮮度が単発と
同一**であること(速さのために正しさを一切犠牲にしていない)。
