# 素材(B-roll)を差し込む

> 手持ちの B-roll を把握し、配置候補を下書きし、参照の不整合を直す。
> 関連: [effects.md](effects.md) / [command-reference.md](command-reference.md) / [safe-editing.md](safe-editing.md) / [../usage.md](../usage.md)

## 素材(B-roll)の中身を知る(materials)

`overlays.json`(`overlays[].file` / `inserts[].file`)・`bgm.json`
(`tracks[].file`)から相対パスで参照される素材(B-roll・スライド・BGM 等。
`materials/` 直下が基本だが、参照は `materials/` 外(root の `bgm.mp3` 等)も
指しうる)の中身を知る知覚コマンド。それまで AI が得られるのは
`describe --json` の `overlays.materials[].file`/`.exists`(参照先のファイル名
と存在有無)だけで、実尺・解像度・音声の有無・画面内テキスト・素材音声の
発話は一切不可視だった。

```sh
node src/cli.ts materials <dir>                 # ffprobe だけ(尺・解像度・fps・音声有無)
node src/cli.ts materials <dir> --frames         # + 代表フレーム PNG
node src/cli.ts materials <dir> --ocr            # + フレーム/画像 OCR(--frames を含意)
node src/cli.ts materials <dir> --transcribe     # + 音声付き素材の文字起こし
node src/cli.ts materials <dir> --all            # = --frames --ocr --transcribe
```

**対象範囲**: `materials/` 配下の実在ファイル(present 集合)と、
overlays/inserts/bgm の参照集合(referenced 集合)の**和集合**。これで
1回の実行で2つの用途を賄う:

- **棚卸し**: `used:false, present:true` = 参照が無い素材(消し忘れ)
- **検証**: `used:true, present:false` = 参照されているのに `materials/` に
  無い素材(dangling。`describe` の `exists:false` と同じ事故を素材側から
  捕捉)

各素材の `references[]` にどの overlay/insert/bgm が指すか(`@id` があれば
併記)を載せるので、`describe --json` の `MaterialEntry.id` と同じ発想で
アドレス可能。`.DS_Store` 等の非メディアは `kind:"unknown"` として一覧には
出すが probe しない。

**出力**: `materials.probe/index.json`(機械可読な集約。stdout にも1行要約が
出る)。`frames/` と違い**実行のたびの全消しはされない差分更新型の
キャッシュ**(`render.chunks/` と同じ位置づけ)で、素材ごとの mtime+size
フィンガープリントが前回と一致し、かつ要求した層が既に取得済みなら再取得
をスキップする(重い層ほどキャッシュが効く)。ディレクトリごと削除すれば
常にフル再生成に戻る。`materials/` 自体(人間の素材置き場)は引き続き
`fileRole` が `"other"` のまま(生成物は別名の `materials.probe/` に集約)。

**opt-in 層**(すべて直交・加算):

- `--frames`: 動画は尺の**中点1枚**を `materials.probe/<slug>.png` に抽出。
  画像は複製せず自身のパスを `frame.file` に記録する
- `--ocr`: 動画に対しては `--frames` を含意(OCR には PNG が要るため)。
  画像は自身をそのまま OCR する。box は**素材フレーム自身のピクセル座標**
  (`coordSpace: "material-frame-px"`)で表現される。`frames --ocr` の box が
  **本編 screenRegion 出力px**であるのとは別の座標系なので混同しないこと。
  全文は `materials.probe/<slug>.ocr.json` に、index にはプレビュー(先頭
  数行)+件数+パスだけを載せる。macOS 以外・Apple Vision 非対応環境では
  `frames --ocr` と同じく警告のうえ probe/frame の出力のみ成功で返る
- `--transcribe`: `hasAudio` な素材だけを対象に、先頭音声ストリームを
  16kHz mono wav へ抽出して whisper.cpp(`-oj`。語単位タイミングは不要)で
  文字起こしし、`materials.probe/<slug>.transcribe.json` に書く。whisper
  モデルが無ければ**その素材だけ**警告してスキップする(他の層の出力には
  影響しない)。本編の `transcript.json`/`whisper-out.*` には一切触れない
- `--all` = `--frames --ocr --transcribe`

**`<slug>` の生成**: 相対パスのパス区切り(`/`)を `__` に置換するだけの
安全化(`materials/slide-01.png` → `materials__slide-01.png`)。同一 stem・
別拡張子(`a.mp4` と `a.png`)や `materials/` 直下以外の参照でも衝突しない。

素材メタは**操作エージェント(Claude Code)向けの露出**であり、カット判断
LLM 自身(`plan`/`plan --cuts-only`/`remeta`)の入力には接続していない
(`src/stages/plan.ts` と `config.yaml` の `plan.perception` は本機能の対象外)。


## 素材配置候補の自動生成(plan-materials)

`plan-materials <dir>` は、手持ちの素材(B-roll)を編集済みタイムラインの
どこに置くか、LLM に**番号選択**だけさせて `overlays.json` の下書きを作る
コマンド(§docs/plans/2026-07-11-m1-material-placement-candidates-design.md)。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **前提**: 先に `node src/cli.ts materials <dir> --all` を実行し
  `materials.probe/index.json` を作っておく必要がある。無ければ実行方法を
  告げて exit 1(例外にはしない)。配置候補にできる素材(present な
  video/image)が0件のときも同様に告知して終了する
- **アンカー(素材を置けるスロット)**: `cutplan.json` の keep span をそのまま
  使う(`config.yaml` の `planMaterials.minSpanSec`、既定3.0秒未満は除外)。
  時刻は常に実在の keep 区間なので LLM が時刻を捏造する余地がない
