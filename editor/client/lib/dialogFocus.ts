export type DialogFocusTarget = { focus: () => void };

/** Keep focus restoration deterministic when a controlled Dialog unmounts immediately. */
export const restoreDialogFocus = (
  event: { preventDefault: () => void },
  target: DialogFocusTarget | null | undefined,
) => {
  event.preventDefault();
  target?.focus();
};
