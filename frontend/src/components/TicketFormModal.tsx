import React, { useState } from "react";
import { Modal } from "./Modal";
import { Board } from "../boards/Boards";
import { TicketForm } from "../lib/tickets";
import { BoardColumn } from "../lib/columns";
import { Markdown, safeLinkHref } from "../lib/markdown";
import { formatDraftAge } from "../drafts";

interface Props {
  form: TicketForm;
  /** Columns of the open board, for the Status select. */
  columns: BoardColumn[];
  editing: boolean;
  boards: Board[];
  boardId: string;
  projectSuggestions: string[];
  draftNotice: { updatedAt: string } | null;
  error: string;
  saving: boolean;
  shake: boolean;
  listening: boolean;
  onChange: (form: TicketForm) => void;
  onBoardChange: (boardId: string) => void;
  onDiscardDraft: () => void;
  onSubmit: () => void;
  onClose: () => void;
  onBackdropClick: () => void;
}

export function TicketFormModal({
  form,
  columns,
  editing,
  boards,
  boardId,
  projectSuggestions,
  draftNotice,
  error,
  saving,
  shake,
  listening,
  onChange,
  onBoardChange,
  onDiscardDraft,
  onSubmit,
  onClose,
  onBackdropClick,
}: Props) {
  const [preview, setPreview] = useState(false);
  const set = <K extends keyof TicketForm>(key: K, value: TicketForm[K]) =>
    onChange({ ...form, [key]: value });
  const linkInvalid = form.link.trim() !== "" && safeLinkHref(form.link) === null;
  const age = draftNotice ? formatDraftAge(draftNotice.updatedAt) : "";

  return (
    <Modal
      id="ticketModal"
      title={editing ? "Edit ticket" : "New ticket"}
      closeLabel="Close (your draft is kept)"
      contentClassName={shake ? "modal-shake" : ""}
      onClose={onClose}
      onBackdropClick={onBackdropClick}
    >
      {draftNotice && (
        <div className="draft-notice" role="status">
          <span>Restored your unsaved draft{age ? ` from ${age}` : ""}.</span>
          <button type="button" className="draft-discard-btn" onClick={onDiscardDraft}>
            Discard draft
          </button>
        </div>
      )}
      <form
        id="ticketForm"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="form-group span-2">
          <label htmlFor="ticketName">Name</label>
          <input
            type="text"
            id="ticketName"
            required
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
          />
        </div>

        <div className="form-group span-2">
          <div className="label-row">
            <label htmlFor="ticketDescription">
              Description <span className="label-hint">optional</span>
              {listening && <span className="voice-inline-status"> · Listening… press Space to stop</span>}
            </label>
            <button
              type="button"
              className="link-button"
              aria-pressed={preview}
              onClick={() => setPreview((prev) => !prev)}
            >
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="markdown-preview">
              {form.description.trim() ? (
                <Markdown text={form.description} />
              ) : (
                <span className="label-hint">Nothing to preview.</span>
              )}
            </div>
          ) : (
            <textarea
              id="ticketDescription"
              value={form.description}
              placeholder="Supports Markdown: **bold**, *italic*, - lists, [links](https://…)"
              onChange={(e) => set("description", e.target.value)}
            />
          )}
        </div>

        <div className="form-group">
          <label htmlFor="ticketProject">
            Project <span className="label-hint">optional</span>
          </label>
          <input
            type="text"
            id="ticketProject"
            value={form.project}
            onChange={(e) => set("project", e.target.value)}
            list="projectSuggestions"
            placeholder="Choose or type a new one"
          />
          <datalist id="projectSuggestions">
            {projectSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        <div className="form-group">
          <label htmlFor="ticketStatus">Status</label>
          <select
            id="ticketStatus"
            value={form.status}
            onChange={(e) => set("status", e.target.value as TicketForm["status"])}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
        </div>

        {editing && boards.length > 1 && (
          <div className="form-group span-2">
            <label htmlFor="ticketBoardSelect">Board</label>
            <select id="ticketBoardSelect" value={boardId} onChange={(e) => onBoardChange(e.target.value)}>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="ticketLink">
            Link <span className="label-hint">optional</span>
          </label>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            id="ticketLink"
            value={form.link}
            placeholder="https://"
            aria-invalid={linkInvalid}
            aria-describedby={linkInvalid ? "ticketLinkError" : undefined}
            onChange={(e) => set("link", e.target.value)}
          />
          {linkInvalid && (
            <div id="ticketLinkError" className="field-error">
              Use a web address (https://…) or mailto:
            </div>
          )}
        </div>

        <div className="form-group">
          <label htmlFor="ticketDeadline">
            Deadline <span className="label-hint">optional</span>
          </label>
          <input
            type="date"
            id="ticketDeadline"
            value={form.deadline}
            onChange={(e) => set("deadline", e.target.value)}
          />
        </div>

        {error && <div className="voice-error span-2">{error}</div>}
        <div className="form-actions span-2">
          <span className="form-actions-hint">Esc closes · your draft is kept</span>
          <button type="button" className="secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving || !form.name.trim()}>
            {editing ? "Save changes" : "Create ticket"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
