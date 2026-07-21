# canvas/GPU エンジン母艦 — CutFlow の Remotion+`<video>` 描画基盤を、OpenCut を設計図に canvas/GPU コンポジタへ作り替える

> 状態: **START（2026-07-22）。P0 IMPLEMENTED / VERIFIED、P1/P2 未着手。** 目的は
> CutFlow のエディタプレビューのガタつき（カット境界の `<video>` seek ヒッチ +
> メインスレッド React 生合成）を、**手法の限界**として根治すること。手段は
> Remotion + `<video>` の描画基盤を **OffscreenCanvas + WebCodecs（必要なら
> WebGPU/wgpu）の canvas/GPU コンポジタ**へ作り替える。設計図は **OpenCut classic
> の `services/renderer`**（fork 済み・MIT）。
>
> **最重要の一線（土台の帰属）**: これは **OpenCut への乗り換えではない**。
> **CutFlow が製品の土台であり続ける。** OpenCut は**参考（reference）実装**で
> あって製品ベースではない。CutFlow の哲学（**JSON が正**・CLI・approvals・
> AI の脳）は 1 バイトも明け渡さない。借りるのは**描画設計だけ**。この境界を
> 動かす提案（例: データ層を IndexedDB/OPFS に寄せる、脳を OpenCut の command
> 模型へ移す）は §9 の意思決定ログに理由を残してから行う（一度誤った方向=
> 「OpenCut を土台に」を 2026-07-22 に訂正済み。§9 参照）。

関連文書:
`docs/programs/render-fastpath-program.md` / `docs/programs/render-design-program.md`
（**最終 render** の高速化・デザイン統合の母艦。本 doc は**エディタプレビュー**と
**描画エンジンの統一**が主題で層が違う。P2 で最終 render も同エンジンに寄せるため
最終的に交差する）/ `docs/programs/hyperframes-integration-program.md`（HF は本 doc で
Remotion のオフライン sidecar として温存＝唯一 Remotion が残る場所）/
`AGENTS_CONTRACT.md`（編集・生成物境界）/ `docs/usage.md`。
実測・調査メモ: memory `capcut-web-architecture-reference`（tier2=WebCodecs+Worker+
WebGL/WebGPU の完成形。到達可能性の一次資料）/ `opencut-fork-data-model-and-seams`
（OpenCut のデータモデル・renderer 事実記述・本方向の確定ログ）。
参考実装（fork・製品ベースではない）: **/Users/19mo/dev/labs/opencut**
（`apps/web/src/services/renderer/`）。
現行コード錨: `editor/client/App.tsx`（Remotion Player プレビュー）/
`remotion/Main.tsx`（最終合成 composition＝合成意味論の正）/
`src/lib/videoEncode.ts`（`PROXY_GOP_FRAMES=6` 等プロキシ生成）/
`src/stages/proxy.ts`（proxy.mp4）。

---

## 0. 他エージェント向け: 現在地と次の一手

- **現在地（2026-07-22）**: 暫定P0を実装・実測済み。P1/P2は未着手。この母艦は
  「何を作り替え、何を絶対に触らないか」を固定するための正本。
- **確定した方向**: CutFlow が土台のまま、描画エンジンだけを Remotion+`<video>`
  から canvas/GPU コンポジタへ作り替える。OpenCut は設計図＋部品供給元（MIT）。
  データモデル・CLI・AI の脳・承認は不変（§1・§7）。
- **次の一手（P1 設計/実装ゲート）**: P0 設計書
  `docs/plans/2026-07-22-canvas-preview-p0-design.md` は **IMPLEMENTED / VERIFIED**。
  結論＝**proxy から keeps-only の連続ファイルをベイク → `videoIsSource:false` で既存
  continuous 経路に流す（`remotion/Main.tsx` 無改造でシーク消滅）**。設計の Q2＝
  **dual-path 共存**・Q6＝**short は含めない**で実装し、C1〜C4・frame drift是正・hardeningを完了した。
  次はP1の設計/実装ゲート。P1/P2 の残 §8 未決（mediabunny 流用/P2 射程/byte 決定性）は
  P1/P2着手判断で解く。
- **触ってはいけない一線**: `cutplan.json` 等の JSON が正であること・`approvals.json`
  の承認 hash・AI の脳（plan/知覚/decision recipes/プロンプト）・CLI 契約。
  エンジン交換は**脳より下の層**で完結する（§1 の図）。

## 1. 目的と境界 — 何を作り替え、何を保つか

