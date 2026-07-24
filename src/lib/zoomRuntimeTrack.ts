// src/lib/zoomRuntimeTrack.ts
//
// OpenScreen `frameRenderer.ts:updateAnimationState`(export 用のオフライン決定論ループ)の
// ループ本体を逐語ミラーする決定論 precompute。
// 出典: docs/programs/openscreen-zoom-fidelity-program.md §3、
//       docs/plans/2026-07-24-openscreen-zoom-A-cursor-follow-design.md §3(D1)。
//
// なぜ必要か: OpenScreen 自身は preview(ticker)・export(frameRenderer)ともに「前フレームの
// 状態(follow smoothing の smoothedAutoFocus・zoom-in 判定用の prevTargetProgress・spring の
// value/velocity)を持ち越しながらフレームを順にステップする」ステートフルな filter を実装して
// いる。一方 Remotion はフレーム N を N-1 と独立に計算するステートレスな per-frame レンダラー
// なので、このステートフルな積分はそのままでは載らない。
//
// 解決: この関数(`updateAnimationState` のループ本体の逐語ミラー)を render fps で全フレーム
// 順に「1回だけ」ステップし、各フレームの sprung transform `{f, scale, x, y}` を軌跡として
// 書き出す precompute にする。呼び出し側(P3 の renderProps.ts)がこの軌跡を props に焼き、
// Main.tsx はフレーム番号で lookup するだけ(ステートレス)にすることで、決定論・再 render
// byte 一致を保ったまま OpenScreen のステートフルな挙動を再現する。
//
// 状態(smoothedAutoFocus・prevTargetProgress・prevAnimationTimeMs・spring)はループの外側で
// 1度だけ宣言し、フレームをまたいで持ち越す。これが chain(連鎖)した zoom 区間をまたいで
// spring を連続させる仕組み(母艦 §2.1 の "fluid" の正体)。同じ zoom グループに属す一連の
// 区間は必ず同じ呼び出しの中で頭から通すこと(別呼び出しにまたがると spring が途切れる)。
//
// このファイルは `src/lib/vendor/openscreen/` の逐語移植関数だけを組み合わせる。OpenScreen の
// ソースを一切変更せず、CutFlow 固有のロジックも足さない(rotation3D/motion-blur 等の非対応
// 機能は意図的に省略。上位の設計ドキュメント参照)。
import type { CursorTelemetryPoint, ZoomFocus, ZoomRegion } from "./vendor/openscreen/types.ts";
import { getZoomScale } from "./vendor/openscreen/types.ts";
import { findDominantRegion } from "./vendor/openscreen/zoomRegionUtils.ts";
import { AUTO_FOLLOW_PARAMS, DEFAULT_FOCUS } from "./vendor/openscreen/constants.ts";
import { advanceFollowFocus } from "./vendor/openscreen/cursorFollowUtils.ts";
import { clampFocusToScale } from "./vendor/openscreen/focusUtils.ts";
import { computeFocusFromTransform, computeZoomTransform } from "./vendor/openscreen/zoomTransform.ts";
import {
  createZoomSpringState,
  resetZoomSpring,
  stepZoomSpring,
  type ZoomSpringState,
  type ZoomTransform,
} from "./vendor/openscreen/zoomSpring.ts";

export interface ZoomRuntimeFrame {
  f: number;
  scale: number;
  x: number;
  y: number;
}

export interface BuildZoomRuntimeTrackParams {
  /** OpenScreen ZoomRegion[]。時間軸は OUTPUT ms(カット後)。 */
  regions: ZoomRegion[];
  /** OUTPUT ms・stage-normalized cx/cy(全画面キャンバスの 0-1)。undefined = 追従なし。 */
  cursorTelemetry?: CursorTelemetryPoint[];
  fps: number;
  stageSize: { width: number; height: number };
  baseMask: { x: number; y: number; width: number; height: number };
  /** 開始フレーム(含む)。 */
  startFrame: number;
  /** 終了フレーム(含む)。 */
  endFrame: number;
}

