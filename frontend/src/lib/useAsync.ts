import { useCallback, useEffect, useRef, useState } from "react";
import { t, useT } from "../i18n";

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: T | ((prev: T | undefined) => T)) => void;
}

/** Run an async loader on mount and whenever deps change. Stale results are ignored. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const v = await loaderRef.current();
      if (id === seq.current) setDataState(v);
    } catch (e) {
      if (id === seq.current) setError(e as Error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void run();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  const setData = useCallback((fn: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof fn === "function" ? (fn as (p: T | undefined) => T)(prev) : fn));
  }, []);

  return { data, error, loading, reload: run, setData };
}

/** Wrap an async action with a busy flag. */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R,>(key: string, fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(key);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

export function useDocumentTitle(title: string) {
  const { locale } = useT();
  useEffect(() => {
    document.title = title ? `${title} · Firealerts` : `Firealerts — ${t("app.tagline")}`;
  }, [title, locale]);
}
