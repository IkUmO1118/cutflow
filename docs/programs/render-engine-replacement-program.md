# render エンジン置換母艦 — Remotion+`<video>` を WebCodecs+WebGPU 単一エンジンへ完全乗り換え

> 状態: **START（2026-07-28・全 plan 設計済み・実装未着手）**
>
> 決定の背景・候補比較・壁打ち論点の正本は
> `docs/plans/2026-07-28-render-engine-direction-brief.md`（方向性ブリーフ）。
> **運用（実行順・ゲート・フェーズ詳細）の正本は本書と配下の plan**。粒度が
> 食い違う場合は本書が優先する。
>
> 旧母艦 `docs/programs/canvas-gpu-engine-program.md` は本書が**置換**する
> （旧 P0=preview cut bake は実装済み・load-bearing のまま M3b で撤去、
> 旧 P1/P2 は本書の M3/M4 に発展的に解消。旧母艦は歴史記録として残す）。

## 0. 他エージェント向け: 現在地と次の一手

- **現在地**: **M1〜M4 + R1〜R4 + G1/G2 実装済み・画素ゲート緑化まで完了**（2026-07-29 に
  親セッションで再検証: `npx tsc --noEmit` 緑・`npm test` 2867/2867・実収録の
  scratch コピーで `frames` がエンジン経路 0.7秒・分割/背景/テロップとも正常）。
  **ただし §7 の削除リスト（＝完全乗り換えの証憑）は1件も実行されていない**:
  `previewCutCache`/`<Player>`/`remotion/Main.tsx`/`render.fast`/`render.chunks`
  はすべて現存し、さらに「エンジン失敗→旧経路へ自動降格」が render/frames/
  thumbnail/editor の4箇所で**恒久 dual-path として既定有効**になっている
  （§1-10「恒久 dual-path にしない」に対する後退。降格は `console.warn` だけで
  可視化されない）。
- **次の一手**: `npm run gate:pixel` は G2
  （`docs/plans/2026-07-29-engine-g2-wipe-color-parity-design.md`）で
  **全12枚一致・exit 0**まで緑化済み。次は §7 の一括削除と、render/frames/
  thumbnail/editor の4箇所に残る「エンジン失敗→旧経路へ自動降格」の撤去。
  削除前に最後の確認として `npm run gate:pixel` を必ず1回通す。
- **実行順**: M1 → M2 → M3a → M3b → M4 → **R1 → R2 → R3 → R4**
  （→ M5 は条件付き。plan 未起草＝発動時に起草）。
  順序は「様子見の段階化」ではなく**新エンジンの依存関係の順**。乗り換え自体は決定済みで、
  各ゲートは中止判断ではなく品質関門（§3）。
- **触ってはいけない一線**: JSON が正 / CLI・AI 契約 / `approvals.json` の承認 hash /
  承認は人間。エンジン置換はこの層より**下**で完結する。

## 1. 決定（2026-07-28・ユーザー批准。変更禁止）

1. **完全乗り換え**。評価軸は移行コストではなく到達性能。既存実装の温存は目的にしない。
2. **`<video>` 要素はプレビュー・書き出しの両経路から恒久排除**する。
3. **Remotion は本編経路（プレビュー・最終 render・frames・thumbnail）から引退**。
   残るのは HyperFrames サイドカー（`hyperframe` コマンドの native interpreter）だけ。
4. **候補 A を採用**: WebCodecs（HW デコード・生 `VideoFrame`）+ WebGPU コンポジタ
   （Worker + OffscreenCanvas）+ 同一エンジンで preview==final。
   ネイティブ（案B）は UI 統合で天井を食い潰すため不採用（ブリーフ §4。
   M5 変種「書き出しだけネイティブ wgpu」の余地は残す）。
5. **FrameDescriptor（純データの中間表現）を継ぎ目**にする。JSON（正）→ 翻訳層（純関数）→
   FrameDescriptor → バックエンド、の一方向。キーは**時刻（秒）でありフレーム番号ではない**
   （元収録・cut.mp4 とも VFR。CFR 前提を焼き込まない）。
6. **GPU バックエンドは `opencut-wasm`（MIT・prebuilt）でブートストラップ**。ただし
   M3a Phase 0 の registry 被覆確認で必要エフェクトが1つでも欠けたら最初から自前 WGSL。
   prebuilt 依存は恒久化しない（置換判定は §8）。
7. **エンコードは「HW `VideoEncoder` で高ビットレート中間体 → ffmpeg で最終 CRF」を既定**。
   `bitrateMode: "quantizer"` で中間体を省けるかは M4 で実測判定。
8. **決定性は2層契約へ移し替え**: FrameDescriptor＝byte 一致で厳格ゲート、
   画素＝知覚一致（SSIM 閾値）＋構造検証（フレーム数・video stream duration。
   container duration は使わない）。画素 byte 一致は放棄（HyperFrames の AA jitter 実測が根拠）。
9. **ブラウザ方針**: 書き出し＝CLI が pin した headless Chromium（現行 `.remotion/` と同構図）
   ＝ユーザーのブラウザと無関係。プレビュー＝Chromium リファレンス、Safari は
   標準 API（WebCodecs 16.4〜/WebGPU 26〜）+ wgpu の WebGL2 フォールバックで追随。
   保証水準（保証 or best-effort）だけ M3b で実測して決める。
