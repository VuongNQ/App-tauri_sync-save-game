/** Shared Tailwind utility class strings used across components. */

export const CARD =
  "border border-[rgba(165,185,255,0.12)] bg-[rgba(14,22,40,0.82)] rounded-3xl shadow-[0_24px_60px_rgba(4,10,22,0.24)] p-6";

export const SEC_HDR =
  "flex items-center justify-between gap-3 mb-[18px]";

export const EYEBROW =
  "mb-2 uppercase tracking-[0.16em] text-xs text-[#7dc9ff]";

export const MUTED = "text-[#9aa8c7]";

export const LABEL_SPAN = "text-[#c7d3f7] text-[0.92rem]";

export const FORM_LABEL = "grid gap-2";

export const FORM_GRID = "grid gap-[14px]";

export const INPUT_ROW = "flex items-center justify-between gap-3";

export const INPUT_CLS =
  "w-full min-h-[46px] rounded-[14px] border border-[rgba(140,165,241,0.16)] bg-[rgba(7,12,23,0.84)] text-[#eef4ff] px-3.5 focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-[1px]";

export const BTN =
  "border-none cursor-pointer transition-[transform,opacity,background] duration-[0.18s] ease-in-out hover:-translate-y-px focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none";

export const PRIMARY_BTN =
  `${BTN} w-full min-h-12 rounded-2xl bg-gradient-to-br from-[#6d7dff] to-[#55c5ff] text-[#05111f] font-bold`;

export const SECONDARY_BTN =
  `${BTN} min-h-[46px] px-4 rounded-2xl text-[#eaf3ff] bg-[rgba(86,133,255,0.16)]`;

export const GHOST_BTN =
  `${BTN} min-h-[46px] px-4 rounded-2xl text-[#eaf3ff] bg-[rgba(255,255,255,0.06)]`;

export const DANGER_BTN =
  `${BTN} w-full min-h-12 rounded-2xl bg-[rgba(255,60,60,0.16)] text-[#ff9e9e] font-bold hover:bg-[rgba(255,60,60,0.28)]`;

const BADGE =
  "inline-flex items-center justify-center px-3 py-1.5 rounded-2xl text-[0.85rem]";

export const SOFT_BADGE = `${BADGE} bg-[rgba(102,126,255,0.14)] text-[#c8d2ff]`;

export const SOURCE_BADGE: Record<string, string> = {
  emulator: `${BADGE} bg-[rgba(255,196,91,0.14)] text-[#ffd98a]`,
  manual:   `${BADGE} bg-[rgba(255,255,255,0.08)] text-[#c7d3f7]`,
};

export const FIELD_ERROR = "text-[0.82rem] text-[#ff9e9e] mt-0.5";

// ── Toggle switch ─────────────────────────────────────────────────────────────

export const TOGGLE_TRACK =
  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1";

export const TOGGLE_TRACK_ON = `${TOGGLE_TRACK} bg-[#6d7dff]`;
export const TOGGLE_TRACK_OFF = `${TOGGLE_TRACK} bg-[rgba(140,165,241,0.2)]`;

export const TOGGLE_THUMB =
  "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out";

export const TOGGLE_THUMB_ON = `${TOGGLE_THUMB} translate-x-5`;
export const TOGGLE_THUMB_OFF = `${TOGGLE_THUMB} translate-x-0`;

// ── Nav ───────────────────────────────────────────────────────────────────────

export const NAV_LINK =
  "flex items-center gap-3 px-4 py-3 rounded-2xl text-[#c7d3f7] transition-colors hover:bg-[rgba(86,133,255,0.12)]";

export const NAV_LINK_ACTIVE =
  "flex items-center gap-3 px-4 py-3 rounded-2xl text-white bg-[rgba(86,133,255,0.18)]";
