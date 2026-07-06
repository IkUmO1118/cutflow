# 読める目:フル解像度 still + 画面 OCR — 設計

*2026-07-06 / 診断レビュー「Now ロードマップ #1」の設計。実装は別担当(Sonnet)。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ A「AI の知覚強化(目・耳)」/ 項目「目が proxy 静止画で画面内テキストを
> 読めない」= severity **blocker** / effort **M**。

---

## 背景とギャップ

`frames` は「AI の目」。だが**ベース映像に proxy.mp4(幅 1280px)を渡している**。
OBS 拡張キャンバス収録はキャンバス 3840×1080(左半分=画面 `screenRegion {0,0,1920,1080}`・
右半分=カメラ)。proxy は 3840→1280 に縮小済みなので画面領域は元の約 640px 相当しか
残らず、それを出力 1920px へ約 3 倍アップスケールする。結果、**開発スクリーンキャストの
主役=画面内のコード・ターミナル・エラーが判読不能**。`CLAUDE.md` 自身が「画面キャプチャ内の
細かい文字の可読性はこの画像では判断できない」と明記している。

問題は**出力解像度ではなくソース解像度**。default プロファイルの出力は screenRegion サイズ
(1920×1080)で既に十分。フル解像度の raw(`manifest.source`)から画面領域を取り直せば鮮明になる。

この設計のゴールは **「AI が画面内テキストをテキストとして読める」知覚能力の追加**。
具体的には Apple Vision OCR で画面領域を文字列化し、AI が Read で読めるサイドカーに落とす。

## スコープ

**やること(今回)**
- フル解像度の画面領域 still 取得経路(読むこと専用)。
- その still に対する画面 OCR(Apple Vision)。
- `frames --ocr` として露出。既存の proxy ベース frames は 1 バイトも変えない。

**やらないこと(明示的にスコープ外)**
- **OCR 結果を `plan` / `remeta` / `plan-shorts` に流し込むこと**。目耳を意思決定ループへ
  接続するのは Next テーマ「カット判断ループに目耳を接続」。今回は**知覚"能力"を作るところまで**で、
  `src/stages/plan.ts` は一切触らない。
- 音声側(語単位タイムスタンプ・システム音声・非言語音)。別項目。
- OCR 結果を使った自動編集・自動アサーション。

---

## 論点と決定

### 論点1:フル解像度 still の取得方式 → **決定: (B) ffmpeg で screenRegion をフル解像度クロップ(合成なし)。(A) は PoC ゲートの任意ストレッチ**

比較:

| 案 | 中身 | 長所 | 短所 |
|---|---|---|---|
| **(A)** | frames の `videoFile` を `manifest.source`(raw)に差し替え、`videoIsSource:true` のまま Remotion へ | 合成込み(テロップ/ワイプ/素材/ズーム/ぼかし)でフル解像度 | **headless Chrome が raw(mkv/HEVC等)を still でシーク・デコードできるかが不確実**。proxy はまさにこの用途の H.264 mp4 |
| **(B)** | ffmpeg で該当元秒の **screenRegion だけ**をフル解像度で PNG 化(純粋に画面の絵) | 決定論・高速・Chrome 非依存・デコードリスク 0。**合成レイヤがテロップ等で画面文字を隠さない**=OCR 入力として最適 | 合成の見た目(テロップ位置)は写らない(それは従来の proxy frames が担う) |
| **(C)** | ffmpeg でフル解像度の canvas フレームを抽出 → それを画像として Remotion のベースに差し込み合成 | A の Chrome デコード問題を回避しつつ合成込み | Main.tsx のベースが `OffthreadVideo`(CroppedVideo)なので `Img` 経路の追加が要る=侵襲大。OCR には不要な複雑さ |

**決定と理由**

