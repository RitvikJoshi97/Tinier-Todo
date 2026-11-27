import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { backendState, resetBackend } from "./test/fakeBackend";

const column = (title: string) => screen.getByRole("region", { name: title });
const titlesIn = (title: string) =>
  within(column(title))
    .queryAllByText((_, el) => el?.classList.contains("ticket-title") ?? false)
    .map((el) => el.textContent?.replace(/Draft$/, ""));

beforeEach(() => {
  resetBackend({
    boards: [
      { id: "default", name: "Product", createdAt: "" },
      { id: "home", name: "Home", createdAt: "" },
    ],
    tickets: {
      default: [
        { id: 1, name: "Draft roadmap", project: "Planning" },
        { id: 2, name: "Fix login loop", project: "Web app", description: "Safari **only**" },
        { id: 3, name: "Book dentist", project: "Personal" },
        { id: 4, name: "Release notes", project: "Planning", status: "inprogress" },
      ],
      home: [{ id: 10, name: "Water plants" }],
    },
  });
});

async function renderApp() {
  render(<App />);
  await screen.findByText("Draft roadmap");
}

describe("App", () => {
  it("shows the open board's tickets in their columns and order", async () => {
    await renderApp();
    expect(titlesIn("To Do")).toEqual(["Draft roadmap", "Fix login loop", "Book dentist"]);
    expect(titlesIn("In Progress")).toEqual(["Release notes"]);
    // Card previews show plain text, not Markdown syntax.
    expect(screen.getByText("Safari only")).toBeTruthy();
  });

  it("quick-adds a ticket with just a title", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(within(column("Done")).getByRole("button", { name: /add ticket/i }));
    await user.type(screen.getByRole("textbox", { name: "New ticket in Done" }), "Ship v1{Enter}");
    await waitFor(() => expect(titlesIn("Done")).toEqual(["Ship v1"]));
    expect(backendState.tickets.default.at(-1)).toMatchObject({ name: "Ship v1", status: "done", project: "" });
  });

  it("filters by clicking a project on a card, and clears", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(within(column("To Do")).getAllByRole("button", { name: "Planning" })[0]);
    expect(titlesIn("To Do")).toEqual(["Draft roadmap"]);
    expect(titlesIn("In Progress")).toEqual(["Release notes"]);
    expect(screen.getByText("Showing 2 of 4")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(titlesIn("To Do")).toHaveLength(3);
  });

  it("filters from the filter menu", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Filter tickets" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Web app/ }));
    expect(titlesIn("To Do")).toEqual(["Fix login loop"]);
    expect(screen.getByRole("button", { name: "Filters (1 active)" })).toBeTruthy();
  });

  it("quick-adding while one project is filtered puts the ticket in that project", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(within(column("To Do")).getAllByRole("button", { name: "Planning" })[0]);
    await user.click(within(column("To Do")).getByRole("button", { name: /add ticket/i }));
    await user.type(screen.getByRole("textbox", { name: "New ticket in To Do" }), "Q2 goals{Enter}");
    await waitFor(() => expect(titlesIn("To Do")).toContain("Q2 goals"));
    expect(backendState.tickets.default.at(-1)?.project).toBe("Planning");
  });

  it("searches with whole words, not scattered letters", async () => {
    const user = userEvent.setup();
    await renderApp();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const search = await screen.findByRole("textbox", { name: "Search tickets" });
    await user.type(search, "login");
    expect(titlesIn("To Do")).toEqual(["Fix login loop"]);
    await user.clear(search);
    await user.type(search, "dnt"); // letters in "dentist" but not a word
    expect(titlesIn("To Do")).toEqual([]);
  });

  it("reorders the focused ticket with Alt+Arrow keys", async () => {
    await renderApp();
    // Focus the first To Do ticket, then move it down twice.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(titlesIn("To Do")).toEqual(["Fix login loop", "Book dentist", "Draft roadmap"]));
    await waitFor(() =>
      expect(backendState.tickets.default.filter((t) => t.status === "todo").map((t) => t.id)).toEqual([2, 3, 1]),
    );
  });

  it("moves a ticket by dragging it above another card", async () => {
    await renderApp();
    const dragged = screen.getByText("Book dentist").closest(".ticket")!;
    const target = within(column("In Progress")).getByText("Release notes").closest(".ticket") as HTMLElement;
    // jsdom has no layout: give the target card a position, then point above
    // its middle.
    target.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) });
    const dataTransfer = { setData: () => undefined, effectAllowed: "", dropEffect: "" };
    const at = (type: "dragOver" | "drop") => {
      const event = createEvent[type](target, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: 105 });
      fireEvent(target, event);
    };
    fireEvent.dragStart(dragged, { dataTransfer });
    at("dragOver");
    expect(column("In Progress").querySelector(".drop-indicator")).not.toBeNull();
    at("drop");
    await waitFor(() => expect(titlesIn("In Progress")).toEqual(["Book dentist", "Release notes"]));
  });

  it("keeps an unsaved new ticket as a draft and restores it", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /new ticket/i }));
    await user.type(await screen.findByLabelText("Name"), "Half an idea");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // draft autosave delay
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(backendState.drafts["new:default"].fields.name).toBe("Half an idea");

    await user.click(screen.getByRole("button", { name: /new ticket/i }));
    expect(await screen.findByDisplayValue("Half an idea")).toBeTruthy();
    expect(screen.getByText(/Restored your unsaved draft/)).toBeTruthy();
  });

  it("creates a ticket with only a name from the full form", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /new ticket/i }));
    await user.type(await screen.findByLabelText("Name"), "Name only");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(titlesIn("To Do")).toContain("Name only"));
  });

  it("edits and deletes comments from the ticket details", async () => {
    const user = userEvent.setup();
    backendState.tickets.default[0].comments = [{ id: 1, text: "Old text", timestamp: "Nov 25" }];
    await renderApp();
    await user.click(screen.getByText("Draft roadmap"));
    await user.click(await screen.findByRole("button", { name: "Edit comment" }));
    const box = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(box);
    await user.type(box, "New text{Enter}");
    await screen.findByText("New text");
    expect(backendState.tickets.default[0].comments[0].text).toBe("New text");

    await user.click(screen.getByRole("button", { name: "Delete comment" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("No comments yet.");
  });

  it("switches boards with Ctrl+2 and resets filters", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(within(column("To Do")).getAllByRole("button", { name: "Planning" })[0]);
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await screen.findByText("Water plants");
    expect(screen.queryByText("Showing", { exact: false })).toBeNull();
    expect(backendState.activeBoardId).toBe("home");
  });

  it("creates a job-search board from a template with its own columns", async () => {
    const user = userEvent.setup();
    await renderApp();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await user.click(await screen.findByRole("radio", { name: "Job search" }));
    expect(screen.getByLabelText("Board name")).toHaveProperty("value", "Job search");
    await user.click(screen.getByRole("button", { name: "Create board" }));

    for (const name of ["Wishlist", "Applied", "Interviewing", "Offer", "Rejected"]) {
      expect(await screen.findByRole("region", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();

    await user.click(within(column("Applied")).getByRole("button", { name: /add ticket/i }));
    await user.type(screen.getByRole("textbox", { name: "New ticket in Applied" }), "Acme{Enter}");
    await waitFor(() => expect(titlesIn("Applied")).toEqual(["Acme"]));
    const board = backendState.boards.at(-1)!;
    expect(backendState.tickets[board.id][0].status).toBe(board.columns![1].id);
  });

  it("renames and removes columns; tickets of a removed column move left", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByTitle(/switch board/i));
    await user.click(screen.getByRole("menuitem", { name: "Edit columns…" }));

    const name = await screen.findByRole("textbox", { name: "Column 1 name" });
    await user.clear(name);
    await user.type(name, "Backlog");
    await user.click(screen.getByRole("button", { name: "Remove In Progress" }));
    expect(screen.getByText("1 ticket in In Progress will move to Backlog.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add column" }));
    // The new column goes before the finished one, with its name field focused.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Column 2 name" }));
    await user.keyboard("Review");
    await user.click(screen.getByRole("button", { name: "Save columns" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "In Progress" })).toBeNull());
    expect(titlesIn("Backlog")).toEqual(["Draft roadmap", "Fix login loop", "Book dentist", "Release notes"]);
    expect(titlesIn("Review")).toEqual([]);
    expect(backendState.boards[0].columns!.map((c) => c.name)).toEqual(["Backlog", "Review", "Done"]);
    // The ticket form offers the new columns.
    await user.click(screen.getByText("Release notes"));
    await user.click(await screen.findByRole("button", { name: "Edit ticket" }));
    const options = within(screen.getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Backlog", "Review", "Done"]);
  });

  it("moves a focused ticket to the fourth column with the 4 key", async () => {
    backendState.boards[0].columns = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
      { id: "d", name: "D", done: true },
    ];
    for (const t of backendState.tickets.default) t.status = "a";
    await renderApp();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "4" });
    await waitFor(() => expect(titlesIn("D")).toEqual(["Draft roadmap"]));
    expect(backendState.tickets.default.find((t) => t.id === 1)!.status).toBe("d");
  });
});