10. **旧経路の削除は M4 で一括**: Remotion 本編 composition・`<video>`・preview cut bake・
    `render.fast/`・`render.chunks/`。それまでは検証の物差し（parity のオラクル）として使う
    ＝温存ではなく足場。

## 2. 目標アーキテクチャ

```
cutplan/transcript/overlays (JSON=正)                     ← 不変
    ↓ buildRenderProps（src/lib/renderProps.ts。既存の解決層＝残す）
    ↓ 翻訳層（新規・純関数。src/engine/）
FrameDescriptor（時刻キーの「そのフレームの絵の仕様」）      ← M2
    ↓                                  ↑ バックエンド差し替えの継ぎ目
┌──────────────┴──────────────┐
│ WebGPU コンポジタ（Worker・opencut-wasm 起動）│ ← M3a
│ 自前 WGSL / ネイティブ wgpu（条件発動）        │ ← 置換判定 §8 / M5
└─────────────────────────────┘
  ↓ プレビュー（editor）          ↓ 書き出し（CLI→pin済 headless Chromium）
OffscreenCanvas → 画面        VideoEncoder(HW) → mux → ffmpeg CRF → final.mp4
        フレーム供給: mediabunny（WebCodecs）＝ <video> 不使用
        音: WebAudio 先読みスケジューラ＝音マスター・遅延フレームは捨てる
        frames / thumbnail も同じ descriptor→コンポジタ経路（M4）
```

## 3. 実行順と品質関門（ゲート）

| 順 | plan ファイル（docs/plans/） | 内容 | 完了ゲート（次へ進む条件） |
|---|---|---|---|
| 1 | `2026-07-28-engine-m1-media-metrics-design.md` | オールイントラ proxy + 計測ハーネス + ベースライン記録 | 現行プレビューの基準値（シーク応答・ドロップ率）が記録済み |
| 2 | `2026-07-28-engine-m2-frame-descriptor-design.md` | FrameDescriptor 型 + 翻訳層 + snapshot 固定 + 参照ペインタ parity | descriptor golden 全緑・全演出の翻訳網羅・parity グリッドで位置/構成一致 |
| 3 | `2026-07-28-engine-m3a-engine-core-design.md` | opencut-wasm 被覆確認 → フレーム供給・コンポジタ・音クロック（headless 検証） | headless 実測が M1 基準を上回る・コンポジタ vs Remotion frames の画素 parity 合格 |
| 4 | `2026-07-28-engine-m3b-preview-integration-design.md` | editor 統合・`<video>`/Player 排除・bake 撤去 | 実機でスムーズ・全編集操作が動く・計測 ≥ 基準値 |
| 5 | `2026-07-28-engine-m4-export-unification-design.md` | 書き出し統合・frames/thumbnail 移設・決定性 CI・旧経路一括削除 | 決定性 CI 緑・出力品質 parity・承認ゲート不変・削除完了 |
| 6 | `2026-07-28-engine-r1-picture-correctness-design.md` | **R1（是正）**: GPU 画素 parity ハーネス新設 → 頂点シェーダ UV 反転修正 → 書き出しページの DOM 文字焼き込み除去 → `hiddenLayers` の逐語移植 | ハーネスが**修正前は反転を検出して落ち・修正後に通る**（両方のログ提示）・演出込みの実データで parity 合格・実機で絵の向きを目視確認 |
| 7 | `2026-07-28-engine-r2-audio-design.md` | **R2（是正）**: 先読みの1パケット問題（全チャンク連結→窓分割）・トラックミュート配線・素材/挿入クリップ音声 | 実機で全編通して音が鳴る・シーク/再生速度/ミュートが Player 経路と同等・書き出し音声経路に差分ゼロ |
| 8 | `2026-07-28-engine-r3-guards-and-followups-design.md` | **R3（是正+再発防止）**: キャッシュ不在のエラー表示・書き出しサーバ Range 対応・`manifest.json` を `clean` から保護・検証収録の記述修正・`render.engineExport` の文書化 | ピン留めテスト追随込みで緑・`clean --dry-run` に manifest が出ない・2026-07-12 の復旧手順が提示済み |
| 9 | `2026-07-29-engine-g1-pixel-gate-design.md` | **G1**: Remotion オラクルの画素 golden を凍結（合成 parity フィクスチャ・`test/fixtures/engine/pixel-golden/`）+ `npm run gate:pixel` 新設（`npm test` には入れない独立ゲート。D1） | ゲート基盤完成。判定は G2 で緑化済み |
| 10 | `2026-07-29-engine-g2-wipe-color-parity-design.md` | **G2**: ワイプの `colorFilter` 欠落修正 + 中間動画への YUV matrix/range VUI タグ焼き込み | `npm run gate:pixel` が全12枚一致で exit 0。閾値・golden PNG は未変更 |
| 11 | （未起草） | M5: ネイティブ wgpu へのスワップ（フル or 書き出しのみ） | 発動条件: 4K 多層でデッドラインを外す実測が出た時だけ |

