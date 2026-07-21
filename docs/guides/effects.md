# 演出(ズーム / ぼかし / 囲み)

> overlays.json の演出を作り、候補を自動生成し、検品ループを回す。
> 関連: [materials.md](materials.md) / [captions-layout.md](captions-layout.md) / [safe-editing.md](safe-editing.md) / [../usage.md](../usage.md)

## 演出(overlays.json)

収録フォルダに `overlays.json` を手で書くと、render 時に演出が合成される。
無ければ何も起きない(plan は生成しないので上書きの心配もない)。
時刻は他のファイルと同じく**元動画の秒**で書く。

```json
{
  "overlays": [
    { "start": 12.0, "end": 18.5, "file": "materials/bench-table.png" },
    { "start": 30.0, "end": 36.0, "file": "materials/demo.mp4", "layer": "over", "fit": "cover" },
    { "start": 60.0, "end": 66.0, "file": "materials/pip.mp4",
      "rect": { "x": 1200, "y": 60, "w": 640, "h": 360 },
      "startFrom": 3.0, "volume": 0.5, "opacity": 0.9,
      "fadeInSec": 0.5, "fadeOutSec": 0.5 }
  ],
  "inserts": [
    { "at": 40.0, "file": "materials/broll.mp4", "durationSec": 4.0, "startFrom": 5.0,
      "volume": 0.8, "fadeInSec": 0.3, "fadeOutSec": 0.3 }
  ],
  "wipeFull":    [ { "start": 50.0, "end": 55.0 } ],
  "zooms": [
    { "start": 70.0, "end": 85.0,
      "rect": { "x": 480, "y": 270, "w": 960, "h": 540 },
      "easeSec": 0.4 }
  ],
  "blurs": [
    { "start": 90.0, "end": 96.0,
      "rect": { "x": 1200, "y": 300, "w": 500, "h": 120 },
      "type": "blur", "strength": 0.6 }
  ],
  "annotations": [
    { "type": "arrow", "start": 100.0, "end": 104.0,
      "from": { "x": 300, "y": 200 }, "to": { "x": 600, "y": 350 } },
    { "type": "box", "start": 100.0, "end": 104.0,
      "rect": { "x": 1200, "y": 300, "w": 400, "h": 120 } },
    { "type": "spotlight", "start": 108.0, "end": 114.0,
      "rect": { "x": 400, "y": 200, "w": 700, "h": 500 }, "shape": "ellipse" }
  ],
  "hideCaption": [ { "start": 50.0, "end": 55.0 } ],
  "colorFilter": { "brightness": 1.05, "contrast": 1.1 }
}
```

- **overlays**: 素材(画像/動画)を表示する。素材ファイルは収録
  フォルダ内に置く(相対パス)。`layer` 省略時は `under`
  - `under`: 背景(画面キャプチャ)だけ覆う。ワイプ・字幕は見える
  - `over`: ワイプごと覆う。字幕だけ素材の上に出る
  - `fit`: `contain`(全体を見せる・全画面時の余白は黒/省略時)か
    `cover`(領域を埋める・端が切れる)
  - `rect`: 表示領域 `{x, y, w, h}`(出力px)。省略時は全画面。指定すると
    ピクチャ・イン・ピクチャ的な部分配置になる(`contain` の余白は透過)。
    エディタではプレビュー上で枠をドラッグして移動・端のハンドルでリサイズできる
    (その素材が再生ヘッド上にあるとき)
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・動画のみ)
  - `volume`: 音量(0〜2、1=素材のまま)。**省略時 0=無音**(動画のみ。
    マイク音声・BGM はそのまま重なる)
  - `opacity`: 不透明度(0〜1。省略時 1)
  - `fadeInSec` / `fadeOutSec`: 表示区間の頭/末尾のフェード(秒。音量も連動)
