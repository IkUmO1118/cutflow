# cutflow

撮影後の編集を自動化するローカルファーストな動画パイプライン。
収録1本 = 1フォルダ(例: `~/Movies/cutflow/2026-07-02-xxx/`)で、その中の
JSON がプロジェクトの正のデータ。**このリポジトリで「動画を編集して」と
頼まれたら、コードではなく収録フォルダの JSON を編集する。**

## AI が動画を編集するときの決まり

- 編集 = 収録フォルダ内の `cutplan.json` / `transcript.json` / `overlays.json` /
  `bgm.json` / `chapters.json` / `meta.json` / `shorts.json` / `thumbnail.json`
  の編集。動画ファイル自体は触らない
- **時刻はすべて「元収録(raw ファイル)の秒」**。カット後の時刻への換算は
  ツールが自動でやる。頭の中で引き算しないこと
- JSON を編集したら**必ず `node src/cli.ts validate <dir>` を実行**する。
  エラーが出たら直してから次へ進む(preview / render で数分かけて気づく
  壊れ方を数ミリ秒で検出できる)
- **`plan` と `run` は再実行禁止**(cutplan / chapters / meta と「章」トラックの
  テロップが LLM の生成物で上書きされ、手編集が消える)。明示的に頼まれた
  ときだけ、上書きされることを伝えてから実行する。生成物が既にあると
  `--force` なしではエラーで止まり、`--force` 時は実行前に手編集ファイルが
  `backups/<日時>/` へ退避される(誤って消えたら退避先から収録フォルダ直下へ
  コピーで復元)。**自分の判断で `--force` を付けない**。カットの手編集を
  保ったまま章立て・タイトル案・概要欄だけを作り直したいときは `plan` では
  なく `remeta`(cutplan は触らず、実行前に transcript / chapters / meta を
  `backups/` へ退避する)を使う
- **`cutplan.json` の `approved` を自分で true にしない**。承認は人間の仕事
  (preview か GUI エディタで確認してもらう)。`shorts.json` の各ショートの
  `approved`(ショート単位の承認。`render --short` のゲート)も同様
