// remotion/playerFlags.ts — Player 専用の再生補助フラグ。Main.tsx から
// 機械的に移設(1文字も変えない)。OverlayLayer.tsx と Main.tsx の両方が使う
// 共有ヘルパーなので独立ファイルへ切り出した(挙動は完全不変)。
import { getRemotionEnvironment } from "remotion";

// ---- Player 専用: 再生補助の切り分けフラグ ----
// エディタの URL にクエリを付けると、再生補助の機構を個別に無効化して
// ブラウザごとの症状を切り分けられる(例: http://127.0.0.1:4310/?nohold)。
//   ?nohold     … フレームホールド(ファイル末尾)を無効化
//   ?nopremount … カット境界・挿入・素材の premount(2秒先読み)を無効化
// 呼び出し時に評価する(isPlayer を示す window.remotion_isPlayer は
// モジュール評価の時点ではまだ立っていない)。最終レンダー・frames は
// isPlayer=false なので常に既定動作(影響なし)
export const playerFlag = (name: string): boolean =>
  typeof location !== "undefined" &&
  getRemotionEnvironment().isPlayer &&
  location.search.includes(name);

/** Sequence の premountFor 値(?nopremount で切れる。Player 専用の挙動) */
export const premountFrames = (fps: number) =>
  playerFlag("nopremount") ? undefined : fps * 2;
