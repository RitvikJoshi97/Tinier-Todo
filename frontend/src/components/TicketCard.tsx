import React from "react";
import { CalendarIcon, LinkIcon } from "../icons";
import { Ticket, formatDeadline, getDeadlineState } from "../lib/tickets";
import { openExternal, safeLinkHref, stripMarkdown } from "../lib/markdown";
import { projectHueStyle } from "../projectColor";

interface Props {
  ticket: Ticket;
  focused: boolean;
  entering: boolean;
  hasDraft: boolean;
  /** In a finished column: deadlines are no longer highlighted. */
  done: boolean;
  cardRef: (el: HTMLDivElement | null) => void;
  onOpen: () => void;
  onProjectClick: (project: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: React.DragEvent<HTMLDivElement>) => void;
}

export function TicketCard({
  ticket,
  focused,
  entering,
  hasDraft,
  done,
  cardRef,
  onOpen,
  onProjectClick,
  onDragStart,
  onDragEnd,
}: Props) {
  const deadlineState = done ? "" : getDeadlineState(ticket.deadline);
  const linkHref = safeLinkHref(ticket.link);
  const preview = ticket.description ? stripMarkdown(ticket.description) : "";
  const classes = ["ticket", entering && "ticket-enter", focused && "ticket-focused"]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={cardRef}
      className={classes}
      data-ticket-id={ticket.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={projectHueStyle(ticket.project)}
    >
      <div className="ticket-title">
        <span>{ticket.name}</span>
        {hasDraft && (
          <span className="ticket-draft-badge" title="Has an unsaved draft">
            Draft
          </span>
        )}
      </div>
      {preview && <div className="ticket-desc">{preview}</div>}
      {(ticket.project || linkHref || ticket.deadline) && (
        <div className="ticket-meta">
          {ticket.project && (
            <button
              type="button"
              className="project-chip project-chip-button"
              title={`Show only ${ticket.project}`}
              onClick={(e) => {
                e.stopPropagation();
                onProjectClick(ticket.project);
              }}
            >
              <span className="project-dot" />
              {ticket.project}
            </button>
          )}
          <span className="ticket-meta-spacer" />
          {linkHref && (
            <a
              className="ticket-link"
              href={linkHref}
              title={linkHref}
              aria-label="Open link"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openExternal(linkHref);
              }}
            >
              <LinkIcon size={13} />
            </a>
          )}
          {ticket.deadline && (
            <span
              className={`ticket-deadline${deadlineState ? ` deadline-${deadlineState}` : ""}`}
              title={deadlineState === "overdue" ? `Overdue (due ${ticket.deadline})` : `Due ${ticket.deadline}`}
            >
              <CalendarIcon size={12} />
              {formatDeadline(ticket.deadline)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
