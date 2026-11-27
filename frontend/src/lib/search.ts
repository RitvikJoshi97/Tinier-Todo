import type { Ticket } from "./tickets";
import { daysUntil } from "./tickets";

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // é -> e
    .replace(/\s+/g, " ")
    .trim();
}

// Damerau-Levenshtein distance, stopping early once it exceeds `max`.
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/**
 * Whether one search word matches the text. A word matches when it appears
 * in the text, or, for words of 4+ letters, when a word in the text (or the
 * start of one) is a single typo away. Letters scattered across the text no
 * longer count.
 */
function tokenMatches(token: string, text: string, words: string[]): boolean {
  if (text.includes(token)) return true;
  if (token.length < 4) return false;
  return words.some((word) => {
    if (editDistance(token, word, 1) <= 1) return true;
    // A typo while still typing: "plannin" -> "planning", "plnan" -> "plan…"
    return word.length > token.length && editDistance(token, word.slice(0, token.length), 1) <= 1;
  });
}

export function searchableText(ticket: Ticket): string {
  return normalizeSearchText(
    [
      ticket.name,
      ticket.description,
      ticket.project,
      ticket.deadline,
      ticket.link ?? "",
      ...(ticket.comments?.map((comment) => comment.text) ?? []),
    ].join(" "),
  );
}

export function matchesSearch(ticket: Ticket, query: string): boolean {
  const normalized = normalizeSearchText(query);
  if (!normalized) return true;
  const text = searchableText(ticket);
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return normalized.split(" ").every((token) => tokenMatches(token, text, words));
}

// ---------- filters ----------

export type DueFilter = "" | "overdue" | "today" | "week" | "none";

export type Filters = {
  /** Lower-cased project names; empty means every project. */
  projects: string[];
  due: DueFilter;
};

export const NO_FILTERS: Filters = { projects: [], due: "" };

export const DUE_FILTER_LABELS: Record<Exclude<DueFilter, "">, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due within 7 days",
  none: "No deadline",
};

export function hasFilters(filters: Filters): boolean {
  return filters.projects.length > 0 || filters.due !== "";
}

/** doneStatuses are the ids of finished columns: overdue no longer applies to them. */
export function matchesFilters(
  ticket: Ticket,
  filters: Filters,
  now = new Date(),
  doneStatuses: Set<string> = new Set(["done"]),
): boolean {
  if (filters.projects.length > 0) {
    const project = (ticket.project ?? "").trim().toLowerCase();
    if (!filters.projects.includes(project)) return false;
  }
  if (filters.due) {
    const days = ticket.deadline ? daysUntil(ticket.deadline, now) : null;
    const open = !doneStatuses.has(ticket.status);
    switch (filters.due) {
      case "none":
        if (days !== null) return false;
        break;
      case "overdue":
        if (days === null || days >= 0 || !open) return false;
        break;
      case "today":
        if (days !== 0) return false;
        break;
      case "week":
        // Includes overdue tickets that are still open.
        if (days === null || days > 7 || (days < 0 && !open)) return false;
        break;
    }
  }
  return true;
}
