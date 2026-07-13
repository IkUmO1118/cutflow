import { useEffect, useMemo, useRef, useState } from "react";
import type { Hunk } from "../../src/lib/docDiff.ts";
import type { ReviewEvent, ReviewEventTimeRange } from "../../src/lib/reviewEvents.ts";
import { reviewEventStatus } from "../../src/lib/reviewEvents.ts";
import type { ReviewBundle, ReviewStill } from "../../src/stages/review.ts";
import type { AiRefineMode } from "./apiTypes.ts";
import { selectPreviewMedia, type PreviewMode } from "./aiVisualReviewMedia.ts";

type Side = "theirs" | "mine";

export interface AiVisualReviewProps {
  proposalId: string;
  title: string;
  description: string;
  events: ReviewEvent[];
  hunks: Hunk[];
  resolution: Map<Hunk, Side>;
  reviewBundle?: ReviewBundle;
  reviewStale?: boolean;
  frameChecks: string[];
  globalWarnings: { label: string; tone?: "warn" | "muted"; items: string[] }[];
  warningSummary: { total: number; groups: { label: string; count: number }[] };
  checkingFrames: boolean;
  refining: boolean;
  refiningMode?: AiRefineMode;
  onSetHunks: (hunks: Hunk[], side: Side) => void;
  onBulk: (side: Side) => void;
  onGenerateReview: (options: { withVlm: boolean }) => void;
  onRefine: (options: { withVlm: boolean; instruction?: string }) => void;
  onFixWarnings?: (options: { withVlm: boolean }) => void;
  onApply: () => void;
  onCancel: () => void;
}

