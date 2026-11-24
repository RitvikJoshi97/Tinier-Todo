import React from "react";
import "./TicketDetails.css";

type Comment = {
  text: string;
  timestamp: string;
};

export type Ticket = {
  id: number;
  name: string;
  description: string;
  project: string;
  link?: string;
  deadline: string;
  status: "todo" | "inprogress" | "done";
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
}

// Utility to generate a color from a string (project name)
function getProjectColor(project: string): string {
  // Simple hash to generate a color
  let hash = 0;
  for (let i = 0; i < project.length; i++) {
    hash = project.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Convert hash to hex color
  const color = `hsl(${hash % 360}, 70%, 60%)`;
  return color;
}

const statusLabels: Record<Ticket["status"], string> = {
  todo: "To Do",
  inprogress: "In Progress",
  done: "Done",
};

const TicketDetails: React.FC<TicketDetailsProps> = ({
  ticket,
  show,
  onClose,
  onEdit,
  onDelete,
  comment,
  setComment,
  onAddComment,
}) => {
  if (!show || !ticket) return null;

  const handleCommentKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onAddComment();
    }
  };

  return (
    <div
      id="ticketDetailsModal"
      className="modal"
      onClick={(e) => {
        // Close when clicking the backdrop
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content">
        <button
          className="edit-ticket-btn"
          aria-label="Edit ticket"
          title="Edit ticket"
          onClick={() => onEdit(ticket)}
        >
          ✎
        </button>
        <button
          className="delete-ticket-btn"
          aria-label="Delete ticket"
          title="Delete ticket"
          onClick={() => onDelete(ticket)}
        >
          🗑
        </button>
        <span
          className="close"
          aria-label="Close modal (Esc)"
          onClick={onClose}
        >
          &times;
        </span>
        <div className="ticket-details">
          <h2>{ticket.name}</h2>
          <p>
            <strong>Status:</strong>{" "}
            <span className={`status-badge status-${ticket.status}`}>
              {statusLabels[ticket.status]}
            </span>
          </p>
          <p>
            <strong>Description:</strong> {ticket.description}
          </p>
          <p>
            <strong>Project:</strong> {ticket.project}
          </p>
          {ticket.link && (
            <p>
              <strong>Link:</strong>{" "}
              <a href={ticket.link} target="_blank" rel="noopener noreferrer">
                {ticket.link}
              </a>
            </p>
          )}
          <p>
            <strong>Deadline:</strong> {ticket.deadline}
          </p>
        </div>
        <div className="comments-section">
          <h3 className="comments-heading">Comments</h3>
          <div id="commentsList">
            {ticket.comments && ticket.comments.length > 0 ? (
              ticket.comments.map((c, idx) => (
                <div key={idx} className="comment">
                  <div className="comment-content">
                    <div className="comment-text">{c.text}</div>
                    <div className="comment-timestamp">{c.timestamp}</div>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: "#888", fontStyle: "italic" }}>
                No comments yet.
              </div>
            )}
          </div>
          <textarea
            id="newComment"
            placeholder="Add a comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={handleCommentKeyDown}
            style={{ marginTop: 12 }}
          />
          <button
            id="addCommentBtn"
            onClick={onAddComment}
            style={{ marginTop: 8 }}
          >
            Add Comment
          </button>
        </div>
      </div>
    </div>
  );
};

export default TicketDetails;
