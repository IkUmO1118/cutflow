# 設計判断の記録

動画台本・概要欄の素材を兼ねる。新しい判断は上に追記する。

## 2026-07-06 plain × マージ後機能(shorts / zooms / colorFilter / thumbnail)の整合

**背景**: 下の「通常動画(plain)は…」判断は feature/editor-bootstrap 単独開発時
(profile.ts / zooms 未マージ)に書かれた。その後 feature/editor-improvements
(ショート・ズーム・パネル・チャンク差分レンダー・colorFilter・サムネイル)が
マージされ、plain とこれらの相互作用を確定する必要が出た。実装分解は
`docs/plans/plain-video-support.md`(マージ後コードで改訂済み)。

**判断(採用)**:
1. **出力解像度の真実源一本化は `resolveProfile` の付け替えで行う**。マージ後は
   「出力解像度 = default プロファイル」の解決が `src/lib/profile.ts` の
   `resolveProfile(cfg, "default")` に集約され、render / frames / thumbnail /
   editor がそこ経由で `cfg.ingest.screenRegion` に到達する。`resolveProfile` の
   引数を cfg から**出力サイズ(manifest.video.screenRegion)**へ変えれば、消費
   箇所すべてが一点で manifest 由来になる(editor はクライアントが server の
   `output` を読むので server 側 1 行で追随)。
2. **wipeFull は plain で validate エラー**(カメラ=crop 元が無い)。方針は初版から
   維持。`layerOrder` に `wipe` があれば警告(無視される旨)。
3. **zooms / colorFilter / thumbnail は plain でそのまま使える**。実コードで確認:
   zooms はベース映像の**背景=画面クロップだけ**を拡大する(remotion/Main.tsx の
   背景レイヤーに transform)ためカメラ非依存。colorFilter はベース映像への CSS
   filter で plain では画面クロップだけに掛かる。thumbnail は default プロファイルで
   `buildRenderProps` を通すだけ(全編 keep+texts)。いずれも B1 のワイプ非描画
   ガードの上でそのまま成立する。validate の zoom rect 上限は manifest.screenRegion
   (plain では全フレーム)で判定するので追加作業なし。
4. **plain のショートは「カメラ=全フレーム」の規約で成立させる**。縦プリセット
   `vertical` / `vertical-cover` は `source:"camera"` パネル前提(profile.ts)。
   plain には物理的なカメラが無いので、描画側で **camera パネルを screen(全
   フレーム)へ解決**する。これで `vertical-cover`(カメラ全面)は「画面全体を
   縦へ cover」になり、元から縦のスマホ動画は追加加工なしで綺麗に出る。ただし
   `vertical`(画面+カメラの2段スタック)は plain では同じフレームを2枚重ねる
   だけで無意味なので **validate エラー**にする(profile 名ではなく layout の
   panel source 集合=screen と camera が両方あるか、で判定)。
5. **チャンク差分レンダー / render.key は cameraRegion optional で無改造**。
   `chunkPlan.globalVideoProps` は screenRegion / cameraRegion / width / height を
   既にキーへ含み、`stableHash`(JSON.stringify+キーソート)が undefined を落とす
   ので plain でも決定的。obs↔plain はこれらのどれかが必ず違うのでキーは自然に
   分かれる(layout タグをキーへ足す必要は無い=冗長)。

**捨てた案**:
- **plain のショートを一律 validate エラー(未対応)にする**: 実装は最小だが、
  「元から縦のスマホ動画をショートにする」という自然な要求まで塞ぐ。camera→screen
  の1行の解決で成立するので、塞ぐ理由が弱い。
- **plain 専用の縦プロファイル(`vertical-screen` 等)を新設する**: プリセットが
  増えると D1(プリセットは閉じた組み込み・設定爆発の回避)に逆行する。既存
  `vertical-cover` を「カメラ=全フレーム」で読み替える方が組み込みを増やさない。
- **camera→screen を profile 解決時(resolveProfile)に静的に書き換える**: profile は
  manifest を知らない純データにしておきたい(cfg 依存を外す F4 の方針と整合)ので、
  manifest(=カメラの有無)を知っている描画側(Main.tsx renderPanels)で解決する。
- **cache キーに layout タグを足す**: 上記5のとおり width/height/region で既に
  区別できるので冗長。真実源を増やさない。

