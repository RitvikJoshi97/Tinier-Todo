import type React from "react";

// A stable hue per project name, used for the small colour accent on cards
// and in the ticket details dialog.
export function getProjectHue(projectName: string): number | null {
  const normalized = projectName.trim().toLowerCase();
  if (!normalized) return null;

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

export function projectHueStyle(projectName: string): React.CSSProperties | undefined {
  const hue = getProjectHue(projectName);
  return hue === null ? undefined : ({ "--project-hue": hue } as React.CSSProperties);
}
