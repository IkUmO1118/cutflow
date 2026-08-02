# 承認・書き出し・配信物

> 承認ゲートから render の高速化・負荷調整、サムネイルまで。
> 関連: [captions-layout.md](captions-layout.md) / [audio-bgm.md](audio-bgm.md) / [command-reference.md](command-reference.md) / [../usage.md](../usage.md)

## 承認(approve/unapprove)

**承認の実体は `approved` という boolean ではなく `approvals.json`**
(収録フォルダ直下の別ファイル。触らない第3カテゴリ)。`render` はこの
ファイルの承認レコードだけを見る **strict なゲート**で、`cutplan.json` の `approved: true` を書くだけでは通らない。

```jsonc
// approvals.json(自動生成。人間や AI が直接書かない)
{
  "version": 1,
  "cutplan": { "hash": "sha256:…", "approvedAt": "2026-07-07T…", "by": "cli" }
}
```

- `hash` は **cutplanの keep 集合**(`mergeIntervals`
  後・ms 丸め)から決定論で計算した sha256。`reason` や cut セグメント、
  境界を保ったままの分割(GUI の分割編集)は keep 集合を変えないので
  hash は変わらない。overlays / transcript / bgm の編集も承認スコープ外
  (承認は「cut の出来」だけに束縛される、というのが今日までの運用と同じ
  意味になるよう設計されている)
- **keep 集合そのものが変わる編集をすると hash が不一致になり、
  承認は自動失効する**。古い内容のまま render されることはない
- 承認・取消は専用コマンドで行う:
  ```sh
  node src/cli.ts approve <dir>                    # 本編を承認
  node src/cli.ts approve <dir> --yes               # 非対話環境でも承認する(意図的バイパス)
  node src/cli.ts unapprove <dir>  # 承認を取り消す
  ```
  `approve` はまず `validate` を通し(エラーがあれば承認しない)、
  端末が対話環境(TTY)なら preview 確認の y/N プロンプトを挟む。
  **非対話環境(Bash からの実行・子エージェント等)では `--yes` が無いと
  拒否される**——「承認して」と頼まれても AI が反射的に承認を通すことは
  ない。承認できたら `approvals.json` にレコードを書き、
  `cutplan.approved`を `true` に同期する
  (boolean は表示用に揃えるだけで、判定には使わない)
- GUI エディタのチェックボックス+保存でも同じレコードが作られる
  (`by: "gui"`)。UI 側の操作感は変わらない
- 過去(この機能導入前)に `approved: true` で承認済みだったフォルダは、
  `approvals.json` を持たないため次の `render` で拒否される。
  `node src/cli.ts approve <dir>` を1回実行すれば復旧する(データ破壊なし・
  冪等)。`validate` はこの状態(`approved: true` なのにレコードが無い/
  陳腐化している)を警告するので、render を待たずに気づける

**AI 向けの注意**: `approvals.json` は自分で作成・編集しない。承認は
`approve` コマンドか人間の GUI 操作でのみ行う(CLAUDE.md 参照)。


## render の高速化(config.yaml `render.hardwareAcceleration`)

`render` の Remotion 合成段は `if-possible`(既定)で GPU ハードウェア
エンコーダ(macOS は VideoToolbox)を使い、`disable` で従来のソフトウェア
エンコードに戻せる。`if-possible` はハードウェアエンコーダが使えない
環境では自動でソフトウェアエンコードにフォールバックする(エラーには
ならない)。

`proxy.mp4` / `preview.mp4` は config.yaml `preview.videoEncoder`(既定
`videotoolbox`)で同じくハードウェアエンコーダを使う。生成時間は
`libx264` とほぼ同じだがファイルサイズが小さい。`libx264` を指定すると
従来の ultrafast+CRF に戻る。

## render 中のマシン負荷(config.yaml `render.offthreadVideoCacheMb` / `render.concurrency`)

