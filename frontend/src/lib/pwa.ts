/* PWA glue: service-worker registration (production only) and the "Install app" prompt. */
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Register /sw.js in production builds when the browser supports service workers. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

/** Capture `beforeinstallprompt` so the user menu can offer "Install app" later. */
export function trackInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Returns an install function while the browser offers installation, else null. */
export function useInstallPrompt(): (() => Promise<boolean>) | null {
  const ev = useSyncExternalStore(subscribe, () => deferred, () => null);
  if (!ev) return null;
  return async () => {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    deferred = null;
    emit();
    return outcome === "accepted";
  };
}

/** Service worker registration usable for push (null when unsupported or not registered, e.g. in dev). */
export async function swRegistration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (existing) return existing;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}