- 中間生成物は編集しない(再実行で上書きされる): `manifest.json` /
  `cuts.auto.json` / `plan.raw.txt` / `render.props.json` / `whisper-out.*` /
  `cut.mp4` / `cut.keeps.json`(cut.mp4 の再利用可否を判定するキャッシュキー。
  削除すれば常にフル再生成に戻る) / `render.key.json`(final.mp4 の再利用
  可否を判定するキャッシュキー。render.props.json・cut.mp4・参照素材ファイル・
  hardwareAcceleration 設定が前回と同じなら Remotion 実行を丸ごと省略する。
  削除すれば常にフル再生成に戻る) / `preview.mp4` / `proxy.mp4` /
  `proxy.key.json`(proxy.mp4 の陳腐化を判定するキャッシュキー。ラウドネス・
  システム音声・プレビュー幅・エンコーダ・元収録ファイルが前回の生成と
  同じなら陳腐化なしと判定する。削除すれば陳腐化判定が効かなくなる=常に
  「陳腐化なし」扱い) / `frames/*.png` / `frames/props.json` /
  `render.chunks/`(チャンク差分レンダーのキャッシュ。`vNNN.mp4`=チャンク
  映像・`audio.m4a`=直前フルレンダーの連続音声・`chunks.key.json`=再利用可否を
  判定するキー。config.yaml の `render.chunkSec` > 0 のときだけ使う。映像に
  効く要素だけを変えた再実行で変更チャンクだけ再レンダーする。音声・keeps・
  全域設定の変更時は自動でフルレンダーに戻る。ディレクトリごと削除すれば
  常にフル再生成に戻る) / `cut.<name>.mp4`(ショート `<name>` 専用の keep 集合
  (`shorts.json` の `ranges`)をフル解像度で結合したもの) /
  `cut.<name>.keeps.json`(cut.<name>.mp4 の再利用可否を判定するキャッシュキー。
  仕組みは cut.keeps.json と同じ) / `render.<name>.props.json` /
  `render.<name>.key.json`(shorts/<name>.mp4 の再利用可否を判定するキャッシュ
  キー。仕組みは render.key.json と同じ。ショートにはチャンク差分レンダーは
  無い=常に full-skip か フルレンダーのどちらか) / `shorts/`(`render --short` /
  `--shorts` の出力先。`shorts/<name>.mp4`)。
  `backups/`(上書き前の退避)と
  `.editor-draft.json`(GUI の未保存編集の自動退避)も触らない。
  `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格。
  `thumbnail.json` を編集したら `thumbnail` コマンドで作り直す)
- GUI エディタ(`npm run editor`)が起動中でも JSON を直接編集してよい。
  保存された変更はホットリロードで GUI に自動反映される(人間側に未保存の
  編集がある場合は GUI にバナーが出て人間が選ぶ)

## 動画の中身を知る方法(AI の知覚)

- `transcript.json` … 何をいつ喋っているか(全文・秒付き)。内容の把握と
  「◯◯と言っているあたり」の時刻特定はこれを読む
- `cutplan.json` … どこが残っていてどこが切られたか(`reason` 付き)
- `manifest.json` … 収録の長さ・解像度(読み取り専用)
- `node src/cli.ts describe <dir>` … タイムラインの要約(keep/カットの並び・
  各区間の発言・カット理由・演出・章を、元秒⇔出力秒の対応付きで)。
  `shorts.json` があれば末尾にショート要約(`name` / `profile` / `approved` /
  `ranges` / 出力尺)も出す。JSON を全部読むよりこれを先に見る
- `node src/cli.ts frames <dir> --t 90,2:30.5` … 指定時刻のフレームを
  **最終合成と同じ見た目**(クロップ+ワイプ+テロップ+素材)で
  `<dir>/frames/*.png` に出力。Read で画像を見て、テロップ位置・ワイプ被り・
  素材の見え方を自己確認する。時刻は元収録の秒(カット内なら直後の keep へ
  自動スナップ)。`--out` を付けるとカット後の秒として解釈
  - 一巡監査は時刻リストを自作せず専用モードを使う: `--captions` で
    テロップ全件(各テロップの表示中間で1枚。どのテロップかはコマンド
    出力に付く)、`--every 10` でカット後タイムラインを10秒間隔+最終
    フレームでサンプリング
  - `--short <name>` を付けると、`shorts.json` の当該ショートの縦レイアウト
    (`profile` のプリセット・`ranges` の keep 集合・`captionTracks` の上書き)で
    出す。`--t` はショートの ranges 内へスナップ、`--every` もショートの
    出力尺基準で動く(本編 `cutplan.json` は無関係)
  - 実行のたびに `frames/` 内の古い PNG は全削除される。逆に言うと、
    JSON 編集後に frames を撮り直さず古い PNG を Read すると編集前の絵を
    見ることになるので、編集したら必ず撮り直す
  - ベース映像はプロキシ(幅1280px)のアップスケールなので、テロップの
    位置・被り・レイアウト確認には十分だが、**画面キャプチャ内の細かい
    文字の可読性はこの画像では判断できない**(ぼやけていても最終出力では
    読める。可読性の最終判断は人間が preview / render で行う)
- 編集の基本ループ: JSON 編集 → `validate` → `describe` か `frames` で
  自己確認 → 人間には `preview` かエディタ(ホットリロード)で見てもらう

## どのファイルが何を決めるか

| ファイル | 決めるもの |
|---|---|
| `cutplan.json` | どこを残すか。`segments[]` の `action: "keep" / "cut"`。keep は時系列順・重なり禁止 |
| `transcript.json` | テロップの文言・表示時間。`track`(トラック番号)、`pos`(`{x,y}` 出力px)、`style`(`{fontSizePx, color, outlineColor, fontFamily, fontWeight, background}`。`outlineColor: "none"` で縁なし、`background` は座布団 `{color, paddingPx?, radiusPx?}`)は省略可で個別上書き |
| `overlays.json` | 演出。`overlays`(素材の表示。全画面または `rect` `{x,y,w,h}` で部分配置。`startFrom` 頭出し・`volume` 音量(省略時 0=無音)・`opacity`・`fadeInSec`/`fadeOutSec`)/ `inserts`(インサート編集。`volume`(省略時 1)・フェード付き)/ `wipeFull`(ワイプ全画面。出入りは config の `render.wipeTransitionSec` で遷移)/ `zooms`(ズーム。画面の一部(`rect` `{x,y,w,h}`)を全画面へ拡大。倍率は書かず `rect` から一意に決まる。区間は重ならないこと。出入りは `easeSec`(省略時 config の `render.zoom.easeSec`)で遷移。かかるのはベース映像の背景レイヤーだけ)/ `layerOrder`(重なり順)/ `captionTracks`(テロップトラックの標準位置・スタイル)/ `hideCaption` |
| `bgm.json` | BGM の区間配置。`tracks[]` の `{start, end, file}`(時系列でなくてよい・重ねてよい)。覆っていない区間は無音、別 `file` の区間で曲の切り替え。`volumeDb`(省略時 config 既定)・`startFrom` 頭出し・`fadeInSec`/`fadeOutSec` は省略可。無ければ収録フォルダ直下の `bgm.*` を全編1曲で流す(後方互換) |
| `chapters.json` | YouTube 概要欄チャプター(`start` / `title`)。動画には描画されない |
| `meta.json` | タイトル案・概要欄の下書き。動画に影響なし |

素材ファイル(B-roll 等)は収録フォルダの `materials/` に置き、相対パスで
参照する。BGM は `bgm.json` で区間ごとに配置(素材と同じく `materials/` の
別ファイルも参照できる)。`bgm.json` が無ければ収録フォルダ直下の `bgm.mp3`
(または bgm.m4a / bgm.wav)を全編1曲で流す。

## コマンド

```sh
node src/cli.ts validate <dir>    # JSON 編集後は必ず(エラーで exit 1)
node src/cli.ts describe <dir>    # タイムライン要約(元秒⇔出力秒の対応付き)
node src/cli.ts frames <dir> --t <times>  # 指定時刻を最終合成の見た目で PNG に
node src/cli.ts frames <dir> --captions   # テロップ全件を一巡監査(1件1枚)
node src/cli.ts frames <dir> --every 10   # カット後全体を10秒間隔でサンプル
node src/cli.ts frames <dir> --short <name> --every 10  # 指定ショートの縦レイアウトで PNG に
node src/cli.ts thumbnail <dir>  # thumbnail.json からサムネイル静止画を生成(thumbnail.png)
node src/cli.ts remeta <dir>      # 章立て・タイトル案・概要欄だけ作り直す(cutplan は触らない)
node src/cli.ts preview <dir>     # カット確認用の軽い動画(人間に見せる)
node src/cli.ts render <dir>      # 最終レンダー(approved: true が必要)
node src/cli.ts render <dir> --short <name>  # ショート1本だけレンダー(shorts/<name>.mp4)
node src/cli.ts render <dir> --shorts        # approved な全ショートをレンダー(未承認はスキップ)
node src/cli.ts editor <dir>      # GUI エディタ(npm run editor と同じ)
node src/cli.ts run <dir>         # 収録直後の初回一括(再実行は --force 必須+backups/ へ退避)
```

## コードを触るとき

- Node 23 の type stripping で TS を直接実行(ビルド工程なし)。**型を消すだけ**の
  モードなので、変換が要る TS 構文は使えない: enum・`namespace`・実行時の
  デコレータ・**コンストラクタのパラメータプロパティ**(`constructor(readonly x)`)
  は実行時に落ちる。フィールドは明示的に宣言して代入する
- 型検査: `npx tsc --noEmit`(= `npm run typecheck`)
- テスト: `npm test`(`node --test`。純関数の単体テストが `test/*.test.ts`。
  `lib/timeline.ts` の時刻写像・`stages/validate.ts` の検査・`lib/renderProps.ts`・
  `lib/fmt.ts` を固定している。ロジックを変えたら追随する)
- 構成: `src/stages/`(パイプライン各段。JSON in → JSON out)、
  `src/lib/`(共有ロジック。時刻写像は `lib/timeline.ts`)、
  `editor/`(GUI。server.ts + client/ の React。正のデータは常にファイル側)、
  `remotion/`(最終合成のコンポジション)
- 設定はすべて `config.yaml`(コードにハードコードしない方針)
- スキーマを変えたら `src/types.ts` のコメントと `src/stages/validate.ts` と
  `docs/usage.md` の表も揃えて更新する