- **inserts**: ベース映像を割って素材を差し込む(Premiere のインサート編集相当)。
  `at`(元収録の秒)の手前に `file` を `durationSec` ぶん挿入し、後続の映像・
  テロップ・章・素材は尺のぶん後ろへずれる。overlays と違い**音声込み**で全面に出る
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・
    動画のみ有効)。エディタでは挿入クリップの左端ドラッグでも調整できる
  - `fit`: `contain`(省略時)か `cover`
  - `volume`: 音量(0〜2。**省略時 1=素材のまま**、0 で無音)
  - `fadeInSec` / `fadeOutSec`: 黒からの明転/黒への暗転(秒。音量も連動)
- **wipeFull**: ワイプ(カメラ)を全画面にして背景を隠す区間。入りと戻りは
  `transitionInSec` / `transitionOutSec` で個別指定できる(0 で瞬時)。省略時は
  config.yaml の `render.wipeTransitionSec`(既定 0.3 秒。エディタの設定画面 ⌘,
  からも変更可)を使う。旧 `transitionSec` は後方互換のため、個別指定がない
  両方向へ適用される。遷移は区間全体の頭と末尾にだけ入り、カット・挿入・
  隣接エントリで区間が繋がっている継ぎ目では走らない
  - 通常動画(`manifest.layout: "plain"`。カメラの無い収録)では**使えない**
    (ワイプの crop 元が無いため。`validate` がエラーにする)。`layerOrder` に
    `wipe` を含めても無視されるだけ(警告)
- **zooms**: 画面の一部を拡大して見せる(Ken Burns 的な寄り)。「画面のこの
  部分に注目」を作る演出で、区間どうしは重ならないこと(validate がエラーにする)
  - `rect`: 拡大する矩形 `{x, y, w, h}`(出力px。テロップ `pos` や overlays の
    `rect` と同じ座標系)。この矩形を全画面へ一様拡大する(歪ませない)。
    拡大率は書かせない: `scale = 出力幅 / rect.w` が rect から一意に決まる
    (倍率と rect の二重指定は矛盾の温床になるため)
  - `easeSec`: 区間の頭でズームイン・末尾でズームアウトする遷移秒数。省略時
    config.yaml の `render.zoom.easeSec`(既定 0.4)。区間が遷移2回分より
    短いときは遷移を区間の半分へ縮める(`wipeFull` と同じ規則)
  - **連鎖(パン遷移)**: 隣のズームと隙間なく接する(`end` === 次の `start`)
    と、境界で等倍へ戻らず**前の rect から次の rect へ直接パン**する(次の
    区間の `easeSec` がパンの遷移時間)。「A に寄る → B へ視線を移す → 引く」
    は A と B を接した2区間で書く。隙間があれば従来どおり一度等倍へ戻る。
    カットで区切られた2つのズームも、カット後のタイムラインで接していれば
    連鎖する(間の映像が無いので境界でパンが始まる)
  - かかるのは**背景(design の背景画像)+画面パネルの合成面全体**(ワイプ・
    テロップ・素材オーバーレイ・挿入クリップ・blur/annotation は不動)。
    design 無しでは背景が無くパネル=出力全面なので、実質ベース映像
    (画面クロップ)だけが動く。テロップ等の位置・可読性は変わらない
  - **ズーム中はカメラワイプが `render.zoom.wipeScale` まで縮む**(既定 0.8。
    ズームで画面が拡大されるぶんワイプが相対的に大きく見えるのを抑える)。
    縮小・復帰のトランジションは zoom 本体の `easeSec`/`easeOutSec` と完全に
    同じ(専用の時間設定は無い)。縮むのは**右下アンカー**(右・下の余白は
    不変。素の経路は `right:0/bottom:0` flush のまま、design 経路は
    `render.design.camera.marginPx` の余白がそのまま残る)。`wipeFull`
    (ワイプ全画面)と重なる間は縮まない。`wipeScale: 1` で無効化できる
  - エディタでは専用の「ズーム」トラックにドラッグで区間を作り、プレビュー上の
    枠をドラッグ・リサイズして `rect` を調整する(素材の部分配置と同じ操作感)
  - ショート(`shorts.json` の縦動画)には効かない(overlays.json を継承しない
    既存設計により自動的に除外される)
