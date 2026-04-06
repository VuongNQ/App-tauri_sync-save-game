import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Convert a thumbnail path or URL to a safe <img src> value for both dev and release builds.
 * - http/https URLs → returned as-is
 * - Local file paths → converted to asset:// protocol via convertFileSrc()
 *   (raw file paths fail in Tauri release builds; asset:// works in both modes)
 */
export function toImgSrc(thumbnail: string | null | undefined): string | undefined {
  if (!thumbnail) return undefined;
  const src = thumbnail.trim();
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  return convertFileSrc(src);
}

/** Trim a string; return null if empty. */
export function norm(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Extract a human-readable message from an unknown thrown value. */
export function msg(e: unknown, fallback: string): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** Format an ISO 8601 timestamp to a local date/time string. */
export function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** Format a byte count into a human-readable string (B, KB, MB, GB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log2(bytes) / 10);
  const clamped = Math.min(i, units.length - 1);
  const value = bytes / Math.pow(1024, clamped);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[clamped]}`;
}
