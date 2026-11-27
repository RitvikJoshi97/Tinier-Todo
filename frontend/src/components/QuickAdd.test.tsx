import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickAdd } from "./QuickAdd";

describe("QuickAdd", () => {
  it("adds tickets one after another with Enter and closes with Esc", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(true);
    render(<QuickAdd columnTitle="To Do" alwaysVisible={false} onAdd={onAdd} />);

    await user.click(screen.getByRole("button", { name: /add ticket/i }));
    const input = screen.getByRole("textbox", { name: "New ticket in To Do" });
    await user.type(input, "First{Enter}");
    await user.type(input, "Second{Enter}");
    expect(onAdd).toHaveBeenNthCalledWith(1, "First");
    expect(onAdd).toHaveBeenNthCalledWith(2, "Second");
    expect(input).toHaveProperty("value", "");

    expect(document.activeElement).toBe(input); // still focused after adding
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: /add ticket/i })).toBeTruthy();
  });

  it("ignores blank titles and keeps the text if adding fails", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(false);
    render(<QuickAdd columnTitle="Done" alwaysVisible onAdd={onAdd} />);

    await user.click(screen.getByRole("button", { name: /add ticket/i }));
    const input = screen.getByRole("textbox");
    await user.type(input, "   {Enter}");
    expect(onAdd).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Keep me{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Keep me");
    expect(input).toHaveProperty("value", "Keep me");
  });

  it("is only faint until hovered, except in an empty column", () => {
    const { rerender } = render(<QuickAdd columnTitle="To Do" alwaysVisible={false} onAdd={vi.fn()} />);
    expect(screen.getByRole("button").className).not.toContain("quick-add-visible");
    rerender(<QuickAdd columnTitle="To Do" alwaysVisible onAdd={vi.fn()} />);
    expect(screen.getByRole("button").className).toContain("quick-add-visible");
  });
});
