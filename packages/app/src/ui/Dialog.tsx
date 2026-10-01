// A modal on the native <dialog>: focus trapping, Escape and the backdrop come with it.

import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog wide" : "dialog"}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
    >
      {open && (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2>{title}</h2>
            <button className="icon-button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
