import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import TicketDetails from "./ticketDetails/TicketDetails";
import { EventsOn } from "../wailsjs/runtime/runtime";
import {
  AddComment,
  CreateBoard,
  CreateTicket,
  DeleteBoard,
  DeleteComment,
  DeleteDraft,
  DeleteTicket,
  EditComment,
  GetBoards,
  GetDraft,
  GetVersion,
  ListDraftKeys,
  LoadDeletedTickets,
  LoadTickets,
  MoveTicketToBoard,
  PlaceTicket,
  RenameBoard,
  ReorderBoards,
  RestoreTicket,
  SetActiveBoard,
  SetBoardColumns,
  UpdateTicket,
} from "../wailsjs/go/main/App";
import { main } from "../wailsjs/go/models";
import { Board, BoardNameModal, EditColumnsModal, ManageBoardsModal, NewBoardModal } from "./boards/Boards";
import { commentDraftKey, editTicketDraftKey, newTicketDraftKey, useDraftSaver } from "./drafts";
import { errorMessage, useVoiceInput } from "./voice/useVoiceInput";
import { TrashIcon } from "./icons";
import {
  DeletedTicket,
  EMPTY_FORM,
  Status,
  Ticket,
  TicketForm,
  formFromDraft,
  formFromTicket,
  sameForm,
  sameJSON,
  toDeletedTicket,
  toTicket,
} from "./lib/tickets";
import { Filters, NO_FILTERS, hasFilters, matchesFilters, matchesSearch } from "./lib/search";
import { placeTicket } from "./lib/reorder";
import { BoardColumn, columnName, columnTone, columnsOf, doneIds } from "./lib/columns";
import { Header } from "./components/Header";
import { FilterBar, ProjectOption } from "./components/FilterMenu";
import { Column } from "./components/Column";
import { TicketCard } from "./components/TicketCard";
import { TicketFormModal } from "./components/TicketFormModal";
import { ConfirmDialog } from "./components/Modal";
import {
  AboutModal,
  DeletedTicketsModal,
  HelpModal,
  MCPModal,
  SettingsModal,
  Toast,
  ToastMessage,
} from "./components/dialogs";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

type BoardDialog = { kind: "new" } | { kind: "rename"; board: Board } | { kind: "columns"; board: Board } | null;
type Panel = "deleted" | "mcp" | "help" | "about" | "settings" | "boards" | null;

const THEME_KEY = "tinier-todo:theme";

