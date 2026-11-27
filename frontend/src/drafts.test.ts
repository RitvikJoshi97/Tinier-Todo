import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDraftSaver } from "./drafts";
import { backendState, resetBackend } from "./test/fakeBackend";

describe("useDraftSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBackend();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves shortly after the last change", async () => {
    const { result } = renderHook(() => useDraftSaver(400));
    act(() => {
      result.current.schedule("new:default", { name: "a" });
      result.current.schedule("new:default", { name: "ab" });
    });
    expect(backendState.drafts["new:default"]).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(backendState.drafts["new:default"].fields).toEqual({ name: "ab" });
  });

  it("flush writes at once, cancel drops the pending write, null deletes", async () => {
    const { result } = renderHook(() => useDraftSaver(400));
    await act(async () => {
      result.current.schedule("new:default", { name: "now" });
      await result.current.flush();
    });
    expect(backendState.drafts["new:default"].fields.name).toBe("now");

    act(() => {
      result.current.schedule("new:default", { name: "never" });
      result.current.cancel();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(backendState.drafts["new:default"].fields.name).toBe("now");

    await act(async () => {
      result.current.schedule("new:default", null);
      await result.current.flush();
    });
    expect(backendState.drafts["new:default"]).toBeUndefined();
  });

  it("writes a pending draft before starting one for a different key", async () => {
    const { result } = renderHook(() => useDraftSaver(400));
    await act(async () => {
      result.current.schedule("comment:default:1", { text: "first" });
      result.current.schedule("comment:default:2", { text: "second" });
      await Promise.resolve();
    });
    expect(backendState.drafts["comment:default:1"].fields.text).toBe("first");
  });

  it("saves what is pending when unmounted", async () => {
    const { result, unmount } = renderHook(() => useDraftSaver(400));
    act(() => result.current.schedule("new:default", { name: "closing" }));
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(backendState.drafts["new:default"].fields.name).toBe("closing");
  });
});
