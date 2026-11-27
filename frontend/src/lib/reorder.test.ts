import { describe, expect, it } from "vitest";
import { dropIndex, neighbourTarget, placeTicket } from "./reorder";
import type { Ticket } from "./tickets";

const t = (id: number, status: Ticket["status"]): Ticket => ({
  id,
  name: `T${id}`,
  description: "",
  project: "",
  deadline: "",
  status,
});
const order = (tickets: Ticket[], status: string) =>
  tickets.filter((x) => x.status === status).map((x) => x.id);

describe("placeTicket", () => {
  const board = [t(1, "todo"), t(2, "todo"), t(3, "todo"), t(4, "done")];

  it("reorders within a column", () => {
    expect(order(placeTicket(board, 3, "todo", 1), "todo")).toEqual([3, 1, 2]);
  });

  it("moves to another column above a ticket or at the bottom", () => {
    expect(order(placeTicket(board, 2, "done", 4), "done")).toEqual([2, 4]);
    expect(order(placeTicket(board, 2, "done", 0), "done")).toEqual([4, 2]);
  });

  it("moves to the bottom of its own column with no target", () => {
    expect(order(placeTicket(board, 1, "todo", 0), "todo")).toEqual([2, 3, 1]);
  });

  it("leaves the board alone when nothing changes", () => {
    expect(placeTicket(board, 3, "todo", 0)).toBe(board); // already at the bottom
    expect(placeTicket(board, 2, "todo", 3)).toBe(board); // already above 3
    expect(placeTicket(board, 99, "done", 0)).toBe(board);
  });
});

describe("dropIndex", () => {
  it("finds the slot under the pointer", () => {
    const mids = [100, 200, 300];
    expect(dropIndex(50, mids)).toBe(0);
    expect(dropIndex(150, mids)).toBe(1);
    expect(dropIndex(350, mids)).toBe(3);
    expect(dropIndex(10, [])).toBe(0);
  });
});

describe("neighbourTarget", () => {
  const ids = [1, 2, 3];
  it("moves up above the previous ticket", () => {
    expect(neighbourTarget(ids, 2, -1)).toBe(1);
    expect(neighbourTarget(ids, 1, -1)).toBeNull();
  });
  it("moves down above the ticket two below, or to the bottom", () => {
    expect(neighbourTarget(ids, 1, 1)).toBe(3);
    expect(neighbourTarget(ids, 2, 1)).toBe(0);
    expect(neighbourTarget(ids, 3, 1)).toBeNull();
  });
});