CutFlow を CutFlow たらしめている層（上）と、今回作り替える層（下）は綺麗に分離できる。
交換は**下だけ**で、上は不変のまま成長を続ける。

```
┌─────────────────────────────────────────────┐
│ AI の脳    plan / 知覚 / decision recipes / prompt │  ← 不変（成長は続く）
│ データの正 cutplan/transcript/overlays/… = JSON  │  ← 不変（IndexedDB/OPFS へ移らない）
│ 契約・運用 CLI / approvals.json / approve 境界    │  ← 不変
├─────────────────────────────────────────────┤
│ 合成意味論 crop/wipe/zoom/blur/annotation/       │  ← 作り替え（今 remotion/Main.tsx）
│           caption3層/karaoke/素材/colorFilter    │     意味は同一・実装を canvas へ移植
│ 描画基盤   Remotion Player + <video>（プレビュー） │  ← 交換対象（本丸）
│           Remotion headless（最終 render）        │  ← P2 で同エンジンへ／HF 専用に降格
└─────────────────────────────────────────────┘
```

### 移植境界（IN / OUT）

| 対象 | 分類 | 扱い |
|---|---|---|
| CutFlow のデータモデル（JSON が正） | **保持（不変）** | IndexedDB/OPFS へ移さない。ファイルが正のまま |
| AI の脳・CLI・approvals・承認 hash | **保持（不変）** | エンジン交換は脳より下。契約に触れない |
| 合成意味論（Main.tsx の各演出の**意味**） | **移植（意味は不変）** | canvas コンポジタで 1:1 再現。見た目が変わってはならない |
| プレビューの描画基盤（Player + `<video>`） | **交換（本丸）** | OffscreenCanvas + WebCodecs コンポジタへ |
| 最終 render の描画基盤（Remotion headless） | **P2 で交換** | 同エンジンへ寄せ preview==final を回復 |
| Remotion 本体 | **HF 専用に降格** | HyperFrames→mp4 のオフライン sidecar としてのみ残す（§4.3） |
| OpenCut のアプリ本体・データ層・command 模型・脳 | **借りない（OUT）** | 製品ベースにしない。参考にするのは renderer だけ |
| OpenCut の renderer 部品（mask-feather JFA・mediabunny 連携等） | **参考／直接流用可** | MIT。設計を写す・小部品は license 順守で lift |

### 評価基準（この母艦の全フェーズが満たし続ける不変条件）

1. **データの正は JSON のまま**。IndexedDB/OPFS へ移さない。CutFlow の「ファイルが正」
   哲学を持ち込み先に明け渡さない。
2. **AI の脳・CLI・approvals・承認 hash に触れない**。エンジン交換は脳より下で完結する。
3. **合成意味論は 1:1 で保存**。overlays/transcript の全機能（crop/wipe/zoom/blur/
   annotation/caption 3層/karaoke/素材/colorFilter/layerOrder/hideCaption）が
   従来と同じ絵を出す。frames 監査・既存スナップショットで回帰を止める。
4. **最終的に preview==final を回復**（P2 完了時）。永続的な二重描画モデルを残さない。
5. **最終 render の byte 決定性を、Remotion 引退の前に再確立**（§8 リスク）。
6. **OpenCut は参考／部品供給元として使う（MIT 順守）。製品ベースにしない**。

## 2. 問題の実体 — なぜガタつくか（手法の限界）

CutFlow のプレビューは `editor/client/App.tsx` の **Remotion Player を proxy.mp4 に対して**
回し、keep 区間を飛び飛びに再生する（本物の NLE と同じ「カットを焼き込まない」方式）。
ガタつきの主因は 2 つ:

- **カット境界の `<video>` seek ヒッチ**: 境界ごとに `<video>` を非連続位置へシークし、
  直前キーフレームからの GOP デコード待ちが出る。緩和策は投入済み（`PROXY_GOP_FRAMES=6`
  ＝0.2秒 GOP、premount 2秒、frame-hold canvas）だが、非表示 video にフレームを供給
  しない環境（Safari）では premount が隠しきれない。**GOP を刻む・先読みする、という
  対症療法の限界**。
- **メインスレッド React 生合成**: テロップ・素材・演出を毎フレーム React/DOM で重ねる
  ため、重い区間でメインスレッドが詰まる。

**壁はブラウザではない。** CapCut は同じブラウザで、C++ エンジンを WASM 化＋WebCodecs
自前デコード＋WebGL 合成＋Worker で CapCut 級を実現している（memory
`capcut-web-architecture-reference` 一次資料）。ガタつくのは「`<video>` seek ＋ メイン
スレッド React 生合成」という**手法**の限界であって、到達可能な tier2（WebCodecs +
Worker + WebGPU）に移せば構造的に消える。

