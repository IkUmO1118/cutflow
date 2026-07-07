# 使い方ガイド(人間が調整しながら使うワークフロー)

cutflow は「全部AI任せ」のツールではない。**自動処理は最初の1回だけ、
以降は人間が JSON を直しながら preview / render と往復する**のが正しい使い方。

## 全体フロー

```
① 収録 → ~/Movies/cutflow/<日付-内容>/ に mkv を置く
     (企画ブリーフがあれば brief.md としてコピーしておくと plan の材料になる)

② node src/cli.ts run <フォルダ>
     自動部分を一括実行: ingest → transcribe → detect → plan(LLM呼び出し込み)

③ 人間の編集タイム(下の表のファイルを直す)

④ node src/cli.ts preview <フォルダ>
     カットのテンポを軽い動画(preview.mp4)で確認
     → 気に入らなければ ③④ を何度でも往復

⑤ node src/cli.ts approve <フォルダ>
     preview 確認 → y で承認(cutplan の keep 集合のハッシュを approvals.json に記録)

⑥ node src/cli.ts render <フォルダ>
     final.mp4 完成(音量は自動で -14 LUFS に正規化される)
     → テロップを直したくなったら transcript.json を編集して ⑥ だけ再実行
     → cutplan.json(keep 集合)を編集すると承認は自動失効するので、
       render 前に ⑤ をやり直す(approvals.json が現内容のハッシュと
       一致しないと render は拒否される)

⑦ meta.json のタイトル案・概要欄、chapters.json の章をYouTube投稿に使う
```

## どのファイルを直すと何が変わるか

時刻はすべて**元動画(収録ファイル)の秒**で書く。カット後の時刻への
換算はツールが自動でやるので、頭の中で引き算する必要はない。

| ファイル | 直すと変わるもの | 編集する場面 |
|---|---|---|
| `transcript.json` | **テロップ**の文言と表示タイミング。`track` でテロップトラック(既定 1)、`pos`(`{x, y}`: 出力px。トラックの `anchor` が無ければテキスト中心、`topLeft` なら左上)でそのテロップだけの表示位置。幅はテキストに自動で合い、折り返しは文言内の改行で指定、`style`(そのテロップだけの見た目。各項目とも省略可: `fontSizePx` / `color`(文字色)/ `outlineColor`(縁取り色。`"none"` で縁なし)/ `fontFamily`(CSS フォント指定)/ `fontWeight`(100〜900)/ `background`(座布団=背景帯。`{color, paddingPx?, radiusPx?}`)/ `anim`(登場/退場アニメ。`{in?, out?, durationSec?}`。種別は `fade` / `slide-up` / `slide-down` / `slide-left` / `slide-right` / `pop` / `none`。省略時アニメ無し)/ `karaoke`(カラオケ表示。`{activeColor?, inactiveColor?, inactiveOpacity?, mode?}`。`mode` は `word`(既定・瞬時切替)/ `fill`(発話中の語を左→右に塗り進み)。`words[]` が無いテロップに指定しても通常表示にフォールバックする=壊れない))でそのテロップだけの見た目。`words`(語/トークン単位のタイミング。`{text, start, end, confidence?}[]`)は省略可の描画専用データで、`karaoke` 指定時の色替えタイミングに使う(それ以外では描画に影響しない)。`config.yaml` の `whisper.wordTimestamps: true`(既定 false)のときだけ transcribe が付ける | whisper の誤字修正、不要な字幕の削除、言い回し調整。位置はエディタのプレビュー上でドラッグ、サイズ・色・フォント・座布団は右側のインスペクタ(クリップ選択時に常時表示)で変更できる |
| `cutplan.json` | **どこを残すか**(`action`: keep/cut)。境界の秒数も手で微調整できる | preview を見て「切りすぎ」「ここは残す」 |
| `chapters.json` | **概要欄チャプター用メタデータ**(`start` / `title` のみ)。動画への描画には使われない: 章タイトルは plan が「章」という名前のテロップトラックとして transcript.json に書き、以降はただのテロップとして編集する | YouTube 概要欄に載せる章タイトルの言い換え |
| `overlays.json` | **演出**: 素材の表示(全画面または `rect` で部分配置。頭出し・音量・不透明度・フェード付き)・インサート編集・ワイプ全画面・**ズーム**(`zooms`: 画面の一部を拡大。下記参照)・**領域ぼかし/モザイク**(`blurs`: 画面の一部を隠す。下記参照)・**注釈グラフィック**(`annotations`: 矢印/囲み/スポットライトで「ここを見ろ」を示す。下記参照)・**簡易カラー調整**(`colorFilter`: 全編一律の明るさ/コントラスト/彩度。下記参照)・字幕非表示・トラックの重なり順(`layerOrder`)・テロップトラックの標準設定(`captionTracks`: `{track, name, x, y, anchor, style}`。`name` はトラック名、`anchor: "topLeft"` で座標を左上基準に、位置・スタイルは個別指定の無いテロップに項目単位で効く) | B-roll を挟む、カメラだけの場面を作る、開発画面の API キーを隠す、画面の一点を指し示す(下の「演出」参照) |
| `bgm.json` | **BGM**を区間ごとに配置(`tracks[]`: `{start, end, file, volumeDb?, startFrom?, fadeInSec?, fadeOutSec?}`)。覆っていない区間は無音、別ファイルの区間で曲の切り替え・重奏。無ければ収録フォルダ直下の `bgm.*` を全編1曲で流す(後方互換) | イントロだけ BGM なし、途中で曲を変える、別の BGM を足す(下の「BGM」参照) |
| `shorts.json` | **ショート動画**の元データ(`shorts[]`: `{name, profile?, approved, ranges[], captionTracks?}`)。`name` は出力ファイル名(`shorts/<name>.mp4`)。`profile` は `default` / `vertical` / `vertical-screen` / `vertical-cover` から選ぶ組み込みレイアウト(省略時の既定は camera 有り→`vertical`、plain→`vertical-screen`)。`ranges` は元収録の秒で、本編 `cutplan.json` の keep とは独立したこのショート専用の keep 集合(本編でカットした素材も含められる)。`captionTracks` は `overlays.json` と同型の縦用テロップ位置/スタイル上書き。`approved` はこのショート(縦動画)を人間が確認したかどうかの**承認意図の表示**(**AI は自分で true にしない**。実際の render ゲートは `approvals.json` の承認レコード) | ショート動画を切り出したいとき |
| `thumbnail.json` | **サムネイル**(`thumbnail.png`)の元データ(`{t, texts[]}`)。下記「サムネイル生成」参照 | サムネイルを作りたいとき |
| `meta.json` | 動画には影響なし。タイトル・概要欄の**下書き** | 投稿時のコピペ元 |
| `rules.md` | **チャンネルの恒久ルール**(自由 Markdown。テロップ表記・トーン/声色・禁止語・ペーシング・章の付け方・タイトルの型など「毎回守る型」)。収録フォルダの親ディレクトリに置くと**チャンネル共通**、収録フォルダ直下に置くと**この収録だけの上書き/追加**(両方あれば連結し、収録固有が優先)。`plan` / `plan --cuts-only` / `remeta` / `plan-shorts` の LLM プロンプトに注入される。`brief.md`(今回の見せ場・中身)とは役割が別(下記「チャンネル rules と learn」参照) | チャンネル全体の編集方針を一貫させたい、この回だけ例外を効かせたいとき |

**触らない第3カテゴリ**(編集ファイルにも中間生成物にも属さない):
`approvals.json`(**承認レコード**。`cutplan.json` / `shorts.json` 各ショートの
keep 集合の sha256 ハッシュに束縛され、`render` の唯一のゲート。内容が変わると
自動失効する。`node src/cli.ts approve` / `unapprove` コマンドと GUI エディタの
保存(チェックボックス)だけが書く。**人間や AI が直接編集・作成しない**。
詳細は下記「承認(approve/unapprove)」参照)。

