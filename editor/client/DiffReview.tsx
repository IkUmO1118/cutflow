import type { Hunk } from "../../src/lib/docDiff.ts";
import type { ReviewBundle } from "../../src/stages/review.ts";
import type { ReactNode } from "react";

type Side = "theirs" | "mine";
export interface DiffWarningGroup {
  label: string;
  items: string[];
}

export interface DiffAction {
  label: string;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  onClick: () => void;
}

export const DiffReview = ({
  kind = "external-conflict",
  title,
  description,
  countLabel,
  hunks,
  resolution,
  onSet,
  onBulk,
  onApply,
  onCancel,
  warnings = [],
  warningGroups,
  frameChecks = [],
  reviewBundle,
  reviewStale = false,
  extraControls,
  onCheckFrames,
  checkingFrames = false,
  checkFramesLabel = "フレーム確認",
  actions,
}: {
  kind?: "external-conflict" | "ai-proposal";
  title?: string;
  description?: string;
  countLabel?: string;
  hunks: Hunk[];
  resolution: Map<Hunk, Side>;
  onSet: (hunk: Hunk, side: Side) => void;
  onBulk: (side: Side) => void;
  onApply: () => void;
  onCancel: () => void;
  warnings?: string[];
  warningGroups?: DiffWarningGroup[];
  frameChecks?: string[];
  reviewBundle?: ReviewBundle;
  reviewStale?: boolean;
  extraControls?: ReactNode;
  onCheckFrames?: () => void;
  checkingFrames?: boolean;
  checkFramesLabel?: string;
  actions?: DiffAction[];
}) => {
  const groups = warningGroups ?? (warnings.length > 0 ? [{ label: "確認事項", items: warnings }] : []);
  return (
    <>
      <div className="diffBackdrop" />
      <section
        className="diffModal"
        role="dialog"
        aria-label={kind === "ai-proposal" ? "AI 提案の差分レビュー" : "外部変更の差分レビュー"}
      >
        <div className="diffHead">
          <div>
            <div className="diffCount">{countLabel ?? defaultCountLabel(kind, hunks.length)}</div>
            <h3>{title ?? (kind === "ai-proposal" ? "AI 提案を確認" : "外部変更と競合しています")}</h3>
            <p>
              {description ??
                (kind === "ai-proposal"
                  ? "採用する変更だけを選んでください。適用後は未保存編集として画面に反映されます。"
                  : "エディタの未保存編集と、ディスク上の変更が同じ場所を変えました。残す内容を選んでください。")}
            </p>
            {groups.length > 0 && (
              <div className="diffWarnings">
                {groups.map((group) => (
                  <section className="diffWarningGroup" key={group.label}>
                    <h4>{group.label}</h4>
                    <ul>
                      {group.items.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {frameChecks.length > 0 && (
              <div className="diffFrameChecks">
                <span>確認推奨: {frameChecks.join(", ")}</span>
                {onCheckFrames && (
                  <button onClick={onCheckFrames} disabled={checkingFrames}>
                    {checkingFrames ? "生成中…" : checkFramesLabel}
                  </button>
                )}
              </div>
            )}
            {reviewBundle && (
              <div className="reviewBundle">
                {reviewStale && (
                  <div className="reviewStale">比較は現在の採否と一致しません</div>
                )}
                <section className="reviewChecks">
                  <h4>deterministic checks</h4>
                  <ul>
                    {reviewBundle.observation.checks.map((check) => (
                      <li key={check.id} className={`status-${check.status}`}>
                        [{check.status}] {check.message}
                      </li>
                    ))}
                  </ul>
                </section>
                {reviewBundle.stills.length > 0 && (
                  <section className="reviewStills">
                    <h4>before / after</h4>
                    <div className="reviewStillGrid">
                      {reviewBundle.stills.map((still, index) => (
                        <article key={`${still.requested.reason}:${index}`} className="reviewStillCard">
                          <div className="reviewStillMeta">
                            {still.requested.reason} / {still.requested.axis} {still.requested.atSec.toFixed(2)}s
                          </div>
                          <div className="reviewStillPair">
                            <figure>
                              <img src={`/media/${encodeURIComponent(still.before.file).replace(/%2F/g, "/")}`} alt="before" />
                              <figcaption>before</figcaption>
                            </figure>
                            <figure>
                              <img src={`/media/${encodeURIComponent(still.after.file).replace(/%2F/g, "/")}`} alt="after" />
                              <figcaption>after</figcaption>
                            </figure>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {(reviewBundle.clips?.beforeFile || reviewBundle.clips?.afterFile) && (
                  <section className="reviewClips">
                    <h4>比較動画</h4>
                    <div className="reviewClipPair">
                      {reviewBundle.clips?.beforeFile && (
                        <figure>
                          <video src={`/media/${encodeURIComponent(reviewBundle.clips.beforeFile).replace(/%2F/g, "/")}`} controls preload="metadata" />
                          <figcaption>before</figcaption>
                        </figure>
                      )}
                      {reviewBundle.clips?.afterFile && (
                        <figure>
                          <video src={`/media/${encodeURIComponent(reviewBundle.clips.afterFile).replace(/%2F/g, "/")}`} controls preload="metadata" />
                          <figcaption>after</figcaption>
                        </figure>
                      )}
                    </div>
                  </section>
                )}
                {reviewBundle.vlm && (
                  <section className="reviewVlm">
                    <h4>AI画像観測（決定論的checkではありません）</h4>
                    <ul>
                      {reviewBundle.vlm.summary.map((message, index) => (
                        <li key={`summary:${index}`}>{message}</li>
                      ))}
                      {reviewBundle.vlm.observations.map((item, index) => (
                        <li key={`${item.frame}:${item.category}:${index}`}>
                          [{item.severity}] frame {item.frame} / {item.category}: {item.message}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
            {extraControls}
          </div>
        </div>
        <div className="diffList">
          {hunks.length > 1 && (
            <div className="diffBulk">
              <span>一括選択</span>
              <button onClick={() => onBulk("mine")}>
                {kind === "ai-proposal" ? "すべて不採用" : "未保存編集を残す"}
              </button>
              <button onClick={() => onBulk("theirs")}>
                {kind === "ai-proposal" ? "すべて採用" : "外部変更にする"}
              </button>
            </div>
          )}
          {hunks.map((hunk, i) => {
            const selected = resolution.get(hunk) ?? "theirs";
            const title = hunkTitle(hunk);
            return (
              <article className="diffHunk" key={`${hunk.address.label}:${i}`}>
                <div className="diffConflictHead">
                  <div>
                    <div className="diffConflictTitle">{title}</div>
                    <div className="diffConflictHelp">
                      {kind === "ai-proposal"
                        ? "この項目に AI 提案の変更があります。"
                        : "この項目が、未保存編集と外部変更の両方で変更されました。"}
                    </div>
                  </div>
                  <code>{hunk.address.label}</code>
                </div>
                <div className="diffValues">
                  <ValuePane
                    title={kind === "ai-proposal" ? "現在の内容" : "エディタの未保存編集"}
                    note={
                      kind === "ai-proposal"
                        ? "この hunk を不採用にすると残る内容"
                        : "いま画面上にある、まだ保存していない内容"
                    }
                    value={hunk.mine}
                    selected={selected === "mine"}
                    onChoose={() => onSet(hunk, "mine")}
                  />
                  <ValuePane
                    title={kind === "ai-proposal" ? "AI 提案" : "外部で変更された内容"}
                    note={
                      kind === "ai-proposal"
                        ? "この hunk を採用すると入る内容"
                        : "ディスク上の JSON に後から書き込まれた内容"
                    }
                    value={hunk.theirs}
                    selected={selected === "theirs"}
                    onChoose={() => onSet(hunk, "theirs")}
                  />
                </div>
              </article>
            );
          })}
        </div>
        <div className="diffFoot">
          <button onClick={onCancel}>キャンセル</button>
          <div className="spacer" />
          {actions ? (
            actions.map((action) => (
              <button
                key={action.label}
                className={action.kind === "primary" ? "primary" : undefined}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))
          ) : (
            <button className="primary" onClick={onApply}>
              {kind === "ai-proposal" ? "選んだ提案を適用" : "選んだ内容を適用"}
            </button>
          )}
        </div>
      </section>
    </>
  );
};

function defaultCountLabel(kind: "external-conflict" | "ai-proposal", count: number): string {
  return kind === "ai-proposal" ? `${count} 件の変更` : `${count} 件の競合`;
}

const ValuePane = ({
  title,
  note,
  value,
  selected,
  onChoose,
}: {
  title: string;
  note: string;
  value: unknown;
  selected: boolean;
  onChoose: () => void;
}) => (
  <button className={`diffValue ${selected ? "on" : ""}`} onClick={onChoose}>
    <div className="diffValueTitle">
      <span>{title}</span>
      <strong>{selected ? "採用予定" : "クリックして採用"}</strong>
    </div>
    <div className="diffValueNote">{note}</div>
    <pre>{formatValue(value)}</pre>
  </button>
);

function formatValue(value: unknown): string {
  if (value === undefined) return "(なし)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function hunkTitle(hunk: Hunk): string {
  const file = fileLabel(hunk.address.file);
  const array = arrayLabel(hunk.address.arrayKey);
  const field = fieldLabel(hunk.address.field);
  if (array && field) return `${file}の${array}の${field}`;
  if (array) return `${file}の${array}`;
  if (field) return `${file}の${field}`;
  return file;
}

function fileLabel(file: string): string {
  if (file === "transcript") return "字幕";
  if (file === "cutplan") return "カット";
  if (file === "overlays") return "演出";
  if (file === "bgm") return "BGM";
  if (file === "shorts") return "ショート";
  return file;
}

function arrayLabel(arrayKey: string | undefined): string {
  if (arrayKey === "segments") return "項目";
  if (arrayKey === "captionTracks") return "テロップトラック";
  if (arrayKey === "tracks") return "区間";
  if (arrayKey === "shorts") return "定義";
  if (arrayKey === "ranges") return "範囲";
  return arrayKey ?? "";
}

function fieldLabel(field: string | undefined): string {
  if (field === "text") return "本文";
  if (field === "reason") return "理由";
  if (field === "start") return "開始時刻";
  if (field === "end") return "終了時刻";
  if (field === "file") return "ファイル";
  if (field?.startsWith("style.")) return `スタイル(${field.slice("style.".length)})`;
  if (field?.startsWith("rect.")) return `矩形(${field.slice("rect.".length)})`;
  return field ?? "";
}