- **OCR の主役は (B)**。OCR が欲しいのは「画面の生ピクセル」であって合成結果ではない。むしろ
  合成(テロップ帯・ワイプ)は画面文字を**隠す**方向に働くので、合成込みは OCR にとって害。
  (B) は Remotion を一切通さない → **論点1のAで問題になる「raw を Chrome が読めるか」問題が
  そもそも発生しない**。決定論・高速・依存最小で blocker を直接解消する。
- **(A) は任意のストレッチ**として `--full-res`(OCR とは別フラグ)で提供を検討するが、
  **PoC で Chrome の raw デコード可否を確認してから**(タスク分解参照)。PoC が NG なら (A) は
  落とす。OCR 能力は (B) 単独で完結するので、(A) の成否は本項目の blocker 解消に影響しない。
- **(C) は却下**(今回は不要な侵襲)。将来 A が NG で「合成込みフル解像度 still」が要るとなった
  ときの保険として名前だけ残す。

**クロップの座標**:raw canvas は `manifest.video.{width,height}`(bench では 3840×1080)、
画面は `manifest.video.screenRegion`(bench では `{0,0,1920,1080}`)。ffmpeg
`-vf crop=w:h:x:y` に screenRegion をそのまま渡せばフル解像度の画面領域が出る。カメラ領域・
テロップ帯は含めない(screenRegion 外なので自然に落ちる)。

**時刻**:frames のターゲットは**出力(カット後)秒**(`outSec`)。raw をクロップするには
**元収録秒**が要る。`src/lib/timeline.ts` に逆写像 `toSourceTime(outSec, timeline)` が既にある
ので、それで outSec → 元秒に変換して `-ss` に渡す。

**`--short` との組み合わせ**:可。ショートの keep 集合(`ranges`)から作った timeline で
outSec → 元秒へ写像し、同じ raw screenRegion をクロップする(ショートの縦 profile の画面配置とは
無関係に、読むのは常に元の画面領域)。frames.ts の `--short` 分岐が既に `keeps` と `overlays` を
切り替えているので、その `keeps` から timeline を組めばよい。

### 論点2:OCR エンジンと呼び出し方式 → **決定: Apple Vision / swiftc で事前コンパイルしたバイナリを実行(初回のみコンパイル・キャッシュ)。非対応環境は優雅に劣化**

エンジン:**Apple Vision `VNRecognizeTextRequest`**(親が実機確認済み。オフライン・追加インストール
不要・高品質・日本語対応)。tesseract は非採用(環境に無い)。

呼び出し方式の比較:

| 案 | 起動コスト | 配布 | 判断 |
|---|---|---|---|
| (a) `swift <file>` 実行時解釈 | 毎回 swift のコンパイル込み(1〜数秒/回)で遅い | ソースを同梱するだけ | frames は 1 実行で複数枚を回すので毎回は重い |
| (b) **swiftc で事前コンパイル→バイナリ実行** | 初回だけコンパイル、以降はバイナリ起動(速い) | ソース同梱 + 初回に自動ビルド | **採用** |
| (c) 実行時に一時 swift を書いて実行 | (a) と同等に遅い | 何も同梱不要 | 遅く、キャッシュも効かない |

**決定: (b)**。swift ソースを `bin/ocr/vision-ocr.swift`(仮)としてリポジトリに同梱し、
`src/lib/ocr.ts` が「バイナリが無ければ swiftc でビルド → キャッシュ(scratch 的な安定パス、例
リポジトリ内 `bin/ocr/.build/vision-ocr` を .gitignore)→ 以降は実行」。
Node 側は `execFile`(`src/lib/exec.ts` の `run`)でバイナリを起動し、**画像パスを引数、JSON を
stdout で受ける**プロトコルにする。

**優雅な劣化(必須)**:
- 実行環境が macOS でない、`swift`/`swiftc` が無い、ビルド失敗、のいずれかなら **OCR を切って
  警告を出し、frames 本体(proxy PNG 出力)は成功で返す**(exit 1 にしない)。既存の `run` は
  ENOENT を分かりやすい例外にするので、`src/lib/ocr.ts` 側で try/catch して
  `warn("OCR は Apple Vision(macOS)が必要です。画面 OCR をスキップしました")` に落とす。
