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