## 3. 目標アーキ — 単一 canvas/GPU コンポジタ

- **フレーム供給**: `<video>` の seek をやめ、**WebCodecs で自前デコード**して必要な
  ソースフレームを得る。カットは「次にどのソースフレームを描くか」を変えるだけ＝
  **シーク不在**。GOP デコード待ちが原理的に発生しない。
- **合成面**: **OffscreenCanvas**（メインスレッド外）へ `drawImage`／GPU 合成で
  レイヤーを重ねる。React は「タイムライン状態を持つ薄い UI」に戻り、毎フレーム合成の
  責務から降りる。
- **GPU**: 多層ブレンド・マスク・効果が 2D canvas で詰まる段になったら **WebGPU/wgpu**
  （OpenCut の `gpu-renderer`＝`opencut-wasm`）へ寄せる。最初から必須ではない（§6 で段階化）。
- **preview==final の回復**: プレビューと最終書き出しを**同一コンポジタ**が担うことで、
  CutFlow が今持つ WYSIWYG（両方 Remotion composition）の強みを、新エンジン上で取り戻す
  （§7-4）。ここが「プレビューだけ canvas 化」との決定的な違い。

## 4. OpenCut を参考にする範囲 — 何を借り、何を借りないか

fork（`/Users/19mo/dev/labs/opencut`）の `apps/web/src/services/renderer/` は本物の
シーングラフ・コンポジタで、CutFlow の Remotion+`<video>` とは別クラス（memory
`opencut-fork-data-model-and-seams` のエンジン評価）。**借りるのはこの描画設計だけ**。

### 4.1 借りる（設計図・部品）

| OpenCut のもの | 借り方 |
|---|---|
| `scene-builder.ts` / `nodes/` / `resolve.ts`（タイムライン→描画ノードグラフ） | **設計を写す**。CutFlow の JSON→描画ノードへ翻訳する層を新規に作る雛形 |
| `canvas-renderer.ts`（OffscreenCanvas 2D `drawImage`） | 合成ループの設計を参考 |
| `gpu-renderer.ts`（`opencut-wasm`＝Rust/wgpu 合成） | GPU 合成の設計を参考（P1 後半／P2 で必要になれば） |
| `compositor/` `mask-feather.ts`（JFA）等の**独立部品** | MIT 順守で**直接 lift 可**（車輪の再発明を避ける） |
| `media/mediabunny.ts`（WebCodecs デコード） | フレーム供給の設計を参考。流用可否は §8 で確定 |
| `scene-exporter.ts`（**preview と export が同一 renderer**） | preview==final を成立させる設計思想を写す |

### 4.2 借りない（OUT）

- OpenCut の**アプリ本体・ルーティング・UI**（CutFlow の editor UI を使う）。
- **データ層**（IndexedDB `video-editor-projects` / OPFS `media-files`）。CutFlow は JSON が正。
- **command 模型**（split-elements 等）と**編集の脳**（そもそも AI の脳が無い＝greenfield
  だった）。CutFlow の脳を移植する話は**訂正で消滅**（§9）。
- 注記: OpenCut classic は upstream で "archived legacy" 扱い。**製品として依存しない**
  ので churn の影響を受けない（設計図・MIT 部品として読むだけ）。

### 4.3 Remotion の行き先 — HyperFrames 専用の sidecar

Remotion は引退させるが**完全には消さない**。HyperFrames は Remotion native interpreter で
mp4 カードを render する完成済み資産（`docs/programs/hyperframes-integration-program.md`）。
HF 出力は**事前レンダー済みの mp4**＝タイムラインには通常素材として import されるだけなので、
**新エンジンの本線に一切触れない**（＝ preview==final の乖離を生まない）。よって Remotion は
「HF→mp4 を吐くオフライン sidecar」として温存する。これが Remotion が残る唯一の場所。

## 5. cut.mp4 bake の位置づけ — 任意・暫定・撤去前提

**bake は必須ではない。** OpenCut は bake を使っていない（fork 実測: `services/`・`export/`
に `concat|bake|stitch|intermediate mp4` は 0 件。全面 `drawImage`＋`mediabunny`）。理由は
**bake が「`<video>` seek 問題」への応急処置**であり、`<video>` を捨てる canvas エンジン
では消すべきシークが構造的に存在しないから。