- 「非対応時は `--ocr` があっても PNG は従来どおり出る」= 既存挙動を壊さない。

**OCR 入力画像**:論点1(B)の**フル解像度 screenRegion クロップ**を渡す。カメラ領域・テロップ帯を
含めない(screenRegion クロップなので構造的に含まれない)。

**認識設定(コード内の閉じた定数。profile.ts の D1 と同じ思想)**:
- 認識レベル = **accurate**(`.accurate`)。速度より精度(開発画面の小さな等幅フォント)。
- `usesLanguageCorrection = true`。
- 認識言語 = `config.yaml` の `ocr.languages`(既定 `[en, ja]`)。開発画面は英語コードが主で
  日本語テロップ/コメントが混在。Vision は `recognitionLanguages` に優先順で渡す。

### 論点3:インターフェース → **決定: `frames --ocr`(サイドカー JSON + stdout 抜粋)。独立コマンドは作らない**

比較:
- **`frames --ocr`(採用)**:frames のターゲット選択(`--t`/`--captions`/`--every`/`--short`)と
  時刻写像・スナップ・全消し慣習をそのまま再利用できる。OCR は「その時刻の画面を読む」ので
  frames と同じ「時刻→絵」の軸に完全に乗る。
- 独立コマンド `read`/`ocr <dir> --t ...`(却下):ターゲット展開・時刻写像・`toSourceTime` を
  丸ごと再実装することになり重複。frames と別軸を作る利点が無い。

**出力の中身**:各 still に対応するサイドカーを `frames/` に書く。
- `frames/out<sec>s.ocr.json` … 機械可読。行単位で `text` / `confidence` / `box`(**出力px**)。
  出力px にするのは、AI が既に扱う座標系(caption `pos`・`blurs.rect` と同じ出力px)に揃えて
  「◯◯という文字はどこ」を blur/ズーム rect にそのまま使えるようにするため。
- 併せて `text` を素の読み順で連結した文字列も JSON に持たせる(単に「読む」用途)。素の
  `.txt` を別に作るかは実装判断だが、**JSON 1 本 + そこに全文フィールド**で用途は足りる。
- **stdout に各フレームの先頭数行を echo**(既存 frames が 1 枚ごとに `✔ …: file` を出すのと同じ
  ノリで、`  OCR: "const foo = …" ほか N 行` のように)。AI がファイルを開かずに読めると速い。

**box の座標変換**(純関数・要テスト):Vision の `boundingBox` は正規化(0..1・原点左下・y 上向き)。
→ クロップ画素へ(y 反転)→ 出力px へ線形スケール。default プロファイルでは
クロップ(screenRegion 1920×1080)= 出力(1920×1080)で 1:1、縦 profile 等で出力サイズが違う
ときだけスケールがかかる。式:
```
cropPx.x = nx * cropW
cropPx.y = (1 - ny - nh) * cropH          // 左下原点→左上原点へ反転
outPx.x  = cropPx.x * (out.width  / screenRegion.w)
outPx.y  = cropPx.y * (out.height / screenRegion.h)
```

**全消し慣習に従うか → 従う**。frames は実行ごとに `frames/*.png` を全削除する
(古い絵を読む事故防止)。**同じ理由で `.ocr.json` サイドカーも実行ごとに全削除**してから
書き直す(古い OCR を読む事故を同様に防ぐ)。frames.ts の削除ループを `.png` だけでなく
`.ocr.json` も対象にする。

**スコープ境界(再掲・doc にも明記)**:`--ocr` はサイドカーを書くところまで。**OCR 結果を
`plan` 等の LLM プロンプトに注入するのはスコープ外**。今回作るのは「AI が読める形にする能力」。

### 論点4:config 追加の要否 → **決定: `ocr.languages` のみ config へ。有効化はフラグ。既定は未使用時完全不変**

