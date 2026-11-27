import { describe, expect, it } from "vitest";
import { EMPTY_FORM, daysUntil, formFromDraft, formatDeadline, getDeadlineState } from "./tickets";

const now = new Date(2026, 10, 26, 18, 30); // Nov 26 2026, evening

describe("deadlines", () => {
  it("counts whole days regardless of the time of day", () => {
    expect(daysUntil("2026-11-26", now)).toBe(0);
    expect(daysUntil("2026-11-27", now)).toBe(1);
    expect(daysUntil("2026-11-20", now)).toBe(-6);
    expect(daysUntil("not a date", now)).toBeNull();
  });

  it("classifies deadlines", () => {
    expect(getDeadlineState("2026-11-25", now)).toBe("overdue");
    expect(getDeadlineState("2026-11-26", now)).toBe("today");
    expect(getDeadlineState("2026-11-28", now)).toBe("soon");
    expect(getDeadlineState("2026-12-10", now)).toBe("");
  });

  it("formats nearby deadlines in words", () => {
    expect(formatDeadline("2026-11-26", now)).toBe("Today");
    expect(formatDeadline("2026-11-27", now)).toBe("Tomorrow");
    expect(formatDeadline("2026-11-25", now)).toBe("Yesterday");
    expect(formatDeadline("2027-02-03", now)).toMatch(/2027/);
  });
});

describe("formFromDraft", () => {
  it("takes known string fields and ignores the rest", () => {
    const base = { ...EMPTY_FORM, status: "applied" };
    const form = formFromDraft({ name: "Half done", status: "bogus", extra: "x" }, base, ["applied", "offer"]);
    expect(form).toEqual({ ...base, name: "Half done" });
    expect(formFromDraft({ status: "offer" }, base, ["applied", "offer"]).status).toBe("offer");
  });
});