export function buildZoomRuntimeTrack(params: BuildZoomRuntimeTrackParams): ZoomRuntimeFrame[] {
  const { regions, cursorTelemetry, fps, stageSize, baseMask, startFrame, endFrame } = params;

  // ループの外側で1度だけ宣言する状態(OpenScreen updateAnimationState と同じ持ち越し変数)。
  let smoothedAutoFocus: ZoomFocus | null = null;
  let prevTargetProgress = 0;
  let prevAnimationTimeMs: number | null = null;
  const spring: ZoomSpringState = createZoomSpringState();

  const track: ZoomRuntimeFrame[] = [];

  for (let f = startFrame; f <= endFrame; f += 1) {
    const timeMs = (f / fps) * 1000;

    const { region, strength, blendedScale, transition } = findDominantRegion(regions, timeMs, {
      connectZooms: true,
      cursorTelemetry,
    });

    let targetScaleFactor = 1;
    let targetFocus: ZoomFocus = { ...DEFAULT_FOCUS };
    let targetProgress = 0;

    if (region && strength > 0) {
      const zoomScale = blendedScale ?? getZoomScale(region);
      const regionFocus = clampFocusToScale(region.focus, zoomScale);
      targetScaleFactor = zoomScale;
      targetFocus = regionFocus;
      targetProgress = strength;

      if (region.focusMode === "auto" && !transition) {
        const raw = targetFocus;
        const dtMs = prevAnimationTimeMs != null ? timeMs - prevAnimationTimeMs : 0;
        const isZoomingIn = targetProgress < 0.999 && targetProgress >= prevTargetProgress;
        if (targetProgress >= 0.999) {
          const prev = smoothedAutoFocus ?? raw;
          const smoothed = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
          smoothedAutoFocus = smoothed;
          targetFocus = smoothed;
        } else if (isZoomingIn) {
          // カーソル直接追従(スナップ回避)。
          smoothedAutoFocus = raw;
        } else {
          const prev = smoothedAutoFocus ?? raw;
          const smoothed = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
          smoothedAutoFocus = smoothed;
          targetFocus = smoothed;
        }
      } else if (region.focusMode !== "auto") {
        smoothedAutoFocus = null;
      }

      prevTargetProgress = targetProgress;

      if (transition) {
        // 連鎖(chain)の transform 補間。start/end 双方を progress=1 の完全ズームとして
        // computeZoomTransform に通してから scale/x/y を lerp し、focus は逆算する。
        const startTransform = computeZoomTransform({
          stageSize,
          baseMask,
          zoomScale: transition.startScale,
          zoomProgress: 1,
          focusX: transition.startFocus.cx,
          focusY: transition.startFocus.cy,
        });
        const endTransform = computeZoomTransform({
          stageSize,
          baseMask,
          zoomScale: transition.endScale,
          zoomProgress: 1,
          focusX: transition.endFocus.cx,
          focusY: transition.endFocus.cy,
        });
        const interpolatedTransform = {
          scale:
            startTransform.scale + (endTransform.scale - startTransform.scale) * transition.progress,
          x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
          y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
        };
        targetScaleFactor = interpolatedTransform.scale;
        targetFocus = computeFocusFromTransform({
          stageSize,
          baseMask,
          zoomScale: interpolatedTransform.scale,
          x: interpolatedTransform.x,
          y: interpolatedTransform.y,
        });
        targetProgress = 1;
      }
    }

    // エンベロープ(targetProgress)をここで transform に適用する。
    const projectedTransform = computeZoomTransform({
      stageSize,
      baseMask,
      zoomScale: targetScaleFactor,
      zoomProgress: targetProgress,
      focusX: targetFocus.cx,
      focusY: targetFocus.cy,
    });

    const dtMs = prevAnimationTimeMs != null ? timeMs - prevAnimationTimeMs : 0;
    let applied: ZoomTransform;
    if (prevAnimationTimeMs == null || dtMs <= 0 || dtMs > 80) {
      // 最初のフレーム・巻き戻り・大きな時間跳躍(>80ms)はスプリングをリセットして
      // projected へ直接スナップする(OpenScreen 同様)。
      resetZoomSpring(spring, projectedTransform);
      applied = { scale: projectedTransform.scale, x: projectedTransform.x, y: projectedTransform.y };
    } else {
      // spring は「エンベロープ適用後の transform」を追う(母艦 §2.1)。
      applied = stepZoomSpring(spring, projectedTransform, dtMs);
    }

    prevAnimationTimeMs = timeMs;
    track.push({ f, scale: applied.scale, x: applied.x, y: applied.y });
  }

  return track;
}
