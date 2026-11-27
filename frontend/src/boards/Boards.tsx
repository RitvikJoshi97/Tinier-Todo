import React, { useEffect, useRef, useState } from "react";
import { main } from "../../wailsjs/go/models";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  PlusIcon,
} from "../icons";
import { shortcutText } from "../lib/platform";
import {
  BOARD_TEMPLATES,
  BoardColumn,
  MAX_COLUMNS,
  columnsError,
  removedColumnTargets,
} from "../lib/columns";

export type Board = main.Board;

// ---------- header switcher ----------

interface SwitcherProps {
  boards: Board[];
  activeBoardId: string;
  onSwitch: (id: string) => void;
  onNewBoard: () => void;
  onManage: () => void;
  onEditColumns: () => void;
}

export const BoardSwitcher: React.FC<SwitcherProps> = ({
  boards,
  activeBoardId,
  onSwitch,
  onNewBoard,
  onManage,
  onEditColumns,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = boards.find((board) => board.id === activeBoardId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="tools-menu-container board-switcher" ref={containerRef}>
      <button
        type="button"
        className="tools-btn board-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Switch board (${shortcutText("1")} to ${shortcutText("9")})`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="board-switcher-name">{active?.name ?? "Board"}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="tools-menu-dropdown board-menu" role="menu">
          {boards.map((board, idx) => (
            <button
              key={board.id}
              type="button"
              role="menuitemradio"
              aria-checked={board.id === activeBoardId}
              className={`tools-menu-item board-menu-item${board.id === activeBoardId ? " board-menu-item-active" : ""}`}
              onClick={() => choose(() => onSwitch(board.id))}
            >
              <span className="board-menu-check">
                {board.id === activeBoardId && <CheckIcon size={14} />}
              </span>
              <span className="board-menu-name">{board.name}</span>
              {idx < 9 && <kbd className="board-menu-kbd">{shortcutText(String(idx + 1))}</kbd>}
            </button>
          ))}
          <div className="board-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="tools-menu-item board-menu-item"
            onClick={() => choose(onNewBoard)}
          >
            <span className="board-menu-check" />
            <span className="board-menu-name">New board…</span>
            <kbd className="board-menu-kbd">{shortcutText("B")}</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="tools-menu-item board-menu-item"
            onClick={() => choose(onEditColumns)}
          >
            <span className="board-menu-check" />
            <span className="board-menu-name">Edit columns…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="tools-menu-item board-menu-item"
            onClick={() => choose(onManage)}
          >
            <span className="board-menu-check" />
            <span className="board-menu-name">Manage boards…</span>
          </button>
        </div>
      )}
    </div>
  );
};

// ---------- new / rename dialog ----------