- **blurs**: 画面の一部にぼかしを掛けて隠す(開発画面の API キー・
  PII・パスワード等の秘匿情報向け)
  - `rect`: 隠す矩形 `{x, y, w, h}`(出力px。テロップ `pos` や `zooms` の
    `rect` と同じ座標系)。画面外へはみ出すと `validate` がエラーにする
  - `strength`: 強度(0〜1。省略時 0.5)。ぼかし半径(出力px)へ変換される。
    **0 は効果なし**(その区間は何も描画されない。0 超は最低限の強さの床から
    始まる)
  - かかるのは**下層(ベース映像+挿入クリップ)だけ**。テロップ・素材
    オーバーレイはぼかしの上に描画される(隠れない)
  - 遷移(フェード)は無い硬い ON/OFF。秘匿はなめらかに現れてはいけないため
  - `rect` は `zooms` に追従しない(出力px固定)。描画は矩形内に実際に
    描かれている映像(zoom 後の見た目)をその場でぼかす(backdrop-filter)。
    zoom 区間と時間が重なると `validate` が警告する(隠したい情報が矩形から
    ずれて露出しうるため。重ねないか rect を広げて対処する)
  - ショート(`shorts.json` の縦動画)には**継承されない**(本編の座標系
    (1920x1080 基準)がショートの座標系と一致しないため。座標がずれた矩形を
    黙って継承する方が継承しないより危険という判断。shorts.json があると
    `validate` が警告する。ショートに秘匿情報が写る場合は別途対処が必要)
- **annotations**: 矢印(`arrow`)・囲み(`box`)・スポットライト(`spotlight`)の
  描画プリミティブで、画面上の一点/矩形を指し示す「ここを見ろ」を作る
  (dev screencast で使う場面を想定)。`type` で種別を判別する
  - 共通: `start` / `end`(元収録の秒)。**登場/退場アニメは無い**(硬い
    ON/OFF。テロップの `anim` のような遷移は v1 では持たせない)
  - `arrow`: `from` → `to`(どちらも出力px の `{x, y}`)へ線を引き矢尻を付ける。
    `color`(既定 `#ff3b30`)・`widthPx`(既定 8)・`headPx`(既定 28)は省略可。
    `from` と `to` が同一点は退化した矢印として `validate` がエラーにする
  - `box`: `rect`(出力px)を枠線で囲む。`color`(既定 `#ff3b30`)・`widthPx`
    (既定 6)・`radiusPx`(既定 8。角丸)・`fill`(塗り色。省略時は塗りなし・
    枠線だけ)は省略可
  - `spotlight`: `rect` の外側を暗くして注目を集める。`shape`(`"rect"`
    省略時既定 / `"ellipse"`)・`dim`(外側の暗さ0〜1。既定 0.6)・
    `featherPx`(縁のぼかし幅。既定 24)・`radiusPx`(`shape:"rect"` の角丸。
    省略時0)は省略可
  - 描画レイヤーは**独立・最前面**(テロップより上。`layerOrder` には載らない)。
    最前面なので、`spotlight` の暗幕が重なった部分のテロップも一緒に
    暗くなる(意図した挙動。テロップの下に置くと矢印がテロップを指せなく
    なるトレードオフを避けた)
  - `zooms` には**追従しない**(出力px固定)。`blurs` と違い、zoom 区間と
    時間が重なっても `validate` は警告しない(「寄って指す」がむしろ想定用途
    のため)
  - `rect` / 矢印の端点が出力解像度の外にはみ出すと `validate` が**警告**
    (blurs と違いエラーにしない。画面端でクリップされるだけで render は
    壊れず、画面外から指す構図もあるため)
  - ショート(`shorts.json` の縦動画)には**継承されない**(`blurs` と同じ
    理由。座標が本編基準のため。shorts.json があると `validate` が警告する)
