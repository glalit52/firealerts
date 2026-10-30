/* Session state: who am I, which organisation, what can I do. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { onApiEvent, session, storage } from "../api/client";
import { auth as authApi, system } from "../api/endpoints";
import type { Me, Meta, Role, SessionPayload } from "../api/types";
import { ROLE_RANK } from "../lib/constants";
import { STORAGE_KEY, isLocale, setLocale } from "../i18n";
import type { Locale } from "../i18n";

interface AuthState {
  me: Me | null;
  meta: Meta | null;
  loading: boolean;
  /** True when the visitor may use the app (signed in, or auth not required). */
  canUseApp: boolean;
  role: Role | null;
  can: (role: Role) => boolean;
  refresh: () => Promise<Me | null>;
  signIn: (payload: SessionPayload, preferredOrgId?: number) => Promise<void>;
  signOut: () => Promise<void>;
  switchOrg: (orgId: number) => Promise<void>;
  /** Bumped whenever the org or identity changes so pages can reload. */
  epoch: number;
  planNotice: string | null;
  clearPlanNotice: () => void;
  sessionExpired: boolean;
  /** Switch the UI language: persisted locally and, when signed in, on the user profile. */
  setLanguage: (l: Locale) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await authApi.me();
      // A stored org the user no longer belongs to: fall back to the default membership.
      const stored = session.orgId();
      if (m.authenticated && stored && m.org && String(m.org.id) !== stored && !m.memberships.some((x) => String(x.org_id) === stored)) {
        session.setOrgId(m.org.id);
      }
      // The signed-in user's saved language wins over the local choice.
      const lang = m.user?.language;
      if (m.authenticated && isLocale(lang)) {
        setLocale(lang);
        storage.set(STORAGE_KEY, lang);
      }
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [m] = await Promise.all([refresh(), system.meta().then((x) => alive && setMeta(x)).catch(() => undefined)]);
      if (alive) {
        setLoading(false);
        if (m && !m.authenticated && session.token()) session.setToken(null); // stale token
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    const off1 = onApiEvent("unauthorized", () => {
      if (session.token()) {
        session.clear();
        setSessionExpired(true);
      }
      void refresh();
    });
    const off2 = onApiEvent("planLimit", (err) => setPlanNotice(err.message));
    return () => {
      off1();
      off2();
    };
  }, [refresh]);

  const signIn = useCallback(
    async (payload: SessionPayload, preferredOrgId?: number) => {
      session.setToken(payload.token);
      const org = preferredOrgId ?? payload.memberships[0]?.org_id;
      session.setOrgId(org ?? null);
      setSessionExpired(false);
      await refresh();
      setEpoch((e) => e + 1);
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    session.clear();
    await refresh();
    setEpoch((e) => e + 1);
  }, [refresh]);

  const switchOrg = useCallback(
    async (orgId: number) => {
      session.setOrgId(orgId);
      await refresh();
      setEpoch((e) => e + 1);
    },
    [refresh],
  );

  const setLanguage = useCallback(
    async (l: Locale) => {
      setLocale(l);
      storage.set(STORAGE_KEY, l);
      if (me?.authenticated && me.user && me.user.language !== l) {
        try {
          const u = await authApi.updateMe({ language: l });
          setMe((prev) => (prev && prev.user ? { ...prev, user: { ...prev.user, ...u, language: l } } : prev));
        } catch {
          /* older servers ignore or reject the field; the local choice still applies */
        }
      }
    },
    [me],
  );

  const value = useMemo<AuthState>(() => {
    const role = me?.role ?? null;
    return {
      me,
      meta,
      loading,
      canUseApp: !!me && (me.authenticated || !me.auth_required),
      role,
      can: (r: Role) => !!role && ROLE_RANK[role] >= ROLE_RANK[r],
      refresh,
      signIn,
      signOut,
      switchOrg,
      epoch,
      planNotice,
      clearPlanNotice: () => setPlanNotice(null),
      sessionExpired,
      setLanguage,
    };
  }, [me, meta, loading, refresh, signIn, signOut, switchOrg, epoch, planNotice, sessionExpired, setLanguage]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