interface NameModalProps {
  title: string;
  initialName?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

export const BoardNameModal: React.FC<NameModalProps> = ({
  title,
  initialName = "",
  submitLabel,
  onSubmit,
  onClose,
}) => {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSubmit(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content board-name-modal">
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="modal-title">{title}</div>
        <form onSubmit={submit}>
          <div className="form-group left-label">
            <label htmlFor="boardName">Board name</label>
            <input
              id="boardName"
              type="text"
              value={name}
              maxLength={60}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <div className="voice-error">{error}</div>}
          <div className="form-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving || !name.trim()}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ---------- manage dialog ----------

interface ManageProps {
  boards: Board[];
  activeBoardId: string;
  onRename: (board: Board) => void;
  onEditColumns: (board: Board) => void;
  onDelete: (board: Board) => void;
  onReorder: (ids: string[]) => void;
  onNewBoard: () => void;
  onClose: () => void;
}

export const ManageBoardsModal: React.FC<ManageProps> = ({
  boards,
  activeBoardId,
  onRename,
  onEditColumns,
  onDelete,
  onReorder,
  onNewBoard,
  onClose,
}) => {
  const move = (idx: number, direction: -1 | 1) => {
    const ids = boards.map((board) => board.id);
    const target = idx + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    onReorder(ids);
  };

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content manage-boards-modal">
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="modal-title">Manage boards</div>
        <div className="manage-boards-list">
          {boards.map((board, idx) => (
            <div key={board.id} className="manage-board-row">
              <div className="manage-board-name">
                {board.name}
                {board.id === activeBoardId && (
                  <span className="manage-board-badge">open</span>
                )}
              </div>
              <div className="manage-board-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${board.name} up`}
                  title="Move up"
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                >
                  <ArrowUpIcon size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${board.name} down`}
                  title="Move down"
                  disabled={idx === boards.length - 1}
                  onClick={() => move(idx, 1)}
                >
                  <ArrowDownIcon size={14} />
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => onRename(board)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => onEditColumns(board)}
                >
                  Columns
                </button>
                <button
                  type="button"
                  className="danger-btn"
                  disabled={boards.length === 1}
                  title={
                    boards.length === 1
                      ? "You can't delete the only board"
                      : undefined
                  }
                  onClick={() => onDelete(board)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mcp-actions">
          <button type="button" className="primary-button" onClick={onNewBoard}>
            New board…
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------- columns ----------

const copyColumns = (columns: BoardColumn[]) => columns.map((column) => ({ ...column }));

interface ColumnListProps {
  columns: BoardColumn[];
  onChange: (columns: BoardColumn[]) => void;
}

/** An editable, ordered list of columns: rename, mark finished, move, remove, add. */
export function ColumnListEditor({ columns, onChange }: ColumnListProps) {
  // Stable React keys for the rows, so a row keeps its input (and focus)
  // when rows above it move or are removed.
  const nextKey = useRef(0);
  const newKeys = (count: number) => Array.from({ length: count }, () => nextKey.current++);
  const [keys, setKeys] = useState(() => newKeys(columns.length));
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const rowKeys = keys.length === columns.length ? keys : newKeys(columns.length);
  if (rowKeys !== keys) setKeys(rowKeys); // the whole list was replaced (a template)

  const change = (next: BoardColumn[], nextKeys: number[]) => {
    setKeys(nextKeys);
    onChange(next);
  };
  const update = (index: number, patch: Partial<BoardColumn>) =>
    onChange(columns.map((column, i) => (i === index ? { ...column, ...patch } : column)));
  const move = (index: number, direction: -1 | 1) => {
    const next = [...columns];
    const nextKeys = [...rowKeys];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    [nextKeys[index], nextKeys[index + direction]] = [nextKeys[index + direction], nextKeys[index]];
    change(next, nextKeys);
  };

  return (
    <div className="column-editor">
      <div className="column-editor-head" aria-hidden="true">
        <span>Columns, left to right</span>
        <span title="Tickets here count as finished: no reminders or overdue colouring">Finished</span>
      </div>
      {columns.map((column, index) => (
        <div className="column-editor-row" key={rowKeys[index]}>
          <input
            type="text"
            value={column.name}
            maxLength={30}
            aria-label={`Column ${index + 1} name`}
            autoFocus={focusKey === rowKeys[index]}
            onChange={(e) => update(index, { name: e.target.value })}
          />
          <input
            type="checkbox"
            className="column-editor-done"
            checked={Boolean(column.done)}
            aria-label={`${column.name || `Column ${index + 1}`} holds finished tickets`}
            title="Tickets here count as finished"
            onChange={(e) => update(index, { done: e.target.checked })}
          />
          <span className="column-editor-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move ${column.name || "column"} up`}
              title="Move up (further left)"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move ${column.name || "column"} down`}
              title="Move down (further right)"
              disabled={index === columns.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${column.name || "column"}`}
              title="Remove column"
              disabled={columns.length === 1}
              onClick={() =>
                change(
                  columns.filter((_, i) => i !== index),
                  rowKeys.filter((_, i) => i !== index),
                )
              }
            >
              <CloseIcon size={14} />
            </button>
          </span>
        </div>
      ))}
      <button
        type="button"
        className="column-editor-add"
        disabled={columns.length >= MAX_COLUMNS}
        onClick={() => {
          // A new column goes before the finished ones at the end.
          let at = columns.length;
          while (at > 0 && columns[at - 1].done) at--;
          if (at === 0) at = columns.length;
          const key = nextKey.current++;
          const next = [...columns];
          const nextKeys = [...rowKeys];
          next.splice(at, 0, { id: "", name: "" });
          nextKeys.splice(at, 0, key);
          setFocusKey(key);
          change(next, nextKeys);
        }}
      >
        <PlusIcon size={14} /> Add column
      </button>
    </div>
  );
}

