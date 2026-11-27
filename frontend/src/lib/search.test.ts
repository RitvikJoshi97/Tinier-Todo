import { describe, expect, it } from "vitest";
import { matchesFilters, matchesSearch } from "./search";
import type { Ticket } from "./tickets";

const ticket = (overrides: Partial<Ticket>): Ticket => ({
  id: 1,
  name: "Fix login redirect loop",
  description: "Users on Safari get bounced after the SSO change.",
  project: "Web app",
  deadline: "",
  status: "todo",
  comments: [],
  ...overrides,
});

describe("matchesSearch", () => {
  it("matches words anywhere in the ticket, ignoring case and accents", () => {
    expect(matchesSearch(ticket({}), "safari")).toBe(true);
    expect(matchesSearch(ticket({}), "WEB APP")).toBe(true);
    expect(matchesSearch(ticket({ name: "Café menu" }), "cafe")).toBe(true);
    expect(matchesSearch(ticket({ comments: [{ id: 1, text: "Repro on iOS", timestamp: "" }] }), "ios")).toBe(true);
  });

  it("needs every word to match", () => {
    expect(matchesSearch(ticket({}), "login safari")).toBe(true);
    expect(matchesSearch(ticket({}), "login chrome")).toBe(false);
  });

  it("no longer matches letters scattered across the text", () => {
    // i-n-f-r-a appear in order in "Fix login redirect loop" but not as a word.
    expect(matchesSearch(ticket({}), "infra")).toBe(false);
  });

  it("forgives one typo in longer words, including while typing", () => {
    expect(matchesSearch(ticket({}), "redirct")).toBe(true);
    expect(matchesSearch(ticket({}), "logni")).toBe(true); // swapped letters
    expect(matchesSearch(ticket({}), "bounc")).toBe(true); // prefix
    expect(matchesSearch(ticket({}), "lgo")).toBe(false); // short words must match exactly
  });

  it("matches everything for an empty query", () => {
    expect(matchesSearch(ticket({}), "   ")).toBe(true);
  });
});

describe("matchesFilters", () => {
  const now = new Date(2026, 10, 26, 10); // Nov 26 2026

  it("filters by project, case-insensitively, including 'no project'", () => {
    expect(matchesFilters(ticket({}), { projects: ["web app"], due: "" }, now)).toBe(true);
    expect(matchesFilters(ticket({}), { projects: ["infra"], due: "" }, now)).toBe(false);
    expect(matchesFilters(ticket({ project: "" }), { projects: [""], due: "" }, now)).toBe(true);
  });

  it("filters by deadline", () => {
    const overdue = ticket({ deadline: "2026-11-20" });
    const today = ticket({ deadline: "2026-11-26" });
    const nextWeek = ticket({ deadline: "2026-12-02" });
    const later = ticket({ deadline: "2027-01-10" });
    const none = ticket({ deadline: "" });
    const doneOverdue = ticket({ deadline: "2026-11-20", status: "done" });

    const pick = (due: "overdue" | "today" | "week" | "none") =>
      [overdue, today, nextWeek, later, none, doneOverdue].map((t) => matchesFilters(t, { projects: [], due }, now));

    expect(pick("overdue")).toEqual([true, false, false, false, false, false]);
    expect(pick("today")).toEqual([false, true, false, false, false, false]);
    expect(pick("week")).toEqual([true, true, true, false, false, false]);
    expect(pick("none")).toEqual([false, false, false, false, true, false]);
  });
});