- クロス依存: M2 の参照ペインタは M3a の rendered テクスチャ描画（テロップ等の
  ラスタライズ）にそのまま昇格する＝捨てにならない。
- **M1 の中身に注意**: Worker デコードのリングバッファ・音マスタークロックは
  **M1 ではやらない**（`<video>` が残る間はブラウザが同等機構を持ち仕事が無い。
  捨てる経路への投資になる）。M3a で新エンジンに一度だけ実装する。

## 4. モデル運用（設計=高モデル / 実装=Sonnet のリレー）

各 plan は **Sonnet 実装セッションが単独で読める自己完結ドキュメント**として書いてある
（memory `opus-sonnet-relay-workflow` の形式）。コーディネータ（高モデル）の責務:

1. 各 plan の Phase 0（アンカー検証）の報告を受けてから実装 go を出す
2. 完了報告を鵜呑みにせず **npm test / npx tsc --noEmit / git status・log / 実データ実走**で
   親が再検証してから次フェーズへ（テスト緑でも「HEAD にコミット済みか」を必ず見る）
3. 各ゲートで git status を見て**スコープ外編集を戻す**（サブエージェントは隣接ファイルに
   手を出しがち）
4. PR マージ前に独立コードレビュー（review-backed merge）

実装セッション共通ルール（各 plan にも再掲。Sonnet はこれに従う）:

- **サブエージェント起動禁止（Agent ツール禁止・委譲禁止）。自分で Read/Edit する**
- **1タスク=1コミット。中断時はどこまでコミット済みかを報告**
- Phase 0 で設計書のアンカー（ファイル・シンボル）を実コードで検証し、**食い違ったら
  実装せず止まって報告**（設計書の行番号はズレるのでシンボル名で特定する）
- **既存 golden/既存テストの書き換えが必要になったら設計違反＝止まって報告**
  （内部関数の deepEqual テストへの項目追加は可）
- `approvals.json`・承認 hash・CLI 契約・prompts/ に触れない
- Node 23 type stripping 制約: enum / namespace / 実行時デコレータ /
  コンストラクタのパラメータプロパティは使えない
- 実データ検証は `~/Movies/cutflow/test`（正規の検証コピー）を scratch へコピーして行い、
  実収録を汚さない（検証用生成物は後片付け）。`test` が失われたときの作り直し手順:
  元収録 `.mkv` を置いた新フォルダで `node src/cli.ts ingest <dir> --layout obs-canvas`
  → 必要なら `proxy`（詳細は `docs/plans/2026-07-28-engine-r3-guards-and-followups-design.md` §4-4b）
- **実収録（`~/Movies/cutflow/2026-07-12` / `2026-07-21`）では `clean` / `ingest` /
  `run` / `plan*` / `render` / `approve` を実行しない**（今回の事故の直接の教訓。
  `frames` / `describe` / `validate` は実収録でも実行してよい=read-mostly）
- editor クライアントは起動時に1回だけバンドルされる＝**UI 検証前に必ずサーバ再起動**。
  editor の headless 検証は同梱 chrome-headless-shell + CDP 直叩き（`el.click()` は
  pointer 系ハンドラに効かない＝`Input.dispatchMouseEvent` / PointerEvent dispatch）
- editor の `--stop` は自分が起動した pid にだけ使う（ユーザー起動中のインスタンスを殺さない）

## 5. 借用と依存（provenance）

| 借りる先 | もの | 形 |
|---|---|---|
| OpenCut（fork: `~/dev/labs/opencut`・MIT） | FrameDescriptor 設計 / テクスチャ2分類（external / rendered+contentHash）/ video-cache の先読み・seek 世代管理 / WebAudio 先読みスケジューラ / preview==export の型 | **設計を写す**（コードの lift は最小限・PROVENANCE 記録） |
| `opencut-wasm@0.2.10`（npm・MIT・prebuilt） | WebGPU/WebGL2 コンポジタ | **依存として導入**（M3a。被覆確認が通った場合のみ。version pin） |
| `mediabunny`（npm・MIT） | WebCodecs デコード（`VideoSampleSink` / `samplesAtTimestamps`）・mux | **依存として導入**（M3a。version pin） |
| OpenScreen（`~/dev/labs/openscreen-gos`・MIT） | 「合成の数学を純関数へ」方針 | 方針のみ（二重実装は反面教師） |
| プロ NLE | オールイントラ proxy / 音マスター＋ドロップ / セグメント render file | 概念 |

依存追加は上記2 npm パッケージのみ（CutFlow は依存追加ゼロ主義だが、ここは
「GPU コードとデコーダ制御を書かずに立ち上がる」ための意図的例外。§9 ログ参照）。

## 6. 不変条件（全フェーズ）

1. **JSON が正**（canvas は表示器。IndexedDB/OPFS へ移らない）
2. **AI 契約・CLI・承認境界（approvals.json の hash 失効・approve の TTY ゲート）不変**
3. **絵の回帰ゼロ**（各機能で Remotion 版 frames と新版の突き合わせ。caption 3層継承・
   karaoke・zoom 連鎖・blur 下層限定・annotation 最前面・colorFilter 適用範囲を含む）
