/** One column of a board. A ticket's status is its column's id. */
export type BoardColumn = { id: string; name: string; done?: boolean };

export const MAX_COLUMNS = 10;

/** The columns of boards that never changed theirs (same as store.go). */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "todo", name: "To Do" },
  { id: "inprogress", name: "In Progress" },
  { id: "done", name: "Done", done: true },
];

export function columnsOf(board: { columns?: BoardColumn[] } | undefined): BoardColumn[] {
  return board?.columns && board.columns.length > 0 ? board.columns : DEFAULT_COLUMNS;
}

/**
 * Colour of a column's dot and badge: hollow for the first column, green for
 * finished columns and amber for the ones in between.
 */
export type ColumnTone = "todo" | "inprogress" | "done";

export function columnTone(columns: BoardColumn[], id: string): ColumnTone {
  const index = columns.findIndex((column) => column.id === id);
  if (index !== -1 && columns[index].done) return "done";
  if (index <= 0) return "todo";
  return "inprogress";
}

export function columnName(columns: BoardColumn[], id: string): string {
  return columns.find((column) => column.id === id)?.name ?? columns[0]?.name ?? "";
}

export function doneIds(columns: BoardColumn[]): Set<string> {
  return new Set(columns.filter((column) => column.done).map((column) => column.id));
}

export type BoardTemplate = { name: string; columns: BoardColumn[] };

const named = (names: string[], done: string[]): BoardColumn[] =>
  names.map((name) => ({ id: "", name, done: done.includes(name) }));

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { name: "Simple", columns: named(["To Do", "In Progress", "Done"], ["Done"]) },
  {
    name: "Job search",
    columns: named(["Wishlist", "Applied", "Interviewing", "Offer", "Rejected"], ["Offer", "Rejected"]),
  },
  { name: "Writing", columns: named(["Ideas", "Drafting", "Editing", "Published"], ["Published"]) },
  { name: "Reading", columns: named(["To Read", "Reading", "Finished"], ["Finished"]) },
];

/** A problem with a column list, or "" if it can be saved. */
export function columnsError(columns: BoardColumn[]): string {
  if (columns.length === 0) return "A board needs at least one column.";
  if (columns.length > MAX_COLUMNS) return `A board can have at most ${MAX_COLUMNS} columns.`;
  const seen = new Set<string>();
  for (const column of columns) {
    const name = column.name.trim();
    if (!name) return "Column names can't be empty.";
    const key = name.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) return `There are two columns called "${name}".`;
    seen.add(key);
  }
  return "";
}

/**
 * Where the tickets of removed columns go when a board's columns change — the
 * nearest earlier column that remains, or the first column. Mirrors
 * SetBoardColumns in columns.go.
 */
export function removedColumnTargets(before: BoardColumn[], after: BoardColumn[]): Map<string, BoardColumn> {
  const remaining = new Set(after.map((column) => column.id).filter(Boolean));
  const moves = new Map<string, BoardColumn>();
  before.forEach((column, i) => {
    if (remaining.has(column.id) || after.length === 0) return;
    let target = after[0];
    for (let j = i - 1; j >= 0; j--) {
      if (remaining.has(before[j].id)) {
        target = after.find((c) => c.id === before[j].id)!;
        break;
      }
    }
    moves.set(column.id, target);
  });
  return moves;
}