- **番号選択のみ**: LLM に渡すのはアンカー一覧(`#id [開始-終了] 発話内容`)と
  素材一覧(`#id 種別 実尺 音声有無 / 画面文字 / 発話プレビュー`。実測は
  `materials.probe/index.json` から)の2リストだけ。LLM の応答は
  `{ "placements": [{ "anchorId": N, "materialId": M, "reason": "..." }] }`
  のみで、時刻・ファイルパス・尺は一切書かせない。番号 → 実体の変換、
  存在しない番号の無視、動画実尺による尺 cap(素材の実尺 < span 尺なら
  span を詰める。尺超過を作らない)はすべてコード側が行う
- **overlays[] 限定**: `inserts[]`(タイムラインシフトを起こす挿入)は生成
  しない。overlays は既存映像に重ねるだけで尺・時刻写像を動かさないため、
  cut と直交して安全に試せる
- **`overlays.json` の他フィールド保持**: `inserts`/`wipeFull`/`zooms`/
  `blurs`/`annotations`/`captionTracks`/`layerOrder`/`colorFilter` は既存
  のまま保持し、`overlays[]` 配列だけを差し替える
- **書き込み前検査(all-or-nothing)**: 組んだ overlays 下書きを、書く前に
  `validate` と同じ検査(尺超過・dangling file・不正 rect 等)へ通す。1つでも
  不正なら1バイトも書かない
- **既存 overlays.json は `--force` 必須**(実行前に `backups/` へ退避)
- **承認不要・下書き扱い**: overlays の編集は承認 hash を失効させない
  (§承認(approve/unapprove))ため、生成しても既存の cutplan/short の承認は
  生きたまま。ただし人間が preview / エディタで見て、要らなければ消す前提
- **測定の注意**: LLM 出力は非決定的なので、単発 diff で配置の質(話題と
  素材の一致度)は採点できない。決定論部分(アンカー生成・尺 cap・参照整合)
  はテストで固定し、当否の判断は人間が `frames`/preview で行う

```sh
node src/cli.ts materials <dir> --all   # 前提知覚(初回・素材変更時)
node src/cli.ts plan-materials <dir>    # overlays.json へ配置下書きを生成
node src/cli.ts validate <dir>          # 尺超過・dangling が無いことを確認
node src/cli.ts frames <dir> --t <配置区間の秒>  # 実際に見えるか目視
```


## 素材参照の不整合検出と修正パッチ(material-fit)

`material-fit <dir>` は、**既に置かれている**素材参照(`overlays.json` の
`overlays[]`/`inserts[]`)の不整合を検出し、修正案を `apply` パッチ下書き
(`material-fit.suggested.json`)として出すコマンド
(§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md)。素材の
**新規配置**候補を作る `plan-materials` とは役割が別(重複実装ではない)。

- **前提**: 先に `node src/cli.ts materials <dir>` を実行し
  `materials.probe/index.json` を作っておく必要がある。無ければ実行方法を
  告げて exit 1(例外にはしない)。`overlays.json` / `bgm.json` がどちらも
  無ければ「検出対象なし」で正常終了(exit 0)
- **`@id` が前提**: 修正案は `apply` の `@id` 宛先 op(`set`/`remove`)として
  出すため、overlay/insert に `@id` が1つも無ければ「先に `id-stamp <dir>`
  を実行してください」と告げて exit 1
- **M2(尺整合)**: `materials.probe/index.json` の実尺(`probe.durationSec`)と、
  overlay の宣言尺(`end - start`)/ insert の宣言尺(`durationSec`)を突き合わせる
  - **尺超過(overrun)**: 素材が足りず最後のフレームで停止する状態。
    insert は `{ set durationSec = 実尺 - startFrom }`、overlay は
    `{ set end = start + (実尺 - startFrom) }` を提案する
  - **尺不足(underrun)**: 実尺が宣言尺よりかなり長い(大半が未使用)。
    既定は情報提示のみ(`set` を出さず reason だけ)。延長 `set` を出したい
    ときは `config.yaml` の `materialFit.suggestUnderrunExtend: true`
  - 画像素材(尺の概念が無い)は対象外
- **M3(dangling の修正提案)**: `used:true, present:false`(参照先ファイルが
  `materials/` に無い)を検出し、① 参照を消す `remove` op と、② `materials/`
  に実在する未使用ファイルへの貼り替え候補(ファイル名の類似度で上位数件。
  `config.yaml` の `materialFit.maxReplacements`)を提示する
- **M3(unused の橋渡し)**: `used:false, present:true`(一度も参照されない
  素材)を列挙し、配置候補は作らず `plan-materials <dir>` へ誘導する
  (重複実装禁止)
- **収録フォルダへ直接書かない**: 出力は `material-fit.suggested.json`
  (使い捨ての下書き。再実行のたびに上書き)と stdout レポートだけ。
  `overlays.json` 等の編集は必ず人間が `apply --patch` を経由する
- **補正値は実測からの算術のみ・LLM は使わない**: `durationSec`/`end` の
  提案値は `probe.durationSec` からの計算で一意に決まる。貼り替え候補も
  実在ファイル名の集合からの選択(存在しないパスを提案しない)
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない

```sh
node src/cli.ts materials <dir>          # 前提知覚(未実行なら先にこれ)
node src/cli.ts id-stamp <dir>           # overlays/inserts に @id が無ければ
node src/cli.ts material-fit <dir>       # 不整合を検出しパッチ下書きを書く
node src/cli.ts apply <dir> --patch material-fit.suggested.json --dry-run  # 変更内容を確認
node src/cli.ts apply <dir> --patch material-fit.suggested.json           # 適用
node src/cli.ts validate <dir>           # 適用後、整合性を再確認
```


