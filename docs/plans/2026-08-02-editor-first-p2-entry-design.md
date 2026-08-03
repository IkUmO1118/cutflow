# P2: 入口の編集器ファースト化 — 空フォルダで開き、ベースメディアを GUI で選ぶ

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: **P1 landing 推奨**(キャンバスをプロジェクト作成時に選ぶ動線と同じ場所に
出るため)。P1 未了でも実装は可能。

解決する欠落: 母艦 §1 の **(1) 空フォルダで開けない** と
**(2) ベースメディアを GUI で選べない**。

---

## 1. 現状の壁

```
editor <dir>
  └─ startEditor()                       editor/server.ts:138-147
       └─ bootstrapProjectWithLayout()   src/stages/bootstrap.ts:33
            └─ findSource(dir)           src/lib/findSource.ts:20
                 └─ メディア0本 → throw  findSource.ts:35
```

さらに `loadProject`(`editor/server.ts:1480-1494`)は manifest / transcript /
cutplan が揃っていないと **「先にパイプライン(run)を実行してください」** と
throw する。この文面自体が編集器ファーストと矛盾している。

`findSource` の暗黙ヒューリスティック(`findSource.ts:26-63`)の問題:

| 状況 | 現在の挙動 | あるべき挙動 |
|---|---|---|
| メディア0本 | throw(`:35`) | **エディタが開き、「メディアを追加」を促す** |
| 動画1本 | それを使う | 同じ(妥当) |
| 動画が複数 | `raw.*` 優先、無ければ**先頭を黙って採用**+警告(`:56-62`) | **人間に選ばせる** |
| 音声が複数(動画0本) | **ハードエラー**(`:49-54`) | **人間に選ばせる** |

## 2. 設計 — `findSource` を「列挙」と「選択」に割る

`src/lib/findSource.ts` を次の3つに再構成する。**既存の `findSource` の
シグネチャと戻り値は変えない**(CLI の全経路が呼んでいるため)。

```ts
/** ベースメディアの候補を、除外規則を適用したうえで列挙する(純関数に近い読み取り)。
 *  除外規則は現行のものをそのまま使う: ドットファイル / ".tmp." を含む名前 /
 *  fileRole==="generated" / final.mp4 / bgm.{mp3,m4a,wav} */
export interface SourceCandidate {
  file: string;
  kind: "video" | "audio";
  /** manifest.source が既にこれを指しているか */
  current: boolean;
}
export function listSourceCandidates(dir: string): SourceCandidate[];

/** manifest.source が実在すればそれ、無ければ候補が一意なときだけ自動選択。
 *  一意でない/0本のときは null を返す(**throw しない**) */
export function resolveSource(dir: string): string | null;

/** 既存 API。resolveSource が null のとき、現行と同じ文面で throw する。
 *  CLI の全経路(ingest / run / bootstrap)はこれを呼び続ける */
export function findSource(dir: string): string;
```

**「候補が一意なときだけ自動選択」**へ変えることで、動画が複数あるときの
「先頭を黙って採用」(`:56-62` の実害を招きうる挙動)が消える。
`raw.*` 優先ルールは**残す**(OBS 収録の既定名で、一意とみなしてよい)。

### 決定規則(`resolveSource`)

1. `manifest.source` が実在 → それ
2. 候補0本 → `null`
3. 候補1本 → それ
4. 候補に `raw.*` がちょうど1本 → それ
5. それ以外 → `null`(= 人間に選ばせる)

## 3. 「ベースメディア未確定」を正常な状態にする

### 3.1 bootstrap

`bootstrapProjectWithLayout`(`src/stages/bootstrap.ts:33`)を、
**ベースメディアが決まっていないときは何も書かずに正常終了**するよう変える。

```ts
export async function bootstrapProjectWithLayout(dir, cfg, layout): Promise<void> {
  if (!existsSync(join(dir, "manifest.json"))) {
    const source = resolveSource(dir);
    if (source === null) return;   // ← 追加。メディア未確定 = 正常状態
    manifest = await ingest(dir, source, cfg, layout);
  }
  // …以降は現行どおり(transcript / cutplan の補完)…
}
```

transcript / cutplan の補完は **manifest がある場合のみ**行う
(`initialCutplan(manifest.durationSec)` が manifest を要求するため)。

### 3.2 `loadProject`

`editor/server.ts:1480` の throw を、**判別子つきの正常応答**へ置き換える。

```ts
export type ProjectData =
  | { state: "empty"; dir: string; candidates: SourceCandidate[]; dirFiles: string[] }
  | { state: "ready"; /* …現行の ProjectData の全フィールド… */ };
```

- `state: "empty"` を返すのは **manifest.json が無いときだけ**。
  manifest があって transcript / cutplan が無いのは bootstrap が必ず補うので
  起こらない(起きたら従来どおり throw = 本当の異常)
- `state: "ready"` の中身は現行と**完全に同じ**。既存クライアントの読み出しは
  判別子の分岐を1つ通るだけで済む

### 3.3 新しい API

```
POST /api/base-media   { file: string }
```

- `file` は `listSourceCandidates` が返した候補のいずれかでなければ拒否する
  (パストラバーサル対策。`basename` 済みの名前で厳密一致)
- 既に `manifest.json` がある場合は **409 で拒否**する。
  ベースメディアの差し替えは「別プロジェクトを作る」行為であり、
  既存の cutplan / transcript / overlays の番地がすべて無意味になるため。
  母艦 §4 決定3(キャンバス作成時固定)と同じ思想
- 成功時は `ingest` → `bootstrapProjectWithLayout` を順に実行し、
  `loadProject` の `state: "ready"` を返す

```
POST /api/upload?as=base
```

