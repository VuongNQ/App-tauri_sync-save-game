import { useEffect } from "react";

interface ToastProps {
  message: string;
  type: "success" | "error";
  onDismiss: () => void;
  duration?: number;
}

export function Toast({ message, type, onDismiss, duration = 3500 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const containerCls =
    type === "success"
      ? "border-[rgba(80,200,120,0.35)] bg-[rgba(14,30,18,0.96)] text-[#86efac]"
      : "border-[rgba(255,100,100,0.35)] bg-[rgba(40,12,12,0.96)] text-[#fca5a5]";

  const icon = type === "success" ? "✓" : "✕";

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-xl backdrop-blur-sm ${containerCls}`}
      role="status"
      aria-live="polite"
    >
      <span className="text-base font-bold leading-none">{icon}</span>
      <p className="m-0 text-sm font-medium">{message}</p>
      <button
        type="button"
        className="ml-2 opacity-50 hover:opacity-100 transition-opacity leading-none"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}
