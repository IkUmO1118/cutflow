// render.props.json のスキーマ定義。
// src/stages/render.ts が生成し、Remotion コンポジション(Main.tsx)が受け取る。
// 時刻はすべて「カット済み動画(cut.mp4)のタイムライン」の秒。

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
}

export interface ChapterCard {
  start: number;
  title: string;
}

export interface RenderProps {
  /** publicDir(収録フォルダ)内のカット済み動画ファイル名。
   * 空文字列なら動画なしのプレースホルダー表示(Remotion Studio 用) */
  videoFile: string;
  /** BGM。収録フォルダに bgm.* が無ければ null */
  bgm: { file: string; volumeDb: number; fadeOutSec: number } | null;
  durationSec: number;
  fps: number;
  /** 出力解像度(通常は screenRegion と同じ 1920x1080) */
  width: number;
  height: number;
  /** カット済み動画の寸法(拡張キャンバスのまま。例: 3840x1080) */
  canvas: { w: number; h: number };
  screenRegion: Region;
  cameraRegion: Region;
  wipe: { widthPx: number; marginPx: number };
  caption: { fontSizePx: number };
  /** 章カードを表示する秒数 */
  chapterCardSec: number;
  captions: Caption[];
  chapters: ChapterCard[];
}

/** Remotion Studio でプレビューする時のダミー値。実レンダーでは --props で上書きされる。
 * videoFile が空なのは、リポジトリ直下で Studio を開くと cut.mp4 が存在せず
 * 再生エラーになるため(実データで見る方法は docs/usage.md 参照) */
export const defaultProps: RenderProps = {
  videoFile: "",
  bgm: null,
  durationSec: 10,
  fps: 30,
  width: 1920,
  height: 1080,
  canvas: { w: 3840, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  wipe: { widthPx: 480, marginPx: 32 },
  caption: { fontSizePx: 44 },
  chapterCardSec: 3,
  captions: [],
  chapters: [],
};