- **hideCaption**: 字幕(全テロップトラック)を出さない区間
- **colorFilter**: 全編一律の簡易カラー調整(区間指定はできない)。
  `{brightness?, contrast?, saturate?}` の各キーは省略可・既定 1.0(無補正)、
  実装は CSS filter。かかるのは**ベース映像(画面クロップ+カメラ=同一収録
  動画)だけ**で、素材オーバーレイ・挿入クリップには効かない。有効範囲は
  各値とも 0 より大きく 3 以下(`validate` が検査する)
  - **ショート(`shorts.json` の縦動画)にも例外的に効く**(演出ではなく
    「収録の見た目補正」という扱いのため。本編とショートで肌色が変わる
    事故を防ぐ)。他の `overlays.json` の演出(素材・インサート・ワイプ・
    zooms 等)はショートに継承されないのと対照的
  - **サムネイル(`thumbnail.json`)にも同じに効く**(下記「サムネイル生成」
    参照)
  - チャンク差分レンダー(`render.chunkSec`)では全域設定扱い: 変更すると
    フルレンダーになる(wipe 幾何等と同じ側)

注意: カット境界をまたいでも区間は1つに繋がったまま扱われ、動画素材も
連続再生される。ただしカットで消えた分だけ表示時間は短くなるため、
素材を最後まで見せたいときはカットされない区間内に収めるのが無難。
インサート(挿入)で時間が割り込まれる場合だけ区間が複数に割れ、
動画素材は挿入のあとも続きから再生される。


## 演出候補の自動生成(plan-effects)

`plan-effects <dir>` は、編集済みタイムラインのどこを拡大/隠す/囲むか、
LLM に**番号+種別選択**だけさせて `overlays.json` の下書きを作るコマンド。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **前提**: 先に `node src/cli.ts frames <dir> --every 10 --ocr` と
  `node src/cli.ts av <dir>` のどちらか(両方推奨)を実行しておく必要がある。
  どちらも無ければ実行方法を告げて exit 1(例外にはしない)。演出アンカーが
  0件のときも同様に告知して終了する
- **演出アンカー(演出を置ける候補)**: 3つの知覚から決定論的に組む。
  画面OCR(`frames/*.ocr.json` の各行。box が十分大きいものだけ)・
  動き(`av.probe/motion.json` の sceneScore 超のサンプル・長い静止区間)・
  発話(十分な尺の keep span ごとの意味づけ用アンカー)。**座標(rect)は
  OCR box または画面変化領域から取り、LLM は一切触らない**。rect の無い
  アンカー(発話のみ由来)は zoom/blur/annotation の対象にできない
- **番号+種別選択のみ**: LLM に渡すのはアンカー一覧
  (`#id [開始-終了] source [座標] テキスト`)だけ。LLM の応答は
  `{ "decisions": [{ "anchorId": N, "effect": "zoom"|"blur"|"annotation"|"none", "reason": "..." }] }`
  のみで、座標・時刻・色は一切書かせない。番号 → 実体の変換、存在しない
  番号の無視はすべてコード側が行う
- **演出分類はopt-in**: 既存の `plan.reasonIds.enabled: true` を使うと、各判断へ
  `effectReasonId`(7分類。`docs/edit-skills/effects/recipes/`)を必須で付けるstrict
  schemaへ切り替わる。false/省略時はプロンプトと応答schemaが導入前とバイト等価。
  非noneは生成したzoom/blur/annotationの `reasonId` へsticky copyされる。
  noneも理由を記録するが、`max(12, ceil(アンカー数×0.1))` 件にコード側で制限し、
  overlaysには何も置かない。非noneの `planEffects.maxDecisions` とは別予算
- **annotation は box(囲み)限定**: arrow(矢印)・spotlight は v1 では
  生成しない(座標・パラメタが多く番号選択で安全に決めにくいため)
- **zoom は重ならない**: validate はズーム区間の重なりをエラーにするため、
  時間衝突する zoom は先着優先で間引く。blur/annotation の rect は出力
  解像度内へ clamp する(blur の画面外は validate エラー)
- **`overlays.json` の他フィールド保持**: `overlays[]`/`inserts`/`wipeFull`/
  `captionTracks`/`layerOrder`/`colorFilter`/`hideCaption` は既存のまま保持し、
  `zooms`/`blurs`/`annotations` の3配列だけを差し替える