render 中に Mac 全体が重くなる主因はメモリで、Remotion の OffthreadVideo
フレームキャッシュは既定で「利用可能メモリの半分」まで成長する(16GB 機では
compositor 単体が数GB)。FrameWright は既定でこれを
`render.offthreadVideoCacheMb: 512`(MB)に制限する。render 速度は変わらず、
render 中のスワップ・他アプリの鈍化を防ぐ。`0` で Remotion 既定(無制限)に戻せる。

`render.concurrency` は Remotion の並列レンダータブ数(省略時は Remotion
既定=CPU コア数の半分)。1タブ ≈ 350〜400MB なので、render 中のメモリを
さらに絞りたいときだけ下げる(速度と引き換え)。

どちらも出力の画・音には影響しないため render キャッシュ
(`render.key.json`)のキーには含まれない=変更しても `final.mp4` の
再生成は誘発されない。本編・チャンク差分の render 経路に
同じ値が効く。

また、テロップ既定フォント(Noto Sans JP)は `remotion.config.ts` で
バンドルへ data URL 焼き込み(asset/inline)している。Remotion 既定の
HTTP 配信(asset/resource)だと、render 中の OffthreadVideo フレーム抽出が
同一ホストへの Chrome の同時接続枠(6本)を占有し、フォント取得が接続待ちの
まま `delayRender` タイムアウト(`Loading Noto Sans JP ... not cleared`)で
render 全体が落ちることがある。


## 旧 shorts.json と縦動画への移行

旧 `shorts.json` は削除済み機能のデータで、FrameWright は読み書きも自動削除もしない。
`validate` は移行警告を1件出すだけで成功する。既存の `shorts.json` / `shorts/` /
`cut.*.mp4` が不要なら、人間が確認して手で削除する。縦動画はP1以降の
キャンバスを使い、独立した9:16プロジェクトとして作成する。

## サムネイル生成(thumbnail.json)

収録フォルダに `thumbnail.json` を書くと、`thumbnail` コマンドで
サムネイル静止画(`thumbnail.png`)を書き出せる。

```jsonc
{
  "t": 754.2,
  "texts": [
    { "text": "配線1本で\n直った", "pos": { "x": 640, "y": 400 },
      "style": { "fontSizePx": 160, "color": "#ffff00", "outlineColor": "#000000" } }
  ]
}
```

- `t` は元収録の秒。**frames と違いスナップしない**: カットされた瞬間
  (`cutplan.json` で cut にした区間)も指定できる(サムネは動画に入って
  いない絵を使ってもよい)
- `texts[]` は表示するテキスト要素の配列(複数指定で見出し+補足など重ねられる)。
  `pos`(`{x, y}`: 出力px のテキスト中心)は必須(サムネに「既定の下部中央」は
  無い)。`style` は transcript のテロップと同じ `CaptionStyle`
  (`fontSizePx` / `color` / `outlineColor` / `outlineWidthPx` / `fontFamily` /
  `fontWeight` / `background` / `anim` / `karaoke`)を共有する(動画と見た目の言語を揃える
  ため)。`anim` / `karaoke` は静止画には意味を持たない(サムネ生成は無視する。
  構文検査は通るが害はないので書いても構わない)
- 合成は最終レンダーと同じ見た目機構を通す: keep は全編(カットの有無を
  問わずどの瞬間も使える)、テロップは `texts` のみ(`transcript.json` は
  使わない)、`overlays.json` の `wipeFull` / `zooms` / `colorFilter` は
  本編と同じに乗る(素材オーバーレイ・インサート・字幕非表示・レイヤー順は
  対象外)
- ベースは `frames` のプロキシ経路と違い**元収録のフル解像度**を使う
  (静止画1枚の可読性が命なので proxy 品質では出さない)
- `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格)。キャッシュは
  作らない(1枚の still は数秒で済むため)

```sh
node src/cli.ts validate <dir>     # t・texts・pos・style を検査
node src/cli.ts thumbnail <dir>    # thumbnail.png を書き出す
```

**v1 の制限**: エディタ(GUI)対応はしていない。`thumbnail.json` を直接編集
→ `validate` → `thumbnail` 再実行 → Read で確認、の AI/CLI ループで完結させる。


