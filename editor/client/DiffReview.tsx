import type { Hunk } from "../../src/lib/docDiff.ts";

type Side = "theirs" | "mine";

export const DiffReview = ({
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
}: {
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
}) => {
  const groups = warnings.length > 0 ? [{ label: "確認事項", items: warnings }] : [];
  return (
    <>
      <div className="diffBackdrop" />
      <section className="diffModal" role="dialog" aria-label="外部変更の差分レビュー">
        <div className="diffHead">
          <div>
            <div className="diffCount">{countLabel ?? defaultCountLabel(hunks.length)}</div>
            <h3>{title ?? "外部変更と競合しています"}</h3>
            <p>
              {description ?? "エディタの未保存編集と、ディスク上の変更が同じ場所を変えました。残す内容を選んでください。"}
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
          </div>
        </div>
        <div className="diffList">
          {hunks.length > 1 && (
            <div className="diffBulk">
              <span>一括選択</span>
              <button onClick={() => onBulk("mine")}>未保存編集を残す</button>
              <button onClick={() => onBulk("theirs")}>外部変更にする</button>
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
                    <div className="diffConflictHelp">この項目が、未保存編集と外部変更の両方で変更されました。</div>
                  </div>
                  <code>{hunk.address.label}</code>
                </div>
                <div className="diffValues">
                  <ValuePane
                    title="エディタの未保存編集"
                    note="いま画面上にある、まだ保存していない内容"
                    value={hunk.mine}
                    selected={selected === "mine"}
                    onChoose={() => onSet(hunk, "mine")}
                  />
                  <ValuePane
                    title="外部で変更された内容"
                    note="ディスク上の JSON に後から書き込まれた内容"
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
          <button className="primary" onClick={onApply}>選んだ内容を適用</button>
        </div>
      </section>
    </>
  );
};

function defaultCountLabel(count: number): string {
  return `${count} 件の競合`;
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