4. **WYSIWYG**（M3b〜M4 間の一時的 preview≠final のみ許容。M4 で閉じる）
5. **決定性の2層契約**（§1-8）
6. **MIT 順守**（lift 部品は PROVENANCE / LICENSE を残す）

## 7. M4 完了時の削除リスト（完全乗り換えの証憑）

**前提: G1/G2 完了（画素ゲート `npm run gate:pixel` が緑であること）。
2026-07-29 に達成済み。削除作業の直前にも `npm run gate:pixel` を1回通す。**

- `remotion/Main.tsx` ほか本編 composition 一式（HF interpreter が使う分は残す）
- editor の Remotion `<Player>`・`<video>` 経路・remount 再 seek ハック（App.tsx:1500 付近）
- preview cut bake 一式（`src/lib/previewCutCache.ts`・再ベイクバナー・`videoVersion` remount）
  ※撤去自体は M3b
- `render.fast/`・`render.chunks/` の生成コードと分類（`files.ts`・ドキュメント追随）
- M3b で入れる一時フォールバック `preview.engine: "legacy"`
- 追随更新: `src/lib/files.ts` → `AGENTS_CONTRACT.md` → `CLAUDE.md` → `docs/usage.md`
  （`test/agentsMd.test.ts` がピン留めしているため機械的に検出される）

## 8. リスクと置換判定

- **opencut-wasm**: upstream 停止済の prebuilt。M3a Phase 0 で必要パス
  （領域ぼかし＋境界フェザー / colorFilter(brightness/contrast/saturate) /
  スポットライト減光 / ワイプのアルファ遷移 / opacity・フェード / mosaic）×
  registry の突き合わせ表を作る。**1つでも欠け or デバッグ不能な不具合 → 自前 WGSL へ置換**
  （継ぎ目は FrameDescriptor なので翻訳層は不変）。
- **Safari プレビュー**: WebGL2 フォールバックで機能は落ちない前提。M3b で実測し
  保証 or best-effort を §9 に記録。
- **色**: 画面収録は Display P3 がありうる。`importExternalTexture` の色空間指定を
  parity 対象に含める（M3a）。
- **VFR**: descriptor は時刻キー（§1-5）。cut.mp4 の CFR 再スタンプ問題を新経路に持ち込まない。
- **UI リデザイン母艦との順序**: リデザイン（`editor-opencut-redesign-program.md`）は
  スタック批准待ちで未着手。**本母艦を先行**させ、M3b は現行 `App.tsx` に
  `EnginePreview` として**最小面積の独立コンポーネント**で載せる（リデザイン時に
  コンポーネントごと移設できる形）。リデザイン着手は M3b 完了後を推奨。
- **HF サイドカー**: Remotion 依存が残る唯一の場所。本母艦では一切触らない。
  依存スリム化（chrome 取得機構の脱 Remotion 化）は M4 後の別課題
  → **`docs/programs/remotion-elimination-program.md`（2026-07-29 起草）が引き取った**。
  同書は §7 の削除リストも引き取っている（本編経路の削除に関しては同書が優先）。

## 9. 意思決定ログ

- **2026-07-28（決定・ユーザー批准）**: 完全乗り換え。`<video>` 恒久排除・Remotion 本編引退・
  外側補填（bake / render.fast / render.chunks）は吸収後に削除。評価軸は到達性能
  （ブリーフ §2）。旧母艦の「P1/P2 条件付き保留」を破棄し本母艦へ移行。
- **2026-07-28（判断）**: リングバッファ・音クロックを M1 から M3a へ移動
  （`<video>` が残る間は仕事が無い＝捨てる経路への投資を避ける）。画質ティアも
  M3a 以降（自前ループを持って初めて意味を持つ）。ブリーフ §6 との差分はこれが正。
- **2026-07-28（判断）**: 依存追加ゼロ主義の意図的例外として mediabunny / opencut-wasm を
  M3a で導入する（両 MIT・version pin・被覆確認ゲート付き）。
- **2026-07-28（判断）**: M3b に一時フォールバック `preview.engine: "legacy"` を置き
  M4 で削除（完全乗り換えの中間安全弁。恒久 dual-path にはしない）。
- **2026-07-28（M1 完了・実測）**: `preview.proxyIntra`(既定 true)で proxy.mp4 を
  オールイントラ化。実測(bench 収録の scratch コピー、582秒・obs-canvas):
  `proxyIntra:false`(従来 GOP=6)は 189,099,958 bytes・I フレーム率 16.66%
  （ffprobe `pict_type` 実測、17,460 フレーム中 2,910 I）。`proxyIntra:true`
  (GOP=1)は 831,202,535 bytes・I フレーム率 100.00%(全17,460フレーム)。
  **サイズ増分は約4.4倍**。この増分は「再生成可能なキャッシュ」の代償として
  許容(母艦の判断基準どおり)。
  計測ハーネス(editor、POST /metrics → `~/.cutflow/editor/metrics/*.jsonl`)は
  実機(Remotion 同梱 chrome-headless-shell を CDP 直叩き)で疎通・記録を確認
  済み(seeking→seeked ms・getVideoPlaybackQuality 差分・HUD の ?metrics=1
  opt-in を含め全項目)。
  **シーク応答の before/after 比較値はここには記録しない**: 同ハーネスで
  `proxyIntra:false` vs `true` を同一手順(ランダムシーク10回+スクラブ)で
  比較したところ、GOP=1 の方が p50 シーク応答が遅い(false: p50=10.3ms/
  p95=25.3ms、true: p50=19.6ms/p95=26.9ms)という、狙いと逆の結果が出た。
  headless Chrome では muted `<video>` のフレーム進行が凍る既知の制約が
  あり、実デコード経路をそのまま反映していない疑いが強く(サンプルも26件と
  少ない)、この数値を
  「GOP=1の方が遅い」という結論の根拠にはしない。**M3a/M3b で実ブラウザ
  (headless でない実セッション)でのシーク応答再測定が必要**(このハーネス
  自体・JSONL 形式はそのまま使い回せる。足りないのは信頼できる測定環境)。
