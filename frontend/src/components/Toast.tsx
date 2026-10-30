import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import { IconX } from "./Icons";
import { t } from "../i18n";

type Kind = "info" | "success" | "error" | "warning";
interface ToastItem {
  id: number;
  kind: Kind;
  title?: string;
  message: ReactNode;
}

interface ToastApi {
  show: (message: ReactNode, kind?: Kind, title?: string, ms?: number) => void;
  success: (message: ReactNode) => void;
  error: (errOrMessage: unknown, title?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback(
    (message: ReactNode, kind: Kind = "info", title?: string, ms = 4500) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, kind, title, message }]);
      setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m) => show(m, "success"),
      error: (err, title) => {
        // Plan-limit errors are surfaced by the global upgrade notice instead.
        if (err instanceof ApiError && err.status === 402) return;
        const forbidden = err instanceof ApiError && err.status === 403;
        show(errorMessage(err), "error", title ?? (forbidden ? t("common.notAllowed") : undefined), 6000);
      },
    }),
    [show],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
            <div className="grow">
              {item.title && <div className="title">{item.title}</div>}
              {item.message}
            </div>
            <button className="close-btn" style={{ width: 22, height: 22 }} onClick={() => dismiss(item.id)} aria-label={t("common.dismissNotification")}>
              <IconX size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
