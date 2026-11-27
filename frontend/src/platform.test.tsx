import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { HelpModal } from "./components/dialogs";
import { hasModifier, shortcutText } from "./lib/platform";
import { backendState, resetBackend } from "./test/fakeBackend";

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  resetBackend({
    boards: [
      { id: "default", name: "Product", createdAt: "" },
      { id: "home", name: "Home", createdAt: "" },
    ],
    tickets: { default: [{ id: 1, name: "Draft roadmap" }], home: [{ id: 10, name: "Water plants" }] },
  });
});
afterEach(() => setPlatform(""));

describe("on macOS", () => {
  beforeEach(() => setPlatform("MacIntel"));

  it("uses ⌘ and leaves Ctrl to text editing", () => {
    expect(hasModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(hasModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(shortcutText("N")).toBe("⌘N");
    expect(shortcutText("Shift", "N")).toBe("⇧⌘N");
  });

  it("switches boards with ⌘2 but not Ctrl+2", async () => {
    render(<App />);
    await screen.findByText("Draft roadmap");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(backendState.activeBoardId).toBe("default");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await screen.findByText("Water plants");
    expect(screen.getByTitle("Search tickets (⌘F)")).toBeTruthy();
  });

  it("shows ⌘, ⌥ and ⌫ in the shortcut list", () => {
    render(<HelpModal onClose={() => undefined} />);
    expect(screen.getAllByText("⌘").length).toBeGreaterThan(3);
    expect(screen.getByText("⌥")).toBeTruthy();
    expect(screen.getByText("⌫")).toBeTruthy();
    expect(screen.queryByText("Ctrl")).toBeNull();
  });
});

describe("on Windows and Linux", () => {
  beforeEach(() => setPlatform("Win32"));

  it("uses Ctrl, and ignores the Windows key", () => {
    expect(hasModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(hasModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(shortcutText("Shift", "N")).toBe("Ctrl+Shift+N");
    render(<HelpModal onClose={() => undefined} />);
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(3);
    expect(screen.getByText("Del")).toBeTruthy();
  });
});