- **2026-07-28（M3a Phase0〜4 実装サマリ。このログは編集のたびに巻き戻る既知の
  不具合があり過去の詳細エントリが失われたため要点だけ再掲）**: Phase0で
  registry欠落2件(mosaic・colorFilter)+構造的問題3件(VideoFrameゼロコピー
  不可・色空間sRGB固定・blurRegionの1:1翻訳不可)を検出→「opencut-wasm続行+
  blit段で吸収+blur2パス+mosaicスコープ外」で方針確定(ユーザー承認)。
  途中でmediabunnyの実ライセンスがMIT誤記でなくMPL-2.0と判明→許容し訂正。
  Phase1(commit `187eee8`)で依存exact pin導入。Phase2(commit `c602799`)で
  frameSource/sourcePool/frameBlit。Phase3直前に`initCompositor`がdocument
  束縛でWorker実行不可と判明→コンポジタをメインスレッド実行に構成変更
  (Phase3 commit `f4e9f4a`。textureCache+blur2パス実装)。Phase4(commit
  `a2e38c4`)でclock.ts(音マスター提示クロック)+audioScheduler.ts(先読み
  スケジューラ。bgmVolumeAtFrameを再利用)。tsc/npm test は全フェーズで緑
  (Phase4完了時点2792/2792)。
- **2026-07-28（M3a Phase5 直前・重大発見。停止して報告）**: Phase5(開発
  ページ)の実装前に opencut-wasm を実際にブラウザで動かせるか確認したところ、
  **opencut-wasm の npm パッケージは CutFlow のビルド経路(esbuild)でも
  素のブラウザ(chrome-headless-shell 実測)でもロードできない**ことが
  判明した。`node_modules/opencut-wasm/opencut_wasm.js` は
  `import * as wasm from "./opencut_wasm_bg.wasm"` という「WASM の
  ES Module 直import」構文で書かれている(wasm-bindgen の "bundler" target
  出力)。これは (1) chrome-headless-shell(Remotion 同梱)へ実際に
  `<script type=module>` で読ませると
  `Failed to load module script: Expected a JavaScript-or-Wasm module
  script but the server responded with a MIME type of "application/wasm"`
  で失敗する(`--enable-experimental-web-platform-features` を付けても同じ)。
  WASM/ESM integration はどのブラウザにも既定で入っていない未成熟仕様。
  (2) esbuild(CutFlow の唯一のバンドラ)で束ねようとすると
  `.wasm` 用の loader が無くビルド自体が失敗し、`--loader:.wasm=file` を
  強制すると `import * as wasm` の中身が `{default: "url文字列"}` という
  ただの静的アセット参照になり、wasm-bindgen が要求する実際の wasm
  exports オブジェクトにならない(`__wbg_set_wasm` に文字列を渡す形になり
  実行時に確実に壊れる)。Vite/webpack 等の bundler-target 前提の
  wasm-bindgen 出力で、esbuild にネイティブ対応が無い。
  **母艦§8 置換発動条件 (b)(デバッグ不能な不具合)に該当しうる**。
  回避策は把握しているが未実施・未検証: 自前 esbuild プラグイン
  (`.wasm` を横取りし `WebAssembly.instantiate` ベースの初期化コードへ
  書き換える。wasm-bindgen の import 表の形を正確に再現する必要があり
  軽くはない)。Phase0〜4 で積んだ VideoFrame ゼロコピー不可・
  メインスレッド実行・blur2パス等の制約と合わせ、opencut-wasm 続行の
  実装コストが当初想定より増えている。**ユーザー回答: 自前WGSLバックエンドへ
  切替(推奨案を採用)**。
- **2026-07-28（opencut-wasm→自前WGSL 実装完了。commit `48f4dbe`）**:
  `src/engine/runtime/webgpuBackend.ts` を新設(opencut-wasmと同じ関数
  シグネチャ。CutFlowはblendMode="normal"・回転/反転なし・GPU側マスク/
  エフェクト無ししか使わないためテクスチャ付き矩形+通常アルファ合成の
  パイプライン1本で足りる)。npm依存からopencut-wasmを削除。
  実測: chrome-headless-shellで`--use-angle=metal --ignore-gpu-blocklist
  --enable-unsafe-webgpu`を付けるとApple Metalアダプタが取得できること、
  esbuildバンドルが正常動作すること、テクスチャアップロード→矩形配置→
  アルファ合成→クリア色まで正しいピクセル値(中心=アップロードした赤
  テクスチャ、角=クリア色の青)で描画できることを確認。
