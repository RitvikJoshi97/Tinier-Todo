import { useEffect, useRef } from "react";
import { Status, Ticket } from "../lib/tickets";
import { neighbourTarget } from "../lib/reorder";
import { hasModifier } from "../lib/platform";

const DOUBLE_TAB_MS = 300;

export interface ShortcutOptions {
  /** True while any dialog is open; board shortcuts are off then. */
  dialogOpen: boolean;
  ticketFormOpen: boolean;
  recording: boolean;
  focusedColumn: number;
  focusedIndex: number;
  setFocusedColumn: (index: number) => void;
  setFocusedIndex: (index: number) => void;
  /** Visible tickets of a column, after search and filters. */
  columnTickets: (column: number) => Ticket[];
  /** The open board's column ids, in order. */
  columnIds: string[];
  boardCount: number;

  closeTopDialog: () => boolean;
  closeSearch: () => boolean;
  openSearch: () => void;
  newTicket: () => void;
  newBoard: () => void;
  switchBoard: (index: number) => void;
  toggleDarkMode: () => void;
  toggleHelp: () => void;
  startVoice: () => void;
  stopVoice: () => void;
  cancelVoice: () => void;
  openTicket: (ticket: Ticket) => void;
  deleteTicket: (ticket: Ticket) => void;
  placeTicket: (ticket: Ticket, status: Status, beforeId: number) => void;
}

/**
 * Global keyboard shortcuts. The listener is registered once and reads the
 * latest options from a ref, so it never works with stale state.
 */
export function useKeyboardShortcuts(options: ShortcutOptions) {
  const ref = useRef(options);
  ref.current = options;
  const lastTab = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const o = ref.current;
      const target = e.target as HTMLElement;
      const tag = target.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
      const key = e.key.toLowerCase();
      // ⌘ on macOS, Ctrl on Windows and Linux.
      const mod = hasModifier(e);

      // ---- available everywhere ----
      if (mod && key === "f") {
        e.preventDefault();
        o.openSearch();
        return;
      }
      if (mod && !e.shiftKey && key === "n") {
        e.preventDefault();
        o.newTicket();
        return;
      }
      if (mod && e.shiftKey && key === "n") {
        e.preventDefault();
        if (!o.recording) o.startVoice();
        return;
      }
      if (o.recording && e.code === "Space") {
        e.preventDefault();
        o.stopVoice();
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        o.toggleDarkMode();
        return;
      }
      if (mod && !e.shiftKey && key === "b") {
        e.preventDefault();
        if (!o.dialogOpen) o.newBoard();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        if (!o.ticketFormOpen) o.switchBoard(Number(e.key) - 1);
        return;
      }
      if ((mod && e.key === "/") || (e.key === "?" && !inInput)) {
        e.preventDefault();
        o.toggleHelp();
        return;
      }
      if (e.key === "Escape") {
        if (o.recording) {
          e.preventDefault();
          o.cancelVoice();
          return;
        }
        if (o.closeTopDialog() || o.closeSearch()) {
          e.preventDefault();
          return;
        }
        if (o.focusedIndex >= 0) o.setFocusedIndex(-1);
        return;
      }

      // ---- board only ----
      if (o.dialogOpen || inInput) return;

      const columnIds = o.columnIds;
      const columnCount = columnIds.length;
      const column = o.focusedColumn;
      const tickets = o.columnTickets(column);
      const focused = o.focusedIndex >= 0 ? tickets[o.focusedIndex] : undefined;

      const moveToColumn = (targetColumn: number) => {
        if (!focused || targetColumn < 0 || targetColumn >= columnCount || targetColumn === column) return;
        const landing = o.columnTickets(targetColumn).length; // goes to the bottom
        o.placeTicket(focused, columnIds[targetColumn], 0);
        o.setFocusedColumn(targetColumn);
        o.setFocusedIndex(landing);
      };

      const focusColumn = (next: number) => {
        o.setFocusedColumn(next);
        o.setFocusedIndex(o.columnTickets(next).length > 0 ? 0 : -1);
      };

      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        if (!focused) return;
        const direction = e.key === "ArrowUp" ? -1 : 1;
        const beforeId = neighbourTarget(
          tickets.map((t) => t.id),
          focused.id,
          direction,
        );
        if (beforeId === null) return;
        o.placeTicket(focused, focused.status, beforeId);
        o.setFocusedIndex(o.focusedIndex + direction);
        return;
      }
      if (mod && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        moveToColumn(column + (e.key === "ArrowRight" ? 1 : -1));
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key) && focused) {
        e.preventDefault();
        moveToColumn(Number(e.key) - 1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (tickets.length === 0) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        const current = o.focusedIndex < 0 ? (step === 1 ? -1 : 0) : o.focusedIndex;
        o.setFocusedIndex((current + step + tickets.length) % tickets.length);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : -1;
        focusColumn((column + step + columnCount) % columnCount);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const now = Date.now();
        const isDouble = now - lastTab.current < DOUBLE_TAB_MS;
        lastTab.current = now;
        if (isDouble) {
          const step = e.shiftKey ? -1 : 1;
          focusColumn((column + step + columnCount) % columnCount);
        } else if (tickets.length > 0) {
          const step = e.shiftKey ? -1 : 1;
          const current = o.focusedIndex < 0 ? (step === 1 ? -1 : 0) : o.focusedIndex;
          o.setFocusedIndex((current + step + tickets.length) % tickets.length);
        }
        return;
      }
      if (e.key === "Enter" && focused) {
        e.preventDefault();
        o.openTicket(focused);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && focused) {
        e.preventDefault();
        o.deleteTicket(focused);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
