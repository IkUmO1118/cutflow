import type { ReviewFrameRequest, ReviewRange, ReviewSpec } from "./review.ts";

export interface EditorAiReviewPlan {
  frames: ReviewFrameRequest[];
  range?: ReviewRange;
  clip?: boolean;
  observations?: {
    motion?: boolean;
    sound?: boolean;
    ocr?: boolean;
  };
  notes: string[];
}

function rangeFromReviewFrames(frames: ReviewFrameRequest[]): ReviewRange {
  const axis = frames[0]?.axis ?? "source";
  const secs = frames.filter((frame) => frame.axis === axis).map((frame) => frame.atSec);
  const start = Math.max(0, Math.min(...secs) - 2);
  const end = Math.max(start + 0.1, Math.max(...secs) + 2);
  return { axis, startSec: start, endSec: end };
}

export function reviewSpecOfProposalReview(review: EditorAiReviewPlan): ReviewSpec | null {
  if (review.frames.length === 0) return null;
  return {
    frames: review.frames,
    ...(review.range ? { range: review.range } : {}),
    ...(review.clip
      ? {
          clip: {
            range: review.range ?? rangeFromReviewFrames(review.frames),
            includeBefore: true,
            includeAfter: true,
          },
        }
      : {}),
    ...(review.observations ? { observations: { ...review.observations } } : {}),
  };
}