- **2026-07-28（M3a Phase5(1/2)完了。commit `fe52c36`）**: editor サーバに
  `GET /engine-dev`(?dir=必須)開発ページを追加。実収録(scratch コピー・
  5分強)をchrome-headless-shellから実際に動かし、sourceKind:"image"
  (design背景・画像overlay)がVideoSampleSinkに渡っていて全滅する実バグを
  発見・修正(frameBlit.tsをVideoSample|ImageBitmap対応にしImageCacheを
  追加)。修正後、実尺316.4s・出力解像度1920x1080・複数時刻での非トリビアル
  なピクセル値を確認。**残タスク(Phase5(2/2)・未着手)**: CDP計測スクリプト
  (scripts/engine-bench.mjs。シーク応答p50/p95・ドロップ率・提示間隔)・
  Remotion framesとの画素parity自動化(M2比較器の流用)・メインスレッド
  競合負荷試験(母艦§8発動条件(c)の判定材料)。音声再生(AudioScheduler)は
  コード疎通のみ確認・実際の音出し検証は未実施。
- **2026-07-28（M3a Phase5(2/2)完了。commit `0dd3299`。M3a 完了）**:
  `scripts/engine-bench.mjs`(engine-parity.mjsと同じ自前CDPパターン・新規
  依存なし)を追加し実収録(5分強)で実測。**シーク応答**: p50=17ms/
  p95=253ms(n=10)。**再生ドロップ率**: 無負荷/メインスレッドDOM churn
  負荷ありとも0%(6秒・360フレーム中0ドロップ、提示間隔p50=16.7ms/
  p95=17.6ms≒60fps張り付き)。**母艦§8発動条件(c)(メインスレッド競合)は
  今回の負荷試験では観測されず**。**per-frameコスト**: decode平均9.2ms・
  blit平均0.75ms(16.6ms予算の主因はdecode待ち。今回のオーバーヘッドは
  自前WGSL化以前の想定より軽い)。**画素parity**: `Page.captureScreenshot`
  (drawImageでの読み戻しはWebGPU canvasだと常に透明黒になる既知の癖を
  headless実測で発見。webgpuBackend.tsにコメント記録済み)で撮った実際の
  描画を目視確認し、oracle(`frames`)と構図・人物・背景・テロップとも
  一致することを確認。ネイティブ解像度でのbyte比較自動化(SSIM/PSNR)は
  今回のcaptureScreenshotが上下反転+CSSスケール後の暫定手段だったため
  未実装のまま(M4の決定性CI整備時に本実装する)。**音声再生の実聴検証は
  未実施**(AudioSchedulerのコード疎通・例外無しのみ確認)。
  **M3a はここまでで完了ゲート(§3表)を満たしたと判断**: tsc/npm test緑
  (2792/2792)・依存はmediabunny 1本のみ(opencut-wasm不採用→自前WGSL)・
  headless実測がM1基準を上回る(ドロップ0%)・画素parity目視合格。
  次は M3b(editor統合・`<video>`/Player排除・bake撤去)。
- **2026-07-28（M1〜M4 後の欠陥発覚・R1〜R3 起草）**: M4 完了直後の点検で
  **合成が上下反転**していることを実測（`node src/cli.ts frames
  ~/Movies/cutflow/2026-07-21 --t 150` の PNG が全テクスチャ反転。位置・
  レイアウトは正しい）。真因は `src/engine/runtime/webgpuBackend.ts` の
  頂点シェーダで、位置を y 下向きのピクセル空間で組んでいるのに `uvs` の v が
  逆順（6頂点すべて）。**上の M3a Phase5 ログの「captureScreenshot が上下反転
  +CSSスケール後の暫定手段だった」という記述自体が誤診の記録**で、
  `canvas.style.transform = "scaleY(-1)"` による打ち消しが症状を隠していた
  （実際にはスクリーンショットは正しい向き。同じ PNG に写り込んだ DOM 文字が
  正立していることが証拠）。あわせて **プレビュー音声が各 keep 区間の先頭
  21.3ms しか鳴らない**（`audioScheduler.ts` が `sink.buffers()` の最初の
  チャンクで `break`。proxy.mp4 は AAC で 1 パケット=1024 サンプル=21.3ms を
  ffprobe で実測）、**書き出しフレームに `#export-status` の文字が焼き込まれる**
  （`engineSession.ts` の HTML で canvas と同じ左上に `position:fixed`）ことも判明。
  `render.engineExport` の既定が true なので `final.mp4` / `frames` / `thumbnail`
  のすべてに①③が乗る（②はプレビュー限定＝書き出し音声は ffmpeg ベッドのまま）。
  **プロセス上の根因**: WebGPU の出力を画素で検証する経路が存在しなかった
  （`scripts/engine-parity.mjs` は Remotion vs canvas2d 参照ペインタの比較で
  GPU を通らない／`test/engineDeterminism.test.ts` は hash・フレーム数・
  duration だけ／M3a の画素 parity は「目視」で、上の M3a ログが自認するとおり
  自動比較は未実装のまま M4 へ進んだ／同ログは「音声再生の実聴検証は未実施」も
  自認している）。よって **R1 は「先に検出できるハーネスを作り、未修正 HEAD で
  赤を確認してから直す」**順序を決定事項にした。
  さらに、M1〜M4 の検証中に **`~/Movies/cutflow/2026-07-12` の manifest.json が
  `clean` → `ingest`（`--layout` 無し）で `layout: "plain"` に作り直され、
  screenRegion/cameraRegion が失われていた**ことも判明（背景・パネル・ワイプが
  出なくなる。§4 が検証用に挙げていた `2026-07-02-whisper-bench` が現存せず、
  実装セッションが実収録で代用したことが引き金）。R3 で
  `manifest.json` を `clean` の削除対象から外し（フォルダの中身だけからは
  復元できないため）、検証収録の指定を実在するものへ直す。
