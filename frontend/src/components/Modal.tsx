import React from "react";
import { CloseIcon } from "../icons";

interface ModalProps {
  title?: React.ReactNode;
  className?: string;
  closeLabel?: string;
  onClose: () => void;
  /** Called for clicks on the dimmed backdrop; defaults to onClose. */
  onBackdropClick?: () => void;
  contentClassName?: string;
  children: React.ReactNode;
  id?: string;
}

/** The dimmed overlay and panel every dialog uses. */
export function Modal({
  title,
  className,
  closeLabel = "Close",
  onClose,
  onBackdropClick,
  contentClassName = "",
  children,
  id,
}: ModalProps) {
  return (
    <div
      id={id}
      className={`modal${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) (onBackdropClick ?? onClose)();
      }}
    >
      <div className={`modal-content ${contentClassName}`.trim()}>
        <button
          type="button"
          className="close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        {title && <div className="modal-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  name?: string;
  message: React.ReactNode;
  confirmLabel: string;
  icon: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, name, message, confirmLabel, icon, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div
      className="modal confirm-delete-overlay"
      role="alertdialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-delete-dialog">
        <div className="confirm-delete-icon">{icon}</div>
        <div className="confirm-delete-title">{title}</div>
        {name && <div className="confirm-delete-name">"{name}"</div>}
        <div className="confirm-delete-subtitle">{message}</div>
        <div className="confirm-delete-actions">
          <button type="button" className="confirm-delete-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="confirm-delete-confirm" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
