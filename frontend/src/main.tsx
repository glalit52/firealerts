import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./styles/global.css";
import "./styles/app.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import { storage } from "./api/client";
import { STORAGE_KEY, detectLocale, setLocale } from "./i18n";
import { registerServiceWorker, trackInstallPrompt } from "./lib/pwa";

// Pick the UI language before the first render (the signed-in user's saved language is applied once /api/me loads).
setLocale(detectLocale({ stored: storage.get(STORAGE_KEY), navigator: typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [] }));
trackInstallPrompt();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
