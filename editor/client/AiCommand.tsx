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
  clearOnSubmit = true,
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
  /** false は失敗時に入力を保つ modal 用。既定 true で既存挙動を維持する。 */
  clearOnSubmit?: boolean;
  onSubmit: (instruction: string) => void;
}) => {
  const [instruction, setInstruction] = useState("");
  const blocked = disabled || busy || instruction.trim().length === 0;
  const submit = () => {
    if (blocked) return;
    onSubmit(instruction.trim());
    if (clearOnSubmit) setInstruction("");
  };
  return (
    <form
      className={`aiCommand ocAiCommand${compact ? " compact" : ""}${modalStyle ? " modalStyle" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {multiline ? (
        <textarea
          value={instruction}
          disabled={disabled || busy}
          placeholder={disabled && disabledReason ? disabledReason : placeholder}
          title={disabled && disabledReason ? disabledReason : placeholder}
          rows={3}
          onChange={(e) => setInstruction(e.target.value)}
          // 複数行入力の作法: Enter は改行、⌘/Ctrl+Enter で送信
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
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