既存の `/api/upload`(`editor/server.ts:777`)に `as=base` を足す。
`as=base` のときは:
- 保存先が `materials/` ではなく**収録フォルダ直下**
- 拡張子の許可を `MATERIAL_EXT` ではなく**ベースメディアの許可集合**
  (mkv / mp4 / mov / mp3 / m4a / wav / aac / flac / ogg)にする
- 保存後に `POST /api/base-media` 相当の処理を続けて行う(1往復で完了させる)

`as` が無いときの挙動は**現行と完全に同じ**。

## 4. クライアント

`state: "empty"` のとき、タイムラインの代わりに**空プロジェクト画面**を出す:

- 「この動画の元になるファイルを選んでください」
- `candidates` が1件以上 → その一覧(ファイル名 / 種別 / 尺があれば尺)から選ぶ
- `candidates` が0件 → ドロップゾーン(`/api/upload?as=base`)
- どちらの経路でも、選択後は `state: "ready"` の応答でそのまま通常画面へ遷移する
  (**リロードを要求しない**)
- P1 landing 済みなら、この画面でキャンバスも選ばせる
  (`/api/base-media` に `canvas?: string` を足し、`ingest` へ渡す)

**この画面は「プロジェクトを作る」画面ではない**(それは P5 のランチャー)。
「開いたプロジェクトにまだ中身が無い」状態の表示である。

## 5. CLI 側の整合

- `editor <dir>` は、`dir` が存在しないときに**作ってから開く**
  (`mkdirSync(dir, { recursive: true })`)。現在は `resolveDir` が
  存在確認で落ちる想定なので、そこを緩める
- `ingest` / `run` の `findSource` 経由の挙動は**変わらない**
  (候補が一意でないときのエラー文面だけ、「エディタで選べます」への
  誘導を1行足す)
- `validate` / `describe` を manifest が無いフォルダで実行したときの
  エラー文面から「先に run」を外し、「`editor <dir>` でメディアを選ぶ」へ変える

## 6. テスト

**新規**:
1. `listSourceCandidates` の除外規則(ドット / `.tmp.` / generated / final.mp4 /
   bgm.*)が現行 `findSource` と一致する
2. `resolveSource` — 候補0本で `null` / 1本でそれ / 動画2本で `null` /
   `raw.mkv` + 他1本で `raw.mkv` / manifest.source 実在で常にそれ
3. `findSource` は `resolveSource` が null のとき**現行と同じ文面**で throw する
   (既存の `findSource` のテストが全部通ること = 後方互換の担保)
4. `bootstrapProjectWithLayout` が空フォルダで throw せず、
   **1バイトも書かない**(manifest / transcript / cutplan が作られない)
5. `loadProject` が manifest 無しで `state: "empty"` を返す
6. `POST /api/base-media` — 候補外のファイル名を拒否 / manifest 既存で 409 /
   成功時に manifest + transcript + cutplan が揃う
7. `POST /api/upload?as=base` が収録フォルダ直下に書き、`as` 無しは
   `materials/` に書く(現行のバイト等価)

**回帰**: メディアが1本あるフォルダで `editor` を開いたときの
`loadProject` の応答が、`state: "ready"` の追加を除いて現行とバイト等価。

## 7. 落とし穴

- **`bootstrapProject` の早期 return が transcript / cutplan の補完を飛ばす。**
  「manifest はあるが transcript が無い」既存収録が壊れないよう、
  early return は **manifest.json が無い場合のブロックの中**に置くこと
  (§3.1 の擬似コードの位置が正しい)
- **`prepareEditorDesignAssets`(`server.ts:148`)が manifest を要求する**
  可能性がある。`state: "empty"` のときはスキップする
- **ファイル監視(`watch(dir, …)`, `server.ts:178`)**: 空プロジェクトに
  メディアがドロップされたとき、`candidates` の変化をクライアントへ
  push できると体験が良い。必須ではない
- **`/api/upload?as=base` の上限**: `editor.maxUploadMb`(既定)は素材向けの
  値で、元収録は桁が違う。`as=base` のときは別の上限
  (`editor.maxBaseUploadMb`、既定を大きめに)を用意するか、
  上限を外す判断が要る。**この plan では別設定を足す**方針

## 8. 完了記録(2026-08-02)

- `listSourceCandidates` / `resolveSource` / `findSource` を分離し、通常ファイルだけを
  候補化した。sticky manifest、一意候補、一意の `raw.*` だけを自動解決し、曖昧なら
  GUI 選択へ送る。拡張子風ディレクトリと path traversal は候補外。
- 空 bootstrap は正常終了し、manifest / transcript / cutplan を1バイトも書かない。
  `loadProject` は `state:"empty" | "ready"` の判別 union を返す。
- `/api/base-media` と `/api/upload?as=base`、`editor.maxBaseUploadMb` を追加。
  候補外400、manifest既存409、アップロード上限413を守り、通常 upload は従来どおり
  `materials/` へ保存する。
- 未存在 dir の `editor` 起動、canvas 選択付き empty UI、選択/upload後の無 reload
  ready 遷移を実装。validate/describe の案内を editor-first の文面へ変更した。
- 主担当が独立に実測したゲート:
  - `npm run typecheck`: PASS
  - `npm test`: **2704 / 2704 PASS**
  - 空 bootstrap no-write、候補規則、400/409/413、通常 upload 回帰: PASS
  - 実サーバ `GET /api/project`: `state:"empty"`、候補空、canvas `square`
  - 実サーバ配信 bundle: empty UI / canvas 選択肢を確認
  - 空フォルダはサーバ起動後もファイル生成なし、`git diff --check`: PASS
- 次の一手は P3(`run` を AI 初版生成へ再定義)。
