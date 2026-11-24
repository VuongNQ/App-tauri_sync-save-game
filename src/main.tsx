import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <App />
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

// ── Dev-only: expose Google API debug util on window.__googleDebug ─────────────
if (import.meta.env.DEV) {
  import("./utils/devDebug").then(({ devDebug }) => {
    window.__googleDebug = devDebug;
    console.info(
      "%c[__googleDebug] Google API debug util loaded.\n" + "Run window.__googleDebug.help() to see all available commands.",
      "color: #4ade80; font-weight: bold;"
    );
  });
}
