import { useEffect, useRef } from "react";

import { DANGER_BTN, GHOST_BTN } from "./styles";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, title, message, confirmLabel = "Remove", onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="m-auto max-w-[420px] w-full rounded-3xl border border-[rgba(165,185,255,0.12)] bg-[rgba(14,22,40,0.97)] p-6 text-[#eef4ff] shadow-[0_32px_80px_rgba(0,0,0,0.5)] backdrop:bg-[rgba(0,0,0,0.55)]"
      onCancel={onCancel}
    >
      <h3 className="m-0 mb-2 text-lg font-semibold text-[#ff9e9e]">{title}</h3>
      <p className="m-0 mb-6 text-sm text-[#9aa8c7] leading-relaxed">{message}</p>
      <div className="flex items-center gap-3">
        <button type="button" className={GHOST_BTN + " flex-1"} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={DANGER_BTN + " flex-1"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
