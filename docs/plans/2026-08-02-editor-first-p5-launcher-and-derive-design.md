# P5: プロジェクトランチャーと派生プロジェクト — shorts の後継動線

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: **P0 landing 必須**(shorts が消えていること)。
**P1 landing 必須**(キャンバスが選べること。派生の主目的が別アスペクトのため)。
**P2 landing 必須**(空プロジェクトを開ける・ベースメディアを選べること)。

解決するもの: 母艦 §1 の **(4) プロジェクト一覧が無い** と、
母艦 §4 決定1 の**「複数出力 = 派生プロジェクト」の実体**。

---

## 1. 二部構成

この plan は独立した2つの機能を1つの段にまとめている。
**先に §2(ランチャー)だけを出荷してもよい。**

| 部 | 内容 | 依存 |
|---|---|---|
| §2 | プロジェクトランチャー(一覧・新規作成) | P2 |
| §3 | 派生プロジェクト(`derive`) | P1 + §2 |

## 2. プロジェクトランチャー

### 2.1 `editor` を引数なしで起動できるようにする

```sh
node src/cli.ts editor            # ランチャー(config.yaml の recordingsDir を開く)
node src/cli.ts editor <dir>      # 現行どおり、そのプロジェクトを直接開く
```

`src/cli.ts:1857` の `.command("editor <dir>")` を
`.command("editor [dir]")` にし、`dir` 省略時は `cfg.recordingsDir` を
**ランチャーモード**で開く。

`--detach` / `--stop` / `--status` はプロジェクト単位の機能なので、
**`dir` 省略時は使えない**(明示的なエラーで止める)。

### 2.2 サーバ

ランチャーモードのサーバは**プロジェクト用サーバとは別のプロセス構造にしない**。
同じ `editor/server.ts` が、`dir` の代わりに `rootDir` を持つモードで起動する。

追加 API:

```
GET  /api/projects            → ProjectSummary[]
POST /api/projects            { name, canvas?, layout? } → { dir }
```

```ts
export interface ProjectSummary {
  /** rootDir からの相対パス(= フォルダ名) */
  name: string;
  /** manifest.json があるか。無ければ「メディア未選択」 */
  hasManifest: boolean;
  /** manifest.durationSec。manifest が無ければ null */
  durationSec: number | null;
  /** manifest.canvas(P1)。省略時は "landscape" */
  canvas: string;
  /** final.mp4 が存在するか(= 書き出し済み) */
  rendered: boolean;
  /** フォルダの mtime(並び順に使う) */
  modifiedAt: string;
}
```

**列挙の規則**: `rootDir` の直下のディレクトリのうち、ドット始まりでないもの。
`manifest.json` の有無は問わない(P2 で空プロジェクトが正常状態になったため)。
`hyperframe-seeds/` と `style.probe/`(channel 直下に置かれる既存の生成物)は
**除外する**。除外リストは `src/lib/files.ts` に定数として置き、
将来 channel 直下に何かが増えたときの単一の出所にする。

`POST /api/projects` は:
1. `name` を `basename` + 危険文字置換で正規化(`saveUpload` の `safe` と同じ規則)
2. 既存フォルダと衝突したら 409
3. `mkdirSync` するだけ。**`ingest` は呼ばない**(メディアがまだ無い)
4. `{ dir }` を返し、クライアントはそのプロジェクトへ遷移する
   → P2 の `state: "empty"` 画面が出て、そこでメディアを選ぶ

### 2.3 クライアント

- カード一覧(フォルダ名 / 尺 / キャンバス / 書き出し済みバッジ / 更新日時)
- 更新日時の降順が既定
- 「新規プロジェクト」で名前 + キャンバス(P1 のプリセット一覧)を入力
- プロジェクトを開く = **同じサーバのプロジェクトモードへ遷移する**のではなく、
  **URL でプロジェクトを切り替える**(`/p/<name>`)。サーバは
  リクエストごとに `rootDir/<name>` を解決する

⚠️ **パストラバーサル**: `<name>` は必ず `basename` を取り、
`resolve(rootDir, name)` が `rootDir` の配下にあることを検証してから使う
(`editor/server.ts` に既にある `normalize` / `sep` を使った検証を写す)。

### 2.4 プロジェクトモードとの共存

現在のサーバは1プロジェクトに束縛され、`watch(dir, …)`(`server.ts:178`)で
そのフォルダだけを監視している。ランチャーモードでは:

- 監視対象は「現在開いているプロジェクト」。切り替え時に張り替える
- `writeEditorServeFile`(`:243`)は**プロジェクト単位**の情報なので、
  ランチャーモードでは書かない(`editor <dir> --status` の意味が壊れるため)
