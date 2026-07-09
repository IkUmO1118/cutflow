// エディタのサーバー(editor/server.ts)とクライアントで共有する API の型。
// 編集対象のドキュメント自体はパイプラインの型(src/types.ts)をそのまま使う。

import type { Config } from "../../src/lib/config.ts";
import type { PerceptionStatus } from "../../src/lib/config.ts";
import type {
  Bgm,
  CutPlan,
  Interval,
  Manifest,
  Overlays,
  Shorts,
  Transcript,
} from "../../src/types.ts";
import type { FrameShot } from "../../src/stages/frames.ts";
import type { ReviewBundle } from "../../src/stages/review.ts";
export type {
  AiProposeRequest,
  AiScope,
  AiSelectionContext,
} from "../../src/stages/editorAi.ts";
import type { AiProposeResponse as EditorAiProposeResponse } from "../../src/stages/editorAi.ts";

export interface AiProposeResponse {
  proposalId: string;
  proposal: EditorAiProposeResponse;
}

export interface AiReviewRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  vlm?: boolean;
}

export interface AiReviewResponse {
  bundle: ReviewBundle;
}

/** GET /api/project のレスポンス。収録フォルダの編集に必要な全データ
 * (chapters.json は YouTube チャプター用メタデータでエディタでは扱わない) */
export interface ProjectData {
  dir: string;
  manifest: Manifest;
  transcript: Transcript;
  cutplan: CutPlan;
  overlays: Overlays;
  /** 収録フォルダ内の全ファイル(相対パス)。素材選択と存在チェック用 */
  dirFiles: string[];
  /** bgm.json(BGM の区間配置)。無ければ null で、その場合は bgmFile を
   * 全編1曲として流す(後方互換)。エディタでは編集せず表示・再生のみ */
  bgm: Bgm | null;
  bgmFile: string | null;
  /** shorts.json(ショート動画の定義)。無ければ null(このセッションでは
   * ショート未定義)。エディタでは編集して /api/save の shorts で保存する */
  shorts: Shorts | null;
  /** cuts.auto.json の無音区間(BGM ダッキングをプレビューでも再現する
   * ために渡す)。detect 未実行なら null */
  silences: Interval[] | null;
  /** proxy.mp4(元収録の軽量プロキシ。エディタの再生ソース)があるか。
   * 無ければ POST /api/proxy で生成する(収録ごとに1回) */
  proxyExists: boolean;
  /** proxy.mp4 が焼き込み済みの設定(ラウドネス・システム音声・プレビュー幅・
   * エンコーダ)か元収録ファイルと食い違っている(古い)か。proxyExists が
   * false のときは常に false(未生成であって陳腐化ではない) */
  proxyStale: boolean;
  renderCfg: Config["render"];
  /** カット確認用プレビュー動画・プロキシの横幅(config の preview.width) */
  previewCfg: { width: number };
  /** エディタ設定(サーバー側で省略時の既定値まで解決した実値) */
  editorCfg: EditorCfg;
  /** 最終レンダーの出力解像度(manifest の screenRegion) */
  output: { w: number; h: number };
  /** カメラ(ワイプ)を持つレイアウトか(obs-canvas かつ cameraRegion あり)。
   * plain(カメラ無し)ではワイプトラック・全画面区間 UI を出さない */
  hasCamera: boolean;
  /** 前回のセッションが保存せずに終わった(クラッシュ等)ときに残る
   * 未保存編集の退避(.editor-draft.json)。無ければ null */
  draft: DraftData | null;
  /** plan/remeta に渡る知覚設定の解決結果。header の短い状態表示用 */
  planPerception: PlanPerceptionStatus;
}

export type PlanPerceptionStatus = PerceptionStatus;

/** エディタ設定の解決済み実値(config.yaml editor セクション+既定値) */
export interface EditorCfg {
  maxUploadMb: number;
  /** タイムラインに置く画像素材・尺不明素材の既定の尺(秒) */
  defaultImageDurationSec: number;
  /** ショート新規追加時、選択中の keep クリップもプレイヘッドも
   * 無いときの既定レンジ長(秒) */
  defaultShortRangeSec: number;
}

/** POST /api/config のレスポンス。保存後の解決済み設定(クライアントは
 * これで proj の該当フィールドを差し替える)。リクエストボディは
 * ConfigPatch(src/lib/configEdit.ts。クライアントからは import type のみ=
 * yaml パッケージをバンドルに入れない) */
export interface ConfigSaveResult {
  ok: true;
  renderCfg: Config["render"];
  previewCfg: { width: number };
  editorCfg: EditorCfg;
}

export interface AiFrameRequest {
  times: number[];
  axis?: "source" | "output";
  activeShortName?: string | null;
  ocr?: boolean;
  fullRes?: boolean;
}

export interface AiFrameResponse {
  shots: FrameShot[];
}

/** POST /api/draft のボディ = .editor-draft.json の中身。未保存の編集を
 * クラッシュ・強制終了から守るための自動退避で、正のデータ(各 JSON)には
 * 保存(⌘S)まで触らない。保存が成功したら削除される */
export interface DraftData {
  /** 退避した時刻(ISO 8601)。復元バナーの表示用 */
  savedAt: string;
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  /** BGM の区間配置(bgm.json)。未設定なら null */
  bgm: Bgm | null;
  /** ショート動画の定義(shorts.json)。古い draft には無いので省略可 */
  shorts?: Shorts | null;
}

/** GET /api/peaks のレスポンス。マイク音声の波形ピーク(タイムライン描画用)。
 * 時刻軸は元収録の秒(micWav は元収録と同じ長さ) */
export interface PeaksData {
  /** 1秒あたりのピーク数 */
  rate: number;
  durationSec: number;
  /** ピーク列(各 0..255、全体の最大値で正規化)のバイト列を base64 で */
  peaks: string;
}

/** POST /api/upload のレスポンス。素材は materials/ に保存される */
export interface UploadResult {
  /** 収録フォルダからの相対パス(materials/xxx.png) */
  file: string;
  /** 動画素材の長さ(秒)。画像や取得失敗時は null */
  durationSec: number | null;
}

/** POST /api/save のボディ。含まれるドキュメントだけがファイルに書かれる。
 * transcript はテロップの文言・表示時間の編集用(手直し→再レンダーは
 * 元々パイプラインが想定するワークフロー。plan の再実行は cutplan と
 * 章トラックのテロップを作り直すので注意) */
export interface SaveRequest {
  cutplan?: CutPlan;
  overlays?: Overlays;
  transcript?: Transcript;
  /** BGM の区間配置。`null` / 空 tracks は bgm.json を削除する(= 全編1曲の
   * 後方互換へ戻す)。`undefined`(キー無し)は bgm.json を触らない */
  bgm?: Bgm | null;
  /** ショート動画の定義。`null` / 空 shorts は shorts.json を削除する。
   * `undefined`(キー無し)は shorts.json を触らない */
  shorts?: Shorts | null;
}