## 2026-07-06 通常動画(plain)は「カメラの無い obs-canvas」として一級サポート

**判断**: OBS 拡張キャンバスでない通常動画(スマホ・カメラ・画面録画)を、
manifest に `layout: "obs-canvas" | "plain"` の区別を持たせて ingest〜レンダーまで
サポートする。plain は **screenRegion=全フレーム / cameraRegion=無し**で表現し、
「ワイプ(カメラ)の crop 元が無い」一点にすべての差分を集約する。OBS 形式の
既存挙動は完全維持する。実装分解は `docs/plans/plain-video-support.md`。

**判断の柱**:
1. **出力解像度は manifest.video.screenRegion を正とする**(config を再読みしない)。
   現状 render/frames/editor が `cfg.ingest.screenRegion` を直読みしており、ingest
   時に焼き込んだ manifest と二重の真実源になっていた。manifest 一本に寄せると、
   plain の縦動画は縦のまま・4K は 4K のまま config を触らず自然に出る。obs-canvas
   では値が同じなので出力はバイト同一(退行なし。むしろ ingest 後に config を
   変えても壊れなくなる改善)。
2. **manifest スキーマは `layout` 明示タグ + `cameraRegion` optional の併用**。
   後方互換のため `layout` 未指定は "obs-canvas" 扱い、既存 manifest は
   cameraRegion を持つので判定不変。
3. **plain の判定は明示を既定にする**(config `ingest.layout`、CLI `--layout`、
   editor 起動 bootstrap は plain を明示)。`auto`(キャンバス寸法の完全一致で
   obs 判定)は opt-in で提供するが**既定にしない**。

**捨てた案**:
- **cameraRegion optional のみで layout タグを持たない(構造から暗黙推論)**: 動作は
  するが「意図した plain」か「壊れた manifest」かの正の信号が無く、validate/editor の
  分岐とメッセージが不明瞭。明示タグは文字列ユニオン1個でコストが小さく、
  「types.ts コメント+validate+usage.md を揃える」規約とも相性が良い。
- **screenRegion=全フレームのフォールバックだけ(スキーマ変更なし)**: 同上で暗黙的
  すぎる。将来の多カメラ等の拡張の掛け先も無い。
- **ingest の幅ベース自動判定を既定にする(`幅 >= screenRegion.w+cameraRegion.w` で
  OBS)**: 4K 通常動画(3840x2160)が OBS キャンバス幅 3840 と一致し**誤判定**する。
  誤判定は「動画の半分しか映らない」等の分かりにくい壊れ方になる。auto を採るなら
  最低でも W×H 完全一致を条件にすべきで、それでも 3840x1080 の通常動画は誤る。
  よって既定は明示、auto は逃げ道付きの opt-in にした。

> **失効(マージ後)**: 本判断の初版にあった「訂正(profile.ts・zooms・vertical-cover
> は実在しない)」の段落は、feature/editor-bootstrap 単独開発時点の事実であり、
> feature/editor-improvements のマージで**すべて失効**した(profile.ts・zooms・
> vertical-cover はいずれも実在する)。plain とこれらの整合は上の
> 「plain × マージ後機能」判断で確定した。実装分解も
> `docs/plans/plain-video-support.md` をマージ後コードで改訂済み。

## 2026-07-06 簡易カラー調整(overlays.json の colorFilter)とサムネイル生成(thumbnail.json)

**判断**:
- **colorFilter**: `overlays.json` のトップレベルに全編一律(区間指定なし)の
  `{brightness?, contrast?, saturate?}` を追加。実装は CSS filter で、
  Remotion のベース映像(画面クロップ+カメラ=同一収録動画)にだけ適用する。
  素材オーバーレイ・挿入クリップは対象外(素材は完成品であり、補正したいのは
  収録の見た目だけのため)。**ショートにも例外的に継承する**(zooms 等の
  演出と違い「収録の見た目補正」という扱いなので、本編とショートで肌色が
  変わる事故を防ぐ)。チャンク差分レンダーではグローバルキー扱い(変更したら
  全チャンクがフルレンダーになる。wipe 幾何等の既存の全域設定と同じ側)