- **2026-07-29（Safari 実機の保証水準を実測で決定。§8「Safari プレビュー」への回答）**:
  ユーザーの実機 Safari 26.5.2 で canvas プレビューが `EncodingError:
  Decoder failure` を連発した件を、専用ハーネス（mediabunny 経由と生
  `VideoDecoder` 直叩きの2段構え）で切り分けた。結論は **「Safari でも
  WebCodecs は動く。落ちていた真因は CutFlow 側のデコーダ閉じ忘れ（枯渇）」**。
  決め手は、エディタのタブが開いている間は **320x240 Constrained Baseline の
  2秒クリップですら**復号できず（同じファイルを `<video>` では
  `readyState=4` で再生できる）、その後は **実物の 2560x720 全イントラ proxy が
  11ms で復号できた**という反転。`VideoDecoder` の VideoToolbox セッションは
  タブ単位ではなく**プロセス全体で共有**されるため、`frameSource` が seek の
  たびにイテレータを `return()` せず放置していると、他タブの復号まで巻き添えで
  落ちる。修正: 捨てるときは必ず `return()`（`discardIterator`）・`seekTo` は
  前のデコーダが閉じ切るのを **await** してから次を作る・落ちたら sink ごと
  作り直して1度リトライ（`stats.recoveries`）。あわせて、失敗が
  未処理 Promise 拒否として消えて「プレビューが黙って静止」していた
  `EnginePreview.repaintAt` を、記録＋連続3回で legacy へフォールバックする形に
  変えた。**符号化（解像度/全イントラ/profile/level）・Annex-B か avcC か・
  `hardwareAcceleration` はいずれも無関係**（1280x360 Main@3.1 や Annex-B でも
  同様に落ち、枯渇解消後は全部通る）。
  **教訓2件**: (a) `VideoDecoder.isConfigSupported` は当てにならない
  （枯渇状態でも `supported:true` を返し続けた＝対応判定に使ってはいけない）。
  (b) この class の欠陥は Chromium では一切表面化しない（CLI・headless 検証・
  parity ハーネスは全部 Chromium）。**ブラウザ差は検証面の空白のままである**。
- **2026-07-29（親セッションの再検証で判明した実装状態のずれ）**: M4 Phase5
  （§7 の削除リスト）が未実行のまま「M4 完了」として扱われていた。加えて
  render/frames/thumbnail/editor の4箇所で旧経路への自動降格が既定有効
  （§1-10 の「恒久 dual-path にしない」に反する）。§0 の「次の一手」を
  「画素 parity のゲート化 →（その後に）§7 の一括削除と自動降格の撤去」に
  更新した。
