import { useState } from "react";

export const AiCommand = ({
  disabled,
  busy,
  compact = false,
  multiline = false,
  modalStyle = false,
  disabledReason,
  placeholder = "AI に編集を提案させる",
  submitLabel = "提案",
  onSubmit,
}: {
  disabled: boolean;
  busy: boolean;
  compact?: boolean;
  multiline?: boolean;
  modalStyle?: boolean;
  disabledReason?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (instruction: string) => void;
}) => {
  const [instruction, setInstruction] = useState("");
  const blocked = disabled || busy || instruction.trim().length === 0;
  return (
    <form
      className={`aiCommand${compact ? " compact" : ""}${modalStyle ? " modalStyle" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        onSubmit(instruction.trim());
        setInstruction("");
      }}
    >
      {!modalStyle && <span className="aiBadge">AI</span>}
      {multiline ? (
        <textarea
          value={instruction}
          disabled={disabled || busy}
          placeholder={disabled && disabledReason ? disabledReason : placeholder}
          title={disabled && disabledReason ? disabledReason : placeholder}
          rows={3}
          onChange={(e) => setInstruction(e.target.value)}
        />
      ) : (
        <input
          value={instruction}
          disabled={disabled || busy}
          placeholder={disabled && disabledReason ? disabledReason : placeholder}
          title={disabled && disabledReason ? disabledReason : placeholder}
          onChange={(e) => setInstruction(e.target.value)}
        />
      )}
      <button className={`primary${busy && !modalStyle ? " loading" : ""}${modalStyle ? " modalSubmit" : ""}`} disabled={blocked}>
        {modalStyle ? (
          <span className="aiCommandSubmitArrow" aria-hidden>
            →
          </span>
        ) : busy ? (
          <img className="aiCommandButtonIcon" src="/particle_loop_icon.svg" alt="" />
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
};