export const AiVisualReview = ({
  proposalId,
  title,
  description,
  events,
  hunks,
  resolution,
  reviewBundle,
  reviewStale = false,
  frameChecks,
  globalWarnings,
  warningSummary,
  checkingFrames,
  refining,
  refiningMode = "normal",
  onSetHunks,
  onBulk,
  onGenerateReview,
  onRefine,
  onFixWarnings,
  onApply,
  onCancel,
}: AiVisualReviewProps) => {
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");
  const [visitedEventIds, setVisitedEventIds] = useState<Set<string>>(() => new Set());
  const [previewMode, setPreviewMode] = useState<PreviewMode>("after");
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [showAllJsonDiffs, setShowAllJsonDiffs] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [descExpanded, setDescExpanded] = useState(false);
  const beforeVideoRef = useRef<HTMLVideoElement | null>(null);
  const afterVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (events.length === 0) {
      setSelectedEventId("");
      return;
    }
    if (!events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  useEffect(() => {
    setRefineOpen(false);
    setRefineInstruction("");
  }, [proposalId]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? events[0],
    [events, selectedEventId],
  );
  const selectedHunks = useMemo(
    () => (selectedEvent ? hunksOfEvent(selectedEvent, hunks) : []),
    [selectedEvent, hunks],
  );
  const displayedHunks = showAllJsonDiffs ? hunks : selectedHunks;
  const selectedStill = useMemo(
    () => (selectedEvent ? selectStillForEvent(selectedEvent, reviewBundle) : null),
    [selectedEvent, reviewBundle],
  );
  const previewMedia = useMemo(
    () => selectPreviewMedia(previewMode, selectedStill, reviewBundle?.clips),
    [previewMode, selectedStill, reviewBundle],
  );
  const videoSeekTarget = useMemo(
    () => clipSeekTarget(selectedStill, reviewBundle),
    [selectedStill, reviewBundle],
  );
  const timelineRange = useMemo(() => timelineRangeOf(events), [events]);
  const actionsDisabled = refining;
  // 候補が1件だけのとき(=一発編集の常態)は左リストが右インスペクタの
  // 複製になるので畳み、2カラムにする。バルク採否も複数候補のときだけ出す。
  const showEventList = events.length >= 2;
  const selectedStatus = useMemo(
    () => (selectedEvent ? reviewEventStatus({ event: selectedEvent, hunks, resolution }) : "unreviewed"),
    [selectedEvent, hunks, resolution],
  );
  const descIsLong = description.length > 90;

  const syncAfterToBefore = (force = false) => {
    const before = beforeVideoRef.current;
    const after = afterVideoRef.current;
    if (!before || !after) return;
    if (!force && Math.abs(after.currentTime - before.currentTime) <= 0.12) return;
    try {
      after.currentTime = before.currentTime;
    } catch {
      // metadata load race is harmless; next sync event will catch up
    }
  };

  const seekPreviewVideos = () => {
    seekVideo(beforeVideoRef.current, videoSeekTarget.beforeSec);
    seekVideo(afterVideoRef.current, videoSeekTarget.afterSec);
  };

  useEffect(() => {
    const before = beforeVideoRef.current;
    const after = afterVideoRef.current;
    before?.pause();
    after?.pause();
    seekPreviewVideos();
  }, [previewMedia, selectedEvent?.id, videoSeekTarget.beforeSec, videoSeekTarget.afterSec]);

  useEffect(() => {
    seekPreviewVideos();
  }, [previewMode]);

  const markVisited = (eventId: string) => {
    setVisitedEventIds((prev) => {
      const next = new Set(prev);
      next.add(eventId);
      return next;
    });
  };

  const chooseEvent = (event: ReviewEvent) => {
    if (actionsDisabled) return;
    setSelectedEventId(event.id);
    markVisited(event.id);
  };

  const setSelectedSide = (side: Side) => {
    if (!selectedEvent || actionsDisabled) return;
    markVisited(selectedEvent.id);
    onSetHunks(selectedHunks, side);
  };

  return (
    <>
      <div className="diffBackdrop" />
      <section className="aiReviewModal" role="dialog" aria-label="AI 一発編集レビュー">
        <div className="aiReviewHead">
          <div className="aiReviewHeadCopy">
            <div className="diffCount">{events.length} 件の変更候補</div>
            <h3>{title}</h3>
            {description && (
              <p className={descIsLong && !descExpanded ? "clamp" : ""}>{description}</p>
            )}
            {descIsLong && (
              <button className="aiReviewDescToggle" onClick={() => setDescExpanded((prev) => !prev)}>
                {descExpanded ? "たたむ" : "続きを読む"}
              </button>
            )}
          </div>
          <div className="aiReviewHeadActions">
            <button disabled={actionsDisabled} onClick={() => onGenerateReview({ withVlm: false })}>比較を更新</button>
            {showEventList && (
              <div className="aiReviewBulkActions" role="group" aria-label="一括採否">
                <button disabled={actionsDisabled} onClick={() => onBulk("mine")}>すべて使わない</button>
                <button disabled={actionsDisabled} onClick={() => onBulk("theirs")}>すべて使う</button>
              </div>
            )}
          </div>
        </div>
        {warningSummary.total > 0 && (
          <div className="aiReviewWarningSummary">
            <div className="aiReviewWarningSummaryCopy">
              <strong>要確認 {warningSummary.total}件</strong>
              <span>{warningSummary.groups.map((group) => `${group.label} ${group.count}`).join(" / ")}</span>
            </div>
            {onFixWarnings && (
              <button disabled={actionsDisabled} onClick={() => onFixWarnings({ withVlm: false })}>
                警告をAIで修正
              </button>
            )}
          </div>
        )}

        <div className={showEventList ? "aiReviewGrid" : "aiReviewGrid noList"}>
          {showEventList && (
          <aside className="aiReviewEventList">
            {events.map((event) => {
              const visited = visitedEventIds.has(event.id);
              const status = reviewEventStatus({ event, hunks, resolution });
              return (
                <button
                  key={event.id}
                  className={event.id === selectedEvent?.id ? "aiReviewEventCard on" : "aiReviewEventCard"}
                  disabled={actionsDisabled}
                  onClick={() => chooseEvent(event)}
                >
                  <div className="aiReviewEventTop">
                    <span className={`aiReviewBadge ${statusClassName(status, visited)}`}>
                      {statusLabel(status, visited)}
                    </span>
                    {event.timeRange && <time>{formatTimeRange(event.timeRange)}</time>}
                  </div>
                  <strong>{event.title}</strong>
                  <span>{event.subtitle}</span>
                  {event.warnings.length > 0 && (
                    <div className="aiReviewEventWarnings">注意 {event.warnings.length}件</div>
                  )}
                </button>
              );
            })}
          </aside>
          )}

          <main className="aiReviewPreview">
            <div className="aiReviewPreviewCard">
              <div className="aiReviewPreviewTop">
                <div className="aiReviewPreviewLabel">プレビュー</div>
                <div className="aiReviewModeSwitch" role="group" aria-label="比較表示">
                  <button
                    disabled={actionsDisabled}
                    className={previewMode === "after" ? "on" : ""}
                    aria-pressed={previewMode === "after"}
                    onClick={() => setPreviewMode("after")}
                  >
                    編集後
                  </button>
                  <button
                    disabled={actionsDisabled}
                    className={previewMode === "before" ? "on" : ""}
                    aria-pressed={previewMode === "before"}
                    onClick={() => setPreviewMode("before")}
                  >
                    編集前
                  </button>
                  <button
                    disabled={actionsDisabled}
                    className={previewMode === "side-by-side" ? "on" : ""}
                    aria-pressed={previewMode === "side-by-side"}
                    onClick={() => setPreviewMode("side-by-side")}
                  >
                    左右で比較
                  </button>
                  <button
                    disabled={actionsDisabled}
                    className={previewMode === "overlay" ? "on" : ""}
                    aria-pressed={previewMode === "overlay"}
                    onClick={() => setPreviewMode("overlay")}
                  >
                    重ねて比較
                  </button>
                </div>
              </div>

              {previewMedia ? (
                <>
                  {previewMedia.kind === "video-single" && (
                    <div className="aiReviewStillStage mode-video-single">
                      <figure className="aiReviewStillPane">
                        <video
                          ref={previewMedia.side === "before" ? beforeVideoRef : afterVideoRef}
                          src={mediaUrl(previewMedia.file)}
                          controls
                          playsInline
                          preload="metadata"
                          className="aiReviewVideo"
                          aria-label={previewMedia.side === "before" ? "before clip" : "after clip"}
                          onLoadedMetadata={() => seekPreviewVideos()}
                        />
                        <figcaption>{previewMedia.side === "before" ? "編集前" : "編集後"}</figcaption>
                      </figure>
                    </div>
                  )}
                  {previewMedia.kind === "video-pair" && (
                    <div className="aiReviewStillStage mode-side-by-side">
                      <figure className="aiReviewStillPane before">
                        <video
                          ref={beforeVideoRef}
                          src={mediaUrl(previewMedia.beforeFile)}
                          controls
                          playsInline
                          preload="metadata"
                          className="aiReviewVideo"
                          aria-label="before clip"
                          onLoadedMetadata={() => seekPreviewVideos()}
                          onPlay={() => {
                            const play = afterVideoRef.current?.play();
                            void play?.catch(() => {});
                          }}
                          onPause={() => afterVideoRef.current?.pause()}
                          onSeeked={() => syncAfterToBefore(true)}
                          onTimeUpdate={() => syncAfterToBefore(false)}
                        />
                        <figcaption>編集前</figcaption>
                      </figure>
                      <figure className="aiReviewStillPane after">
                        <video
                          ref={afterVideoRef}
                          src={mediaUrl(previewMedia.afterFile)}
                          playsInline
                          preload="metadata"
                          muted
                          className="aiReviewVideo"
                          aria-label="after clip"
                          onLoadedMetadata={() => seekPreviewVideos()}
                        />
                        <figcaption>編集後</figcaption>
                      </figure>
                    </div>
                  )}
                  {previewMedia.kind === "still" && (
                    <>
                      <div className={`aiReviewStillStage mode-${previewMode}`}>
                        {(previewMode === "before" || previewMode === "side-by-side" || previewMode === "overlay") && (
                          <figure className={`aiReviewStillPane before ${previewMode === "overlay" ? "overlayBase" : ""}`}>
                            <img src={mediaUrl(previewMedia.still.before.file)} alt="編集前" />
                            <figcaption>編集前</figcaption>
                          </figure>
                        )}
                        {(previewMode === "after" || previewMode === "side-by-side" || previewMode === "overlay") && (
                          <figure
                            className={`aiReviewStillPane after ${previewMode === "overlay" ? "overlayTop" : ""}`}
                            style={previewMode === "overlay" ? { opacity: overlayOpacity } : undefined}
                          >
                            <img src={mediaUrl(previewMedia.still.after.file)} alt="編集後" />
                            <figcaption>編集後</figcaption>
                          </figure>
                        )}
                      </div>
                      {previewMode === "overlay" && (
                        <label className="aiReviewOverlayControl">
                          Afterの重ね具合
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={overlayOpacity}
                            onChange={(event) => setOverlayOpacity(Number(event.target.value))}
                          />
                          <span>{Math.round(overlayOpacity * 100)}%</span>
                        </label>
                      )}
                    </>
                  )}
                  {selectedStill && (
                    <div className="aiReviewStillMeta">
                      <span>{selectedStill.requested.reason}</span>
                      <span>{formatFrameRequest(selectedStill)}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="aiReviewPreviewPlaceholder">
                  <strong>比較画像がまだありません</strong>
                  <span>deterministic review を生成すると before / after 比較を表示します。</span>
                </div>
              )}

              {showEventList && timelineRange && (
                <div className="aiReviewMiniTimeline" aria-label="変更タイムライン">
                  {events.flatMap((event) => {
                    if (!event.timeRange) return [];
                    const left = ((event.timeRange.startSec - timelineRange.startSec) / timelineRange.durationSec) * 100;
                    const width = (Math.max(event.timeRange.endSec - event.timeRange.startSec, 0.05) / timelineRange.durationSec) * 100;
                    return [(
                      <button
                        key={event.id}
                        className={[
                          "aiReviewTimelineMarker",
                          event.id === selectedEvent?.id ? "on" : "",
                          event.warnings.length > 0 ? "warn" : "",
                        ].filter(Boolean).join(" ")}
                        disabled={actionsDisabled}
                        style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
                        onClick={() => chooseEvent(event)}
                        title={`${event.title} ${formatTimeRange(event.timeRange)}`}
                      />
                    )];
                  })}
                </div>
              )}

              {reviewStale && (
                <div className="reviewStale">比較は現在の採否と一致しません</div>
              )}
              {reviewBundle && (
                <div className="aiReviewMeta">
                  <span>stills {reviewBundle.stills.length} 枚</span>
                  <span>checks {reviewBundle.observation.checks.length} 件</span>
                  {reviewBundle.secondaryObservation && <span>VLM あり</span>}
                </div>
              )}
              {frameChecks.length > 0 && (
                <div className="aiReviewFrameChecks">
                  確認推奨: {frameChecks.join(", ")}
                </div>
              )}
              {globalWarnings.length > 0 && (
                <div className="aiReviewWarnings">
                  {globalWarnings.map((group) => (
                    <details key={group.label} className={`aiReviewWarningGroup tone-${group.tone ?? "warn"}`}>
                      <summary>
                        <span className="aiReviewWarningGroupTitle">{group.label} {group.items.length}件</span>
                        <span className="aiReviewWarningGroupPreview">{summarizeWarning(group.items[0] ?? "")}</span>
                      </summary>
                      <ul>
                        {group.items.map((item, index) => (
                          <li key={`${group.label}:${index}`}>{item}</li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              )}
              {(checkingFrames || refining) && (
                <div className="aiReviewPending">
                  {checkingFrames
                    ? "比較を生成中…"
                    : refining
                      ? refiningMode === "warning-fix"
                        ? "AI が検証警告を修正中..."
                        : "AI が再調整中…"
                      : ""}
                </div>
              )}
            </div>
          </main>

          <aside className="aiReviewInspector">
            {selectedEvent ? (
              <>
                <div className="aiReviewInspectorHead">
                  <h4>{selectedEvent.title}</h4>
                  <div className="aiReviewInspectorSub">{selectedEvent.subtitle}</div>
                </div>

                {selectedEvent.warnings.length > 0 && (
                  <section className="aiReviewInspectorSection">
                    <h5>注意</h5>
                    <ul>
                      {selectedEvent.warnings.map((warning, index) => (
                        <li key={`warning:${index}`}>{warning}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="aiReviewInspectorSection">
                  <h5>確認ポイント</h5>
                  <ul>
                    {selectedEvent.checkPoints.map((point, index) => (
                      <li key={`check:${index}`}>{point}</li>
                    ))}
                  </ul>
                </section>

                {selectedEvent.reviewFrameReasons.length > 0 && (
                  <section className="aiReviewInspectorSection">
                    <h5>関連 frame 理由</h5>
                    <ul>
                      {selectedEvent.reviewFrameReasons.map((reason, index) => (
                        <li key={`frame:${index}`}>{reason}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <div className="aiReviewDecision" role="group" aria-label="この変更の採否">
                  <span className="aiReviewDecisionLabel">この変更を</span>
                  <div className="aiReviewDecisionToggle">
                    <button
                      disabled={actionsDisabled}
                      className={selectedStatus === "skip" ? "on skip" : ""}
                      aria-pressed={selectedStatus === "skip"}
                      onClick={() => setSelectedSide("mine")}
                    >
                      使わない
                    </button>
                    <button
                      disabled={actionsDisabled}
                      className={selectedStatus === "use" ? "on use" : ""}
                      aria-pressed={selectedStatus === "use"}
                      onClick={() => setSelectedSide("theirs")}
                    >
                      使う
                    </button>
                  </div>
                </div>

                <section className="aiReviewInspectorSection">
                  <h5>この変更をAIに直させる</h5>
                  <p>
                    この変更をもう一度見直します。代表フレーム最大4枚を vision provider に送れます。
                    結果は自動採用されず、新しい提案としてもう一度レビューします。
                  </p>
                  {!refineOpen ? (
                    <button disabled={actionsDisabled} onClick={() => setRefineOpen(true)}>直し方を指示する</button>
                  ) : (
                    <div className="aiReviewRefinePanel">
                      <textarea
                        rows={4}
                        placeholder="追加指示"
                        value={refineInstruction}
                        disabled={actionsDisabled}
                        onChange={(event) => setRefineInstruction(event.target.value)}
                      />
                      <div className="aiReviewInspectorActions">
                        <button
                          disabled={actionsDisabled}
                          onClick={() => onRefine({ withVlm: false, instruction: refineInstruction })}
                        >
                          画像を見せずに再提案
                        </button>
                        <button
                          disabled={actionsDisabled}
                          onClick={() => onRefine({ withVlm: true, instruction: refineInstruction })}
                        >
                          画像を見せて再提案
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <details className="aiReviewJsonDetails">
                  <summary>詳細: JSON diff</summary>
                  <label className="aiReviewJsonToggle">
                    <input
                      type="checkbox"
                      checked={showAllJsonDiffs}
                      disabled={actionsDisabled}
                      onChange={(event) => setShowAllJsonDiffs(event.target.checked)}
                    />
                    すべての JSON diff を表示
                  </label>
                  <div className="aiReviewJsonList">
                    {displayedHunks.map((hunk, index) => (
                      <article key={`${hunk.address.label}:${index}`} className="aiReviewJsonCard">
                        <code>{hunk.address.label}</code>
                        <div className="aiReviewJsonPair">
                          <section>
                            <h6>現在値</h6>
                            <pre>{formatValue(hunk.mine)}</pre>
                          </section>
                          <section>
                            <h6>AI 提案</h6>
                            <pre>{formatValue(hunk.theirs)}</pre>
                          </section>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              </>
            ) : (
              <div className="aiReviewEmpty">変更候補がありません。</div>
            )}
          </aside>
        </div>

        <div className="aiReviewFoot">
          <button disabled={actionsDisabled} onClick={onCancel}>キャンセル</button>
          <div className="spacer" />
          <button disabled={actionsDisabled} className="primary" onClick={onApply}>この内容で確定</button>
        </div>
      </section>
    </>
  );
};

function summarizeWarning(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 88) return compact;
  return `${compact.slice(0, 85)}...`;
}

function hunksOfEvent(event: ReviewEvent, hunks: Hunk[]): Hunk[] {
  return event.hunkIndexes.map((index) => hunks[index]).filter((hunk): hunk is Hunk => Boolean(hunk));
}

function statusClassName(status: ReturnType<typeof reviewEventStatus>, visited: boolean): string {
  if (status === "unreviewed") return visited ? "mixed" : "pending";
  if (status === "use" && !visited) return "pending";
  return status;
}

function statusLabel(status: ReturnType<typeof reviewEventStatus>, visited: boolean): string {
  if (status === "unreviewed") return visited ? "未確定" : "未確認";
  if (status === "use" && !visited) return "未確認";
  if (status === "use") return "使う";
  if (status === "skip") return "使わない";
  return "一部採用";
}

function formatTimeRange(range: ReviewEventTimeRange): string {
  return `${range.axis === "source" ? "source" : "output"} ${formatSec(range.startSec)}-${formatSec(range.endSec)}`;
}

function formatFrameRequest(still: ReviewStill): string {
  return `${still.requested.axis} ${formatSec(still.requested.atSec)}`;
}

function formatSec(value: number): string {
  return `${Math.round(value * 100) / 100}s`;
}

function mediaUrl(file: string): string {
  return `/media/${encodeURIComponent(file).replace(/%2F/g, "/")}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(なし)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function selectStillForEvent(event: ReviewEvent, bundle?: ReviewBundle): ReviewStill | null {
  if (!bundle || bundle.stills.length === 0) return null;
  if (!event.timeRange) return matchByReason(event, bundle.stills) ?? bundle.stills[0];
  const inRange = bundle.stills.filter((still) =>
    still.requested.axis === event.timeRange?.axis &&
    still.requested.atSec >= event.timeRange.startSec &&
    still.requested.atSec <= event.timeRange.endSec
  );
  if (inRange.length > 0) return nearestStill(inRange, centerOf(event.timeRange));
  return nearestStill(bundle.stills.filter((still) => still.requested.axis === event.timeRange?.axis), centerOf(event.timeRange))
    ?? matchByReason(event, bundle.stills)
    ?? bundle.stills[0];
}

function matchByReason(event: ReviewEvent, stills: ReviewStill[]): ReviewStill | null {
  for (const reason of event.reviewFrameReasons) {
    const match = stills.find((still) => still.requested.reason === reason);
    if (match) return match;
  }
  return null;
}

function nearestStill(stills: ReviewStill[], atSec: number): ReviewStill | null {
  if (stills.length === 0) return null;
  let best = stills[0];
  let bestDistance = Math.abs(best.requested.atSec - atSec);
  for (const still of stills.slice(1)) {
    const distance = Math.abs(still.requested.atSec - atSec);
    if (distance < bestDistance) {
      best = still;
      bestDistance = distance;
    }
  }
  return best;
}

function centerOf(range: ReviewEventTimeRange): number {
  return (range.startSec + range.endSec) / 2;
}

function seekVideo(video: HTMLVideoElement | null, sec: number | null): void {
  if (!video || sec === null || !Number.isFinite(sec)) return;
  const max = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, video.duration - 0.05)
    : sec;
  const next = Math.max(0, Math.min(sec, max));
  if (Math.abs(video.currentTime - next) <= 0.08) return;
  try {
    video.currentTime = next;
  } catch {
    // Metadata can still be loading; onLoadedMetadata will retry.
  }
}

function clipSeekTarget(
  still: ReviewStill | null,
  bundle?: ReviewBundle,
): { beforeSec: number | null; afterSec: number | null } {
  if (!still || !bundle) return { beforeSec: null, afterSec: null };
  return {
    beforeSec: outputOffset(still.before.outSec, bundle.range.beforeOutput?.startSec),
    afterSec: outputOffset(still.after.outSec, bundle.range.afterOutput?.startSec),
  };
}

function outputOffset(outSec: number | null, clipStartSec: number | undefined): number | null {
  if (outSec === null || clipStartSec === undefined) return null;
  return Math.max(0, outSec - clipStartSec);
}

function timelineRangeOf(events: ReviewEvent[]): { startSec: number; durationSec: number } | null {
  const timed = events.filter((event): event is ReviewEvent & { timeRange: ReviewEventTimeRange } => Boolean(event.timeRange));
  if (timed.length === 0) return null;
  const startSec = Math.min(...timed.map((event) => event.timeRange.startSec));
  const endSec = Math.max(...timed.map((event) => event.timeRange.endSec));
  return { startSec, durationSec: Math.max(endSec - startSec, 1) };
}
