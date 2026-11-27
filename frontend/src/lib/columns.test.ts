import { describe, expect, it } from "vitest";
import {
  BOARD_TEMPLATES,
  DEFAULT_COLUMNS,
  columnTone,
  columnsError,
  columnsOf,
  removedColumnTargets,
} from "./columns";

const jobs = [
  { id: "w", name: "Wishlist" },
  { id: "a", name: "Applied" },
  { id: "i", name: "Interviewing" },
  { id: "o", name: "Offer", done: true },
];

describe("columns", () => {
  it("falls back to the default columns", () => {
    expect(columnsOf(undefined)).toBe(DEFAULT_COLUMNS);
    expect(columnsOf({ columns: [] })).toBe(DEFAULT_COLUMNS);
    expect(columnsOf({ columns: jobs })).toBe(jobs);
  });

  it("colours the first, middle and finished columns", () => {
    expect(columnTone(jobs, "w")).toBe("todo");
    expect(columnTone(jobs, "i")).toBe("inprogress");
    expect(columnTone(jobs, "o")).toBe("done");
  });

  it("checks names", () => {
    expect(columnsError(jobs)).toBe("");
    expect(columnsError([])).toMatch(/at least one/);
    expect(columnsError([{ id: "", name: " " }])).toMatch(/empty/);
    expect(columnsError([{ id: "", name: "Applied" }, { id: "", name: "applied " }])).toMatch(/two columns/);
    for (const template of BOARD_TEMPLATES) expect(columnsError(template.columns)).toBe("");
  });

  it("moves removed columns' tickets to the nearest earlier column", () => {
    const after = [jobs[1], { id: "", name: "Ghosted" }, jobs[3]]; // drop Wishlist and Interviewing
    const moves = removedColumnTargets(jobs, after);
    expect(moves.get("w")?.name).toBe("Applied"); // nothing before it: the first column
    expect(moves.get("i")?.name).toBe("Applied");
    expect(moves.has("a")).toBe(false);
  });
});
