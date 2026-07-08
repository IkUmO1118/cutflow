import { useState } from "react";

export const AiCommand = ({
  disabled,
  busy,
  compact = false,
  disabledReason,
  placeholder = "AI に編集を提案させる",
  submitLabel = "提案",
  onSubmit,
}: {
  disabled: boolean;
  busy: boolean;
  compact?: boolean;
  disabledReason?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (instruction: string) => void;
}) => {
  const [instruction, setInstruction] = useState("");
  const blocked = disabled || busy || instruction.trim().length === 0;
  return (
    <form
      className={`aiCommand${compact ? " compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        onSubmit(instruction.trim());
        setInstruction("");
      }}
    >
      <span className="aiBadge">AI</span>
      <input
        value={instruction}
        disabled={disabled || busy}
        placeholder={disabled && disabledReason ? disabledReason : placeholder}
        title={disabled && disabledReason ? disabledReason : placeholder}
        onChange={(e) => setInstruction(e.target.value)}
      />
      <button className="primary" disabled={blocked}>
        {busy ? "提案中…" : submitLabel}
      </button>
    </form>
  );
};
