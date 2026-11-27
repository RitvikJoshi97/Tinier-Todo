import { useCallback, useEffect, useRef } from "react";
import { DeleteDraft, SaveDraft } from "../wailsjs/go/main/App";

export type DraftFields = Record<string, string>;

// Draft keys match the Go side (store.go): one new-ticket draft per board, and
// one edit draft and one comment draft per ticket.
export const newTicketDraftKey = (boardId: string) => `new:${boardId}`;
export const editTicketDraftKey = (boardId: string, ticketId: number) =>
  `edit:${boardId}:${ticketId}`;
export const commentDraftKey = (boardId: string, ticketId: number) =>
  `comment:${boardId}:${ticketId}`;

type PendingWrite = { key: string; fields: DraftFields | null };

function writeDraft({ key, fields }: PendingWrite): Promise<void> {
  const write = fields ? SaveDraft(key, fields) : DeleteDraft(key);
  return write.catch((error) => {
    console.error(`Failed to ${fields ? "save" : "delete"} draft ${key}:`, error);
  });
}

/**
 * Saves drafts to disk shortly after typing stops, so an accidental close,
 * crash or quit loses at most the last few hundred milliseconds of typing.
 * `schedule(key, null)` deletes the draft instead. `flush()` writes any
 * pending change immediately; `cancel()` drops it (used after a successful
 * save, when the draft must not come back).
 */
export function useDraftSaver(delayMs = 400) {
  const pending = useRef<PendingWrite | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flush = useCallback((): Promise<void> => {
    clearTimer();
    const write = pending.current;
    pending.current = null;
    return write ? writeDraft(write) : Promise.resolve();
  }, []);

  const schedule = useCallback(
    (key: string, fields: DraftFields | null) => {
      // A different draft is pending: write it now rather than dropping it.
      if (pending.current && pending.current.key !== key) {
        void writeDraft(pending.current);
      }
      pending.current = { key, fields };
      clearTimer();
      timer.current = window.setTimeout(() => {
        void flush();
      }, delayMs);
    },
    [delayMs, flush],
  );

  const cancel = useCallback(() => {
    clearTimer();
    pending.current = null;
  }, []);

  useEffect(() => {
    const onUnload = () => {
      void flush();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      void flush();
    };
  }, [flush]);

  return { schedule, flush, cancel };
}

export function formatDraftAge(updatedAt: string): string {
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString();
}