**触らないファイル**(中間生成物。再実行すると上書きされる):
`manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `plan-shorts.raw.txt`
(plan-shorts の LLM 生応答の記録) / `render.props.json` /
`whisper-out.*` / `cut.mp4` / `cut.keeps.json`(cut.mp4 の再利用可否を
判定するキャッシュキー。keeps・音声設定・元収録ファイルが前回と同じなら
render は ffmpeg cut を省略する。削除すれば常にフル再生成に戻る) /
`render.key.json`(final.mp4 の再利用可否を判定するキャッシュキー。
render.props.json の内容・cut.mp4・参照素材ファイル(overlays / inserts /
bgm)・hardwareAcceleration 設定が前回と同じなら render は Remotion 実行を
丸ごと省略する。削除すれば常にフル再生成に戻る) / `proxy.key.json`
(proxy.mp4 の陳腐化を判定するキャッシュキー。ラウドネス(targetLufs)・
システム音声(systemAudio)・ノイズ除去(denoise)・プレビュー幅・エンコーダ・
元収録ファイルが前回の生成と同じなら陳腐化なしと判定する。無ければ常に
「陳腐化なし」扱いになる) / `render.chunks/`(チャンク差分レンダーのキャッシュ。
config.yaml の `render.chunkSec` > 0 のときだけ使う。`vNNN.mp4` =
チャンク映像・`audio.m4a` = 直前フルレンダーの連続音声・`chunks.key.json` =
再利用可否を判定するキー。映像に効く要素(テロップ・位置・ワイプ等)だけを
変えた再実行で変更チャンクだけを再レンダーして連結する。音声・keeps・
全域設定(layerOrder 等)の変更時は自動でフルレンダーに戻る。ディレクトリ
ごと削除すれば常にフル再生成に戻る) / `cut.<name>.mp4` / `cut.<name>.keeps.json` /
`render.<name>.props.json` / `render.<name>.key.json`(いずれもショート
`<name>` 専用の中間生成物。仕組みは無印の同名ファイルと同じで、チャンク
差分レンダーだけは無い。詳細は下記「ショート動画」参照) / `rules.suggested.md`
(`learn` が書く下書き。使い捨てで、次回の `learn` 実行で黙って上書きされる。
採用したい項目は人間が手で `rules.md` に転記する。詳細は下記「チャンネル
rules と learn」参照)

## 安定 id / @-mention

編集ファイルの各要素(`cutplan.segments` / `transcript.segments` /
`overlays.json` の各配列 / `chapters.chapters` / `bgm.tracks` / 各ショートの
`ranges`・`captionTracks` / `thumbnail.texts`)には、任意で**安定 id**
(`id?: string`。例 `seg_a1b2c3`)を付けられる。文法は
`<種別を表す2〜3文字の接頭辞>_<英数字6桁>`(`seg`=cutplan の区間 / `cap`=テロップ /
`mat`=素材 / `ins`=挿入 / `zm`=ズーム / `bl`=ぼかし / `wf`=ワイプ全画面 /
`hc`=字幕非表示 / `ct`=テロップトラック標準設定 / `ch`=章 / `bg`=BGM区間 /
`rg`=ショートの range / `tx`=サムネのテキスト)。**shorts(ショート本体)だけは
`name` がそのまま id 代わり**で、別の id フィールドは持たない
(`@<name>` または `@short:<name>` で指せる)。

- **一度振ったら内容・位置が変わっても不変**(id は「この要素」を指す
  永続アドレス。`@id` で人間/AI が位置に依存せず参照できる)。
- **opt-in・sticky**: プロジェクトに `id` が1つも無ければ「id 無効」で、
  全コマンドの出力は本機能導入前と完全に同じ(バイト等価)。`id-stamp <dir>`
  を一度実行すると「id 有効」になり、以後は `plan` / `transcribe` /
  `plan-shorts` の再実行や GUI 保存が新規要素にだけ id を採番し、既存 id は
  常に保つ。**id 無効なプロジェクトを触らない限り、この機能は一切見えない**。
- **`id-stamp <dir>`**: 既存プロジェクトへの一括採番コマンド(冪等。既存 id は
  不変、無い要素にだけ新規採番。内容が実際に変わったファイルだけ書く)。
  `validate` と同じ検査を通してから書く。`approvals.json`(承認レコード)には
  一切触れない。
- **id の発見手段は `describe <dir> --json`**(散文 `describe` には出ない。
  golden 出力を汚さないため)。各要素の `index` の次に `id`(採番済みのものだけ)
  が載る。
- **`validate`** は id の重複・形式不正・(有効時の)欠落密度を**警告**で知らせる
  (id は render に一切影響しないため error にはしない。id が無いプロジェクトでは
  この検査自体が no-op で警告も増えない)。
- **id は render / preview / frames / 承認 hash に一切影響しない**(アドレッシング
  専用。cut 決定のハッシュは `[start, end]` のみを見るので、id を stamp しても
  承認は失効しない)。
- `@id` を宛先にした差分適用(パッチ)は `apply <dir>` コマンドで行う
  (下記「検査付きアトミック適用(apply)」参照)。配列添字を書かず、
  `@id` と1フィールドの新しい値だけで編集を当てられる。

## 検査付きアトミック適用(apply)

`cutplan.json` 等を Write/Edit で直接書き換える(=検査は書いた後の
`validate` 任せ)代わりに、`apply <dir>` は**「全部 valid なら全部書く、
1つでもエラーなら1バイトも書かない」全か無か**で編集を当てるコマンド。
GUI エディタの保存(`/api/save`)が既に持っていた「検査を通さないと保存
できない」を CLI/AI へ露出したもの(GUI と同じ merge+検査を共有=
`src/lib/applyEdits.ts` の `mergeBodyOverDisk`)。

```sh
node src/cli.ts apply <dir> --patch edit.json     # ファイルからパッチを読む
node src/cli.ts apply <dir> < edit.json           # stdin から(--patch 省略時)
node src/cli.ts apply <dir> --patch edit.json --dry-run   # 検査・要約だけ。書かない
```

パッチ(`ApplyPatch`。`src/types.ts`)は次の2形式を両方受け付ける(両方
あるときは ops を先に適用し、その結果へ replace を重ねる):

- **`ops`**(`@id` 指定の高水準オペレーション列。**推奨経路**): 配列添字を
  一切書かず、Feature 2 の安定 id(`describe --json` / `id-stamp` で確認)
  だけで宛先を指す。

  | op | target | 追加フィールド | 意味 |
  |---|---|---|---|
  | `set` | 既存要素の `@id` | `field`(ドット区切りパス。例 `"style.fontSizePx"`) / `value` | 指した要素の1フィールドを設定。パス末端の置換のみ(中間の欠落・配列添字(`words[0]`)はエラー。勝手に中間オブジェクトを作らない) |
  | `remove` | 既存要素の `@id` | — | 指した要素を所属配列から削除 |
  | `add` | コレクション選択子(例 `"cutplan.segments"`) | `value`(新要素オブジェクト) / `at?`(挿入位置。省略時は末尾) | コレクションへ新要素を追加。id 有効プロジェクトなら新要素にも自動採番される |

  `add` の選択子は allow-list(`cutplan.segments` / `transcript.segments` /
  `overlays.overlays` / `overlays.inserts` / `overlays.zooms` /
  `overlays.blurs` / `overlays.wipeFull` / `overlays.hideCaption` /
  `overlays.captionTracks` / `chapters.chapters` / `bgm.tracks` /
  `thumbnail.texts`)のみ。**shorts[] 自体の追加、および shorts 配下
  (`ranges`/`captionTracks`)への set/remove/add は対象外**(`@id` だけでは
  「どのショートか」を一意に復元できないため。全置換(`replace`)で編集する)。
  `cut`/`keep` も独立 op にせず `{op:"set", target:"@seg_x", field:"action", value:"cut"}`
  で表す。
- **`replace`**(ファイル単位の全置換。`SaveRequest` と同型の低水準の脱出
  ハッチ): split・要素の並べ替え・shorts[] 自体の追加など、`ops` の3種で
  表せない編集に使う。`bgm`/`shorts` は `null` で該当ファイルを削除できる
  (`undefined` はそのファイルを触らない)。

**守られる不変条件**(コードで強制。「自分の判断で回避」できない):

1. **`approvals.json` を一切書かない・読んで判定に使わない**。承認は
   `approve`/`unapprove` コマンドと GUI 保存の専権のまま。
2. **`approved` を変更できない**。`set` の `field` に `approved` を指定、
   `add` の `value` に `approved` を含める、`replace` で
   `cutplan.approved`/`shorts[].approved` をディスク現状と違う値にする
   —— いずれもエラーで拒否される(cutplan/short の `approved` は常に
   ディスク現状の値へ強制されて書き戻される)。承認を変えたいときは
   `approve <dir>` / `unapprove <dir>` を使う。
3. **エラー時ゼロ書き込み**: 宛先未解決・op 不正・JSON パース失敗・
   `validate` と同じ不変条件違反(keep の重なり・尺超え・overlays の file
   欠落等)のいずれでも、収録フォルダのファイルは1バイトも変わらない
   (`backups/` も作られない)。
4. **書き込みはファイル単位で `<file>.tmp` → rename(アトミック確定)**。
   書く前に `backupEditableFiles` と同じ仕組みで上書き対象の現状を
   `backups/<日時>/` へ退避する。
5. **apply が書けるのは cutplan/transcript/overlays/chapters/bgm/shorts/
   thumbnail の7ファイルだけ**(`meta.json` は id を持つ要素が無いため
   `apply` のスキーマ自体に含まれない。触りたいときは通常の Write/Edit で
   直接編集する)。`approvals.json` や中間生成物は物理的に書き込み対象に
   入らない。

**出力・exit code は `validate` と同形式**: エラーは `✖ file where: message`
(`(patch)` file は「JSON 本体・パッチ形式そのものの問題(未解決 @id・
未知の op 等)」を表す)、警告は `⚠ ...`。エラーがあれば(`--dry-run` でも)
exit 1。`--dry-run` は `@id` 単位の変更要約(`field: 旧 → 新`)と
`validate` 相当の検査結果を出し、書かずに検査だけしたいときに使う。

現状スコープ外: MCP サーバ本体(`applyEdits(dir, patch)` は
`process.exit`/`console` に依存しない純関数なので、将来 MCP tool から
呼び出す土台にはなっている)、GUI 差分レビュー UI、split/move 等の複合 op。

## 編集後の意図検査(assert)

`validate` が答えるのは「この編集は**壊れていない**か」(スキーマ・keep の
重なり・参照ファイルの存在・尺超えという普遍の不変条件)。一方 `assert <dir>`
が答えるのは「この編集は**私が意図した状態になっている**か」——「ショートを
60秒以内に収めたはずだ」「@cap_x のテロップは本編に残っているはずだ」
「API キーを写した区間は目隠しできているはずだ」というこの収録固有の期待値
(`docs/plans/2026-07-07-visual-assertions-design.md` 設計)。

期待値は `assertions.json`(収録フォルダ直下)に平文で宣言する。人間/AI が
手で書く**第3の宣言ファイル**で、`rules.md` / `brief.md` と同じく
`EDITABLE_FILES`(plan/transcribe 再実行の退避対象)にも `GENERATED_FILES`
(中間生成物)にも属さない。**どの生成コマンドも上書きしない**ので、
`plan --force` で cutplan をやり直しても assertions.json は残り、そのまま
再評価できる。

```sh
node src/cli.ts assert <dir>            # Tier 1(構造)だけ評価。fail/error があれば exit 1
node src/cli.ts assert <dir> --visual   # Tier 1 + Tier 2(OCR)。非対応環境は Tier 2 を skip
node src/cli.ts assert <dir> --json     # AssertReport を純 JSON で stdout(パイプ可。診断の所要時間行は stderr へ)
```

`assertions.json` が無ければ「アサーションがありません」と表示して **exit 0**
(未使用時は無害)。

```jsonc
{
  "schemaVersion": 1,
  "assertions": [
    { "label": "本編は5分以内", "type": "outDuration", "op": "<=", "value": 300 },
    { "type": "keepCount", "op": ">=", "value": 3 },
    { "type": "captionVisible", "ref": "@cap_qs3bwg", "visible": true },
    { "type": "noCaptionOverlap" }
  ]
}
```

### 語彙(9種。type で判別)

各アサーションは共通で任意の `label?`(レポート表示用の作者ラベル。要素の
`@id` とは別物)を持てる。`op` は `"<=" | ">=" | "<" | ">" | "=="`。

**Tier 1(構造。`describe --json` 射影から。依存ゼロ・数ミリ秒・全環境。
既定 `assert <dir>` で評価される)**

| type | フィールド | 意味 |
|---|---|---|
| `outDuration` | `op, value, short?` | 出力尺の比較。`short` 指定でそのショートの `outDurationSec`、省略で本編 `summary.outDurationSec` |
| `keepCount` | `op, value` | keep 区間数(`summary.keepCount`)の比較 |
| `captionVisible` | `ref, visible?` | `@id` のテロップが出力に現れるか。`visible` 省略時 true |
| `captionText` | `ref, contains?, equals?` | `@id` のテロップ本文が部分一致/完全一致するか(手編集で文言が保たれたかの確認) |
| `timeKept` | `at, kept?` | 元収録秒 `at` が出力に残っているか(keep 内)。`kept` 省略時 true |
| `materialExists` | `ref` | `@id` の素材の参照ファイルが実在するか |
| `noCaptionOverlap` | `track?` | テロップの出力秒区間が同一トラック内で重ならない。`track` 省略で全トラックを検査 |

**Tier 2(視覚。`frames --ocr` から。macOS 依存・重い。`--visual` のときだけ
評価。既定では `skip`)**

| type | フィールド | 意味 |
|---|---|---|
| `screenText` | `at, contains, present?` | 元収録秒 `at` の画面 OCR 全文に文字列が含まれる/含まれない |
| `regionClear` | `ref` | `@id` の blur 領域内に OCR テキスト行が無い(=目隠しできている) |

`ref` を取るアサーション(`captionVisible` / `captionText` / `materialExists` /
`regionClear`)は `@id` で対象を指す。**プロジェクトに id が1つも無い
(id-stamp 未実行)場合は `fail` ではなく `error`**(`id-stamp <dir>` を実行
してから @id で指定するよう促す)。ref が解決できない(id はあるが該当が
無い)場合も `error`。

### 結果の意味論

1件ごとに `pass`(成立)/ `fail`(不成立)/ `skip`(視覚アサーションで
`--visual` 無し、または OCR 非対応環境)/ `error`(宣言そのものが評価不能:
未知 type・ref 未解決・id 未採番・`at` が収録尺外 等)。**exit code は
`fail > 0 || error > 0` なら 1**(`skip` だけでは 1 にしない=非対応環境で
CI/ループが赤にならない優雅な劣化)。CLI 表示は `validate` に揃える:
`✔`(pass)/ `✖`(fail)/ `⚠`(error)/ `–`(skip)。

## 機械可読契約(JSON Schema / AGENTS_CONTRACT.md)

Claude Code に限らず、任意のコーディングエージェント・素の JSON エディタ・
外部バリデータが cutflow の編集ファイルを機械的に検証・補完できるよう、
契約をコードから射影した2種類の成果物がある(`docs/plans/2026-07-07-machine-contract-design.md`
設計。types.ts / validate.ts / files.ts / ids.ts という**既存の単一の出所**の
射影であり、新しい真実は宣言しない。ずれたら `npm test`(`test/schema.test.ts` /
`test/agentsMd.test.ts`)が落ちる)。

- **`schemas/*.schema.json`**(draft 2020-12): 8編集ファイル
  (`cutplan` / `transcript` / `overlays` / `bgm` / `chapters` / `meta` /
  `shorts` / `thumbnail`)それぞれに1スキーマ + 共有 `$defs`
  (`schemas/common.schema.json`。`Region` / `CaptionPos` / `CaptionStyle` 系 /
  `WordTiming` / `Annotation` union / `CaptionTrackDef` / `id` パターン /
  `Interval`)。`schemas/apply-patch.schema.json` は `apply` コマンドの入力形
  (`ApplyPatch` / `EditOp`)。各スキーマの kitchen-sink 例は
  `schemas/examples/<file>.max.json`(全任意フィールドを1つ以上使う。
  ドキュメント兼・構造ドリフト検知の fixture)。
  - **ファイル自体には `$schema` キーを注入しない**(収録フォルダの JSON は
    このスキーマ導入前とバイト等価。ユーザーデータ不可侵)。エディタ/
    バリデータ側の設定で `<file>.json` ↔ `schemas/<file>.schema.json` の
    命名規約に紐づける。
  - 外部バリデータ(例: `ajv-cli`)で実収録フォルダの JSON を検証したい場合、
    `--schema schemas/<file>.schema.json` に加えて `schemas/common.schema.json`
    を(`$ref` 解決のため)一緒に読み込ませる。
  - `schemas/assertions.schema.json` は8編集ファイルには含まれない
    (`assertions.json` は「other」カテゴリの宣言ファイル。上の
    「編集後の意図検査(assert)」参照)。`test/schema.test.ts` の全単射
    テストは `common.schema.json` / `apply-patch.schema.json` と同様に
    これを除外している。
- **`AGENTS_CONTRACT.md`**(リポジトリ直下・英語・Claude 非依存): 能力・不変条件・
  承認境界・触ってよい/いけないファイル・`@id` アドレッシング・主要コマンドを
  宣言する emerging standard のエージェント向けマニフェスト。CLAUDE.md との
  役割分担は「AGENTS_CONTRACT.md=契約(何が編集可能か・不変条件・コマンド)の正、
  CLAUDE.md=Claude Code 向けの運用ニュアンス」。

依存追加はゼロ(ajv 等の runtime 依存は足していない)。`test/helpers/jsonSchema.ts`
はテスト専用の vendored な JSON Schema 部分集合バリデータ(`$ref` / `$defs` /
`type` / `required` / `properties` / `additionalProperties` / `enum` /
`const` / `pattern` / `items` / `oneOf` / `minimum` / `maximum` / `minItems`)。

## MCP サーバ(`mcp`)

`AGENTS_CONTRACT.md`(機械可読契約)を JSON ファイルの読み書き規約として公開するのに
加え、`node src/cli.ts mcp <dir>` は同じ契約を [Model Context Protocol](https://modelcontextprotocol.io/)
の tool として露出する。Claude Desktop・codex 等、任意の MCP 対応ホストが
この収録フォルダを発見・操作できるようになる(`docs/plans/2026-07-07-mcp-server-design.md`
設計)。依存追加はゼロ(公式 SDK は使わず、`node:readline`/`node:process` だけの
自前 stdio JSON-RPC 2.0 最小実装。schema バリデータを自前実装した前例と同じ
判断軸)。

### 起動方法

```sh
node src/cli.ts mcp <dir>
```

起動すると1つの収録フォルダ `<dir>` に**束縛**される(dir は起動時に固定、
各 tool は dir 引数を取らない)。プロセスはこのフォルダの外に読み書きできない。
標準入出力で改行区切りの JSON-RPC 2.0 をやり取りする(`initialize` /
`notifications/initialized` / `tools/list` / `tools/call` / `ping`)。ログ・
診断は標準エラーへ出す(標準出力は JSON-RPC 専用チャネル)。終了は Ctrl+C。

### ホストへの登録例

MCP 対応ホストの設定(例: Claude Desktop の `claude_desktop_config.json` 相当)
に、収録フォルダごとに1エントリを追加する形が想定される(dir 束縛の設計上、
複数の収録を1サーバで扱うことはしない):

```json
{
  "mcpServers": {
    "cutflow-2026-07-02-xxx": {
      "command": "node",
      "args": ["/path/to/cutflow/src/cli.ts", "mcp", "/path/to/2026-07-02-xxx"]
    }
  }
}
```

### 露出する tool

「読む」+「承認スコープ外の安全編集」に限定している(AGENTS_CONTRACT.md §11 が正の
一覧・信頼モデル宣言):

| tool | 種別 | 対応する CLI |
|---|---|---|
| `cutflow_describe` | 読取 | `describe <dir> --json` |
| `cutflow_validate` | 読取 | `validate <dir>` |
| `cutflow_frames` | 読取(知覚) | `frames <dir>` |
| `cutflow_materials` | 読取 | `materials <dir>` |
| `cutflow_assert` | 読取(検証) | `assert <dir>` |
| `cutflow_apply` | 安全編集 | `apply <dir>`(`dryRun` 引数で `--dry-run` 相当) |
| `cutflow_id_stamp` | 安全編集 | `id-stamp <dir>` |

`approve` / `unapprove` / `render` / `plan` / `remeta` / `plan-shorts` /
`run` / `ingest` / `transcribe` / `detect` / `preview` / `thumbnail` /
`editor` / `frames-serve` / `learn` は**レジストリに存在せず、tool として
一切呼べない**(汎用の「CLI を実行する」tool も無い)。承認は人間だけの
行為であり、その実体は `approvals.json` の keep 集合ハッシュに束縛された
承認レコード(「承認の実体」節参照)。`cutflow_apply` は `apply <dir>` と同じ
`applyEdits`/`planApply` をそのまま呼ぶので、`approvals.json` 非改変・
`approved` 変更不可の保証を一切緩めない。

ドメイン層の失敗(`validate` がエラーを検出・`apply` が検査で拒否)は
JSON-RPC エラーではなく `tools/call` の成功 result に `isError: true` +
構造化 JSON として返る(呼び出し側のエージェントが読んで自己修正できる
ように)。不正な JSON-RPC・未知メソッド・未知 tool 名・引数の型違反は
標準の JSON-RPC エラーコード(`-32700`〜`-32603`)で返る。

## ⚠️ 最重要の注意: plan の再実行は手編集を消す

`plan`(と `run`)を再実行すると **cutplan.json / chapters.json / meta.json と
「章」トラックのテロップが上書きされる**(他のトラックのテロップは保たれる)。
手編集を始めたら plan は再実行しないこと。
「LLM の案は最初の1回だけ、以降は人間が育てる」が原則。

運用ルールだけには頼らない二重の防御がある:

- 生成物が既にあるときの `plan` / `run` は **`--force` を付けないとエラーで
  止まる**(初回は今までどおり何も聞かれない)
- `--force` で実行しても、上書き前に手編集ファイル一式(cutplan / chapters /
  meta / transcript / overlays)が **`backups/<日時>/` へ自動退避**される。
  消してしまったら退避先のファイルを収録フォルダ直下へコピーし直せば戻る
  (`transcribe` の単体再実行も transcript.json を同じ場所へ退避する)

## 個別コマンドの使い分け

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | 収録直後の1回だけ(2回目以降は `--force` が必要。実行前に backups/ へ退避) |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる。transcribe の再実行はテロップの手編集ごと上書きする(既存の transcript.json は backups/ へ退避される)。`whisper.wordTimestamps: true`(省略時 false)にすると transcribe が各テロップに `words[]`(語単位タイミング。テロップの `style.karaoke` が消費する。省略時と完全に同じ挙動を保つための既定 false)を付ける |
| `ingest <dir> --layout <plain\|obs-canvas\|auto>` / `run <dir> --layout …` | 収録レイアウトを明示するとき。既定は `config.yaml` の `ingest.layout`(初期値 `obs-canvas`=拡張キャンバス方式)。`plain` は通常動画(1画面・カメラ無し。出力解像度=収録の実寸)。`auto` はキャンバス寸法が `screenRegion + cameraRegion` と完全一致なら obs-canvas、それ以外は plain(通常動画の誤判定を避けるため既定にはしない)。**動画だけのフォルダを `editor` で開くと plain として自動 bootstrap される**ので、通常動画は明示しなくてよいことが多い |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(上記。2回目以降は `--force` が必要) |
| `plan <dir> --cuts-only` | カット判断だけをやり直したいとき(章立て・タイトル案・概要欄は変えたくない)。cutplan.json / plan.raw.txt だけを書く(chapters / meta / transcript の章テロップ / overlays の章トラックには触らない) |
| `remeta <dir>` | **カットは手編集済みだが、章立て・タイトル案・概要欄だけ作り直したい**とき。現在の cutplan の keep 区間(=完成動画)を見て chapters / meta と「章」トラックのテロップだけを再生成する。cutplan は触らないのでカットの手編集は保たれる(実行前に transcript / chapters / meta を backups/ へ退避) |
| `plan-shorts <dir>` | **長尺1本からショートの下書きを作りたい**とき。detect の候補区間を LLM に番号で選ばせ、`shorts.json`(各ショート `profile`(camera 有り→`vertical`、plain→`vertical-screen`)/ `approved: false` / 時間順の `ranges`。尺は `config.yaml` の `planShorts.maxDurationSec`(既定60秒)以下)を生成する。時刻は LLM に生成させず番号選択のみ。承認は人間(preview / エディタのショートモードで確認して `approve <dir> --short <name>`)。既存 `shorts.json` があるときは `--force` 必須で、実行前に shorts.json ごと backups/ へ退避する |
| `learn <dir>` | **直前の LLM 生成を人間がどう仕上げたかから、次回用のチャンネルルール追記案を作りたい**とき。`plan.raw.txt`(AI の最初の案)と `describe(dir)` + `meta.json`(人間の仕上げ)を LLM に見せ、`rules.suggested.md` に追記案の下書きを書く。**channel の `rules.md` には一切書き込まない**(採用は人間が内容を確認して手で `rules.md` に転記)。`plan.raw.txt` が無ければ先に `plan` か `run` を実行するよう促してエラー終了。詳細は下記「チャンネル rules と learn」参照 |
| `validate <dir>` | JSON を手編集した後は毎回。整合性エラー(exit 1)と警告を出す。概要欄チャプター(chapters.json)と画面表示の章タイトル(「章」トラックのテロップ)が食い違うと警告するので、片方だけ直した取りこぼしに気づける。GUI の保存も同じ検査を通す(壊れた JSON は保存できない)。`frames/index.json` が現在の JSON より古ければ「frames を撮り直せ」も警告する(下記) |
| `preview <dir>` | cutplan.json を編集するたび。承認前でも動く |
| `approve <dir>` / `approve <dir> --short <name>` | preview(または縦動画)を確認して承認したいとき。`approvals.json` に keep 集合のハッシュを記録し、`cutplan.approved`(または該当ショートの `approved`)を true に同期する。対話操作(preview 確認の y/N を挟む)で、非対話環境からは `--yes` が無いと拒否される。詳細は下記「承認(approve/unapprove)」参照 |
| `unapprove <dir>` / `unapprove <dir> --short <name>` | 承認を取り消したいとき。`approvals.json` のレコードを消し、boolean を false に戻す(安全側の操作なので確認プロンプトは無い) |
| `render <dir>` | `approve` 済み(= `approvals.json` に現内容のハッシュと一致するレコードがある状態)のときだけ実行できる。cutplan.json の `approved: true` を書くだけでは通らない(下記「承認(approve/unapprove)」参照)。transcript.json 修正後の再実行も速い(再文字起こし不要) |
| `render <dir> --short <name>` / `--shorts` | `shorts.json` のショートを書き出すとき(下記「ショート動画」参照)。承認はショート単位(本編の承認とは別のレコード) |
| `describe <dir>` | AI/人間が JSON 群を全部読まずに編集状態(keep/カットの並び・各区間の発言・カット理由・演出・章・ショート)を把握したいとき。人間可読の散文で出す(発言は36字で切り捨て、タイトル案は先頭3件のみ)。元秒⇔出力秒を併記する。末尾に frames の現況(何の絵が `frames/` に入っているか)か、古ければ撮り直し勧告を添える(下記) |
| `describe <dir> --json` | **散文では切り捨てられる情報まで含めて機械的に処理したい**とき。発言・タイトルを一切切り捨てない機械可読な完全射影を stdout に純 JSON で出す(`schemaVersion` / `source` / `summary` / `keeps` / `cuts`(消える発言も全文) / `captions`(全文・`pos`/`style`/`words`・元秒⇔出力秒) / `overlays`(素材・挿入・ワイプ・ズーム・ぼかし・色調整の全フィールド) / `chapters` / `meta`(タイトル全件・概要欄全文) / `bgm` / `shorts`)。パイプ/`JSON.parse` 可能(所要時間の診断行は stderr に出る)。`--json` を付けない限り `describe` の散文出力は完全に不変。**id-stamp 済みのプロジェクトでは各要素に `id` が載る(散文には出ない。@-mention の発見手段はここ)**(下記「安定 id / @-mention」参照) |
| `id-stamp <dir>` | **既存プロジェクトの各要素に `@id` を一括採番したい**とき(冪等。既存 id は保持し、無い要素にだけ振る)。詳細は下記「安定 id / @-mention」参照 |
| `apply <dir> --patch <file>` | **`@id` 指定の編集を検査付きで当てたい**とき(生 JSON を丸ごと書き換えず、配列添字も書かない)。全部 valid なら全書き込み、1つでもエラーなら1バイトも書かない。`--dry-run` で書かずに変更要約だけ見られる。詳細は下記「検査付きアトミック適用(apply)」参照 |
| `frames <dir> --t ... \| --captions \| --every N` | AI がその時刻の絵を確認したいとき(テロップ位置・ワイプ被り・素材の見え方)。`frames/*.png` に出力(実行のたびに古い PNG は全消し) |
| `frames <dir> ... --ocr` | 画面内のコード・ターミナル・エラー文をテキストとして読みたいとき。元収録のフル解像度の画面領域を Apple Vision で OCR し `frames/out<秒>s.ocr.json`(`text` / `lines[].{text,confidence,box}`)に書く。macOS 専用・オフライン。非対応環境では警告のうえ PNG 出力のみ続行し、`--ocr` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames <dir> ... --full-res` | 画面キャプチャ内の文字を絵として鮮明に見たいとき。ベース映像をプロキシ(幅1280px)ではなく元収録のフル解像度にした**合成込み**(テロップ/ワイプ/素材/ズーム/ぼかし込み)still を出す。`--ocr` はテキスト抽出、こちらは見た目そのものの鮮明化(レイアウト込みで確認したいとき)。`--ocr` と併用可。`--full-res` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames-serve <dir>` | **JSON 微調整ループ(編集 → `frames --t …` → 確認 → 編集 → …)を何度も回すとき**。bundle(webpack)+headless Chrome を暖めたまま待ち受ける opt-in の常駐デーモン(下記「frames-serve(常駐フレームサーバ)」参照)。起動していなければ `frames` は現状どおりの単発実行(挙動・出力は不変) |
| `materials <dir>` | **素材(B-roll)の中身を知りたい**とき(尺・解像度・fps・音声有無・`overlays.json`/`bgm.json` との参照クロスリンク・未使用/dangling 検出)。既定は ffprobe だけ。`--frames`/`--ocr`/`--transcribe`/`--all` で見た目・画面文字・音声発話まで opt-in で取得(下記「素材(B-roll)の中身を知る(materials)」参照) |
| `mcp <dir>` | **任意の MCP 対応エージェントにこの収録フォルダを機械的に開かせたい**とき。stdio 上で `describe`/`validate`/`frames`/`materials`/`assert`/`apply`/`id-stamp` 相当の tool を露出する常駐サーバ(上記「MCP サーバ(mcp)」参照)。承認/render/plan 等は露出しない |

`frames` は撮影のたびに、その絵を決める編集 JSON(本編経路は cutplan/
transcript/overlays、`--short` 経路は shorts/transcript/overlays)の内容
フィンガープリントを `frames/index.json` に記録する(stale-PNG 対策。
frames は毎回全消し+撮り直すので安全だが、frames を**呼ばずに**古い PNG を
Read すると編集前の絵を見てしまう罠がある)。これを踏まえ、`validate`(必ず
編集後に叩く)と `describe`(最初に見る)が現在の JSON と突き合わせ、
食い違えば「frames を撮り直せ」と警告する。`frames/index.json` が無い
(未撮影・機能導入前)フォルダでは警告しない。**`config.yaml` の変更
(caption サイズ等)はこの検出の対象外**(JSON 手編集の撮り直し漏れが対象
のため。config を変えたときは自分で撮り直す)。

### frames-serve(常駐フレームサーバ)

`frames` は1回の実行の中では bundle(webpack)と headless Chrome を使い
回すが、CLI は呼び出しのたびに別プロセスなので、微調整ループ(JSON 編集 →
`frames --t 90` → 確認 → JSON 編集 → `frames --t 90` → …)は毎回そのコールド
コストを払い直す。`frames-serve <dir>` はこれを暖めたまま待ち受ける**opt-in**
の常駐デーモン:

```sh
node src/cli.ts frames-serve <dir>          # 起動(bundle+browser を暖機。数十秒)
node src/cli.ts frames-serve <dir> --port 5000  # ポートを変えたいとき(既定 4311)
```

起動している間、`frames <dir> --t ...` 等は自動でデーモンを検出して撮影を
委譲する(何も指定しなくてよい)。**暖めるのは bundle(webpack)と browser
だけ**で、`config.yaml` と編集 JSON(cutplan/transcript/overlays/shorts)は
毎リクエスト読み直すので、デーモン経由でも単発実行と出る絵は完全に同一
(config 編集・JSON 編集は即座に反映される)。

- **opt-in**: `frames-serve` を明示的に起動しない限り、`frames` の挙動・
  出力は現状と1バイトも変わらない(portfile 有無の `existsSync` 1回が
  増えるだけ)
- **中間生成物**: `frames/.serve.json`(`{port, pid}`)。デーモン起動中だけ
  存在し、終了(Ctrl+C)時に自動で消える。`props.json`/`index.json` と同じ
  位置づけで、手で編集・作成しない
- **remotion を触ったら**: `remotion/*.tsx` の変更は mtime で検知して
  自動的に再バンドルする(`node_modules/.cache/webpack` の陳腐化ごと
  作り直す)ので、通常は再起動不要。ただしバンドル自体に失敗する等の
  異常時は一度 Ctrl+C で再起動すれば復旧する
- **終了**: Ctrl+C。`frames/.serve.json` を残さない
- 1 デーモン = 1 収録(bundle が対象フォルダに束縛されるため)。別の収録を
  同時に暖めたいときはポートを変えて別プロセスを立てる

`preview` / `render` は GUI エディタのヘッダーの「プレビュー生成」「レンダー」
ボタンからも起動できる(未保存の編集は自動保存してから走る。render は
「承認済み」チェックが要る)。完了したレンダーは Finder で開く。

AI のカット判断を使いたくない回は、plan を1回走らせてから cutplan.json を
全部自分で直せばよい(実質手動編集)。cutplan.json を自分でゼロから
書いても動く(必要なのは keep 区間のリストと、preview 確認後の
`node src/cli.ts approve <dir>` だけ)。

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

## 承認(approve/unapprove)

**承認の実体は `approved` という boolean ではなく `approvals.json`**
(収録フォルダ直下の別ファイル。触らない第3カテゴリ)。`render` はこの
ファイルの承認レコードだけを見る **strict なゲート**で、`cutplan.json` /
`shorts.json` の `approved: true` を書くだけでは通らない。

```jsonc
// approvals.json(自動生成。人間や AI が直接書かない)
{
  "version": 1,
  "cutplan": { "hash": "sha256:…", "approvedAt": "2026-07-07T…", "by": "cli" },
  "shorts": {
    "highlight-1": { "hash": "sha256:…", "approvedAt": "2026-07-07T…", "by": "gui" }
  }
}
```

- `hash` は **cutplan(または当該ショート)の keep 集合**(`mergeIntervals`
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
  node src/cli.ts approve <dir> --short <name>      # 指定ショートを承認
  node src/cli.ts approve <dir> --yes               # 非対話環境でも承認する(意図的バイパス)
  node src/cli.ts unapprove <dir> [--short <name>]  # 承認を取り消す
  ```
  `approve` はまず `validate` を通し(エラーがあれば承認しない)、
  端末が対話環境(TTY)なら preview 確認の y/N プロンプトを挟む。
  **非対話環境(Bash からの実行・子エージェント等)では `--yes` が無いと
  拒否される**——「承認して」と頼まれても AI が反射的に承認を通すことは
  ない。承認できたら `approvals.json` にレコードを書き、
  `cutplan.approved`(または該当ショートの `approved`)を `true` に同期する
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

## チャンネル rules(rules.md)と learn

`.cursor/rules` の動画版。テロップ様式・トーン/声色・禁止語・ペーシング・
章の付け方・タイトルの型など、**チャンネルで毎回守りたい恒久的な方針**を
自由 Markdown の `rules.md` に書いておくと、`plan` / `plan --cuts-only` /
`remeta` / `plan-shorts` の LLM プロンプトに自動で注入される。

- `brief.md` = **今回の中身**(見せ場・狙い・絶対に切らない内容。収録ごと)
- `rules.md` = **毎回守る型**(恒久的な様式。チャンネル + 収録固有)

### 置き場所

- **チャンネル共通**: 収録フォルダの**親ディレクトリ**に `rules.md` を置く
  (`~/Movies/cutflow/2026-07-02-xxx/` なら `~/Movies/cutflow/rules.md`)。
  そのディレクトリ配下の全収録に効く
- **この収録だけ**: 収録フォルダ直下に `rules.md` を置く(この回だけの
  上書き・追加)。両方あれば連結され、**収録固有が共通ルールより優先**される
- rules ファイルが無ければプロンプトは注入前と完全に同じ(既定挙動は不変)

```markdown
# このチャンネルの編集ルール

## トーン・声色
- ですます調。初学者に語りかける柔らかさ。煽り・過度な誇張はしない。

## テロップ様式
- 専門用語は初出でカッコ書きの短い補足を付ける(例: 「ホットリロード(保存で即反映)」)。

## 禁止語・言い換え
- 「めっちゃ」「ヤバい」は使わない → 「かなり」「大きく」に。

## ペーシング・カット
- 沈黙の“ため”は1秒までは残す(考えている間も味)。切りすぎない。
```

**注意**: `~/Movies/cutflow/` 直下に複数チャンネルを平置きすると
`rules.md` は全チャンネルに効いてしまう。チャンネルを分けたい場合は
サブフォルダを切って(例: `~/Movies/cutflow/series-a/2026-.../`)、その
サブフォルダ直下に `rules.md` を置く運用にする。

### 修正からの学習(`learn <dir>`)

「人間が LLM の生成物をどう直したか」を材料に、次回のための rules 追記案を
LLM に下書きさせるコマンド:

```sh
node src/cli.ts learn <dir>
```

- 入力: `plan.raw.txt`(AI が最初に出した案)・`describe(dir)`(人間が仕上げた
  タイムライン)・`meta.json`(人間が仕上げたタイトル・概要欄)・既存の
  channel `rules.md`(あれば)。すべて読むだけ
- 出力: `<dir>/rules.suggested.md` に追記案の下書きを書く。**channel の
  `rules.md` には一切書き込まない**(「AI は自分で承認しない」原則。採用は
  人間が内容を読んで手で `rules.md` に転記する)
- `rules.suggested.md` は使い捨ての下書き。既存があれば黙って上書きされる
  (次の `learn` 実行で消える前提。採用したい項目は早めに `rules.md` へ転記する)
- `plan.raw.txt` が無い(まだ `plan` / `run` を実行していない)ときは、
  先に実行するよう促してエラー終了する

## plan の知覚(config.yaml の plan.perception。既定オフ)

`plan` / `plan --cuts-only` / `remeta` は既定では発話テキスト(transcript)
だけを見てカット判断・章立てを行う。`config.yaml` の `plan.perception` で、
detect が既に持つ情報や画面の文字を LLM 入力に添えられる(**既定オフ**。
書かない限り LLM 入力・`plan.raw.txt` は導入前と1バイトも変わらない)。

```yaml
plan:
  perception:
    audio: true        # 無音・間の注記(決定論・追加依存なし。まずこれから)
    ocr: false         # 画面OCRテキスト(macOS/Apple Vision 必要・区間数ぶん重い)
    ocrMaxSegments: 40
    ocrMaxLines: 6
    systemSpeech: false # システム音声の発話(要 whisper.systemAudio。下記参照)
```

- `audio`: 各区間の `尺` / `直前カット`(直前に落ちた素材秒)/ `内無音`(区間内に
  残った無音の合計秒)を秒で記述文にして添える。すべて `cuts.auto.json`(detect
  の結果)と番号区間だけから計算する純関数で、**新規の音量計測はしない**。
  決定論・追加依存なしなので、まず有効にするならこちら
- `ocr`: 各区間の代表フレーム(元収録の中点)を `frames --ocr` と同じ
  Apple Vision OCR にかけ、画面内の文字(コード・ターミナル・エラー文)を
  記述文にして添える。macOS + Apple Vision が必要で、無い環境では警告のうえ
  OCR 部分を省いて続行する(plan 自体は止まらない)。区間数ぶんの ffmpeg
  クロップ+Vision が走るため `ocrMaxSegments`(既定40。超過時は尺の長い区間を
  優先)・`ocrMaxLines`(区間ごとにプロンプトへ載せる行数の上限。既定6)で
  コストを抑える
- どちらも LLM に算術はさせない(値はこちらで丸めて記述文として渡し、番号選択
  だけをさせる)。`plan-shorts` はこの機能の対象外(触らない)
- 画像(スクリーンショット)そのものを LLM に渡すマルチモーダル入力は
  **やらない**(既定 backend の claude-cli では画像添付が難しく、backend 非依存の
  `complete` 設計に反するため。開発系チャンネルは画面の主役が文字なので OCR で
  代替する)
- `systemSpeech`: システム音声(デモ音・再生動画・TTS)の発話を各区間へ添える。
  `whisper.systemAudio: true`(下記)で `transcript.system.json` を先に作っておく
  必要があり、無ければ自動で省略(劣化)する

## システム音声の文字起こし・keep 内の間(AI の耳の強化。既定オフ)

マイク音声(あなたの声)は `transcript.json` に描画用テロップとして起こされるが、
最終出力に mix される**システム音声**(デモアプリの音・再生した動画・TTS の
読み上げ)は従来 AI から不可視だった。これを**知覚専用**に文字起こしできる。

```yaml
whisper:
  systemAudio: false  # true でシステム音声(ingest.systemTrack)を第2トラックとして
                      # 文字起こしし transcript.system.json を書く
describe:
  pauses: false       # keep 内に残った無音(間)の位置と長さを describe に出す
  pauseMax: 3         # 1 keep あたりに出す間の件数上限
  pauseMinSec: 0.6    # これ以上の長さの間だけ出す(秒)
```

- **システム音声の文字起こし(`whisper.systemAudio`)**: 収録にシステム音声トラック
  (`ingest.systemTrack`)があるとき、`ingest` が `audio/system.wav` を抽出し、
  `transcribe` が第2回 whisper で `transcript.system.json`(`speaker: "system"`)を
  書く。これは**描画されない・編集されない・`@id`/承認/apply の対象外の知覚専用
  生成物**で、`transcript.json`(テロップの描画契約)には混ざらない。`describe`
  (散文は `[システム音声]「…」`、`--json` は `systemAudio` キー)と、`plan` の
  `plan.perception.systemSpeech` で読める。既定 false のとき出力は一切変わらない
  (収録に system トラックが無ければ true でも自動で無視)。
- **話者分離について(正直な宣言)**: cutflow の「話者分離」は**収録トラック起源の
  音源分離**(マイク=あなた / システム=アプリ・デモ・TTS)であって、1本の音声波形
  から複数の人間の声を聞き分ける**音響的 diarization ではない**。OBS の2トラック
  収録では声とアプリ音が物理的に別トラックに録れているため、トラックを分けて
  文字起こしするだけで実用上の分離になる。1マイクに複数人が乗る収録の分離は
  重い ML 依存(pyannote 等)を招くため**やらない**(ローカル・決定論・ソロ保守の
  方針)。
- **keep 内の間(`describe.pauses`)**: `plan.perception.audio` が区間内無音の
  **合計秒**を渡すのに対し、これは残した keep の**どこに何秒**の間があるかを
  `describe`(散文/`--json`)に出す(「ここを詰める/カットを足す」判断の材料)。
  `cuts.auto.json` の無音区間から算出する純関数で**新規計測はしない**。既定 false。

## ショート動画(shorts.json)

本編とは別に、収録の一部を縦動画(YouTube ショート等)として切り出せる。
収録フォルダに `shorts.json` を書く:

```jsonc
{
  "shorts": [
    {
      "name": "hook-mistake",          // 出力: shorts/hook-mistake.mp4
      "profile": "vertical",           // 省略時は camera 有り→"vertical"、plain→"vertical-screen"
      "approved": false,               // 承認意図の表示(render --short の実ゲートは approvals.json)
      "ranges": [                      // 元収録の秒。このショート専用の keep 集合
        { "start": 120.0, "end": 158.0 }
      ],
      "captionTracks": [               // 縦用テロップ位置/スタイルの上書き(任意)
        { "track": 1, "y": 1600, "style": { "fontSizePx": 92 } }
      ]
    }
  ]
}
```

- `ranges` は複数指定でき、飛び区間をまとめて1本にできる(フィラーを
  飛ばしたいときはレンジを分割する)。**本編 `cutplan.json` の keep とは
  独立**(本編でカットした素材もショートに含められる。交差判定はしない)
- `profile` は組み込みレイアウトから選ぶ: `vertical`(camera上+screen下
  スタック)/ `vertical-screen`(画面だけを縦に contain。下は字幕帯の黒帯)/
  `vertical-cover`(camera全画面)/ `default`(横・本編と同じワイプ経路)。
  実体は `src/lib/profile.ts` の組み込み定数で、**config.yaml には追加しない**
  (閉じたプリセット。設定爆発の回避)。**省略時の既定**は収録に camera が
  あるか(`manifest.layout: "obs-canvas"` かつ `cameraRegion` あり)で自動的に
  決まる: camera 有り→`vertical`、通常動画(plain)→`vertical-screen`
  - 通常動画(`manifest.layout: "plain"`。カメラの無い収録)では `vertical`
    (画面+カメラの2段構成)は使えない(`validate` がエラーにする)。
    `vertical-screen`(画面だけを縦の枠へ contain。16:9 の画面録画でも左右
    上下を切らない。既定)/ `vertical-cover`(収録全体を縦へ cover。元から
    縦のスマホ動画なら綺麗に決まるが、16:9 画面録画では両端が切れる)/
    `default` のいずれかを使う。plain の「カメラ」は収録全体=画面として
    解決される
- `captionTracks` は `overlays.json` と同じ形式・解決順(セグメント個別 →
  トラック標準 → 既定)。テロップの文言・タイミング自体は `transcript.json`
  を流用する(ショート専用のテロップファイルは無い)

書いたら validate → 承認 → 書き出しの順:

```sh
node src/cli.ts validate <dir>                        # name の重複・ranges・座標を検査
node src/cli.ts approve <dir> --short hook-mistake     # 縦動画を確認してから承認(承認(approve/unapprove)参照)
node src/cli.ts render <dir> --short hook-mistake      # 1本だけ
node src/cli.ts render <dir> --shorts                  # 承認済みな全ショート(未承認はスキップしログ表示)
```

- **承認はショート単位の別レコード**(本編 `cutplan.json` の承認とは別。
  縦・字幕再配置後の別の絵なので、本編の承認では代用しない)
- キャッシュの考え方は本編と同じ(full-skip: 編集内容・素材・profile が
  前回と同じなら Remotion 実行ごとスキップ)だが、**チャンク差分レンダーは
  ショートには使わない**(短尺なので恩恵が小さい)。生成される中間ファイルは
  `cut.<name>.mp4` / `cut.<name>.keeps.json` / `render.<name>.props.json` /
  `render.<name>.key.json`(いずれも触らない)

**v1 の制限**: 本編 `overlays.json` の素材/インサート/ワイプ全画面/字幕非表示と
`bgm.json` は**継承しない**(rect が横向き前提で縦に翻訳できない・inserts は
尺を変えるため)。ショートに演出や BGM を足したい場合は今後の対応を待つ。

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
  (`fontSizePx` / `color` / `outlineColor` / `fontFamily` / `fontWeight` /
  `background` / `anim` / `karaoke`)を共有する(動画と見た目の言語を揃える
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

## 音量

- **最終出力は自動で -14 LUFS(YouTube 基準)に正規化される**ので、
  収録音量の多少のばらつきは気にしなくてよい(config.yaml `render.targetLufs`)
- **システム音声(OBS トラック2)は収録にあれば自動でマイクとミックス**されて
  出力に入る(render / preview / proxy 共通)。バランスは config.yaml
  `render.systemAudio.volumeDb`、`mix: false` でマイクのみ(従来どおり)に戻せる。
  正規化はミックス後の全体にかかる
- ただし**収録時のゲインが低すぎるのは別問題**: detect の無音判定
  (-35dB 以下=無音)に発言が引っかかってカットされる危険がある。
  OBS のメーターで、普通に喋って黄色ゾーン(-20〜-10dB)を目安に
- **マイクの環境ノイズが気になる場合**は config.yaml `render.denoise.mic: true`
  でノイズ除去(ffmpeg afftdn)がかかる(既定 false)。**マイク音声にのみ**
  かかり、システム音声(アプリ音・デモ音)は対象外(デジタル由来でノイズが
  無く、通すと音楽・効果音が劣化するため)。強さは `noiseFloorDb`(既定 -25。
  下げるほど控えめ、上げるほど強い)で調整。正規化(loudnorm)より前段に
  入るため、ノイズ除去後の音声に対して -14 LUFS へ揃う

## BGM

いちばん簡単なのは収録フォルダに `bgm.mp3`(または bgm.m4a / bgm.wav)を
置いて render するだけ。全編に自動ループで流れ、終端でフェードアウトする。

**区間ごとに BGM を出し分けたい**(イントロだけ無音、途中で別の曲に切り替え、
2曲を重ねる…)ときは収録フォルダに `bgm.json` を書く。`bgm.json` があると
上の `bgm.*` 全編1曲は無効になり、`tracks[]` の区間だけが流れる。

```jsonc
{
  "tracks": [
    // イントロ(元 0〜42.5 秒)は覆わない → 無音
    { "start": 42.5, "end": 600, "file": "bgm.mp3", "fadeInSec": 1 },
    // エンディングだけ別の曲(materials/ に置く)。終端でフェードアウト
    { "start": 600, "end": 640, "file": "materials/outro.mp3", "volumeDb": -18, "fadeOutSec": 3 }
  ]
}
```

- `start` / `end` は他の編集ファイルと同じく**元収録の秒**。ツールがカット後の
  時刻へ写像する(カットをまたぐ区間は自動でひと続きに繋がる)
- `file` は収録フォルダからの相対パス。**素材と同じように** `materials/` に
  別の BGM を置いて参照すればよい(アップロードはエディタの素材パネルからでも
  OK)。区間を並べれば曲の切り替え、区間を重ねれば重奏になる
- `volumeDb`(省略時は config の `render.bgm.volumeDb`)/ `startFrom`(頭出し)/
  `fadeInSec` / `fadeOutSec` を区間ごとに指定できる
- 音量は config.yaml `render.bgm.volumeDb`(デフォルト -22dB)。
  「BGMがうるさい動画」になるのを避けるため、声より20dB前後小さくが目安
- **発話中は自動でダッキング**(さらに `render.bgm.ducking.duckDb` 下げる。
  デフォルト -8dB、`fadeSec` 秒で滑らかに下げ・戻し)。どの区間の BGM にも
  効く。発話区間は無音検出(cuts.auto.json)から決定的に求めるので LLM は
  使わない。`duckDb: 0` で無効。エディタのプレビューでも同じ聞こえ方になる
- `bgm.json` を編集したら `validate` で検査する(区間・ファイル存在を確認)

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
- **wipeFull**: ワイプ(カメラ)を全画面にして背景を隠す区間。出入りは
  config.yaml の `render.wipeTransitionSec`(既定 0.3 秒、0 で瞬時。エディタの
  設定画面 ⌘, からも変更可)でなめらかに遷移する。遷移は区間全体の頭と末尾に
  だけ入り、カット・挿入・隣接エントリで区間が繋がっている継ぎ目では走らない
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
  - かかるのは**ベース映像の背景レイヤー(画面クロップ)だけ**。ワイプ・
    テロップ・素材オーバーレイ・挿入クリップの位置・可読性は変わらない
  - エディタでは専用の「ズーム」トラックにドラッグで区間を作り、プレビュー上の
    枠をドラッグ・リサイズして `rect` を調整する(素材の部分配置と同じ操作感)
  - ショート(`shorts.json` の縦動画)には効かない(overlays.json を継承しない
    既存設計により自動的に除外される)
- **blurs**: 画面の一部にぼかし/モザイクを掛けて隠す(開発画面の API キー・
  PII・パスワード等の秘匿情報向け)
  - `rect`: 隠す矩形 `{x, y, w, h}`(出力px。テロップ `pos` や `zooms` の
    `rect` と同じ座標系)。画面外へはみ出すと `validate` がエラーにする
  - `type`: `"blur"`(CSS ぼかし。省略時の既定)/ `"mosaic"`(ピクセル化)
  - `strength`: 強度(0〜1。省略時 0.5)。`type` ごとに px へ変換される
    (blur=ぼかし半径・mosaic=ブロック辺長)
  - かかるのは**ベース映像(画面クロップ)だけ**。テロップ・素材オーバーレイは
    ぼかしの上に描画される(隠れない)
  - 遷移(フェード)は無い硬い ON/OFF。秘匿はなめらかに現れてはいけないため
  - `zooms` には追従しない(出力px固定)。zoom 区間と時間が重なると
    `validate` が警告する(隠したい情報が矩形からずれて露出しうるため。
    重ねないか rect を広げて対処する)
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

## カット境界のディップ・トゥ・ブラック(config.yaml `render.cutTransition`)

既定(`type: none`)ではカット境界(keep区間の継ぎ目)は瞬時に切り替わる。
`type: dip-to-black` にすると、境界の前後で黒フェードが入る(ジャンプカットの
繋ぎ目を和らげる演出)。`sec` は黒への往復の合計秒(前半でフェードアウト、
後半でフェードイン)。カット段(cut.mp4)自体には触れない Remotion 合成層の
オーバーレイなので、動画の総尺・音声・テロップのタイミングは変わらない。

```yaml
render:
  cutTransition:
    type: dip-to-black
    sec: 0.3
```

境界ごとの個別指定はできない(全境界に一律で効く)。`hardwareAcceleration` /
`chunkSec` と同じく config.yaml のみの設定で、GUI エディタの設定画面には
専用の UI はない(エディタのプレビューは render.props.json を最終レンダーと
共有しているため、config.yaml を変えれば自動でプレビューにも反映される)。

ズーム演出(`overlays.json` の `zooms`)の遷移秒数の既定値も同じ扱いで、
config.yaml の `render.zoom.easeSec`(既定 0.4)のみで変更する
(`zooms[].easeSec` で個別指定があればそちらが優先)。

## 見た目の調整(Remotion Studio)

ワイプの大きさ・余白・字幕サイズ・テロップ既定の色/縁/フォントは
GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)から変更できる
(実体は config.yaml の `render` セクションなので YAML 手編集でもよい)。
黒帯などデザインそのものを変えたいときは `remotion/Main.tsx` を編集する。

設定画面で保存した変更のうちラウドネス(`targetLufs`)・システム音声・
ノイズ除去(`denoise`)・プレビュー幅は proxy.mp4 に焼き込まれるため、
エディタのプレビューへ反映するにはプロキシの再生成が必要(保存後に
バナーで案内が出る。書き出しには再生成なしで反映される)。

## render の高速化(config.yaml `render.hardwareAcceleration`)

`render` の Remotion 合成段は `if-possible`(既定)で GPU ハードウェア
エンコーダ(macOS は VideoToolbox)を使い、`disable` で従来のソフトウェア
エンコードに戻せる。`if-possible` はハードウェアエンコーダが使えない
環境では自動でソフトウェアエンコードにフォールバックする(エラーには
ならない)。実測は docs/perf.md 参照。

`proxy.mp4` / `preview.mp4` は config.yaml `preview.videoEncoder`(既定
`videotoolbox`)で同じくハードウェアエンコーダを使う。生成時間は
`libx264` とほぼ同じだがファイルサイズが小さい。`libx264` を指定すると
従来の ultrafast+CRF に戻る。

```sh
# レイアウトだけ確認(動画部分はプレースホルダー表示)
npx remotion studio

# 実際の収録データを流し込んで確認(render を1回実行した後に使える)
npx remotion studio --props <収録フォルダ>/render.props.json --public-dir <収録フォルダ>
```

Studio はブラウザで開く動画エディタ風の画面で、Main.tsx を保存すると
即座に反映される。デザインが決まったら通常の `render` を実行する。
