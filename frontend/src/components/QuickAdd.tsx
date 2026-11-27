import React, { useEffect, useRef, useState } from "react";
import { PlusIcon } from "../icons";

/**
 * "+ Add ticket" at the bottom of a column. It stays faint until the column
 * is hovered. Enter adds the ticket and keeps the field open for the next
 * one; Esc or clicking away closes it.
 */
export function QuickAdd({
  columnTitle,
  alwaysVisible,
  onAdd,
}: {
  columnTitle: string;
  alwaysVisible: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await onAdd(trimmed);
    setBusy(false);
    if (ok) {
      setName("");
      inputRef.current?.focus();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className={`quick-add-trigger${alwaysVisible ? " quick-add-visible" : ""}`}
        onClick={() => setOpen(true)}
      >
        <PlusIcon size={14} />
        Add ticket
      </button>
    );
  }

  return (
    <div className="quick-add">
      <input
        ref={inputRef}
        type="text"
        value={name}
        placeholder="Ticket title"
        aria-label={`New ticket in ${columnTitle}`}
        // Read-only, not disabled, while saving: a disabled input loses
        // focus, and then Esc and the next title go nowhere.
        readOnly={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setName("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!name.trim()) setOpen(false);
        }}
      />
      <div className="quick-add-hint">
        <span>
          <kbd>Enter</kbd> to add
        </span>
        <span>
          <kbd>Esc</kbd> to cancel
        </span>
      </div>
    </div>
  );
}