`whisper.wordTimestamps`(既定 false・未使用時バイト等価)の前例に倣う。
- **有効化はフラグ `--ocr`**(config に enable フラグは置かない。実行時の意図なので)。
- **config には可変のチューニングだけ**:`ocr.languages`(認識言語の優先順)。言語は収録の
  言語構成で変わりうる(英語のみの海外向け等)ので config が妥当。
- 認識レベル(accurate)・言語補正は**コード内の閉じた定数**(profile.ts の D1 と同じ:プリセット的で
  変える必要が薄いものは設定爆発を避けてコードに置く)。
- `ocr` ブロックごと省略可。省略時 `loadConfig` が `cfg.ocr ??= {}` → `languages ??= ["en","ja"]`。
  **`--ocr` を使わない限り config も読まれず、既存挙動は 1 バイトも変わらない**。

---

## スキーマ / インターフェース案

### CLI(`src/cli.ts` の frames コマンド)
```
node src/cli.ts frames <dir> --t 90 --ocr           # その時刻の画面を OCR
node src/cli.ts frames <dir> --captions --ocr        # テロップ全件の画面を OCR
node src/cli.ts frames <dir> --every 10 --ocr        # 定間隔で画面 OCR
node src/cli.ts frames <dir> --t 90 --short intro --ocr
```
`--ocr` は既存の `--t/--captions/--every/--short` と直交する追加オプション。単独指定不可
(どのフレームを撮るかは従来どおり 3 モードのいずれかが必要)。

### 出力(`frames/` 内・実行ごとに全消し)
- `out<sec>s.png` … 従来どおりの合成 PNG(**proxy ベースのまま。変更なし**)。
- `out<sec>s.ocr.json` … 新規。`--ocr` のときだけ書く。
```jsonc
{
  "outSec": 90.00,          // 出力(カット後)秒。PNG と対応
  "sourceSec": 132.40,      // クロップ元の元収録秒(toSourceTime の結果)
  "image": { "w": 1920, "h": 1080 },   // OCR にかけたクロップの画素寸法
  "text": "const foo = bar\nnpm run build\n…",  // 読み順の全文(単に読む用)
  "lines": [
    { "text": "const foo = bar", "confidence": 0.98,
      "box": { "x": 120, "y": 340, "w": 410, "h": 44 } }   // box は出力px
  ]
}
```

### 型(`src/types.ts` へ追記イメージ)
`FrameShot` に OCR サイドカーのパスを任意で足す(CLI の echo 用):
```ts
export interface FrameShot {
  requested: number;
  outSec: number;
  file: string;
  note?: string;
  ocrFile?: string;   // --ocr のとき書いたサイドカー(絶対パス)。省略時は OCR なし
}
```
OCR の行の型は props.ts の `Region` を再利用(`box`)。`src/lib/ocr.ts` にローカル型:
```ts
export interface OcrLine { text: string; confidence: number; box: Region; }
export interface OcrResult { text: string; lines: OcrLine[]; image: { w: number; h: number }; }
```
> TS 制約:enum・namespace・パラメータプロパティは使わない(Node 23 type stripping)。
> フィールドは明示宣言して代入する。

### config(`config.yaml` 追記・`src/lib/config.ts` の `Config` に追加)
```yaml
# 画面 OCR(frames --ocr)。AI が画面内テキスト(コード/ターミナル/エラー)を
# テキストとして読むための Apple Vision OCR 設定。macOS 専用・オフライン。
# frames --ocr を使わない限り一切走らない(既定挙動は完全に不変)。
ocr:
  # 認識言語の優先順(Vision の recognitionLanguages)。開発画面は英語コードが
  # 主で日本語テロップ/コメントが混在するので en 優先・ja 併記
  languages: [en, ja]
```
```ts
// Config に追加(すべて省略可)
ocr?: { languages?: string[] };
// loadConfig 末尾:
cfg.ocr ??= {};
cfg.ocr.languages ??= ["en", "ja"];
```

