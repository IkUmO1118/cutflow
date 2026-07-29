// editor/client/enginePreviewTimeline.ts — EnginePreview.tsx(M3b T2-2)が
// AudioScheduler へ渡す base timeline を RenderProps から作る純関数。
// JSX を含まない(node:test が直接 import してテストできるようにする理由)。
import type { TimelineEntry } from "../../src/lib/timeline.ts";
import type { RenderProps } from "../../src/lib/renderPropsTypes.ts";

/** AudioScheduler の base timeline は props.baseSegments(renderProps.ts が
 * 書く「カット後開始秒+videoFile内秒+尺(+速度)」の連結済み区間)から作る。
 * describeFrame も同じ baseSegments を正として映像側のソース秒を解決して
 * いるので、音声側もここから作れば両者は必ず一致する(二重に持たない)。
 * 省略時(baseSegments 無し)は describeFrame の fallback と同じ全編連続 */
export function timelineFromBaseSegments(props: RenderProps): TimelineEntry[] {
  const segs = props.baseSegments ?? [{ start: 0, videoStart: 0, durationSec: props.durationSec }];
  return segs.map((s) => {
    const speed = s.playbackRate ?? 1;
    return {
      outputStart: s.start,
      outputEnd: s.start + s.durationSec,
      sourceStart: s.videoStart,
      sourceEnd: s.videoStart + s.durationSec * speed,
      speed,
    };
  });
}

/** audioScheduler を作り直すべきかの判定材料(音に効く要素だけ)。
 * caption/overlay 等の見た目だけの変更では再構築しない(§2-4 #5) */
export function audioSignatureOf(props: RenderProps): string {
  return JSON.stringify({
    videoFile: props.videoFile,
    baseSegments: props.baseSegments ?? null,
    bgm: props.bgm,
    fps: props.fps,
  });
}