- `mcp <dir>` は1収録束縛のまま。**ランチャーは MCP に露出しない**

## 3. 派生プロジェクト(`derive`)

### 3.1 何をするコマンドか

```sh
node src/cli.ts derive <dir> --name <新プロジェクト名> \
    --canvas portrait --range 120-165 [--range 300-330]
```

`<dir>` のベースメディアと transcript を引き継いだ**新しいプロジェクト**を
`<dir> の親`/`<新プロジェクト名>` に作る。旧 `shorts.json` の1エントリが
していたことを、プロジェクトとして表現する。

| 旧 `Short` | 派生プロジェクトでの表現 |
|---|---|
| `name` | フォルダ名 |
| `profile` | `manifest.canvas`(P1) |
| `ranges` | `cutplan.json` の keep 群 |
| `captionTracks` | 派生先の `overlays.json` の `captionTracks` |
| `approved` / `approvals.shorts[name]` | 派生先の `approvals.json`(通常の cutplan 承認) |

### 3.2 ベースメディアの引き継ぎ — シンボリックリンク

`manifest.source` は「収録フォルダ内のファイル名」という不変条件を持つ
(`src/types.ts` の `Manifest.source`)。これを崩さずに元メディアを共有するため、
**元ファイルへのシンボリックリンクを派生フォルダ内に張る**。

```
2026-08-02-talk/          raw.mkv           ← 実体
2026-08-02-talk-short/    raw.mkv -> ../2026-08-02-talk/raw.mkv
```

- ローカルファースト・単一マシン前提なので symlink で十分
- ffmpeg / ffprobe / proxy 生成はすべて透過的に読める
- 失敗した場合(ファイルシステムが symlink 非対応)は**ハードリンク → コピー**の
  順にフォールバックし、どれを使ったかをログに出す
- **コピーは最後の手段**(元収録は大きい)

`findSource`(P2 の `listSourceCandidates`)は symlink を特別扱いしない。
`existsSync` は symlink をたどるのでそのまま通る。

### 3.3 引き継ぐもの / 引き継がないもの

| ファイル | 措置 | 理由 |
|---|---|---|
| ベースメディア | symlink | §3.2 |
| `manifest.json` | **`ingest` を新規実行**して作る | `canvas` が違う。`dir` フィールドも違う |
| `transcript.json` | **コピー**(id は再採番せずそのまま) | 同じメディアなので source 秒が完全に一致する。whisper の再実行は無駄 |
| `cutplan.json` | `--range` から生成(keep 群 + その間を cut) | 旧 `Short.ranges` の役割 |
| `overlays.json` | **コピーしない** | `pos` / `rect` / `blurs` / `annotations` / `zooms` はすべて出力px絶対で、キャンバスが変わると無意味。旧 shorts が blurs/annotations を継承しなかったのと同じ理由 |
| `bgm.json` | **コピーしない** | 区間が本編の構成前提。派生では選び直す |
| `chapters.json` / `meta.json` | **コピーしない** | 本編用の章立て・タイトル |
| `materials/` | **コピーしない** | 必要なら人間が置く。大きい |
| `approvals.json` | **作らない** | 承認は派生先で人間が改めて行う |
| `thumbnail.json` | コピーしない | 同上 |

**`--range` の解釈は元収録の秒**(旧 `Short.ranges` と同じ)。
複数指定でき、`mergeIntervals` で正規化してから keep にする。

生成する `cutplan.json`:
```jsonc
{
  "approved": false,
  "segments": [
    { "action": "cut",  "start": 0,   "end": 120, "reason": "派生プロジェクト: 範囲外" },
    { "action": "keep", "start": 120, "end": 165, "reason": "derive --range" },
    { "action": "cut",  "start": 165, "end": 600, "reason": "派生プロジェクト: 範囲外" }
  ]
}
```

`generatedBy: "bootstrap"` は**付けない**(P3)。`--range` は人間の意図であり、
`run` に上書きされてよい初期値ではない。

### 3.4 ガード

- 派生先フォルダが既にあれば**エラーで止める**(`--force` も用意しない。
  プロジェクトの上書きは常に危険)
- `--range` が1つも無ければエラー(全編の派生は「新規プロジェクトを作って
  同じメディアを選ぶ」で足りる)
- `--range` が元収録の尺を超えていればエラー
- `<dir>` に `manifest.json` が無ければエラー(元が未確定)

### 3.5 エディタからの派生

タイムラインで keep 区間を選択した状態から「この範囲で派生プロジェクトを作る」。

```
POST /api/derive   { name, canvas, ranges: [{start, end}, …] }
```

