import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { MCPModal, SettingsModal } from "./components/dialogs";
import { safeLinkHref } from "./lib/markdown";
import { backendState, resetBackend } from "./test/fakeBackend";
import { BrowserOpenURL, ClipboardSetText } from "../wailsjs/runtime/runtime";

beforeEach(() => {
  resetBackend({
    tickets: {
      default: [
        // Saved by an older version, before links were checked.
        { id: 1, name: "Old ticket", link: "file:///Applications/Calculator.app" },
        { id: 2, name: "Web ticket", link: "example.com/docs" },
      ],
    },
  });
});

describe("links", () => {
  it("only opens web and email links", () => {
    expect(safeLinkHref("https://example.com")).toBe("https://example.com");
    expect(safeLinkHref(" example.com/a ")).toBe("https://example.com/a");
    expect(safeLinkHref("mailto:me@example.com")).toBe("mailto:me@example.com");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "smb://host/share", "https://", ""]) {
      expect(safeLinkHref(bad)).toBeNull();
    }
  });

  it("shows unsafe links as plain text and opens safe ones with https://", async () => {
    render(<App />);
    expect(await screen.findByText("Old ticket")).toBeTruthy();
    // Only the safe ticket gets a link button on its card.
    const cardLinks = screen.getAllByRole("link", { name: "Open link" });
    expect(cardLinks).toHaveLength(1);
    fireEvent.click(cardLinks[0]);
    expect(BrowserOpenURL).toHaveBeenCalledWith("https://example.com/docs");

    fireEvent.click(screen.getByText("Old ticket"));
    const text = await screen.findByText("file:///Applications/Calculator.app");
    expect(text.tagName).toBe("SPAN");
  });

  it("won't save a ticket with an unsafe link", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(await screen.findByText("Web ticket"));
    await user.click(await screen.findByRole("button", { name: "Edit ticket" }));
    const link = screen.getByLabelText(/^Link/);
    await user.clear(link);
    await user.type(link, "vscode://evil");
    expect(screen.getByText("Use a web address (https://…) or mailto:")).toBeTruthy();
    expect(link.getAttribute("aria-invalid")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/invalid link "vscode:\/\/evil"/)).toBeTruthy();
    expect(backendState.tickets.default.find((t) => t.id === 2)?.link).toBe("example.com/docs");
  });
});

describe("MCP settings", () => {
  it("hides the token until asked, copies the real one and can replace it", async () => {
    const user = userEvent.setup();

    render(<MCPModal onClose={() => undefined} />);
    const token = await screen.findByLabelText("Access token");
    await waitFor(() => expect(token.textContent).toMatch(/^•+$/));
    expect(screen.getAllByText(/Bearer •+/, { selector: "pre" })).toHaveLength(2);
    expect(screen.getByText("Off")).toBeTruthy(); // off until turned on

    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(ClipboardSetText).toHaveBeenCalledWith(
      'claude mcp add --transport http tinier-todo http://localhost:3535/mcp --header "Authorization: Bearer fake-token-1"',
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(token.textContent).toBe("fake-token-1");

    await user.click(screen.getByRole("button", { name: "New token…" }));
    expect(screen.getByText(/Clients using the current token will stop working/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Make new token" }));
    await waitFor(() => expect(token.textContent).toBe("fake-token-2"));
    expect(screen.getByText(/Update your MCP clients/)).toBeTruthy();
  });
});

describe("Settings", () => {
  it("warns when FileVault is off", async () => {
    render(<SettingsModal onClose={() => undefined} />);
    expect(await screen.findByText(/FileVault is off/)).toBeTruthy();
  });
});