- **thumbnail**: 収録フォルダに `thumbnail.json`(`{t, texts[]}`)を書くと
  `thumbnail` コマンドで `thumbnail.png`(1920x1080)を書き出せる。`t` は
  frames と違いスナップしない(カットされた瞬間も指定できる。サムネは動画に
  入っていない絵を使ってよいため)。`texts[]` は transcript と同じ
  `CaptionStyle` を共有し、`pos` は省略不可。合成は最終レンダーと同じ見た目
  機構(buildRenderProps)を通し、keep=全編・テロップ=texts のみ・
  `wipeFull` / `zooms` / `colorFilter` は本編と同じに乗る。ベースは
  `frames` のプロキシと違い元収録のフル解像度を使う(静止画の可読性が命)。
  `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格)。
  エディタ対応は今回やらない

**理由**: どちらも既存の時刻写像・`buildRenderProps`・キャッシュキー機構に
相乗りさせて実装コストを抑える方針(zooms・ショートと同じ考え方)。colorFilter
は「演出」(zooms 等)と「見た目補正」を区別し、後者だけをショート・
サムネイルへ横断的に効かせることで、一箇所直せば全出力の肌色が揃うようにした。
thumbnail は「動画に入っていない絵も使いたい」という要件が frames の
スナップ挙動と相容れないため、専用のスナップなし経路として独立させた。

## 2026-07-06 ズーム演出(overlays.json の zooms)

**判断**: 画面の一部を拡大して見せる演出を、既存の `wipeFull` と同じ
「元収録の秒の区間+宣言的な指定」の作法で `overlays.json` に追加する。

- スキーマ: `zooms: [{ start, end, rect: {x,y,w,h}, easeSec? }]`。`rect` は
  出力px座標系(テロップ `pos`・overlays `rect` と同じ)で「この矩形を全画面へ
  拡大する」の意味。倍率は書かせない(`scale = 出力幅 / rect.w` が rect から
  一意に決まる。倍率と rect の二重指定は矛盾の温床になるため)
- 拡大は一様スケール(歪ませない)。rect のアスペクトが出力と違う場合も
  この規則で決まる(validate で警告)
- かかるのは**ベース映像の背景レイヤー(画面クロップ)だけ**。ワイプ・
  テロップ・素材オーバーレイ・挿入クリップは動かさない(拡大してもテロップの
  位置・可読性が変わらないのが狙い)
- 区間の重なりは禁止(validate エラー)。ズーム中のパン(rect の時間変化)は
  v1では対応しない(区間を分ければ実用上足りる)
- 遷移(イーズイン/アウト)は `wipeFull` の `wipeTransitionSec` と同じ
  smoothstep・区間が短いときの遷移縮小規則を踏襲(`src/lib/zoom.ts` に
  純関数として切り出し、`remotion/Main.tsx` の背景レイヤーだけに適用)
- チャンク差分レンダー(render.chunks/)では `wipeFull` と同じ「区間限定
  (チャンク重なりだけ無効化)」の扱いにする(`src/lib/chunkPlan.ts`)
- ショート(`profile` の layout 経路)には効かせない。ショートは
  `overlays.json` を継承しない既存設計(D2)により自動的に対象外になる
  (特別扱いのコードは書いていない)

**理由**: 「画面のこの部分に注目」を作る解説動画向けの演出。既存の
時刻写像・キャッシュキー機構への相乗りで実装コストを抑えつつ、
`wipeFull` で確立済みの UX(タイムラインの属性スパン帯・プレビュー上の
枠ドラッグ)を踏襲してユーザーの学習コストも増やさない。

## 2026-07-06 ショート動画対応(縦動画の書き出し・エディタ編集)

**判断**(詳細は docs/shorts-design.md、実装済み):
- **D1**: 出力プロファイルは `src/lib/profile.ts` の組み込みプリセット
  (`default` / `vertical` / `vertical-cover`)。config.yaml には追加しない
  (プリセットは閉じた組み込み。設定爆発の回避)。
- **D2**: `shorts.json` の各ショートは `ranges`(元収録の秒)をそのまま
  `mergeIntervals` した keep 集合として使う。本編 cutplan の keep とは
  独立(交差させない)。テロップは transcript.json を流用し、位置/スタイルは
  ショート専用の `captionTracks`(トラック単位。per-segment 上書きは持たない)
  で上書きする。
- **D3**: 縦レイアウトは `vertical`(camera上/screen下スタック)と
  `vertical-cover`(camera 全画面)の2プリセットに閉じる。既存の横ワイプ
  経路は無改造(layout 無し = 現行のまま)。
- **D4**: レンダーはショートごとに `cut.<name>.mp4` → `shorts/<name>.mp4`。
  承認は本編とは別の `short.approved`(render --short のゲート)。キャッシュは
  full-skip のみ(チャンク差分レンダーはショートに入れない)。
- **D5**: エディタの縦プレビューは既存 `proxy.mp4` を流用(縦専用 proxy は
  作らない)。カメラの甘さは既知・許容。
- **D6**: エディタは新規ビューを作らず、ヘッダーの「本編/各ショート」
  セレクタ + プリセット/承認バー、既存 Timeline への `SpanKind: "short"`
  帯、パネルの「ショート」タブ(CRUD)に留める。ショート編集
  (ranges・captionTracks・profile・approved)は cutplan/overlays/transcript/
  bgm の undo 履歴には含めない(別ドキュメントで、この程度の編集に undo
  一貫性のコストを払う価値が薄いと判断した意図的な簡略化)。

**理由**: 本編とは別解像度・別レイアウトの出力を、既存の時刻写像
(`lib/timeline.ts`)・`buildRenderProps`・キャッシュキー機構に相乗りさせて
実装コストを抑える。エディタ側も同じ発想で、新規サーフェスをセレクタ1個・
タブ1個・SpanKind 1個に絞り `App.tsx`/`Timeline.tsx` の肥大を避けた。

## 2026-07-02 音量は render でツーパス loudnorm、BGM はファイル規約で自動合成

**判断**: 最終出力の音量は ffmpeg の loudnorm(EBU R128)で -14 LUFS
(YouTube 基準)に自動正規化する。方式はツーパス(1回目に音声のみ実測、
2回目に実測値を渡して線形正規化)。BGM は「収録フォルダに bgm.mp3 が
あれば合成する」というファイル規約にし、Remotion の Audio でループ+
終端フェードアウト付きミックスする。

**理由**: 実収録の初回レンダーは -30.2 LUFS で、YouTube 基準より16dBも
小さかった。収録時のゲイン管理だけに頼ると毎回ばらつくので、出口で
ツールが保証する。ワンパス loudnorm を試したら -16.7 LUFS までしか
届かなかった(流しながら調整する方式のため、入力が目標から遠いと
数dB残る)。ツーパスにしたら -14.3 LUFS(誤差0.3dB)。

**ハマった点**: 「loudnorm を1フィルタ足すだけ」では終わらなかった。
音量系は必ず実測で確認すること(ebur128 フィルタで数秒で測れる)。

**注意**: 収録ゲインが低すぎる問題は出口では直せない。detect の無音判定
(-35dB)に発言が引っかかるリスクがあるため、収録時は OBS メーターで
黄色ゾーンを維持する(docs/usage.md 参照)。

## 2026-07-02 render は「ffmpegでカット→Remotionで合成」の2段構成

**判断**: 最終レンダーは、①ffmpeg が cutplan の keep 区間をフル解像度のまま
結合して中間ファイル cut.mp4 を作り、②Remotion は1本になった動画の上に
画面クロップ・ワイプ・字幕・章カードを重ねるだけ、という2段構成にする。
字幕と章の時刻は、コード側で「元動画→カット後」のタイムライン変換
(src/lib/timeline.ts)をしてから Remotion に渡す。

**理由**: Remotion のタイムライン上で OffthreadVideo に区間ごとの細かい
シークをさせると、遅い上にフレームずれの温床になる。トリム・結合は決定的な
ffmpeg が得意な仕事なのでそちらに寄せ、Remotion には「表現」(レイアウト・
字幕・カード)だけをさせる。役割が分かれるのでデバッグも楽になる。

**トレードオフ**: 中間ファイル分のエンコードが1回増える(世代劣化を抑える
ため高ビットレートで出力)。M5 のハードウェアエンコーダなら時間は問題に
ならない。

## 2026-07-02 plan は LLM に「区間番号の選択」だけをさせる

**判断**: plan ステージは detect が出した「残す候補区間」に番号を付けて
LLM に渡し、LLM は「どの番号をカットするか+理由」「章の開始番号+章タイトル」
だけを返す。タイムスタンプ(秒数)は LLM に一切生成させない。

**理由**: LLM に時刻を直接出力させると、もっともらしい数値のでっち上げ
(ハルシネーション)が起きて動画が壊れる。番号選択方式なら時刻は常に
コード側が管理し、LLM の間違いは「存在しない番号」として機械的に検出・無視
できる。出力トークンも減って速く安くなる。

**副産物**: LLM の生応答は毎回 plan.raw.txt に保存する(パース失敗時の調査用。
判断過程の記録として動画素材にもなる)。

**ハマった点**: 初回実行でプロンプトのテンプレート置換が壊れていた
(memory/lessons/template-replace-first-match.md 参照)。壊れたプロンプトを
受け取った `claude -p` は JSON を返す代わりに「あなたのコードのバグはここです」
という診断レポートを返してきた。LLM をパイプラインに組み込むと、失敗モードが
「エラー」ではなく「想定外の正しい応答」になることがある。

## 2026-07-02 収録は「拡張キャンバス方式」(3840x1080 横並び)

**判断**: OBS のキャンバスを 3840x1080 にし、左半分に画面・右半分にカメラを
並べて1本の mkv に録る。パイプラインは領域クロップで画面とカメラを分離する。

**理由**: ワイプ焼き込みだと後からレイアウト変更が一切できず、編集自動化の
価値が激減する。一方 OBS のマルチトラックは音声専用で、映像は必ず1本に合成
される(これが最初の誤算だった)。映像を分けて録る Source Record プラグインは
macOS で不安定という報告が多い。拡張キャンバスならプラグイン不要・同期ズレ
ゼロ・決定的に処理できる。

**トレードオフ**: 録画ファイルの解像度が倍になる(ビットレート増)。
Apple M5 のハードウェアエンコーダなら負荷は問題にならない。

## 2026-07-02 ingest では映像を再エンコードしない

**判断**: ingest は「解析+マイク音声抽出+manifest.json 生成」のみ。
画面/カメラの切り出しは manifest に領域情報として記録し、preview/render が
必要になった時点でクロップする。

**理由**: 3840x1080 の再エンコードは時間もディスクも食う。試した結果、
再エンコードなしなら ingest は数秒で終わる。中間生成物は増やさない。

## 2026-07-02 LLM は claude-cli をデフォルトに、API は後日切替

**判断**: 意味カット・章立ての LLM 呼び出しは `claude -p` のサブプロセス実行を
デフォルトにし、config.yaml で従量課金 API に切り替え可能にする(2択のみ)。

**理由**: Claude Code サブスク内なら追加費用ゼロ・API キー管理不要。
運用が安定したら安いモデルの API に移す。プロンプトは prompts/ に外部化して
あるのでバックエンドを替えても中身は共通。

## 2026-07-02 whisper モデルは large-v3-turbo の q5_0 量子化

**判断**: `ggml-large-v3-turbo-q5_0.bin`(574MB)を採用。

**理由**: 日本語精度と速度のバランスが最良のクラスで、量子化版なら
16GB RAM でも余裕。実測: Apple M5 で16秒の音声を約1.0秒で文字起こし
(約16倍速)。フル精度版(1.6GB)との差が問題になったら差し替える。

## 2026-07-02 Lottie Creator MCP は保留

**判断**: アニメーション挿入用の Lottie Creator MCP は今回導入しない。

**理由**: 今週の目標はパイプライン完成であり、アニメ挿入は装飾(完成後の
改善領域)。採用済みの Remotion は `@remotion/lottie` で Lottie を再生できる
ため、後から導入しても設計変更が発生しない。再検討はパイプラインで動画を
2〜3本作った後。

## 2026-07-02 チャンネル運用者の決定(記録)

- カット判断: AI がカット案を生成し、**人間が承認してから**レンダー
  (見せ場=本番事故シーンの誤カットを防ぐ)
- レンダラー: Remotion(字幕・ワイプ・章カードの表現力を優先)
- 第1話: パイプライン完成後に自作ツール自身で編集する(ドッグフーディングがオチ)