CLI の `derive` と**同じ関数**(`src/stages/derive.ts`)を呼ぶ。
成功後はランチャー経由で新プロジェクトへ遷移する。

`config.yaml` の `editor.defaultShortRangeSec`(P0 で削除)に相当する
「選択が無いときの既定レンジ」は**復活させない**。範囲選択は必須。

## 4. テスト

**ランチャー**:
1. `/api/projects` が rootDir 直下のディレクトリを列挙し、`hyperframe-seeds` /
   `style.probe` / ドット始まりを除外する
2. `manifest.json` の無いフォルダも `hasManifest: false` で列挙される
3. `POST /api/projects` — 名前の正規化 / 既存衝突で 409 / `ingest` を呼ばない
4. `<name>` のパストラバーサル(`../`、絶対パス)が拒否される

**derive**(`src/stages/derive.ts` の純ロジックを中心に):
5. `--range` から生成される cutplan が、keep 群 + その間の cut で
   元収録の尺を隙間なく覆う
6. 複数 `--range` が `mergeIntervals` で正規化される(重なり・逆順)
7. 引き継ぎ対象のファイルだけがコピーされ、`overlays.json` / `bgm.json` /
   `chapters.json` / `meta.json` / `approvals.json` が作られない
8. 派生先が既存ならエラー / `--range` 無しでエラー / 尺超過でエラー
9. symlink が張れない環境でハードリンク→コピーへフォールバックする
10. 派生先で `validate` がエラー0で通る

**5点セット**: `derive` はコマンド表面を増やすので **`AGENTS_CONTRACT.md` 必須**。
`docs/usage.md` に「縦動画の作り方」の節を新設し、旧 shorts の節から
リンクを張り替える。`CLAUDE.md` のコマンド一覧にも追加する。

## 5. 落とし穴

- **symlink と `clean`**: `clean` は元収録を削除対象にしないが、
  「remux 複製の検出」(`src/lib/remuxDup.ts`)が symlink を実体と誤認しないか
  確認する。派生フォルダには `.mkv` と `.mp4` が両方あることは通常無いので
  発火しないはずだが、**テストで1件固定する**
- **`manifest.dir` の絶対パス**: 派生先で `ingest` を新規実行するので
  正しい値が入る。**コピーで済ませようとすると `dir` が元のままになる**ので、
  必ず `ingest` を通すこと
- **transcript の id**: コピーすると元プロジェクトと同じ id を持つ。
  `@id` はプロジェクト内で一意であればよい(`src/lib/ids.ts`)ので**問題ない**。
  再採番するとむしろ「同じ発言を指す id が違う」ことになり不便
- **ランチャーの watch**: プロジェクト切り替えで `FSWatcher` を確実に
  `close()` すること。張りっぱなしだとファイルディスクリプタが漏れる
- **`recordingsDir` が存在しない**初回起動。`mkdirSync(recursive)` で作って
  空のランチャーを出す(エラーにしない)

## 6. 完了記録(2026-08-02)

- `editor [dir]` と同一サーバ内のランチャーモードを実装。`recordingsDir` の
  安全な直下列挙、更新順カード、空プロジェクト作成、作成時 canvas 選択を追加した。
- `/p/<name>/` でリクエストごとに project dir を解決し、API、media、SSE、metrics、
  engine preview を同じ prefix に束縛。名前の直下制約、percent-encoding 異常の 400、
  watcher の張り替え/close、launcher での serve file 非作成を実装した。
- CLI/API 共通の `deriveProject` を追加。source 秒 range を正規化した全尺被覆
  cutplan、symlink → hardlink → copy、派生先 ingest、transcript 継承、既存先/尺超過/
  range無し/manifest無し/transcript無しの作成前拒否を実装した。
- 選択中 keep からの派生UI、CLI help、usage、`CLAUDE.md`、`AGENTS_CONTRACT.md`
  を追随。派生source symlinkが clean/remux 対象にならないことも固定した。
- 主担当が独立に実測したゲート:
  - `npm run typecheck`: PASS
  - P5 focused tests: **10 / 10 PASS**
  - `npm test`: **2736 / 2736 PASS**
  - 実ランチャー: project 一覧、201 作成/名前正規化、`/p/<name>/` 配信と
    empty API、壊れた encoding の 400、名前衝突の 409、正常停止を確認
  - 実 CLI derive: 24秒素材から 2 keep / 3 cut、`raw.mp4 -> ../ready/raw.mp4`、
    `canvas:portrait`、意図したファイルだけを生成、`validate` **0 errors**
  - 本番エディタbundle: JS 10,725,994 bytes / CSS 167,724 bytes / HTML 905 bytes
  - `git diff --check`: PASS
- P0〜P5 の全フェーズが完了。