---

## タスク分解(1 タスク = 1 コミット・小さく直列)

> **タスク 0 は PoC(spike)**。結果でタスク 6(任意の `--full-res`)の実施可否が分岐する。
> OCR 本体(タスク 1〜5)は PoC 結果に依存しない=blocker はここまでで解消する。

### タスク 0(PoC / spike・コミットなし)
- **やること**:bench 収録で 2 点を実測。
  1. **Vision OCR 実現性**:`ffmpeg -ss <元秒> -i <raw> -vf crop=1920:1080:0:0 -frames:v 1 crop.png` で
     フル解像度の画面クロップを作り、swift の Vision ワンショットにかけて**画面のコード/ターミナル文字が
     テキストで取れるか**を確認。
  2. **(A) の可否**:`manifest.source`(mkv)を Remotion `renderStill` のベースに渡して 1 枚
     still を出せるか(headless Chrome が raw をデコード・シークできるか)を確認。
- **判断**:1 が OK なら OCR 本体(タスク 1〜)へ。2 が OK ならタスク 6 で `--full-res`(案 A)を
  実装、NG ならタスク 6 は見送り(または将来の案 C)。**結果を本 doc 末尾か PR 説明に追記**。
- **壊してはいけない**:何も。読み取りと使い捨てクロップのみ。

### タスク 1:Vision OCR ヘルパー(swift ソース + Node ラッパー)
- **変更**:`bin/ocr/vision-ocr.swift`(新規)、`src/lib/ocr.ts`(新規)、`.gitignore`(ビルド成果物)。
- **中身**:swift は「画像パス + 言語 CSV を受け、`{text, lines:[{text,confidence,box(正規化)}]}` を
  stdout JSON で返す」。`src/lib/ocr.ts` は (i) swiftc ビルド(初回のみ・キャッシュ)、(ii) バイナリ実行、
  (iii) 正規化 box → 出力px 変換(論点3の式)、(iv) 非対応環境の try/catch → warn 劣化。
- **テスト**:`test/ocr.test.ts`(node --test)で**純関数**をテスト = Vision の正規化 JSON 文字列を
  入力に、出力px 変換と行整形が正しいこと(y 反転・スケール)。実バイナリは呼ばない(macOS 依存を
  テストに持ち込まない)。座標変換関数は `src/lib/ocr.ts` から export して単体で固定。
- **壊してはいけない**:既存コードから未参照の新規ファイルのみ=既存挙動ゼロ影響。

### タスク 2:フル解像度 screenRegion still 抽出ヘルパー(ffmpeg)
- **変更**:`src/lib/screenStill.ts`(新規)。
- **中身**:`(dir, manifest, sourceSec) → PNG パス` を ffmpeg `-ss …-i raw -vf crop=screenRegion -frames:v 1`
  で作る(`src/lib/exec.ts` の `run` を使用)。クロップ rect は `manifest.video.screenRegion`。
- **テスト**:crop 引数・`-ss` 値の**組み立て(純関数)**を `test/screenStill.test.ts` で固定
  (screenRegion → `crop=w:h:x:y` 文字列、元秒の丸め)。ffmpeg 実行そのものはタスク 3 の bench 検証で。
- **壊してはいけない**:未参照の新規ファイルのみ。

### タスク 3:`--ocr` を frames へ配線
- **変更**:`src/stages/frames.ts`、`src/cli.ts`(frames コマンドに `--ocr` 追加)、`src/types.ts`
  (`FrameShot.ocrFile?`)。