- **書き込み前検査(all-or-nothing)**: 組んだ演出下書きを、書く前に
  `validate` と同じ検査(zoom 重なり・blur 画面外・annotation の型等)へ通す。
  1つでも不正なら1バイトも書かない
- **既存の zooms/blurs/annotations は `--force` 必須**(実行前に `backups/`
  へ退避)
- **承認不要・下書き扱い**: overlays の編集は承認 hash を失効させないため、
  生成しても既存の cutplan/short の承認は生きたまま。ただし人間が
  preview / frames で見て、要らなければ消す前提
- **測定の注意**: LLM 出力は非決定的なので、単発 diff で演出の質(種別選択・
  対象の妥当性)は採点できない。決定論部分(アンカー生成・rect 由来・
  zoom 重なり間引き・clamp)はテストで固定し、当否の判断は人間が
  `frames`/preview で行う

```sh
node src/cli.ts frames <dir> --every 10 --ocr   # 前提知覚(画面OCR)
node src/cli.ts av <dir>                        # 前提知覚(動き検出)
node src/cli.ts plan-effects <dir>              # overlays.json へ演出下書きを生成
node src/cli.ts validate <dir>                  # zoom 重なり・blur 画面外が無いことを確認
node src/cli.ts frames <dir> --t <演出区間の秒>  # 実際に効いて見えるか目視
```

```yaml
plan:
  reasonIds:
    enabled: true # cutとplan-effectsの分類を同じスイッチで有効化
```


## 演出の検品(effect-check)

`effect-check <dir>` は、`overlays.json` の `zooms`/`blurs`/`annotations` が
**座標として妥当**なだけでなく**対象を外していないか**を検品するコマンド。
`plan-effects` が演出を**作る**のに対し、こちらは既存(生成/手書き問わず)の
演出を**検品する**役割で、演出そのものは一切生成しない。

- **決定論チェック(常に実行・必ず成功する)**:
  - **E4(zoom×固定px演出の相互作用)**: `blurs`/`annotations` は zoom に
    追従しない出力px固定のため、zoom と時間が重なると指す/隠す位置がずれる。
    zoom の rect が blur/annotation(box・spotlight)の rect を包含していれば
    「rect を zoom 領域いっぱいへ広げる」、包含していなければ「zoom 終端の
    後ろへずらす」補正候補を出す。arrow(rect を持たない)は常にずらす候補
  - **E5(密度ガード)**: `densityWindowSec` 秒の窓に演出(zoom+blur+annotation)
    が `maxPerWindow` 本を超えて詰まっていたら警告(`chapters.json` があれば
    章区間を見せ場とみなし、見せ場内は抑制する)。annotation の表示尺が
    `maxAnnotationSec` を超えていたら「表示尺を詰める」補正候補を出す
  - **E3(座標視覚検証・決定論の一次判定)**: テロップ(`pos` が明示された
    ものだけ。v1 では既定の下部中央フローは対象外)の推定矩形が
    blur/annotation/素材(`overlays[]` の `rect` 付き)と時間・座標の両方で
    重なっていたら `caption-overlap` 警告
- **still 撮影(E3)**: 演出ごとの表示中間の時刻を、既存の `frames` 経路
  (合成込みの見た目)で1回にまとめて撮る。`frames-serve` が起動中なら自動で
  速くなる。v1 は after(演出込み)の still のみ
- **VLM 二次確認(任意・優雅に劣化)**: `ai.routes.vision` が設定されていて
  `config.yaml` の `effectCheck.useVlm`(既定 true)かつ `--no-vlm` を付けて
  いなければ、after still を最大4枚まで vision route に見せ「この演出は
  目的(隠す/指す/見せる)を満たすか」を `ok`(true/false)+短い理由だけで
  問う。**座標・修正案は一切生成させない**(判定専用。母艦 原則4)。
  vision route が無い/`--no-vlm`/呼び出しが失敗した場合は例外を投げず
  「VLM 未実行(決定論のみ)」と明示して決定論の結果だけを返す(exit 0)