- **効能**: keep 区間を 1 本の mp4 に連結し `<video>` を単一連続ファイルで再生 → 境界
  シークが消える。低コストで**今すぐ**効かせられる（capcut メモの「最初の一手」）。
- **弱点（エディタ固有）**: カット境界を 1 回いじるたびに**再 bake（再エンコード）**が要り、
  「編集→再エンコード待ち→反映」という**別種のもたつき（反映レイテンシ）**が出る。bake が
  輝くのは「確定したカットを通しで滑らかに再生」する場面で、それは既存の `preview.mp4` が
  カバーする領域と重なる。canvas エンジンは「滑らかな再生」と「編集の即時反映」を両立する。
- **結論**: bake は **P1（canvas エンジン）が landing する前にどうしても中間の体験改善が
  要る場合だけの保険**。P1 に到達すれば CutFlow も OpenCut と同じ理由で bake が不要になり、
  bake 経路は撤去する。**二度手間（構築→撤去）と編集レイテンシを嫌うなら P0 を飛ばして
  P1 直行が正当**（推奨の傾き＝直行。最終判断は §8）。
- **決定（2026-07-22・ユーザー判断）**: 上の推奨（直行）を承知の上で **P0 を挟む**。
  P1 到達までの中間の脱ガタつきを優先し、編集レイテンシと撤去前提のコストを受け入れる（§9）。

## 6. フェーズ

### P0（IMPLEMENTED / VERIFIED 2026-07-22。暫定・撤去前提）— cut.mp4 bake で暫定の脱ガタつき
- 設計書: **`docs/plans/2026-07-22-canvas-preview-p0-design.md`（IMPLEMENTED / VERIFIED）**。
- プレビュー用に keep 区間を連結した連続ファイルを焼き、Player を単一連続ファイルで回す。
  結論＝**`proxy.mp4` から keeps-only・proxy 解像度でベイク**し、`videoIsSource:false` で
  既存の continuous 経路（`Main.tsx:161-209`）へ流す＝`Main.tsx` 無改造でカット境界シークが消える。
- **render 側の full-res cut.mp4 は preview に再利用しない**（scout で確定）: 重い（full-res）・
  承認ゲート内でしか生成されない・wipe 焼き込みで幾何が違う、の 3 点で不適。二重生成は
  「proxy からの軽量ベイク」で回避する。
- **採用が確定（§9）**。中間の体験改善を優先。P1 landing 後に bake 経路は撤去する（撤去前提）。
- 実装列: 設計 `414f417`、C1 `d2f012c`、C2 `e5c3a2f`、C3 `b7cec05`、C4 `3320987`、
  frame drift `98d560c`、composition clock `0cfb429`、hardening `652fea6`。実測と環境制約は設計書 §7。

### P1（本丸）— プレビューを WebCodecs + OffscreenCanvas コンポジタへ
- CutFlow の JSON（cutplan/transcript/overlays）→ 描画ノードグラフへの**翻訳層**を新規に
  作る（OpenCut `scene-builder`/`resolve` を設計図に）。
- **合成意味論を 1:1 で移植**: crop/wipe/zoom/blur/annotation/caption 3層/karaoke/素材/
  colorFilter/layerOrder/hideCaption。frames 監査・既存スナップショットで絵の回帰を止める。
- フレーム供給を WebCodecs（mediabunny 流用 or 自前＝§8）へ。`App.tsx` の Player を
  canvas サーフェスに置換。**ここでガタつきは根治**。
- この段階では **preview≠final の乖離が一時的に生じる**（最終はまだ Remotion）。P2 で解消。

### P2 — 最終 render を同エンジンへ寄せ preview==final を回復
- 最終書き出しも canvas/GPU コンポジタ（+ WebCodecs encode、必要なら wgpu）へ。
  OpenCut の `scene-exporter`（preview==export）を設計図に。
- **preview==final を回復**し、二重描画モデルを解消。**ここで Remotion を最終 render から
  引退**（HF 専用 sidecar に降格＝§4.3）。
- **前提ゲート**: 最終 render の **byte 決定性を再確立**してからでないと引退させない（§8）。
- render 高速パス／デザイン統合母艦（`render-fastpath`/`render-design`）とここで交差する
  ＝それらの成果を新エンジン上でどう継ぐかを P2 の設計で扱う。

## 7. 保たれるべき不変条件（詳細）

§1 の評価基準の運用面:

1. **JSON が正**: 全フェーズで cutplan.json 等が編集の唯一の真実。canvas は JSON の
   **表示器**であって保存先ではない。