- **中身**:frames の各ターゲット(outSec)について、`--ocr` のとき:
  (i) `toSourceTime(outSec, timeline)` で元秒を得る、(ii) タスク2で crop PNG を作る、
  (iii) タスク1で OCR、(iv) `frames/out<sec>s.ocr.json` を書く、(v) `FrameShot.ocrFile` に載せる。
  frames.ts の PNG 全消しループを **`.ocr.json` も削除**するよう拡張(論点3)。CLI は各 shot の
  echo に OCR 先頭数行を足す。timeline は既に `buildTargets` 内で組んでいる(`--t` 経路)ので、
  captions/every 経路でも同じ timeline を使えるよう `frames()` 側で 1 本に持たせる。
- **テスト**:配線は実データ検証(bench)を主とする。純粋に切り出せる部分(サイドカー JSON の
  シリアライズ整形)があれば軽く単体化。**主検証は bench の OCR テキスト照合**(下記「実測検証」)。
- **壊してはいけない**:**`--ocr` 未指定のとき frames は完全に現状のまま**(proxy PNG のみ・
  `.ocr.json` を書かない・OCR コードを一切呼ばない)。`--ocr` 指定でも OCR が劣化(非 macOS 等)なら
  PNG 出力は成功で返す。

### タスク 4:config `ocr.languages`
- **変更**:`src/lib/config.ts`(`Config.ocr?`・`loadConfig` の既定)、`config.yaml`(コメント付き追記)、
  `src/lib/ocr.ts`(言語を受け取る)。
- **テスト**:`test/config.test.ts` に「`ocr` 省略時に `languages` が `["en","ja"]` になる」を追加。
- **壊してはいけない**:`ocr` を書いていない既存 config.yaml が今までどおり読める(省略可)。

### タスク 5:ドキュメント同期
- **変更**:`docs/usage.md`(frames の項に `--ocr` と出力サイドカー)、`CLAUDE.md`
  (「動画の中身を知る方法」に画面 OCR、中間生成物の一覧に `frames/*.ocr.json` を追加)。
- **テスト**:なし(doc)。`node src/cli.ts validate <dir>` が無関係に通ることだけ確認。
- **壊してはいけない**:記述の整合(スキーマ表とコードの一致)。

### タスク 6(任意・タスク0 の PoC が OK のときだけ):`--full-res` 合成 still(案 A)
- **変更**:`src/stages/frames.ts`(`videoFile` を `manifest.source`・`videoIsSource:true` に切替える
  分岐)、`src/cli.ts`(`--full-res` フラグ)。
- **中身**:`--full-res` のとき proxy の代わりに raw をベースにして**合成込みフル解像度 PNG**を出す。
  props は canvas 寸法が同じ(raw も proxy も canvas=3840×1080 の座標系)なので `buildRenderProps` は
  無改造で流用できる(唯一の違いは物理解像度)。
- **テスト**:bench で 1 枚出して目視(圧縮の限界はあるが「明確に鮮明化したか」の粗い確認)。
- **壊してはいけない**:`--full-res` 未指定は proxy のまま完全不変。PoC NG なら本タスクは着手しない。

**実装済み(PoC OK・案A採用)**。bench で `--full-res` の OCR 照合により proxy 版との
判読差を確認済み(例: `curl`/`mkdir` が proxy では `cur1`/`ekdir` に誤読、日付
`2026-07-02` が `2826-87-02` に誤読。full-res ではどちらも正しく読めた)。

---

## 実装子が先に読むコード(シンボル名。行番号は先行機能マージでズレる)

- `src/stages/frames.ts` — `frames()` 本体・`buildTargets()`(ターゲット展開と時刻写像)・
  PNG 全消しループ・`buildRenderProps` 呼び出し(`videoFile:"proxy.mp4", videoIsSource:true`)。
  ここに OCR を差し込む。
- `src/lib/timeline.ts` — `toSourceTime()`(**outSec → 元秒**の逆写像。OCR クロップ時刻に使う)・
  `buildTimeline()`・`mergeIntervals()`。
- `src/stages/proxy.ts` — `buildProxy()`(ffmpeg で raw をどう読んでいるかの前例。`manifest.source`
  参照・`run("ffmpeg", …)` の呼び方・`-vf scale` の組み方)。
