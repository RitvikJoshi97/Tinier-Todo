/*
 * An in-memory stand-in for the Go backend (wailsjs/go/main/App), so tests
 * can render the app. It follows the same rules as store.go for the parts
 * the UI relies on.
 */
import { safeLinkHref } from "../lib/markdown";

type Comment = { id: number; text: string; timestamp: string; editedAt?: string };
type Ticket = {
  id: number;
  name: string;
  description: string;
  project: string;
  link: string;
  deadline: string;
  status: string;
  comments: Comment[];
  deletedAt?: string;
};
type Column = { id: string; name: string; done?: boolean };
type Board = { id: string; name: string; createdAt: string; columns?: Column[] };

const DEFAULT_COLUMNS: Column[] = [
  { id: "todo", name: "To Do" },
  { id: "inprogress", name: "In Progress" },
  { id: "done", name: "Done", done: true },
];

const state = {
  boards: [] as Board[],
  activeBoardId: "default",
  tickets: {} as Record<string, Ticket[]>,
  deleted: {} as Record<string, Ticket[]>,
  drafts: {} as Record<string, { fields: Record<string, string>; updatedAt: string }>,
  nextId: 1000,
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function resetBackend(seed?: { boards?: Board[]; tickets?: Record<string, Partial<Ticket>[]> }) {
  state.boards = (seed?.boards ?? [{ id: "default", name: "Default", createdAt: "" }]).map((b) => ({
    ...b,
    columns: b.columns ?? clone(DEFAULT_COLUMNS),
  }));
  state.activeBoardId = state.boards[0].id;
  mcp = { enabled: false, port: 3535, token: "fake-token-1" };
  state.tickets = {};
  state.deleted = {};
  state.drafts = {};
  state.nextId = 1000;
  for (const board of state.boards) {
    state.tickets[board.id] = (seed?.tickets?.[board.id] ?? []).map((t) => ({
      id: t.id ?? state.nextId++,
      name: t.name ?? "Ticket",
      description: t.description ?? "",
      project: t.project ?? "",
      link: t.link ?? "",
      deadline: t.deadline ?? "",
      status: t.status ?? "todo",
      comments: t.comments ?? [],
    }));
    state.deleted[board.id] = [];
  }
}

export const backendState = state;

const board = (id: string) => (id ? id : state.activeBoardId);
const list = (id: string) => state.tickets[board(id)] ?? [];
const find = (boardId: string, id: number) => {
  const ticket = list(boardId).find((t) => t.id === id);
  if (!ticket) throw new Error(`ticket ${id} not found`);
  return ticket;
};

export const GetBoards = async () => clone({ boards: state.boards, activeBoardId: state.activeBoardId });
export const SetActiveBoard = async (id: string) => {
  state.activeBoardId = id;
};
export const CreateBoard = async (name: string, columns: Column[] = []) => {
  const created = {
    id: `b${state.nextId++}`,
    name,
    createdAt: "",
    columns: columns.length
      ? columns.map((c, i) => ({ ...c, id: c.id || `c${state.nextId + i}` }))
      : clone(DEFAULT_COLUMNS),
  };
  state.nextId += columns.length;
  state.boards.push(created);
  state.tickets[created.id] = [];
  state.deleted[created.id] = [];
  return clone(created);
};
export const RenameBoard = async (id: string, name: string) => {
  state.boards.find((b) => b.id === id)!.name = name;
};
export const DeleteBoard = async (id: string) => {
  state.boards = state.boards.filter((b) => b.id !== id);
  if (state.activeBoardId === id) state.activeBoardId = state.boards[0].id;
};
// Same rules as SetBoardColumns in columns.go: removed columns' tickets move
// to the nearest earlier column that remains.
export const SetBoardColumns = async (boardId: string, columns: Column[]) => {
  const target = state.boards.find((b) => b.id === boardId)!;
  const old = target.columns ?? DEFAULT_COLUMNS;
  const next = columns.map((c) => ({ ...c, id: old.some((o) => o.id === c.id) ? c.id : `c${state.nextId++}` }));
  const remaining = new Set(next.map((c) => c.id));
  const moveTo = new Map<string, string>();
  old.forEach((c, i) => {
    if (remaining.has(c.id)) return;
    let to = next[0].id;
    for (let j = i - 1; j >= 0; j--) {
      if (remaining.has(old[j].id)) {
        to = old[j].id;
        break;
      }
    }
    moveTo.set(c.id, to);
  });
  for (const t of state.tickets[boardId]) t.status = moveTo.get(t.status) ?? t.status;
  target.columns = next;
  return clone(target);
};
export const ReorderBoards = async (ids: string[]) => {
  state.boards = ids.map((id) => state.boards.find((b) => b.id === id)!);
};

export const LoadTickets = async (boardId: string) => clone(list(boardId));
export const LoadDeletedTickets = async (boardId: string) => clone(state.deleted[board(boardId)] ?? []);

function checkLink(link = ""): string {
  if (link.trim() && !safeLinkHref(link)) throw new Error(`invalid link "${link.trim()}"`);
  return link.trim() ? safeLinkHref(link)! : "";
}

export const CreateTicket = async (boardId: string, fields: Record<string, string>) => {
  if (!fields.name?.trim()) throw new Error('"name" is required');
  const link = checkLink(fields.link);
  const ticket: Ticket = {
    id: state.nextId++,
    name: fields.name.trim(),
    description: fields.description ?? "",
    project: (fields.project ?? "").trim(),
    link,
    deadline: fields.deadline ?? "",
    status: fields.status || (state.boards.find((b) => b.id === board(boardId))?.columns ?? DEFAULT_COLUMNS)[0].id,
    comments: [],
  };
  list(boardId).push(ticket);
  delete state.drafts[`new:${board(boardId)}`];
  return clone(ticket);
};

export const UpdateTicket = async (boardId: string, id: number, fields: Record<string, string>) => {
  const ticket = find(boardId, id);
  const link = checkLink(fields.link);
  Object.assign(ticket, fields, { link });
  delete state.drafts[`edit:${board(boardId)}:${id}`];
  return clone(ticket);
};

export const PlaceTicket = async (boardId: string, id: number, status: string, beforeId: number) => {
  const tickets = list(boardId);
  const ticket = find(boardId, id);
  const rest = tickets.filter((t) => t.id !== id);
  let at = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].status === status) {
      at = i + 1;
      break;
    }
  }
  if (beforeId) at = rest.findIndex((t) => t.id === beforeId);
  ticket.status = status;
  rest.splice(at, 0, ticket);
  state.tickets[board(boardId)] = rest;
  return clone(ticket);
};
export const MoveTicket = async (boardId: string, id: number, status: string) =>
  find(boardId, id).status === status ? clone(find(boardId, id)) : PlaceTicket(boardId, id, status, 0);

