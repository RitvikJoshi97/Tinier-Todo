import React, { useEffect, useState } from "react";
import { projectHueStyle } from "../projectColor";
import { Markdown, openExternal, safeLinkHref } from "../lib/markdown";
import { CalendarIcon, CloseIcon, LinkIcon, PencilIcon, TrashIcon } from "../icons";

type Comment = {
  id: number;
  text: string;
  timestamp: string;
  editedAt?: string;
};

export type Ticket = {
  id: number;
  name: string;
  description: string;
  project: string;
  link?: string;
  deadline: string;
  /** The id of the ticket's column. */
  status: string;
  comments?: Comment[];
};

interface TicketDetailsProps {
  ticket: Ticket | null;
  show: boolean;
  onClose: () => void;
  onEdit: (ticket: Ticket) => void;
  onDelete: (ticket: Ticket) => void;
  comment: string;
  setComment: (c: string) => void;
  onAddComment: () => void;
  /** Resolves to true once saved. */
  onEditComment: (commentId: number, text: string) => Promise<boolean>;
  onDeleteComment: (commentId: number) => void;
  /** Name of the ticket's column. */
  statusName: string;
  statusTone: "todo" | "inprogress" | "done";
}

function CommentItem({
  comment,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  onEdit: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(comment.text);

  useEffect(() => {
    if (!editing) setText(comment.text);
  }, [comment.text, editing]);

  const save = async () => {
    if (!text.trim()) return;
    if (text === comment.text || (await onEdit(text))) setEditing(false);
  };

  if (editing) {
    return (
      <div className="comment comment-editing">
        <textarea
          value={text}
          aria-label="Edit comment"
          autoFocus
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
        <div className="comment-edit-actions">
          <button type="button" className="secondary-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={!text.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="comment">
      <Markdown text={comment.text} className="comment-text" />
      <div className="comment-footer">
        <span className="comment-timestamp">
          {comment.timestamp}
          {comment.editedAt && <span title={new Date(comment.editedAt).toLocaleString()}> · edited</span>}
        </span>
        {confirming ? (
          <span className="comment-actions comment-actions-visible">
            <span className="comment-confirm-text">Delete this comment?</span>
            <button type="button" className="link-button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="link-button link-button-danger" onClick={onDelete}>
              Delete
            </button>
          </span>
        ) : (
          <span className="comment-actions">
            <button
              type="button"
              className="toolbar-btn toolbar-btn-small"
              aria-label="Edit comment"
              title="Edit comment"
              onClick={() => setEditing(true)}
            >
              <PencilIcon size={13} />
            </button>
            <button
              type="button"
              className="toolbar-btn toolbar-btn-small toolbar-btn-danger"
              aria-label="Delete comment"
              title="Delete comment"
              onClick={() => setConfirming(true)}
            >
              <TrashIcon size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

const TicketDetails: React.FC<TicketDetailsProps> = ({
  ticket,
  show,
  onClose,
  onEdit,
  onDelete,
  comment,
  setComment,
  onAddComment,
  onEditComment,
  onDeleteComment,
  statusName,
  statusTone,
}) => {
  if (!show || !ticket) return null;

  const handleCommentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onAddComment();
    }
  };

  const comments = ticket.comments ?? [];
  const linkHref = safeLinkHref(ticket.link);

  return (
    <div
      id="ticketDetailsModal"
      className="modal"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content details-modal">
        <div className="details-header">
          <div className="details-tags">
            <span className={`status-badge status-${statusTone}`}>{statusName}</span>
            {ticket.project && (
              <span className="project-chip" style={projectHueStyle(ticket.project)}>
                <span className="project-dot" />
                {ticket.project}
              </span>
            )}
          </div>
          <div className="details-toolbar">
            <button
              type="button"
              className="toolbar-btn"
              aria-label="Edit ticket"
              title="Edit ticket"
              onClick={() => onEdit(ticket)}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="toolbar-btn toolbar-btn-danger"
              aria-label="Delete ticket"
              title="Delete ticket"
              onClick={() => onDelete(ticket)}
            >
              <TrashIcon />
            </button>
            <button type="button" className="toolbar-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <h2 className="details-title">{ticket.name}</h2>
        {ticket.description ? (
          <Markdown text={ticket.description} className="details-description" />
        ) : (
          <button type="button" className="details-add-description" onClick={() => onEdit(ticket)}>
            Add a description…
          </button>
        )}

        {(ticket.deadline || ticket.link) && (
          <div className="details-meta">
            {ticket.deadline && (
              <div className="details-meta-item">
                <CalendarIcon size={14} />
                <span>Due {ticket.deadline}</span>
              </div>
            )}
            {ticket.link && (
              <div className="details-meta-item">
                <LinkIcon size={14} />
                {linkHref ? (
                  <a
                    href={linkHref}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternal(linkHref);
                    }}
                  >
                    {ticket.link}
                  </a>
                ) : (
                  <span title="Only web and email links can be opened">{ticket.link}</span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="comments-section">
          <h3 className="comments-heading">
            Comments
            {comments.length > 0 && <span className="comments-count">{comments.length}</span>}
          </h3>
          <div id="commentsList">
            {comments.length > 0 ? (
              comments.map((c) => (
                <CommentItem
                  key={c.id}
                  comment={c}
                  onEdit={(text) => onEditComment(c.id, text)}
                  onDelete={() => onDeleteComment(c.id)}
                />
              ))
            ) : (
              <div className="comments-empty">No comments yet.</div>
            )}
          </div>
          <div className="comment-composer">
            <textarea
              id="newComment"
              placeholder="Write a comment… (Enter to send, Shift+Enter for a new line)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              rows={2}
            />
            <button
              id="addCommentBtn"
              type="button"
              className="primary-button"
              disabled={!comment.trim()}
              onClick={onAddComment}
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TicketDetails;