- **収録フォルダへ直接書かない**: 出力は検品結果 `effect-check.json`
  (機械可読。警告一覧・撮った still・VLM 実行有無)+ stdout の人間向け
  レポート + 補正候補があるときだけの `effect-fix.suggested.json`
  (使い捨ての `apply` パッチ下書き)。`overlays.json` 等の編集は必ず人間が
  `apply --patch` を経由する
- **補正値は決定論の算術のみ**: rect を広げる/ずらす・annotation の表示尺を
  詰めるは、すべて既存の zoom rect・区間からの計算で一意に決まる。VLM は
  判定だけで座標は書かない
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない
  (演出の時刻は元収録秒、座標は出力pxで完結し、cut 決定に依存しない)

```sh
node src/cli.ts effect-check <dir>          # 決定論チェック + (可能なら)VLM 二次確認
node src/cli.ts effect-check <dir> --no-vlm # 決定論チェックのみ(CI・vision route 未設定向け)
node src/cli.ts apply <dir> --patch effect-fix.suggested.json --dry-run  # 補正候補を確認
node src/cli.ts apply <dir> --patch effect-fix.suggested.json           # 適用
node src/cli.ts validate <dir>              # 適用後、整合性を再確認
```


## 検品を閉じる(E6: レビューイベント化 / E7: 提案ループへ戻す)

`effect-check` の検品結果は、それだけでは人間/AI が読む止まりで終わりうる。
これを既存のレビュー(GUI エディタの AI 提案レビュー)と次の `plan-effects`
再実行へ**配線する**のが E6/E7。
どちらも**新コマンドは無い**(既存の関数/コマンドへの追記・フラグ)。

- **E6(レビューイベント化)**: `src/lib/reviewEvents.ts` の `buildReviewEvents`
  が `effectWarnings?`(effect-check の `EffectWarning[]`)を受け取れるように
  なった。渡すと、時間帯(元収録秒)+種別(zoom/blur/annotation)が一致する
  既存の `ReviewEvent` へ警告・種別ごとの確認観点
  (zoom=見せたい所が中心か / blur=覆えているか / annotation=指す先が合うか)
  ・撮影/確認理由を追記する。一致するイベントが無ければ、その演出単独の
  `ReviewEvent` を1つ作る。補正候補(`suggestions`)がある警告は
  `effect-fix.suggested.json#@<id>` という参照が `warnings` に載る(**自動
  適用はしない**。適用は人間が `apply --patch effect-fix.suggested.json`)。
  `effectWarnings` を渡さない(undefined/空配列)ときは、この変更導入前と
  バイト等価(cut/caption/insert 等の既存イベントは一切変わらない)
- **E7(検品観点を提案ループへ戻す・opt-in)**: `plan-effects <dir> --observe`
  (または `config.yaml` の `effectReview.observe: true`)を付けると、前回の
  `effect-check.json` があればその警告件数サマリ(例: 「前回の effect-check
  で演出の警告が3件ありました(ぼかし×ズーム重なり2件・密度過多1件)。
  これは参考情報であり、必ず直すべき指示ではありません」)をプロンプトへ
  1ブロック追記し、次の演出候補生成が「前回の失敗」を踏まえられるようにする。
  **命令ではなく観測**(「必ず直せ」とは書かない・番号選択の枠は変えない)。
  `--observe` を付けない/`effectReview.observe` が既定(false)のときは、
  `effect-check.json` の有無に関わらずプロンプトは SD-E1 導入時とバイト等価
  (観測ブロックは一切追記されない)
- **`src/lib/planLoop.ts` の `withEffectObservation`**: cut の `plan --cuts-only`
  ループ(`planLoop.ts`)向けの同型 opt-in フック(観測 `warnings` 配列へ
  演出観測の1行を足す純関数)。既定では呼び出されない(観測ソースが
  演出であって cut と別ドメインのため、統合は今後の横展開課題)

```sh
node src/cli.ts effect-check <dir>                # effect-check.json を更新
node src/cli.ts plan-effects <dir> --observe --force  # 前回警告を観測して演出候補を作り直す
```

