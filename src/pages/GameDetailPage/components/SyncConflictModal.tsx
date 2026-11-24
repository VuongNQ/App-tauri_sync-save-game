// ── SyncConflictModal ─────────────────────────────────────────────────────────

import { EYEBROW, GHOST_BTN, MUTED, PRIMARY_BTN } from "@/components/styles";
import { useT } from "@/i18n";
import { SyncStructureDiff } from "@/types/dashboard";
import { useState } from "react";
import { SyncMethod } from "../hooks";

interface SyncConflictModalProps {
  open: boolean;
  diff: SyncStructureDiff;
  onConfirm: (method: SyncMethod) => void;
  onCancel: () => void;
}

function SyncConflictModal({ open, diff, onConfirm, onCancel }: SyncConflictModalProps) {
  const [selected, setSelected] = useState<SyncMethod>("auto");
  const t = useT();

  if (!open) return null;

  const rows: Array<{ label: string; count: number; warn?: boolean }> = [
    { label: t("conflict.rowConflict"), count: diff.conflictFiles.length, warn: true },
    { label: t("conflict.rowLocalOnly"), count: diff.localOnlyFiles.length },
    { label: t("conflict.rowLocalDeleted"), count: diff.localDeletedFiles?.length ?? 0, warn: true },
    { label: t("conflict.rowCloudDeleted"), count: diff.cloudDeletedFiles?.length ?? 0, warn: true },
    {
      label: t("conflict.rowCloudOnly"),
      count: diff.cloudOnlyFiles.length,
    },
    {
      label: t("conflict.rowLocalNewer"),
      count: diff.localNewerFiles.length,
      warn: true,
    },
    {
      label: t("conflict.rowCloudNewer"),
      count: diff.cloudNewerFiles.length,
      warn: true,
    },
  ].filter((r) => r.count > 0);

  const methods: Array<{
    value: SyncMethod;
    label: string;
    description: string;
  }> = [
    {
      value: "auto",
      label: t("conflict.autoLabel"),
      description: t("conflict.autoDesc"),
    },
    {
      value: "restore",
      label: t("conflict.restoreLabel"),
      description: t("conflict.restoreDesc"),
    },
    {
      value: "push",
      label: t("conflict.pushLabel"),
      description: t("conflict.pushDesc"),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-conflict-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="w-full max-w-120 rounded-3xl border border-[rgba(165,185,255,0.15)] bg-[rgba(9,14,28,0.97)] p-6 shadow-2xl grid gap-5">
        {/* Header */}
        <div>
          <p className={EYEBROW}>{t("conflict.eyebrow")}</p>
          <h3 id="sync-conflict-title" className="m-0 mt-1">{t("conflict.title")}</h3>
        </div>

        {/* Diff summary */}
        <div className="grid gap-2">
          {rows.map((r) => (
            <div
              key={r.label}
              className={`flex items-center justify-between gap-3 px-4 py-2 rounded-2xl border text-sm ${
                r.warn
                  ? "border-[rgba(255,180,80,0.2)] bg-[rgba(40,28,10,0.6)] text-[#ffd5a0]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] text-[#c7d3f7]"
              }`}
            >
              <span>{r.label}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>

        {/* Method picker */}
        <div className="grid gap-2">
          <p className={`${MUTED} text-xs uppercase tracking-wider`}>{t("conflict.choose")}</p>
          {methods.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={selected === m.value}
              onClick={() => setSelected(m.value)}
              className={`text-left p-4 rounded-2xl border transition-colors ${
                selected === m.value
                  ? "border-[rgba(125,201,255,0.5)] bg-[rgba(125,201,255,0.08)]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] hover:border-[rgba(165,185,255,0.2)]"
              }`}
            >
              <p className="m-0 font-medium text-[#c7d3f7] text-sm">{m.label}</p>
              <p className={`${MUTED} m-0 text-xs mt-0.5`}>{m.description}</p>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className={GHOST_BTN} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className={PRIMARY_BTN} onClick={() => onConfirm(selected)}>
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SyncConflictModal;
