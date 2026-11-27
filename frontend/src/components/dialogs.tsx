import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  DiskEncryption,
  GetMCPSettings,
  GetSettings,
  RegenerateMCPToken,
  SaveSettings,
  SendTestReminder,
  UpdateMCPSettings,
} from "../../wailsjs/go/main/App";
import { main } from "../../wailsjs/go/models";
import { ClipboardSetText } from "../../wailsjs/runtime/runtime";
import { Modal } from "./Modal";
import { altLabel, deleteLabel, isMac, modLabel } from "../lib/platform";
import { DeletedTicket } from "../lib/tickets";
import { errorMessage } from "../voice/useVoiceInput";

// ---------- deleted tickets ----------

export function DeletedTicketsModal({
  tickets,
  boardName,
  onRestore,
  onClose,
}: {
  tickets: DeletedTicket[];
  boardName?: string;
  onRestore: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Deleted tickets" contentClassName="deleted-tickets-modal" onClose={onClose}>
      {boardName && <div className="modal-subtitle">On the board "{boardName}"</div>}
      {tickets.length === 0 ? (
        <div className="deleted-empty">No deleted tickets yet.</div>
      ) : (
        <div className="deleted-ticket-list">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="deleted-ticket-item">
              <div className="deleted-ticket-info">
                <div className="deleted-ticket-name">{ticket.name}</div>
                <div className="deleted-ticket-meta">
                  {[ticket.project, `Deleted ${new Date(ticket.deletedAt).toLocaleString()}`]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <button className="restore-ticket-btn" onClick={() => onRestore(ticket.id)}>
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------- MCP ----------

/**
 * Copies text with the system clipboard through Wails, which works in every
 * platform's web view; the browser clipboard API isn't available in all of
 * them (WebKitGTK on Linux).
 */
async function copyText(text: string) {
  try {
    if (await ClipboardSetText(text)) return;
  } catch {
    // fall back to the browser API
  }
  await navigator.clipboard.writeText(text);
}

const DEFAULT_MCP_PORT = 3535;
const HIDDEN_TOKEN = "••••••••••••••••";

export function buildMCPConfigSnippet(port: number, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "tinier-todo": {
          type: "http",
          url: `http://localhost:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

export function buildClaudeCommand(port: number, token: string): string {
  return `claude mcp add --transport http tinier-todo http://localhost:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

export function MCPModal({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState(String(DEFAULT_MCP_PORT));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmingNewToken, setConfirmingNewToken] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);

  const apply = (settings: Record<string, any>) => {
    if (typeof settings?.enabled === "boolean") setEnabled(settings.enabled);
    if (typeof settings?.port === "number") setPort(String(settings.port));
    if (typeof settings?.token === "string") setToken(settings.token);
  };

  useEffect(() => {
    GetMCPSettings()
      .then(apply)
      .catch(() => setFeedback("Couldn't load the MCP settings."));
  }, []);

  const parsed = Number.parseInt(port, 10);
  const effectivePort = parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_MCP_PORT;
  const shownToken = showToken ? token : HIDDEN_TOKEN;
  const snippet = useMemo(() => buildMCPConfigSnippet(effectivePort, shownToken), [effectivePort, shownToken]);
  const command = useMemo(() => buildClaudeCommand(effectivePort, shownToken), [effectivePort, shownToken]);

  const save = async () => {
    setSaving(true);
    try {
      apply((await UpdateMCPSettings(enabled, effectivePort)) as Record<string, any>);
      setFeedback("Saved.");
    } catch (error) {
      setFeedback(`Couldn't save: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    setConfirmingNewToken(false);
    try {
      apply((await RegenerateMCPToken()) as Record<string, any>);
      setFeedback("New token made. Update your MCP clients with it.");
    } catch (error) {
      setFeedback(`Couldn't make a new token: ${errorMessage(error)}`);
    }
  };

  // Copying always uses the real token, even while it's hidden.
  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      setFeedback(`${what} copied.`);
    } catch {
      setFeedback(`Couldn't copy the ${what.toLowerCase()}.`);
    }
  };

  return (
    <Modal title="MCP server" contentClassName="mcp-modal" onClose={onClose}>
      <div className="mcp-settings-grid">
        <div className="mcp-toggle-row">
          <div>
            <div className="mcp-setting-label">MCP server</div>
            <div className="mcp-setting-hint">
              Lets AI assistants on this computer read and update your boards. They need the access
              token below.
            </div>
          </div>
          <label className="mcp-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setFeedback("");
              }}
            />
            <span>{enabled ? "On" : "Off"}</span>
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="mcpPort">Port</label>
          <input
            id="mcpPort"
            type="number"
            min="1"
            max="65535"
            value={port}
            onChange={(e) => {
              setPort(e.target.value);
              setFeedback("");
            }}
          />
        </div>

        <div>
          <div className="mcp-setting-label">Access token</div>
          <div className="mcp-setting-hint">
            Clients send it as <code>Authorization: Bearer &lt;token&gt;</code>. Keep it private: anything
            with it can change your boards.
          </div>
          <div className="mcp-token-row">
            <code className="mcp-token" aria-label="Access token">
              {token ? shownToken : "…"}
            </code>
            <button type="button" className="secondary-btn" onClick={() => setShowToken((v) => !v)}>
              {showToken ? "Hide" : "Show"}
            </button>
            <button type="button" className="secondary-btn" disabled={!token} onClick={() => void copy(token, "Token")}>
              Copy
            </button>
            {confirmingNewToken ? (
              <span className="mcp-token-confirm">
                Clients using the current token will stop working.
                <button type="button" className="link-button" onClick={() => setConfirmingNewToken(false)}>
                  Cancel
                </button>
                <button type="button" className="link-button link-button-danger" onClick={() => void regenerate()}>
                  Make new token
                </button>
              </span>
            ) : (
              <button type="button" className="secondary-btn" onClick={() => setConfirmingNewToken(true)}>
                New token…
              </button>
            )}
          </div>
        </div>

        <div>
          <div className="mcp-setting-label">Endpoint</div>
          <div className="mcp-endpoint">http://localhost:{effectivePort}/mcp</div>
          <div className="mcp-setting-hint">
            Older clients that only support SSE can use http://localhost:{effectivePort}/sse?token=&lt;token&gt;.
          </div>
        </div>

        <div>
          <div className="mcp-setting-label">Claude Code</div>
          <div className="mcp-setting-hint">Run this in a terminal.</div>
          <pre className="mcp-snippet">{command}</pre>
        </div>

        <div>
          <div className="mcp-setting-label">Config snippet</div>
          <div className="mcp-setting-hint">For other clients: paste this into their MCP configuration.</div>
          <pre className="mcp-snippet">{snippet}</pre>
        </div>

        {feedback && <div className="mcp-feedback">{feedback}</div>}

        <div className="mcp-actions">
          <button
            type="button"
            className="mcp-copy-btn"
            disabled={!token}
            onClick={() => void copy(buildClaudeCommand(effectivePort, token), "Command")}
          >
            Copy command
          </button>
          <button
            type="button"
            className="mcp-copy-btn"
            disabled={!token}
            onClick={() => void copy(buildMCPConfigSnippet(effectivePort, token), "Snippet")}
          >
            Copy snippet
          </button>
          <button type="button" className="mcp-save-btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- settings ----------

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<main.Settings | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    GetSettings()
      .then(setSettings)
      .catch(() => setFeedback("Couldn't load the settings."));
  }, []);

  const update = useCallback(async (reminders: main.ReminderSettings) => {
    const next = main.Settings.createFrom({ reminders });
    setSettings(next);
    try {
      setSettings(await SaveSettings(next));
      setFeedback("");
    } catch (error) {
      setFeedback(`Couldn't save: ${errorMessage(error)}`);
    }
  }, []);

  const test = async () => {
    try {
      await SendTestReminder();
      setFeedback("Test notification sent. If nothing appeared, allow notifications for Tinier Todo in your system settings.");
    } catch (error) {
      setFeedback(`Couldn't show a notification: ${errorMessage(error)}`);
    }
  };

  const reminders = settings?.reminders;

  return (
    <Modal title="Settings" contentClassName="settings-modal" onClose={onClose}>
      <div className="settings-section">
        <div className="mcp-toggle-row">
          <div>
            <div className="mcp-setting-label">Deadline reminders</div>
            <div className="mcp-setting-hint">
              A notification for tickets that are due today or overdue, once a day per ticket.
              Reminders appear while Tinier Todo is open.
            </div>
          </div>
          <label className="mcp-toggle">
            <input
              type="checkbox"
              checked={Boolean(reminders?.enabled)}
              disabled={!reminders}
              onChange={(e) =>
                reminders && void update({ ...reminders, enabled: e.target.checked })
              }
            />
            <span>{reminders?.enabled ? "On" : "Off"}</span>
          </label>
        </div>

        <div className="settings-row">
          <div className="form-group">
            <label htmlFor="reminderHour">Remind me from</label>
            <select
              id="reminderHour"
              value={reminders?.hour ?? 9}
              disabled={!reminders?.enabled}
              onChange={(e) =>
                reminders && void update({ ...reminders, hour: Number(e.target.value) })
              }
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="secondary-btn"
            disabled={!reminders?.enabled}
            onClick={() => void test()}
          >
            Send a test notification
          </button>
        </div>

        {feedback && <div className="mcp-feedback">{feedback}</div>}
      </div>
      <PrivacySection />
    </Modal>
  );
}

/** Where the boards are kept, and whether the disk they're on is encrypted. */
function PrivacySection() {
  const [status, setStatus] = useState<{ state: string; name: string } | null>(null);

  useEffect(() => {
    DiskEncryption()
      .then(setStatus)
      .catch(() => setStatus({ state: "unknown", name: "" }));
  }, []);

  const mac = isMac();
  const windows = /win/i.test(navigator.platform || navigator.userAgent) && !mac;
  const howToTurnOn = mac
    ? "Turn it on in System Settings → Privacy & Security → FileVault."
    : windows
      ? "Turn it on in Settings → Privacy & security → Device encryption, or BitLocker on Pro editions."
      : "On Linux it is usually set up when installing, by choosing to encrypt the disk.";

  return (
    <div className="settings-section privacy-section">
      <div className="mcp-setting-label">Your data</div>
      <div className="mcp-setting-hint">
        Your boards are saved only on this computer, in the <code>.tinier-todo</code> folder of your home
        folder, which only your user account can open. They aren't encrypted by Tinier Todo itself.
      </div>
      {status?.state === "on" && (
        <div className="privacy-status privacy-ok">
          {status.name === "disk encryption" ? "Disk encryption" : status.name} is on, so they're encrypted on
          disk.
        </div>
      )}
      {status?.state === "off" && (
        <div className="privacy-status privacy-warn">
          {status.name === "disk encryption" ? "Disk encryption" : status.name} is off, so anyone who gets hold of
          this computer's disk could read them. {howToTurnOn}
        </div>
      )}
      {status?.state === "unknown" && (
        <div className="mcp-setting-hint">
          To protect them if your computer is lost or stolen, turn on disk encryption (FileVault on macOS,
          BitLocker or Device encryption on Windows, LUKS on Linux).
        </div>
      )}
    </div>
  );
}

// ---------- about ----------

export function AboutModal({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <Modal title="About Tinier Todo" contentClassName="help-modal about-modal" onClose={onClose}>
      <div className="about-content">
        <p>
          <strong>Made by:</strong> Ritvik Joshi
        </p>
        <p>
          <strong>Version:</strong> {version || "dev"}
        </p>
        <p>
          <strong>Licence:</strong> MIT
        </p>
        <p>
          <strong>Platform:</strong> Wails (Go + React)
        </p>
      </div>
    </Modal>
  );
}

// ---------- keyboard shortcuts ----------

/** The platform's shortcut modifier: ⌘ on macOS, Ctrl elsewhere. */
const Mod = () => <kbd>{modLabel()}</kbd>;

const shortcuts = (): { title: string; rows: [React.ReactNode, string][] }[] => [
  {
    title: "General",
    rows: [
      [<><Mod />+<kbd>N</kbd></>, "New ticket"],
      [<><Mod />+<kbd>F</kbd></>, "Search tickets"],
      [<><Mod />+<kbd>D</kbd></>, "Toggle dark mode"],
      [<><Mod />+<kbd>Shift</kbd>+<kbd>N</kbd></>, "Start voice input (macOS)"],
      [<kbd>Space</kbd>, "Stop voice input"],
      [<><Mod />+<kbd>/</kbd></>, "Show this help"],
      [<kbd>Esc</kbd>, "Close dialog (drafts are kept)"],
    ],
  },
  {
    title: "Boards",
    rows: [
      [<><Mod />+<kbd>1</kbd>…<kbd>9</kbd></>, "Switch to board 1–9"],
      [<><Mod />+<kbd>B</kbd></>, "New board"],
    ],
  },
  {
    title: "Navigation",
    rows: [
      [<><kbd>↑</kbd> <kbd>↓</kbd></>, "Move between tickets"],
      [<><kbd>←</kbd> <kbd>→</kbd></>, "Move between columns"],
      [<kbd>Tab</kbd>, "Next ticket"],
      [<><kbd>Shift</kbd>+<kbd>Tab</kbd></>, "Previous ticket"],
      [<><kbd>Tab</kbd> <kbd>Tab</kbd></>, "Next column"],
      [<kbd>Enter</kbd>, "Open ticket"],
    ],
  },
  {
    title: "Ticket actions",
    rows: [
      [<><kbd>{altLabel()}</kbd>+<kbd>↑</kbd> <kbd>↓</kbd></>, "Move ticket up / down"],
      [<><Mod />+<kbd>←</kbd> <kbd>→</kbd></>, "Move ticket to the previous / next column"],
      [<><kbd>1</kbd> … <kbd>9</kbd></>, "Move ticket to the first … ninth column"],
      [<kbd>{deleteLabel()}</kbd>, "Delete ticket"],
    ],
  },
  {
    title: "Ticket details",
    rows: [
      [<kbd>Enter</kbd>, "Post comment"],
      [<><kbd>Shift</kbd>+<kbd>Enter</kbd></>, "New line in comment"],
    ],
  },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" contentClassName="help-modal" onClose={onClose}>
      <div className="help-grid">
        {shortcuts().map((section) => (
          <div key={section.title} className="help-section">
            <h3>{section.title}</h3>
            {section.rows.map(([keys, label]) => (
              <div key={label} className="help-row">
                <span>{label}</span>
                <span className="help-keys">{keys}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------- toast ----------

export type Toast = { id: number; message: string; tone: "info" | "error" };

export function ToastMessage({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div
      key={toast.id}
      className={`toast toast-${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      {toast.message}
    </div>
  );
}