function getInitialDarkMode(): boolean {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {
    // storage unavailable: fall through to the system setting
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function App() {
  // ---------- data ----------
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [deletedTickets, setDeletedTickets] = useState<DeletedTicket[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState("");
  const activeBoardRef = useRef("");
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const [appVersion, setAppVersion] = useState("");

  // ---------- dialogs ----------
  const [panel, setPanel] = useState<Panel>(null);
  const [boardDialog, setBoardDialog] = useState<BoardDialog>(null);
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState<Board | null>(null);
  const [confirmDeleteTicket, setConfirmDeleteTicket] = useState<Ticket | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  // ---------- ticket form ----------
  const [showForm, setShowForm] = useState(false);
  const [editingTicketId, setEditingTicketId] = useState<number | null>(null);
  const [form, setForm] = useState<TicketForm>(EMPTY_FORM);
  const [formBoardId, setFormBoardId] = useState("");
  const [formError, setFormError] = useState("");
  const [savingForm, setSavingForm] = useState(false);
  const [formShake, setFormShake] = useState(false);
  const [draftNotice, setDraftNotice] = useState<{ updatedAt: string } | null>(null);
  const [comment, setComment] = useState("");

  // Drafts are saved to disk while typing, so closing a dialog by mistake
  // (or a crash) loses nothing.
  const formDraft = useDraftSaver();
  const commentDraft = useDraftSaver();
  const formBaselineRef = useRef<TicketForm>(EMPTY_FORM);
  const formDraftKeyRef = useRef("");
  const lastFormDraftRef = useRef("");
  const commentDraftKeyRef = useRef("");

  // ---------- board view ----------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [enteringId, setEnteringId] = useState<number | null>(null);
  const [focusedColumn, setFocusedColumn] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [darkMode, setDarkMode] = useState(getInitialDarkMode);
  const [toast, setToast] = useState<Toast | null>(null);

  // Refs read by callbacks that must not change identity on every render.
  const formRef = useRef(form);
  formRef.current = form;
  const showFormRef = useRef(showForm);
  showFormRef.current = showForm;
  const selectedTicketRef = useRef(selectedTicket);
  selectedTicketRef.current = selectedTicket;
  const commentRef = useRef(comment);
  commentRef.current = comment;

  useEffect(() => {
    GetVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  // ---------- toast ----------
  const showToast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ---------- theme ----------
  useEffect(() => {
    document.body.classList.toggle("dark-mode", darkMode);
  }, [darkMode]);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      try {
        window.localStorage.setItem(THEME_KEY, prev ? "light" : "dark");
      } catch {
        // not fatal: the choice just isn't remembered
      }
      return !prev;
    });
  }, []);

  // ---------- derived ----------
  const activeBoard = boards.find((board) => board.id === activeBoardId);
  const columns = useMemo(() => columnsOf(activeBoard), [activeBoard]);
  const finished = useMemo(() => doneIds(columns), [columns]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const byKey = new Map<string, ProjectOption>();
    for (const ticket of tickets) {
      const name = ticket.project?.trim() ?? "";
      const key = name.toLowerCase();
      const option = byKey.get(key) ?? { key, name, count: 0 };
      option.count += 1;
      byKey.set(key, option);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (!a.key) return 1; // "No project" last
      if (!b.key) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [tickets]);

  const projectSuggestions = useMemo(
    () => projectOptions.filter((p) => p.key).map((p) => p.name),
    [projectOptions],
  );

  const narrowed = searchQuery.trim() !== "" || hasFilters(filters);

  const visibleTickets = useMemo(
    () => tickets.filter((t) => matchesSearch(t, searchQuery) && matchesFilters(t, filters, undefined, finished)),
    [tickets, searchQuery, filters, finished],
  );

  const columnTickets = useCallback(
    (column: number) => visibleTickets.filter((t) => t.status === columns[column]?.id),
    [visibleTickets, columns],
  );

  const hasNewDraft = draftKeys.includes(newTicketDraftKey(activeBoardId));

  // Clamp keyboard focus when a column shrinks or columns are removed.
  useEffect(() => {
    if (focusedColumn >= columns.length) setFocusedColumn(Math.max(0, columns.length - 1));
  }, [columns.length, focusedColumn]);
  useEffect(() => {
    const count = columnTickets(focusedColumn).length;
    if (count === 0 && focusedIndex !== -1) setFocusedIndex(-1);
    else if (focusedIndex >= count) setFocusedIndex(count - 1);
  }, [columnTickets, focusedColumn, focusedIndex]);

  // ---------- loading ----------
  const refreshDraftKeys = useCallback(async () => {
    try {
      const keys = ((await ListDraftKeys()) ?? []).sort();
      setDraftKeys((prev) => (sameJSON(prev, keys) ? prev : keys));
    } catch (error) {
      console.error("Failed to list drafts:", error);
    }
  }, []);

  // Reload boards and the open board's tickets from disk: on start-up, after
  // switching boards and whenever the files change (MCP, other windows).
  const syncFromStorage = useCallback(async () => {
    let boardId = activeBoardRef.current;
    try {
      const state = await GetBoards();
      const loadedBoards = state.boards ?? [];
      setBoards((prev) => (sameJSON(prev, loadedBoards) ? prev : loadedBoards));
      if (!boardId || !loadedBoards.some((board) => board.id === boardId)) {
        boardId = state.activeBoardId;
        activeBoardRef.current = boardId;
        setActiveBoardId(boardId);
      }
    } catch (error) {
      console.error("Failed to load boards:", error);
    }
    if (!boardId) return;

    try {
      const [loaded, loadedDeleted] = await Promise.all([LoadTickets(boardId), LoadDeletedTickets(boardId)]);
      if (boardId !== activeBoardRef.current) return; // switched while loading
      const next = (loaded ?? []).map(toTicket);
      const nextDeleted = (loadedDeleted ?? []).map(toDeletedTicket);
      setTickets((prev) => (sameJSON(prev, next) ? prev : next));
      setDeletedTickets((prev) => (sameJSON(prev, nextDeleted) ? prev : nextDeleted));
      setSelectedTicket((prev) => {
        if (!prev) return prev;
        const updated = next.find((t) => t.id === prev.id) ?? null;
        if (!updated) setShowDetails(false);
        return updated && sameJSON(updated, prev) ? prev : updated;
      });
    } catch (error) {
      console.error("Failed to load tickets:", error);
    }
    void refreshDraftKeys();
  }, [refreshDraftKeys]);

  const reportFailure = useCallback(
    (action: string, error: unknown) => {
      console.error(action, error);
      showToast(`${action}: ${errorMessage(error)}`, "error");
      void syncFromStorage();
    },
    [showToast, syncFromStorage],
  );

  // ---------- FLIP animation ----------
  const ticketRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevRectsRef = useRef<Map<number, DOMRect>>(new Map());

  const capturePositions = useCallback(() => {
    const rects = new Map<number, DOMRect>();
    ticketRefs.current.forEach((el, id) => rects.set(id, el.getBoundingClientRect()));
    prevRectsRef.current = rects;
  }, []);

  useLayoutEffect(() => {
    const prevRects = prevRectsRef.current;
    if (prevRects.size === 0) return;
    ticketRefs.current.forEach((el, id) => {
      const prev = prevRects.get(id);
      if (!prev) return;
      const curr = el.getBoundingClientRect();
      const dx = prev.left - curr.left;
      const dy = prev.top - curr.top;
      if (dx === 0 && dy === 0) return;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.transition = "none";
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)";
        el.style.transform = "";
        el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
      });
    });
    prevRectsRef.current = new Map();
  }, [tickets]);

  const flashEntering = (id: number) => {
    setEnteringId(id);
    window.setTimeout(() => setEnteringId(null), 400);
  };

  const replaceTicket = (updated: Ticket) => {
    setTickets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedTicket((prev) => (prev && prev.id === updated.id ? updated : prev));
  };

  // ---------- ticket actions ----------

  // Show the new position at once, then save it.
  const moveTicket = useCallback(
    (ticket: Ticket, status: Status, beforeId: number) => {
      const next = placeTicket(tickets, ticket.id, status, beforeId);
      if (next === tickets) return;
      capturePositions();
      setTickets(next);
      setSelectedTicket((prev) => (prev && prev.id === ticket.id ? { ...prev, status } : prev));
      if (status !== ticket.status) flashEntering(ticket.id);
      PlaceTicket(activeBoardRef.current, ticket.id, status, beforeId).catch((error) =>
        reportFailure("Couldn't move the ticket", error),
      );
    },
    [tickets, capturePositions, reportFailure],
  );

  const quickAdd = useCallback(
    async (status: Status, name: string) => {
      // With a single project filter on, new tickets join that project.
      const project =
        filters.projects.length === 1
          ? projectOptions.find((p) => p.key === filters.projects[0])?.name ?? ""
          : "";
      try {
        const created = toTicket(
          await CreateTicket(
            activeBoardRef.current,
            main.TicketFields.createFrom({ ...EMPTY_FORM, name, status, project }),
          ),
        );
        setTickets((prev) => [...prev, created]);
        flashEntering(created.id);
        return true;
      } catch (error) {
        showToast(`Couldn't add the ticket: ${errorMessage(error)}`, "error");
        return false;
      }
    },
    [filters.projects, projectOptions, showToast],
  );

  const performDelete = useCallback(
    (ticket: Ticket) => {
      capturePositions();
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
      setDeletedTickets((prev) => [{ ...ticket, deletedAt: new Date().toISOString() }, ...prev]);
      if (selectedTicketRef.current?.id === ticket.id) {
        commentDraft.cancel();
        commentDraftKeyRef.current = "";
        setShowDetails(false);
        setSelectedTicket(null);
        setComment("");
      }
      setConfirmDeleteTicket(null);
      DeleteTicket(activeBoardRef.current, ticket.id)
        .then(refreshDraftKeys)
        .catch((error) => reportFailure("Couldn't delete the ticket", error));
    },
    [capturePositions, commentDraft, refreshDraftKeys, reportFailure],
  );

  const restoreTicket = useCallback(
    async (id: number) => {
      try {
        const restored = toTicket(await RestoreTicket(activeBoardRef.current, id));
        setDeletedTickets((prev) => prev.filter((t) => t.id !== id));
        setTickets((prev) => (prev.some((t) => t.id === restored.id) ? prev : [...prev, restored]));
      } catch (error) {
        reportFailure("Couldn't restore the ticket", error);
      }
    },
    [reportFailure],
  );

  // ---------- ticket form (new / edit) ----------

  // Opens the form with `base` values, or with the saved draft for `key`.
  const openTicketForm = useCallback(async (key: string, base: TicketForm, ticketId: number | null) => {
    let draft: main.Draft | null = null;
    try {
      draft = await GetDraft(key);
    } catch (error) {
      console.error("Failed to load draft:", error);
    }
    const statuses = columnsRef.current.map((column) => column.id);
    const restored = draft?.fields ? formFromDraft(draft.fields, base, statuses) : null;
    const usable = restored && !sameForm(restored, base) ? restored : null;

    formBaselineRef.current = base;
    formDraftKeyRef.current = key;
    lastFormDraftRef.current = usable ? JSON.stringify(usable) : "";
    setForm(usable ?? base);
    setDraftNotice(usable && draft ? { updatedAt: draft.updatedAt } : null);
    setEditingTicketId(ticketId);
    setFormBoardId(activeBoardRef.current);
    setFormError("");
    setShowForm(true);
    setFocusedIndex(-1);
  }, []);

  const openNewTicket = useCallback(async () => {
    if (showFormRef.current) return;
    const base = { ...EMPTY_FORM, status: columnsRef.current[0]?.id ?? "" };
    await openTicketForm(newTicketDraftKey(activeBoardRef.current), base, null);
  }, [openTicketForm]);

  // Save the form as a draft shortly after each change; delete the draft
  // once the form matches what it started with again.
  useEffect(() => {
    const key = formDraftKeyRef.current;
    if (!showForm || !key) return;
    const dirty = !sameForm(form, formBaselineRef.current);
    const serialized = dirty ? JSON.stringify(form) : "";
    if (serialized === lastFormDraftRef.current) return;
    lastFormDraftRef.current = serialized;
    formDraft.schedule(key, dirty ? { ...form } : null);
  }, [form, showForm, formDraft]);

  // Unless the ticket was just saved, whatever was typed stays as a draft.
  const closeForm = useCallback(
    (saved = false) => {
      const wasNew = formDraftKeyRef.current.startsWith("new:");
      const dirty = !sameForm(formRef.current, formBaselineRef.current);
      if (saved) {
        formDraft.cancel();
      } else {
        void formDraft.flush().then(refreshDraftKeys);
        if (dirty && showFormRef.current) {
          showToast(
            wasNew
              ? "Draft kept. It'll be back next time you open New ticket."
              : "Unsaved changes kept as a draft. Edit the ticket to continue.",
          );
        }
      }
      formDraftKeyRef.current = "";
      lastFormDraftRef.current = "";
      setShowForm(false);
      setEditingTicketId(null);
      setDraftNotice(null);
      setFormError("");
      setForm(EMPTY_FORM);
    },
    [formDraft, refreshDraftKeys, showToast],
  );

  const discardDraft = useCallback(() => {
    const key = formDraftKeyRef.current;
    formDraft.cancel();
    lastFormDraftRef.current = "";
    setForm(formBaselineRef.current);
    setDraftNotice(null);
    if (key) {
      DeleteDraft(key)
        .then(refreshDraftKeys)
        .catch((error) => console.error("Failed to delete draft:", error));
    }
  }, [formDraft, refreshDraftKeys]);

  const onFormBackdropClick = useCallback(() => {
    // A stray click outside the form must not throw away typing.
    if (!sameForm(formRef.current, formBaselineRef.current)) {
      setFormShake(true);
      window.setTimeout(() => setFormShake(false), 400);
      return;
    }
    closeForm();
  }, [closeForm]);

  const submitForm = async () => {
    if (savingForm) return;
    const boardId = activeBoardRef.current;
    const fields = main.TicketFields.createFrom({ ...form });
    setSavingForm(true);
    setFormError("");
    try {
      if (editingTicketId !== null) {
        const saved = toTicket(await UpdateTicket(boardId, editingTicketId, fields));
        if (formBoardId && formBoardId !== boardId) {
          await MoveTicketToBoard(boardId, editingTicketId, formBoardId);
          capturePositions();
          setTickets((prev) => prev.filter((t) => t.id !== editingTicketId));
          setSelectedTicket(null);
          const target = boards.find((board) => board.id === formBoardId);
          showToast(`Moved "${saved.name}" to ${target?.name ?? "another board"}.`);
        } else {
          replaceTicket(saved);
        }
      } else {
        const created = toTicket(await CreateTicket(boardId, fields));
        setTickets((prev) => [...prev, created]);
        flashEntering(created.id);
      }
      closeForm(true);
      void refreshDraftKeys();
    } catch (error) {
      setFormError(errorMessage(error)); // the form stays open, the draft is kept
    } finally {
      setSavingForm(false);
    }
  };

  // ---------- details & comments ----------

  const openDetails = useCallback(
    (ticket: Ticket) => {
      void commentDraft.flush();
      const key = commentDraftKey(activeBoardRef.current, ticket.id);
      commentDraftKeyRef.current = key;
      setSelectedTicket(ticket);
      setShowDetails(true);
      setComment("");
      setFocusedIndex(-1);
      GetDraft(key)
        .then((draft) => {
          const text = draft?.fields?.text;
          if (text && commentDraftKeyRef.current === key) setComment(text);
        })
        .catch((error) => console.error("Failed to load comment draft:", error));
    },
    [commentDraft],
  );

  const changeComment = useCallback(
    (text: string) => {
      setComment(text);
      const key = commentDraftKeyRef.current;
      if (key) commentDraft.schedule(key, text.trim() ? { text } : null);
    },
    [commentDraft],
  );

  const closeDetails = useCallback(() => {
    void commentDraft.flush().then(refreshDraftKeys);
    if (commentRef.current.trim()) showToast("Your unfinished comment was kept as a draft.");
    commentDraftKeyRef.current = "";
    setShowDetails(false);
    setSelectedTicket(null);
    setComment("");
  }, [commentDraft, refreshDraftKeys, showToast]);

  const openEditForm = useCallback(
    (ticket: Ticket) => {
      void commentDraft.flush();
      commentDraftKeyRef.current = "";
      setShowDetails(false);
      void openTicketForm(editTicketDraftKey(activeBoardRef.current, ticket.id), formFromTicket(ticket), ticket.id);
    },
    [commentDraft, openTicketForm],
  );

  const addComment = useCallback(async () => {
    const ticket = selectedTicketRef.current;
    const text = commentRef.current;
    if (!text.trim() || !ticket) return;
    commentDraft.cancel();
    setComment("");
    try {
      replaceTicket(toTicket(await AddComment(activeBoardRef.current, ticket.id, text)));
      void refreshDraftKeys();
    } catch (error) {
      setComment(text); // put the text back so nothing is lost
      if (commentDraftKeyRef.current) commentDraft.schedule(commentDraftKeyRef.current, { text });
      reportFailure("Couldn't add the comment", error);
    }
  }, [commentDraft, refreshDraftKeys, reportFailure]);

  const editComment = useCallback(
    async (commentId: number, text: string) => {
      const ticket = selectedTicketRef.current;
      if (!ticket) return false;
      try {
        replaceTicket(toTicket(await EditComment(activeBoardRef.current, ticket.id, commentId, text)));
        return true;
      } catch (error) {
        showToast(`Couldn't save the comment: ${errorMessage(error)}`, "error");
        return false;
      }
    },
    [showToast],
  );

  const deleteComment = useCallback(
    async (commentId: number) => {
      const ticket = selectedTicketRef.current;
      if (!ticket) return;
      try {
        replaceTicket(toTicket(await DeleteComment(activeBoardRef.current, ticket.id, commentId)));
      } catch (error) {
        reportFailure("Couldn't delete the comment", error);
      }
    },
    [reportFailure],
  );

  // ---------- boards ----------

  const switchBoard = useCallback(
    async (boardId: string) => {
      if (!boardId || boardId === activeBoardRef.current) return;
      if (showFormRef.current) closeForm();
      if (selectedTicketRef.current) closeDetails();
      activeBoardRef.current = boardId;
      setActiveBoardId(boardId);
      setFilters(NO_FILTERS); // projects differ between boards
      setFocusedIndex(-1);
      setFocusedColumn(0);
      try {
        await SetActiveBoard(boardId);
      } catch (error) {
        console.error("Failed to save the open board:", error);
      }
      await syncFromStorage();
    },
    [closeDetails, closeForm, syncFromStorage],
  );

  const createBoard = useCallback(
    async (name: string, boardColumns: BoardColumn[]) => {
      const board = await CreateBoard(name, boardColumns.map((column) => main.Column.createFrom(column)));
      setBoardDialog(null);
      setBoards((prev) => [...prev, board]);
      await switchBoard(board.id);
      showToast(`Created board "${board.name}".`);
    },
    [showToast, switchBoard],
  );

  const renameBoard = useCallback(
    async (board: Board, name: string) => {
      await RenameBoard(board.id, name);
      setBoardDialog(null);
      await syncFromStorage();
    },
    [syncFromStorage],
  );

  const saveColumns = useCallback(
    async (board: Board, boardColumns: BoardColumn[]) => {
      const updated = await SetBoardColumns(board.id, boardColumns.map((column) => main.Column.createFrom(column)));
      setBoardDialog(null);
      setBoards((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      await syncFromStorage();
    },
    [syncFromStorage],
  );

  const reorderBoards = useCallback(
    (ids: string[]) => {
      setBoards((prev) =>
        ids.map((id) => prev.find((board) => board.id === id)).filter((b): b is Board => Boolean(b)),
      );
      ReorderBoards(ids).catch((error) => reportFailure("Couldn't reorder boards", error));
    },
    [reportFailure],
  );

  const deleteBoard = useCallback(
    async (board: Board) => {
      setConfirmDeleteBoard(null);
      try {
        await DeleteBoard(board.id);
        if (board.id === activeBoardRef.current) {
          if (showFormRef.current) closeForm();
          if (selectedTicketRef.current) closeDetails();
          activeBoardRef.current = "";
          setFilters(NO_FILTERS);
        }
        await syncFromStorage();
        showToast(`Deleted board "${board.name}".`);
      } catch (error) {
        reportFailure("Couldn't delete the board", error);
      }
    },
    [closeDetails, closeForm, reportFailure, showToast, syncFromStorage],
  );

  // ---------- search & filters ----------

  // Opening focuses the (empty) box; pressing Ctrl+F again while it's open
  // selects the current query so it can be replaced.
  const openSearch = useCallback(() => {
    const input = searchInputRef.current;
    if (input) {
      input.focus();
      input.select();
      return;
    }
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setFocusedIndex(-1);
  }, []);

  const toggleProjectFilter = useCallback((project: string) => {
    const key = project.trim().toLowerCase();
    setFilters((prev) => ({
      ...prev,
      projects: prev.projects.length === 1 && prev.projects[0] === key ? [] : [key],
    }));
  }, []);

  // ---------- voice ----------

  const appendToDescription = useCallback((text: string) => {
    setForm((prev) => ({
      ...prev,
      description: [prev.description.trim(), text.trim()].filter(Boolean).join(" "),
    }));
  }, []);

  const voice = useVoiceInput({
    onTranscript: (text) => {
      if (!text.trim()) {
        showToast("Didn't catch anything. Try again, a little closer to the microphone.");
        return;
      }
      if (showFormRef.current) appendToDescription(text);
      else void openNewTicket().then(() => appendToDescription(text));
    },
    onError: (message) => showToast(message, "error"),
  });
  const recording = voice.phase === "recording";

  // Stop recording and open the New ticket form (unless a form is open),
  // where the transcript is added to the description.
  const stopVoice = useCallback(async () => {
    if (!showFormRef.current) {
      setShowDetails(false);
      await openNewTicket();
    }
    voice.stop();
  }, [openNewTicket, voice]);

  // ---------- keyboard ----------

  const dialogOpen =
    showForm ||
    showDetails ||
    panel !== null ||
    boardDialog !== null ||
    confirmDeleteBoard !== null ||
    confirmDeleteTicket !== null;

  useKeyboardShortcuts({
    dialogOpen,
    ticketFormOpen: showForm,
    recording,
    focusedColumn,
    focusedIndex,
    setFocusedColumn,
    setFocusedIndex,
    columnTickets,
    columnIds: columns.map((column) => column.id),
    boardCount: boards.length,
    closeTopDialog: () => {
      if (confirmDeleteBoard) setConfirmDeleteBoard(null);
      else if (confirmDeleteTicket) setConfirmDeleteTicket(null);
      else if (boardDialog) setBoardDialog(null);
      else if (panel) setPanel(null);
      else if (showDetails) closeDetails();
      else if (showForm) closeForm();
      else return false;
      return true;
    },
    closeSearch: () => {
      if (!searchOpen) return false;
      closeSearch();
      return true;
    },
    openSearch,
    newTicket: () => void openNewTicket(),
    newBoard: () => setBoardDialog({ kind: "new" }),
    switchBoard: (index) => {
      const board = boards[index];
      if (board) void switchBoard(board.id);
    },
    toggleDarkMode,
    toggleHelp: () => setPanel((prev) => (prev === "help" ? null : "help")),
    startVoice: voice.start,
    stopVoice: () => void stopVoice(),
    cancelVoice: () => {
      voice.cancel();
      showToast("Voice input cancelled.");
    },
    openTicket: openDetails,
    deleteTicket: setConfirmDeleteTicket,
    placeTicket: moveTicket,
  });

  // Scroll the focused ticket into view.
  useEffect(() => {
    if (focusedIndex < 0) return;
    const ticket = columnTickets(focusedColumn)[focusedIndex];
    if (ticket) ticketRefs.current.get(ticket.id)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focusedColumn, focusedIndex, columnTickets]);

  const editColumns = useCallback(() => {
    const board = boards.find((b) => b.id === activeBoardRef.current);
    if (board) setBoardDialog({ kind: "columns", board });
  }, [boards]);
  const editColumnsRef = useRef(editColumns);
  editColumnsRef.current = editColumns;

  // ---------- start-up and native menu ----------

  useEffect(() => {
    void syncFromStorage();
  }, [syncFromStorage]);

  useEffect(() => {
    const unsubscribers = [
      EventsOn("openDeletedTickets", () => setPanel("deleted")),
      EventsOn("openMCPSettings", () => setPanel("mcp")),
      EventsOn("openSettings", () => setPanel("settings")),
      EventsOn("openNewTicket", () => void openNewTicket()),
      EventsOn("openNewBoard", () => setBoardDialog({ kind: "new" })),
      EventsOn("openManageBoards", () => setPanel("boards")),
      EventsOn("openEditColumns", () => editColumnsRef.current()),
      EventsOn("switchBoard", (id: string) => void switchBoard(id)),
      EventsOn("openKeyboardShortcuts", () => setPanel("help")),
      EventsOn("openAbout", () => setPanel("about")),
      EventsOn("ticketsUpdated", () => void syncFromStorage()),
      EventsOn("toast", (data: { message: string; error?: boolean }) =>
        showToast(data.message, data.error ? "error" : "info"),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [openNewTicket, showToast, switchBoard, syncFromStorage]);

  // ---------- render ----------

  const totals = columns.map((column) => tickets.filter((t) => t.status === column.id).length);

  return (
    <div id="App">
      <Header
        boards={boards}
        activeBoardId={activeBoardId}
        onSwitchBoard={(id) => void switchBoard(id)}
        onNewBoard={() => setBoardDialog({ kind: "new" })}
        onManageBoards={() => setPanel("boards")}
        onEditColumns={editColumns}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        onSearchChange={setSearchQuery}
        onOpenSearch={openSearch}
        onCloseSearch={closeSearch}
        filters={filters}
        projects={projectOptions}
        onFiltersChange={setFilters}
        recording={recording}
        onMic={() => (recording ? void stopVoice() : voice.start())}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
        onHelp={() => setPanel("help")}
        hasNewDraft={hasNewDraft}
        onNewTicket={() => void openNewTicket()}
      />

      <FilterBar
        filters={filters}
        projects={projectOptions}
        shown={visibleTickets.length}
        total={tickets.length}
        onChange={setFilters}
      />

      <main className="board" style={{ "--column-count": columns.length } as React.CSSProperties}>
        {columns.map((boardColumn, column) => (
          <Column
            key={boardColumn.id}
            status={boardColumn.id}
            title={boardColumn.name}
            tone={columnTone(columns, boardColumn.id)}
            tickets={columnTickets(column)}
            total={totals[column]}
            narrowed={narrowed}
            active={column === focusedColumn && focusedIndex >= 0}
            draggedId={draggedId}
            onDropTicket={(target, beforeId) => {
              const ticket = tickets.find((t) => t.id === draggedId);
              setDraggedId(null);
              if (ticket) moveTicket(ticket, target, beforeId);
            }}
            onQuickAdd={quickAdd}
            renderCard={(ticket, index) => (
              <TicketCard
                ticket={ticket}
                focused={column === focusedColumn && index === focusedIndex}
                entering={enteringId === ticket.id}
                done={finished.has(ticket.status)}
                hasDraft={
                  draftKeys.includes(editTicketDraftKey(activeBoardId, ticket.id)) ||
                  draftKeys.includes(commentDraftKey(activeBoardId, ticket.id))
                }
                cardRef={(el) => {
                  if (el) ticketRefs.current.set(ticket.id, el);
                  else ticketRefs.current.delete(ticket.id);
                }}
                onOpen={() => openDetails(ticket)}
                onProjectClick={toggleProjectFilter}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(ticket.id));
                  const el = e.currentTarget;
                  requestAnimationFrame(() => el.classList.add("dragging"));
                  setDraggedId(ticket.id);
                }}
                onDragEnd={(e) => {
                  e.currentTarget.classList.remove("dragging");
                  setDraggedId(null);
                }}
              />
            )}
          />
        ))}
      </main>

      {showForm && (
        <TicketFormModal
          form={form}
          columns={columns}
          editing={editingTicketId !== null}
          boards={boards}
          boardId={formBoardId}
          projectSuggestions={projectSuggestions}
          draftNotice={draftNotice}
          error={formError}
          saving={savingForm}
          shake={formShake}
          listening={recording}
          onChange={setForm}
          onBoardChange={setFormBoardId}
          onDiscardDraft={discardDraft}
          onSubmit={() => void submitForm()}
          onClose={() => closeForm()}
          onBackdropClick={onFormBackdropClick}
        />
      )}

      <TicketDetails
        ticket={selectedTicket}
        show={showDetails}
        onClose={closeDetails}
        comment={comment}
        setComment={changeComment}
        onAddComment={() => void addComment()}
        onEditComment={editComment}
        onDeleteComment={(id) => void deleteComment(id)}
        onEdit={openEditForm}
        onDelete={setConfirmDeleteTicket}
        statusName={selectedTicket ? columnName(columns, selectedTicket.status) : ""}
        statusTone={selectedTicket ? columnTone(columns, selectedTicket.status) : "todo"}
      />

      {panel === "deleted" && (
        <DeletedTicketsModal
          tickets={deletedTickets}
          boardName={boards.length > 1 ? activeBoard?.name : undefined}
          onRestore={(id) => void restoreTicket(id)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "mcp" && <MCPModal onClose={() => setPanel(null)} />}
      {panel === "settings" && <SettingsModal onClose={() => setPanel(null)} />}
      {panel === "help" && <HelpModal onClose={() => setPanel(null)} />}
      {panel === "about" && <AboutModal version={appVersion} onClose={() => setPanel(null)} />}
      {panel === "boards" && (
        <ManageBoardsModal
          boards={boards}
          activeBoardId={activeBoardId}
          onRename={(board) => setBoardDialog({ kind: "rename", board })}
          onEditColumns={(board) => setBoardDialog({ kind: "columns", board })}
          onDelete={setConfirmDeleteBoard}
          onReorder={reorderBoards}
          onNewBoard={() => setBoardDialog({ kind: "new" })}
          onClose={() => setPanel(null)}
        />
      )}

      {boardDialog?.kind === "new" && (
        <NewBoardModal onSubmit={createBoard} onClose={() => setBoardDialog(null)} />
      )}
      {boardDialog?.kind === "columns" && (
        <EditColumnsModal
          board={boardDialog.board}
          columns={columnsOf(boardDialog.board)}
          ticketCounts={
            boardDialog.board.id === activeBoardId
              ? Object.fromEntries(columns.map((c, i) => [c.id, totals[i]]))
              : undefined
          }
          onSubmit={(boardColumns) => saveColumns(boardDialog.board, boardColumns)}
          onClose={() => setBoardDialog(null)}
        />
      )}
      {boardDialog?.kind === "rename" && (
        <BoardNameModal
          title="Rename board"
          submitLabel="Rename"
          initialName={boardDialog.board.name}
          onSubmit={(name) => renameBoard(boardDialog.board, name)}
          onClose={() => setBoardDialog(null)}
        />
      )}

      {confirmDeleteTicket && (
        <ConfirmDialog
          title="Delete ticket?"
          name={confirmDeleteTicket.name}
          message="You can restore it later from Tools → Deleted Tickets."
          confirmLabel="Delete"
          icon={<TrashIcon size={20} />}
          onConfirm={() => performDelete(confirmDeleteTicket)}
          onCancel={() => setConfirmDeleteTicket(null)}
        />
      )}
      {confirmDeleteBoard && (
        <ConfirmDialog
          title="Delete board?"
          name={confirmDeleteBoard.name}
          message="The board and its tickets disappear from the app. Its files are kept in ~/.tinier-todo/trash/boards in case you need them back."
          confirmLabel="Delete board"
          icon={<TrashIcon size={20} />}
          onConfirm={() => void deleteBoard(confirmDeleteBoard)}
          onCancel={() => setConfirmDeleteBoard(null)}
        />
      )}

      <ToastMessage toast={toast} />
    </div>
  );
}

export default App;