export const AddComment = async (boardId: string, id: number, text: string) => {
  const ticket = find(boardId, id);
  const nextId = Math.max(0, ...ticket.comments.map((c) => c.id)) + 1;
  ticket.comments.push({ id: nextId, text, timestamp: "Nov 26, 2026, 9:00 AM" });
  delete state.drafts[`comment:${board(boardId)}:${id}`];
  return clone(ticket);
};
export const EditComment = async (boardId: string, id: number, commentId: number, text: string) => {
  const ticket = find(boardId, id);
  const comment = ticket.comments.find((c) => c.id === commentId)!;
  comment.text = text;
  comment.editedAt = "2026-11-26T09:00:00Z";
  return clone(ticket);
};
export const DeleteComment = async (boardId: string, id: number, commentId: number) => {
  const ticket = find(boardId, id);
  ticket.comments = ticket.comments.filter((c) => c.id !== commentId);
  return clone(ticket);
};

export const DeleteTicket = async (boardId: string, id: number) => {
  const ticket = find(boardId, id);
  state.tickets[board(boardId)] = list(boardId).filter((t) => t.id !== id);
  state.deleted[board(boardId)].unshift({ ...ticket, deletedAt: "2026-11-26T09:00:00Z" });
};
export const RestoreTicket = async (boardId: string, id: number) => {
  const deleted = state.deleted[board(boardId)];
  const ticket = deleted.find((t) => t.id === id)!;
  state.deleted[board(boardId)] = deleted.filter((t) => t.id !== id);
  delete ticket.deletedAt;
  list(boardId).push(ticket);
  return clone(ticket);
};
export const MoveTicketToBoard = async (from: string, id: number, to: string) => {
  const ticket = find(from, id);
  state.tickets[board(from)] = list(from).filter((t) => t.id !== id);
  list(to).push(ticket);
  return clone(ticket);
};

export const GetDraft = async (key: string) => (state.drafts[key] ? clone(state.drafts[key]) : null);
export const SaveDraft = async (key: string, fields: Record<string, string>) => {
  state.drafts[key] = { fields: clone(fields), updatedAt: new Date().toISOString() };
};
export const DeleteDraft = async (key: string) => {
  delete state.drafts[key];
};
export const ListDraftKeys = async () => Object.keys(state.drafts);

export const GetVersion = async () => "test";
let mcp = { enabled: false, port: 3535, token: "fake-token-1" };
export const GetMCPSettings = async () => ({ ...mcp });
export const UpdateMCPSettings = async (enabled: boolean, port: number) => {
  mcp = { ...mcp, enabled, port };
  return { ...mcp };
};
export const RegenerateMCPToken = async () => {
  mcp = { ...mcp, token: `fake-token-${Number(mcp.token.split("-").pop()) + 1}` };
  return { ...mcp };
};
export const DiskEncryption = async () => ({ state: "off", name: "FileVault" });
export const GetSettings = async () => ({ reminders: { enabled: true, hour: 9 } });
export const SaveSettings = async (settings: unknown) => settings;
export const SendTestReminder = async () => undefined;
export const RefreshMenu = async () => undefined;
