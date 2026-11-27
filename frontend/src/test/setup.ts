import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

vi.mock("../../wailsjs/go/main/App", () => import("./fakeBackend"));
vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: () => () => undefined,
  BrowserOpenURL: vi.fn(),
  ClipboardSetText: vi.fn(async () => true),
  Environment: async () => ({ platform: "darwin", arch: "arm64", buildType: "dev" }),
}));

// jsdom lacks these.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
Element.prototype.scrollIntoView = function scrollIntoView() {};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.className = "";
});