function useSubmit(onSubmit: () => Promise<void>) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };
  return { error, saving, submit };
}

interface NewBoardProps {
  onSubmit: (name: string, columns: BoardColumn[]) => Promise<void>;
  onClose: () => void;
}

export const NewBoardModal: React.FC<NewBoardProps> = ({ onSubmit, onClose }) => {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(0);
  const [columns, setColumns] = useState(() => copyColumns(BOARD_TEMPLATES[0].columns));
  const problem = columnsError(columns);
  const { error, saving, submit } = useSubmit(() =>
    onSubmit(name, columns.map((column) => ({ ...column, name: column.name.trim() }))),
  );

  const pick = (index: number) => {
    setTemplate(index);
    setColumns(copyColumns(BOARD_TEMPLATES[index].columns));
    if (!name.trim() && index > 0) setName(BOARD_TEMPLATES[index].name);
  };

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content board-name-modal columns-modal">
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="modal-title">New board</div>
        <form onSubmit={submit}>
          <div className="form-group left-label">
            <label htmlFor="boardName">Board name</label>
            <input
              id="boardName"
              type="text"
              value={name}
              maxLength={60}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-group left-label">
            <span className="form-label">Start from</span>
            <div className="template-picker" role="radiogroup" aria-label="Start from">
              {BOARD_TEMPLATES.map((t, index) => (
                <button
                  key={t.name}
                  type="button"
                  role="radio"
                  aria-checked={template === index}
                  className={`template-chip${template === index ? " template-chip-active" : ""}`}
                  onClick={() => pick(index)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <ColumnListEditor columns={columns} onChange={setColumns} />
          {(error || (problem && columns.every((c) => c.name.trim()))) && (
            <div className="voice-error">{error || problem}</div>
          )}
          <div className="form-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving || !name.trim() || Boolean(problem)}>
              Create board
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface EditColumnsProps {
  board: Board;
  columns: BoardColumn[];
  /** Tickets per column id, when known (the open board). */
  ticketCounts?: Record<string, number>;
  onSubmit: (columns: BoardColumn[]) => Promise<void>;
  onClose: () => void;
}

export const EditColumnsModal: React.FC<EditColumnsProps> = ({
  board,
  columns: initial,
  ticketCounts,
  onSubmit,
  onClose,
}) => {
  const [columns, setColumns] = useState(() => copyColumns(initial));
  const problem = columnsError(columns);
  const { error, saving, submit } = useSubmit(() =>
    onSubmit(columns.map((column) => ({ ...column, name: column.name.trim() }))),
  );

  const moves = Array.from(removedColumnTargets(initial, columns).entries())
    .map(([id, target]) => ({
      from: initial.find((c) => c.id === id)!,
      to: target,
      count: ticketCounts?.[id],
    }))
    .filter((move) => move.count === undefined || move.count > 0);

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content board-name-modal columns-modal">
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="modal-title">Columns of {board.name}</div>
        <form onSubmit={submit}>
          <ColumnListEditor columns={columns} onChange={setColumns} />
          {moves.length > 0 && (
            <ul className="column-moves" role="status">
              {moves.map((move) => (
                <li key={move.from.id}>
                  {move.count === undefined
                    ? `Tickets in ${move.from.name}`
                    : `${move.count} ${move.count === 1 ? "ticket" : "tickets"} in ${move.from.name}`}{" "}
                  will move to {move.to.name.trim() || "the first column"}.
                </li>
              ))}
            </ul>
          )}
          {(error || (problem && columns.every((c) => c.name.trim()))) && (
            <div className="voice-error">{error || problem}</div>
          )}
          <div className="form-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving || Boolean(problem)}>
              Save columns
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
