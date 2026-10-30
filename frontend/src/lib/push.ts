/* Web Push on this device: permission, subscription and (un)registration with the API. */
import { push as pushApi } from "../api/endpoints";
import type { PushSubscriptionBody } from "../api/endpoints";

export type PushSupport = "supported" | "unsupported" | "insecure";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "supported";
}

/** base64url (VAPID public key) → bytes for `applicationServerKey`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The service worker registration, registering /sw.js on demand (dev builds don't register it at start-up). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (existing?.active) return existing;
  if (!existing) await navigator.serviceWorker.register("/sw.js");
  // pushManager.subscribe needs an *active* worker: wait for activation.
  const ready = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
  if (!ready?.active) throw new Error("service-worker");
  return ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  // No registration means no subscription: don't wait for a worker that may never register (dev builds).
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export class PushError extends Error {
  constructor(readonly code: "denied" | "disabled" | "unsupported" | "service-worker" | "subscribe") {
    super(code);
  }
}

/** Ask permission, subscribe with the server's VAPID key and register the subscription. */
export async function enablePush(): Promise<PushSubscription> {
  if (pushSupport() !== "supported") throw new PushError("unsupported");
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") throw new PushError("denied");
  const { enabled, key } = await pushApi.vapidKey();
  if (!enabled || !key) throw new PushError("disabled");
  let reg: ServiceWorkerRegistration;
  try {
    reg = await registration();
  } catch {
    throw new PushError("service-worker");
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
    } catch {
      // The browser's push service refused or is unreachable (e.g. headless browsers, blocked networks).
      throw new PushError(Notification.permission === "denied" ? "denied" : "subscribe");
    }
  }
  const json = sub.toJSON() as PushSubscriptionBody;
  await pushApi.subscribe({ endpoint: json.endpoint, keys: json.keys, expirationTime: json.expirationTime ?? null, user_agent: navigator.userAgent });
  return sub;
}

/** Unsubscribe this device locally and on the server. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await pushApi.unsubscribe(endpoint);
}
