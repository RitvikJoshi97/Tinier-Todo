/*
 * Keyboard conventions differ by platform: macOS uses ⌘ (Command) where
 * Windows and Linux use Ctrl. On macOS, Ctrl+letter keys are text-editing
 * shortcuts (Ctrl+D deletes forward, Ctrl+F moves forward…) and Ctrl+←/→
 * switch desktops, so the app must not take them over there.
 */

/** True on macOS. Read on every call, so tests can change it. */
export function isMac(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac/i.test(platform);
}

/**
 * True when the platform's shortcut modifier is held: ⌘ on macOS, Ctrl
 * elsewhere. The other one must not be held, so macOS text-editing keys and
 * Windows-key combinations pass through.
 */
export function hasModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Labels of the modifier keys, as they're printed on the keyboard. */
export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

export function altLabel(): string {
  return isMac() ? "⌥" : "Alt";
}

export function deleteLabel(): string {
  return isMac() ? "⌫" : "Del";
}

/**
 * A shortcut written out for a tooltip, with the platform's modifier first:
 * "⇧⌘N" on macOS (Apple's order: ⌥ ⇧ ⌘), "Ctrl+Shift+N" elsewhere.
 */
export function shortcutText(...keys: string[]): string {
  if (!isMac()) return ["Ctrl", ...keys].join("+");
  const alt = keys.includes("Alt") ? "⌥" : "";
  const shift = keys.includes("Shift") ? "⇧" : "";
  return alt + shift + "⌘" + keys.filter((key) => key !== "Alt" && key !== "Shift").join("");
}
