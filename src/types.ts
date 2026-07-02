// パイプラインの中間ファイル(JSON)のスキーマ定義。
// 各ステージはここで定義した型のファイルを読み書きする。

/** ingest が生成。収録ファイルの構成情報(manifest.json) */
export interface Manifest {
  /** 収録フォルダの絶対パス */
  dir: string;
  /** 元ファイル名(収録フォルダ内) */
  source: string;
  durationSec: number;
  video: {
    width: number;
    height: number;
    fps: number;
    /** 3840x1080 内での画面キャプチャ領域 */
    screenRegion: Region;
    /** 3840x1080 内でのカメラ領域 */
    cameraRegion: Region;
  };
  audio: {
    /** マイク音声のストリーム番号(ffmpeg の a:N) */
    micStream: number;
    /** システム音声のストリーム番号。存在しない場合は null */
    systemStream: number | null;
    /** 抽出済みマイク音声(16kHz mono wav、収録フォルダからの相対パス) */
    micWav: string;
  };
  createdAt: string;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** transcribe が生成(transcript.json) */
export interface Transcript {
  language: string;
  model: string;
  segments: TranscriptSegment[];
}

export interface TranscriptSegment {
  /** 秒 */
  start: number;
  end: number;
  text: string;
}

/** detect が生成(cuts.auto.json)。機械的に検出したカット候補 */
export interface AutoCuts {
  /** 検出パラメータ(再現性のため記録) */
  params: { silenceDb: number; minSilenceSec: number; padSec: number };
  /** 無音区間(この区間がカット候補) */
  silences: Interval[];
  /** 残す区間(無音の補集合+前後パディング) */
  keepSegments: Interval[];
  /** 残す区間の合計秒数 */
  keptDurationSec: number;
  originalDurationSec: number;
}

export interface Interval {
  start: number;
  end: number;
}

/** plan が生成、人間が編集して承認する(cutplan.json) */
export interface CutPlan {
  approved: boolean;
  /** 残す区間のリスト(時系列順)。reason は人間が確認するための説明 */
  segments: PlanSegment[];
}

export interface PlanSegment {
  start: number;
  end: number;
  /** keep: 残す / cut: 切る(確認用に候補も残しておく) */
  action: "keep" | "cut";
  reason: string;
}

/** plan が生成(chapters.json)。YouTube チャプター用の章立て */
export interface Chapters {
  chapters: { start: number; title: string }[];
}

/** plan が生成(meta.json)。タイトル案と概要欄の下書き */
export interface Meta {
  titles: string[];
  description: string;
}
