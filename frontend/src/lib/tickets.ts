import type { Ticket } from "../ticketDetails/TicketDetails";
import { main } from "../../wailsjs/go/models";
import type { DraftFields } from "../drafts";

export type { Ticket };
/** A column id of the ticket's board. */
export type Status = string;
export type DeletedTicket = Ticket & { deletedAt: string };
export type TicketForm = {
  name: string;
  description: string;
  project: string;
  link: string;
  deadline: string;
  status: Status;
};

export const EMPTY_FORM: TicketForm = {
  name: "",
  description: "",
  project: "",
  link: "",
  deadline: "",
  status: "", // the board's first column
};
const FORM_KEYS = Object.keys(EMPTY_FORM) as (keyof TicketForm)[];

export function toTicket(ticket: main.Ticket): Ticket {
  return {
    ...ticket,
    comments: ticket.comments ?? [],
  };
}

export function toDeletedTicket(ticket: main.Ticket): DeletedTicket {
  return { ...toTicket(ticket), deletedAt: ticket.deletedAt ?? "" };
}

export function formFromTicket(ticket: Ticket): TicketForm {
  return {
    name: ticket.name,
    description: ticket.description ?? "",
    project: ticket.project ?? "",
    link: ticket.link ?? "",
    deadline: ticket.deadline ?? "",
    status: ticket.status,
  };
}

/** Fills a form from a saved draft. statuses, when given, are the column ids
 * a draft's status must be one of. */
export function formFromDraft(fields: DraftFields | undefined, base: TicketForm, statuses?: string[]): TicketForm {
  const form = { ...base };
  if (!fields) return form;
  for (const key of FORM_KEYS) {
    if (typeof fields[key] === "string") {
      (form as Record<string, string>)[key] = fields[key];
    }
  }
  if (statuses && !statuses.includes(form.status)) form.status = base.status;
  return form;
}

export function sameForm(a: TicketForm, b: TicketForm): boolean {
  return FORM_KEYS.every((key) => a[key] === b[key]);
}

export function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- deadlines ----------

export type DeadlineState = "overdue" | "today" | "soon" | "";

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days from today until a YYYY-MM-DD deadline (negative = overdue). */
export function daysUntil(deadline: string, now = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!match) return null;
  const due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000);
}

export function getDeadlineState(deadline: string, now = new Date()): DeadlineState {
  const days = daysUntil(deadline, now);
  if (days === null) return "";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 2) return "soon";
  return "";
}

export function formatDeadline(deadline: string, now = new Date()): string {
  const days = daysUntil(deadline, now);
  if (days === null) return deadline;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const [y, m, d] = deadline.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