- **2026-07-29（G1: golden 凍結+ゲート実装完了・ゲート判定は赤。原因特定済み）**:
  `docs/plans/2026-07-29-engine-g1-pixel-gate-design.md` の Phase 0〜5 を実装。
  合成 parity フィクスチャ（1920x540・obs-canvas・960x540 出力・24秒・12シーン）を
  `test/fixtures/engine/parity-project/`（編集 JSON のみコミット）に用意し、
  Remotion オラクルから `test/fixtures/engine/pixel-golden/`(12枚+provenance.json・
  合計1.2MB)を捕獲。`npm run gate:pixel`(独立ゲート。D1)を新設した。
  **設計時の想定と異なり、#6(インサート)は元収録秒(source axis)からは原理的に
  到達できない**(挿入区間は出力秒専用のスパン。`toOutputTime()`はアンカー
  ちょうどの時刻を「挿入後」へ解決する)ため、この1点だけ`--out`(出力軸)で
  挿入区間内の時刻を直接指定する方式に変更した(シーン表の他11点は元収録秒のまま)。
  **較正実測(T-6)**: 12枚中10枚が不一致(exit 1)。tileDiffMax実測値:
  out1.00s=32.12 / out2.50s=41.36 / out4.00s=39.50 / out5.50s=33.76 /
  out7.00s=31.87 / out9.00s(インサート)=1.95(一致) / out12.20s(ワイプ中)=39.06 /
  out14.20s=32.02 / out16.20s=42.20 / out18.20s=40.52 / out20.20s=32.13 /
  short-s1=19.98(僅差で一致)。**不一致タイルは例外なくカメラ(ワイプ)映像が
  写っている領域に集中し、画面(screenRegion)側は無傷**(diffNormal全体は
  0.9〜4.8と低いのにカメラのタイルだけ突出)。実ピクセル値を直接比較すると
  カメラ領域だけ全チャンネルが中間グレーへ圧縮されていた
  (例: golden(0,223,217)→captured(0,173,191)、golden(255,0,255)→
  captured(205,30,197)。画面領域は golden(255,255,0)→captured(255,251,0)で
  誤差4=無視できる)。振幅が中央へ潰れるこのパターンは**YUVのlimited-range
  (16–235)⇔full-rangeの解釈違い**の典型症状。実収録(`2026-07-21`。
  `color_range=tv, color_space=bt709`とタグ付き)でも本セッション冒頭の
  T-1完了確認で同種の症状(ワイプ領域のtileDiffMax=51.98/75.07)が出ていたため、
  **合成フィクスチャ固有ではなく実収録でも起きる可能性が高い既存バグ**と判断。
  画面もカメラも`src/engine/runtime/frameBlit.ts`の同じ`blitVideoSample()`を
  通るが、実デコードは`mediabunny`パッケージの`VideoSampleSink`(WebCodecs
  `VideoDecoder`のラッパー)任せで、本リポジトリのコードに`colorSpace`設定は
  見当たらない(カメラ素材が0/255に近い極端な配色を含むためだけ誤差が
  可視化されている可能性が高い=画面素材側にバグが無いのではなく単に
  誤差が隠れているだけ、という仮説)。**このバグの修正は本plan(G1)のスコープ外**。
  ユーザー判断(2026-07-29)によりG1は「ゲート基盤は完成・判定は赤」の状態で
  コミットし、バグ修正は別issueへ切り出した。
  **T-7(赤→緑の実証)は前提が崩れたため適応して実施**: 頂点シェーダのUVを
  わざとV反転させたところ、8枚が明示的に「上下反転を検出」に変わり
  diffNormal/tileDiffMaxとも全面的に悪化(例: out2.50s tileDiffMax 41.36→95.48・
  それまで一致していたout9.00s/short-s1も不一致化)。変更を戻すと**全12枚の
  tileDiffMaxが一字一句、変更前と完全に同じ値へ復帰**(残留無し・決定論的)。
  「クリーンな緑」の実証はできなかったが、「ゲートは実際のコード変更に反応し、
  復元後は元の状態(ここでは既知バグによる赤)へ正確に戻る」ことは実証できた。
  この赤判定は後続 G2 で原因訂正込みで解消済み（次項）。
- **2026-07-29（G2: 画素ゲート緑化。G1原因記録の訂正）**:
  `docs/plans/2026-07-29-engine-g2-wipe-color-parity-design.md` を実装。
  G1時点の `npm run gate:pixel` ベースラインは12枚中10枚赤:
  `out1.00=32.12` / `out12.20=39.06` / `out14.20=32.02` /
  `out16.20=42.20` / `out18.20=40.52` / `out2.50=41.36` /
  `out20.20=32.13` / `out4.00=39.50` / `out5.50=33.76` /
  `out7.00=31.87`。`out9.00=1.95` と `short-s1-out1.50=19.98` は一致。
  **原因訂正**: limited/full range ではなく、主因はワイプ(camera) descriptor だけ
  `colorFilter` を落としていたこと。独立要因として未タグ 540p 中間動画の
  YUV matrix が Remotion/ffmpeg 側では BT.601、WebCodecs 側では BT.709 と
  解釈されていた。screenRegion も無傷ではなく、原色が `saturate` 後にクランプ
  されて差が見えにくかっただけ。
  T-3（ワイプ `colorFilter` 修正後）は12枚中5枚赤:
  `out1.00=12.38` / `out12.20=17.54` / `out14.20=12.27` /
  `out16.20=42.20` / `out18.20=40.52` / `out2.50=41.36` /
  `out20.20=12.44` / `out4.00=39.50` / `out5.50=33.76` /
  `out7.00=12.05` / `out9.00=1.95` / `short-s1-out1.50=19.98`。
  proxy/preview/preview-cut/cut.mp4 に `-colorspace <matrix> -color_range <range>` を
  焼く配線を追加し、フィクスチャ proxy 再生成後は全12枚一致:
  `out1.00=0.00` / `out12.20=0.00` / `out14.20=0.00` /
  `out16.20=0.00` / `out18.20=0.00` / `out2.50=0.00` /
  `out20.20=0.00` / `out4.00=0.00` / `out5.50=0.00` /
  `out7.00=0.00` / `out9.00=1.95` / `short-s1-out1.50=11.17`。
  再生成 proxy は mp4 コンテナと Annex B elementary stream の両方で
  `color_space=smpte170m, color_range=tv` を確認。タグ有り/無しエンコードを
  BT.601/tv 明示で raw RGB 比較した画素不変検証は `maxdiff=0`。
  残件: `frames --full-res` は proxy を通らず未タグ SD 素材では同じ 601/709 差が
  残りうる。ただし実収録は HD で双方 709 に落ちるため、§7 の削除前提からは外す。
- （以降、各 plan の完了・ゲート判定・実測値をここへ追記する）
