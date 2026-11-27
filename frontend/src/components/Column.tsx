import React, { useEffect, useRef, useState } from "react";
import { Status, Ticket } from "../lib/tickets";
import { dropIndex } from "../lib/reorder";
import { QuickAdd } from "./QuickAdd";

interface Props {
  status: Status;
  title: string;
  tone: "todo" | "inprogress" | "done";
  tickets: Ticket[];
  /** Total in the column before search and filters. */
  total: number;
  narrowed: boolean;
  active: boolean;
  draggedId: number | null;
  renderCard: (ticket: Ticket, index: number) => React.ReactNode;
  onDropTicket: (status: Status, beforeId: number) => void;
  onQuickAdd: (status: Status, name: string) => Promise<boolean>;
}

/**
 * One board column. While a ticket is dragged over it, a line shows where it
 * will land; dropping places it above the ticket under that line.
 */
export function Column({
  status,
  title,
  tone,
  tickets,
  total,
  narrowed,
  active,
  draggedId,
  renderCard,
  onDropTicket,
  onQuickAdd,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    if (draggedId === null) setDropAt(null);
  }, [draggedId]);

  // The cards other than the one being dragged, in order.
  const others = tickets.filter((ticket) => ticket.id !== draggedId);

  const updateDropAt = (clientY: number) => {
    const list = listRef.current;
    if (!list || !Number.isFinite(clientY)) return;
    const mids = Array.from(list.querySelectorAll<HTMLElement>("[data-ticket-id]"))
      .filter((el) => Number(el.dataset.ticketId) !== draggedId)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
    setDropAt(dropIndex(clientY, mids));
  };

  // The line is drawn before the card at dropAt (in `others` order).
  const indicatorBefore = dropAt !== null && dropAt < others.length ? others[dropAt].id : null;
  const indicatorAtEnd = dropAt !== null && dropAt >= others.length;

  return (
    <section
      className={`column${dropAt !== null ? " drag-over" : ""}${active ? " column-active" : ""}`}
      aria-label={title}
      onDragOver={(e) => {
        if (draggedId === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        updateDropAt(e.clientY);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const index = dropAt ?? others.length;
        setDropAt(null);
        onDropTicket(status, others[index]?.id ?? 0);
      }}
    >
      <h2>
        <span className={`status-dot status-dot-${tone}`} />
        {title}
        <span className="column-match-count">
          {narrowed ? `${tickets.length} of ${total}` : total}
        </span>
      </h2>
      <div className="ticket-list" data-column={status} ref={listRef}>
        {tickets.map((ticket, index) => (
          <React.Fragment key={ticket.id}>
            {indicatorBefore === ticket.id && <div className="drop-indicator" />}
            {renderCard(ticket, index)}
          </React.Fragment>
        ))}
        {indicatorAtEnd && <div className="drop-indicator" />}
        {tickets.length === 0 && dropAt === null && (
          <div className="ticket-search-empty">{narrowed ? "No matches" : "No tickets"}</div>
        )}
        <QuickAdd
          columnTitle={title}
          alwaysVisible={total === 0}
          onAdd={(name) => onQuickAdd(status, name)}
        />
      </div>
    </section>
  );
}
