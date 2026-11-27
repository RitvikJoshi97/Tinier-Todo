import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TicketDetails, { Ticket } from "./TicketDetails";

const ticket: Ticket = {
  id: 7,
  name: "Write release notes",
  description: "Cover **boards** and drafts",
  project: "Planning",
  deadline: "2026-12-01",
  status: "inprogress",
  comments: [
    { id: 1, text: "First draft is up", timestamp: "Nov 25" },
    { id: 2, text: "Needs screenshots", timestamp: "Nov 26", editedAt: "2026-11-26T10:00:00Z" },
  ],
};

function renderDetails(overrides: Partial<React.ComponentProps<typeof TicketDetails>> = {}) {
  const props = {
    ticket,
    show: true,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    comment: "",
    setComment: vi.fn(),
    onAddComment: vi.fn(),
    onEditComment: vi.fn().mockResolvedValue(true),
    onDeleteComment: vi.fn(),
    statusName: "In Progress",
    statusTone: "inprogress" as const,
    ...overrides,
  };
  render(<TicketDetails {...props} />);
  return props;
}

describe("TicketDetails", () => {
  it("renders the description as Markdown and marks edited comments", () => {
    renderDetails();
    expect(screen.getByText("boards").tagName).toBe("STRONG");
    expect(screen.getByText(/· edited/)).toBeTruthy();
  });

  it("edits a comment inline; Enter saves, Esc cancels", async () => {
    const user = userEvent.setup();
    const props = renderDetails();

    await user.click(screen.getAllByRole("button", { name: "Edit comment" })[0]);
    const box = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(box);
    await user.type(box, "First draft is up, v2{Enter}");
    expect(props.onEditComment).toHaveBeenCalledWith(1, "First draft is up, v2");

    await user.click(screen.getAllByRole("button", { name: "Edit comment" })[1]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled(); // Esc only left the editor
  });

  it("asks before deleting a comment", async () => {
    const user = userEvent.setup();
    const props = renderDetails();

    await user.click(screen.getAllByRole("button", { name: "Delete comment" })[1]);
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onDeleteComment).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Delete comment" })[1]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDeleteComment).toHaveBeenCalledWith(2);
  });

  it("offers to add a description when there is none", async () => {
    const user = userEvent.setup();
    const props = renderDetails({ ticket: { ...ticket, description: "" } });
    await user.click(screen.getByRole("button", { name: "Add a description…" }));
    expect(props.onEdit).toHaveBeenCalled();
  });
});
