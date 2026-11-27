import type { Status, Ticket } from "./tickets";

/**
 * Moves a ticket into a column, above `beforeId` or at the bottom when it is
 * 0 — the same rule as PlaceTicket in store.go, so the board can update at
 * once while the change is saved.
 */
export function placeTicket(
  tickets: Ticket[],
  id: number,
  status: Status,
  beforeId: number,
): Ticket[] {
  const index = tickets.findIndex((ticket) => ticket.id === id);
  if (index === -1) return tickets;
  const ticket = tickets[index];
  if (beforeId === id) beforeId = 0;

  const rest = tickets.filter((t) => t.id !== id);
  // The bottom of the column: just after its last ticket.
  let insertAt = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].status === status) {
      insertAt = i + 1;
      break;
    }
  }
  if (beforeId !== 0) {
    const before = rest.findIndex((t) => t.id === beforeId);
    if (before !== -1 && rest[before].status === status) insertAt = before;
  }
  const moved = ticket.status === status ? ticket : { ...ticket, status };
  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  // Same place as before: keep the old array so nothing re-renders.
  return next.every((t, i) => t === tickets[i]) ? tickets : next;
}

/**
 * Where a dragged ticket would land in a column, from the pointer's height
 * and the column's card midpoints. Returns the index among `cardMidpoints`
 * (which must not include the dragged card), or its length for the bottom.
 */
export function dropIndex(pointerY: number, cardMidpoints: number[]): number {
  const index = cardMidpoints.findIndex((mid) => pointerY < mid);
  return index === -1 ? cardMidpoints.length : index;
}

/** The ticket to place a moved ticket above, for keyboard reordering. */
export function neighbourTarget(
  columnIds: number[],
  id: number,
  direction: -1 | 1,
): number | null {
  const index = columnIds.indexOf(id);
  if (index === -1) return null;
  if (direction === -1) {
    return index === 0 ? null : columnIds[index - 1];
  }
  if (index === columnIds.length - 1) return null;
  // Moving down one place = above the ticket two below, or the bottom.
  return columnIds[index + 2] ?? 0;
}