2. **脳と契約の不可侵**: plan/知覚/decision recipes/CLI/approve 境界に一切手を入れない。
3. **絵の回帰ゼロ**: 移植の各機能で「Remotion 版 frames」と「canvas 版 frames」を突き合わせ、
   差が出たら止める。caption 3層継承・karaoke・zoom 連鎖・blur の下層限定・annotation 最前面
   などの細部を回帰対象に含める。
4. **WYSIWYG の回復**: P1 で一時的に許した preview≠final を P2 で必ず閉じる。恒久的な乖離を
   仕様として残さない。
5. **決定性の再確立**: 現行の render 決定性資産（多数の memory）は Remotion 前提。新経路には
   新経路の byte 一致検証を用意する（P2 のゲート）。
6. **MIT 順守**: OpenCut から lift した部品は provenance/LICENSE を残す（HF の
   `vendor/.../PROVENANCE.md` 流儀を踏襲）。

## 8. リスクと未決事項（着手前に確定する go-no-go）

- **[確定 2026-07-22] P0 を挟む**（ユーザー判断・§9）。推奨（直行）を承知の上で中間体験を優先。残る未決は P1/P2 のみ（下記）。
- **[未決] WebCodecs フレーム供給**: OpenCut の mediabunny を流用するか、CutFlow 用に薄く
  自前実装するか。ライセンス・依存重量・CutFlow の proxy/フル解像度の 2 経路との相性で決める。
- **[未決] P2 の射程**: 最終 render を全面 canvas に寄せるか、当面 Remotion 併存で
  preview だけ canvas のまま運用するか（後者は WYSIWYG 未回復のトレードオフ）。
- **[リスク・最重要] 最終 render の byte 決定性**: 現行 determinism は Remotion 前提。
  新経路で再確立できない限り Remotion を最終 render から外さない。**①②はプレビューなので
  無影響、③で本気の検証＝リスクが後ろ倒しになる**のが本フェーズ順の利点。
- **[リスク] 移植量**: OpenCut renderer は相応の規模。CutFlow の合成意味論は Remotion に
  密結合しており、翻訳層＋各演出の移植は数日ではなく数週規模。ただし MIT の参考実装を
  丸読みできる分、ゼロから設計するより大幅に de-risk される。
- **[リスク] Safari 等の環境差**: WebCodecs/OffscreenCanvas/WebGPU の対応差。フォールバック
  戦略（2D canvas への degrade 等）を P1 設計で決める。

## 9. 意思決定ログ

- **2026-07-21（誤・破棄）**: 「OpenCut を製品土台にして CutFlow の脳を移植する／JSON→
  IndexedDB へ移す／Remotion は乗り換えで自動的に引退」と結論した。これは**土台の帰属を
  取り違えた誤り**。CutFlow の哲学（ファイルが正）を明け渡す方向になっていた。
- **2026-07-22（訂正・確定＝本 doc）**: ユーザー訂正により方向を反転。**CutFlow が土台の
  まま。OpenCut は参考実装で乗り換えない。第一目的は CutFlow を成長させること。** 借りるのは
  描画設計だけで、データモデル・脳・CLI・承認は保持。私の当初の推奨（「アプリでなく
  エンジンを借りる」）に最終的に一致した形。
- **2026-07-22**: bake は必須ではないと確定（OpenCut は bake 不使用＝fork 実測 0 件）。
  bake はエディタ固有の反映レイテンシ弱点を持つ暫定策で、P1 到達後に撤去前提。P0 直行を推奨。
- **2026-07-22（確定・ユーザー判断）**: 上の推奨（P1 直行）に反し、**P0 を挟む**ことを採用。
  理由＝P1 到達（数週規模）までの中間の脱ガタつきを優先。P0 は撤去前提のまま（P1 landing 後に撤去）。
  次段＝P0 の設計（read-only scout → `docs/plans/` の P0 設計書 → 実装）。P1/P2 の §8 残 3 件
  （mediabunny 流用/P2 射程/byte 決定性）は P0 に影響しないため未決のまま先送り。
- **2026-07-22（P0完了）**: C1〜C4を直列実装し、実収録コピー・Chrome CDP・props parity・全テストで検証。
  秒trimの +0.506秒 driftを途中で検出し、composition clock / frame-index v3でexactへ是正した。
  VideoToolboxと物理Safariの実測は実行環境制約により未完了として明記し、P0の暫定・撤去前提は維持する。
- **未記入**: P1/P2 の着手判断・go は §8 の残る未決事項を潰してから本ログに追記する。
