import type { EditSnapshot } from "./review.ts";
import type { Problem } from "../stages/validate.ts";
import type { RenderProps } from "../../remotion/props.ts";

export interface SideObservation {
  durationSec: number;
  keepCount: number;
  cutCount: number;
  captionCount: number;
  visibleCaptionTexts: string[];
  motion?: {
    sceneChanges: number;
    frozenSec: number;
    meanSceneScore: number;
  };
  sound?: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    silenceSec: number;
    clippingSamples: number;
  };
  ocr?: {
    lines: string[];
  };
}

export interface DeterministicReviewObservation {
  before: SideObservation;
  after: SideObservation;
  delta: {
    durationSec: number;
    keepCount: number;
    cutCount: number;
    captionCount: number;
    silenceSec?: number;
    truePeakDbtp?: number;
  };
  checks: ReviewCheck[];
}

export interface ReviewCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  source: "structure" | "motion" | "sound" | "ocr";
}

export function structureObservationOf(snapshot: EditSnapshot, props: RenderProps): SideObservation {
  const keeps = snapshot.cutplan.segments.filter((segment) => segment.action === "keep");
  const cuts = snapshot.cutplan.segments.filter((segment) => segment.action === "cut");
  return {
    durationSec: round2(props.durationSec),
    keepCount: keeps.length,
    cutCount: cuts.length,
    captionCount: props.captions.length,
    visibleCaptionTexts: props.captions.map((caption) => caption.text),
  };
}

export function buildDeterministicObservation(args: {
  before: SideObservation;
  after: SideObservation;
  validateErrors: Problem[];
  unresolvedAfterFrames: number;
  requestedOcr: boolean;
  ocrSupported: boolean;
}): DeterministicReviewObservation {
  const { before, after } = args;
  const checks: ReviewCheck[] = [];
  if (args.validateErrors.length > 0) {
    checks.push({
      id: "candidate-invalid",
      status: "fail",
      message: `candidate に validate error が ${args.validateErrors.length} 件あります`,
      source: "structure",
    });
  } else {
    checks.push({
      id: "candidate-valid",
      status: "pass",
      message: "candidate は validate を通過しました",
      source: "structure",
    });
  }
  checks.push(
    after.durationSec > 0
      ? {
          id: "after-duration",
          status: "pass",
          message: `after の出力尺は ${after.durationSec.toFixed(2)} 秒です`,
          source: "structure",
        }
      : {
          id: "after-duration",
          status: "fail",
          message: "candidate の出力尺が 0 秒です",
          source: "structure",
        },
  );
  checks.push(
    args.unresolvedAfterFrames === 0
      ? {
          id: "after-frame-mapping",
          status: "pass",
          message: "after の still 要求は全て解決できました",
          source: "structure",
        }
      : {
          id: "after-frame-mapping",
          status: "fail",
          message: `after で解決できない still が ${args.unresolvedAfterFrames} 件あります`,
          source: "structure",
        },
  );
  if (after.sound) {
    if (after.sound.truePeakDbtp !== null && after.sound.truePeakDbtp > 0) {
      checks.push({
        id: "after-true-peak",
        status: "fail",
        message: `after の true peak が 0 dBTP を超えています (${after.sound.truePeakDbtp.toFixed(2)} dBTP)`,
        source: "sound",
      });
    } else {
      checks.push({
        id: "after-true-peak",
        status: "pass",
        message: "after の true peak は 0 dBTP 以下です",
        source: "sound",
      });
    }
    checks.push(
      after.sound.clippingSamples > 0
        ? {
            id: "after-clipping",
            status: "fail",
            message: `after に clipping sample が ${after.sound.clippingSamples} 件あります`,
            source: "sound",
          }
        : {
            id: "after-clipping",
            status: "pass",
            message: "after に clipping sample はありません",
            source: "sound",
          },
    );
    if (before.sound) {
      const silenceDelta = round2(after.sound.silenceSec - before.sound.silenceSec);
      if (silenceDelta >= 1) {
        checks.push({
          id: "silence-increase",
          status: "warn",
          message: `after の無音が ${silenceDelta.toFixed(2)} 秒増えています`,
          source: "sound",
        });
      }
    }
  }
  if (before.motion && after.motion) {
    const newFrozenSec = round2(after.motion.frozenSec - before.motion.frozenSec);
    checks.push(
      newFrozenSec >= 2
        ? {
            id: "freeze-increase",
            status: "warn",
            message: `after の freeze が ${newFrozenSec.toFixed(2)} 秒増えています`,
            source: "motion",
          }
        : {
            id: "freeze-increase",
            status: "pass",
            message: "freeze 増加は閾値未満です",
            source: "motion",
          },
    );
  }
  if (args.requestedOcr) {
    if (!args.ocrSupported) {
      checks.push({
        id: "ocr-supported",
        status: "skip",
        message: "OCR は非対応環境のためスキップしました",
        source: "ocr",
      });
    } else if ((after.ocr?.lines.length ?? 0) === 0) {
      checks.push({
        id: "ocr-after-empty",
        status: "warn",
        message: "after OCR が空でした",
        source: "ocr",
      });
    } else {
      checks.push({
        id: "ocr-after-empty",
        status: "pass",
        message: "after OCR は空ではありません",
        source: "ocr",
      });
    }
  }
  return {
    before,
    after,
    delta: {
      durationSec: round2(after.durationSec - before.durationSec),
      keepCount: after.keepCount - before.keepCount,
      cutCount: after.cutCount - before.cutCount,
      captionCount: after.captionCount - before.captionCount,
      ...(before.sound && after.sound
        ? { silenceSec: round2(after.sound.silenceSec - before.sound.silenceSec) }
        : {}),
      ...(before.sound && after.sound && after.sound.truePeakDbtp !== null && before.sound.truePeakDbtp !== null
        ? { truePeakDbtp: round2(after.sound.truePeakDbtp - before.sound.truePeakDbtp) }
        : {}),
    },
    checks,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