- `src/lib/exec.ts` — `run()`(外部コマンド実行。ENOENT 整形。swiftc/swift/ffmpeg 呼び出しの土台)。
- `src/lib/blur.ts` — `outputRectToCanvasRegion()`(出力px⇔canvas 領域の線形写像の前例。OCR box の
  座標変換の考え方の参考)。
- `src/lib/config.ts` — `Config` 型・`loadConfig()`(`cfg.whisper.wordTimestamps ??= false` の
  既定付与パターン=`ocr` もこれに倣う)。
- `src/lib/profile.ts` — `resolveProfile()`(`--short` 経路の profile。及び「閉じた定数はコードに置く」
  D1 の思想=OCR の accurate レベルの置き場所の前例)。
- `src/cli.ts` — frames コマンド定義(`--t/--out/--captions/--every/--short` の option・action・
  shot の echo)。ここに `--ocr` を足す。
- `manifest.json`(bench: `~/Movies/cutflow/2026-07-02-whisper-bench/`)— `source`・
  `video.{width,height,screenRegion}`。クロップ rect と raw パスの実物。
- 前例として「未使用時バイト等価」で機能追加した回:語単位タイムスタンプ
  (`src/lib/renderProps.ts` の `wordPieces`)・blurs(`blurSpans`)。差分の作り方の手本。

---

## 実測検証(bench 収録)

検証対象:`~/Movies/cutflow/2026-07-02-whisper-bench`(raw mkv + manifest/cutplan/transcript/
overlays/proxy 一式・obs-canvas)。

> **PNG の目視は圧縮でアテにならない**前例がある(親の指示・`MEMORY.md`)。よって
> **主検証は OCR テキスト出力の照合**にする。PNG 目視は補助。中立 cwd から絶対パスで走らせる
> (`MEMORY.md` llm-command-verify-neutral-cwd に倣い、repo 直下の文脈汚染を避ける)。

1. **PoC(タスク0)**:
   ```
   ffmpeg -ss 40 -i "<bench>/2026-07-02 17-26-36.mkv" -vf crop=1920:1080:0:0 -frames:v 1 /tmp/crop.png
   swift bin/ocr/vision-ocr.swift /tmp/crop.png en,ja
   ```
   → 画面に映っているコード/コマンド文字列が JSON に**実際の文字列として**現れるか。
   proxy 版(`frames --t 40` の PNG)を Vision にかけた結果と比べ、**フル解像度版で判読できる語が
   増える**ことを確認(before/after)。
2. **`--ocr` の一巡(タスク3以降)**:
   ```
   node src/cli.ts frames <bench> --every 10 --ocr
   ```
   → `frames/out*.ocr.json` が各 PNG と 1:1 で出る。数枚の `text` を Read し、
   **その時刻に画面に出ているはずのコマンド名・関数名・エラー文が含まれるか**を transcript /
   実際の収録内容と突き合わせる(「読める」の判定はこの照合)。
3. **座標**:ある行の `box`(出力px)を、同時刻の PNG 上の文字位置と目視で突き合わせ、
   **box が実際の文字位置に一致**するか(左下原点→左上原点の反転が正しいか)。
4. **既存不変の確認(最重要)**:
   ```
   node src/cli.ts frames <bench> --every 10        # --ocr なし
   ```
   → 出力 PNG のバイト内容・枚数・stdout が `--ocr` 導入前と一致。`.ocr.json` が 1 個も出ない。
   さらに `npm run typecheck` と `npm test`(既存 + 追加した純関数テスト)が緑。
5. **優雅な劣化**:`config.yaml` から `ocr` を消して `--ocr` を実行 → 既定言語で動く。
   (非 macOS の劣化は実機では確認できないので、`src/lib/ocr.ts` の分岐を単体テストで固定。)

「画面文字が読める」と言える条件 = **手順1で before/after の差が明確**かつ**手順2で画面内の
既知の語が OCR テキストに現れる**こと。
