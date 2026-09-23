import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, getToken } from './api/client';
import { endsSession, sessionLoadMessage } from './authModel';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  /** When this user finished or skipped the guided tour; null means it has never run for them. */
  tourCompletedAt: string | null;
  /** The platform owner (server PLATFORM_OPERATOR_EMAILS), who alone reviews the shared catalog. */
  platformOperator?: boolean;
  /** What this user may do (server capabilities.ts); read through capabilityModel.can. */
  capabilities?: string[];
  /** Whether they switched off the HR-Box daily summary email (Settings). */
  digestOptOut?: boolean;
}
/** The organisation the signed-in user belongs to. */
export interface Tenant {
  id: string;
  name: string;
  /** The org's own sign-in link, when one has been created. */
  slug?: string | null;
  isDemo?: boolean;
  sessionEndsAt?: string | null;
}

/** What creating an account needs. */
export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  tenantName?: string;
}

/**
 * What the password step answered.
 *
 * `signed_in` means there was no code to enter — the organisation does not ask
 * this person for one, or this browser holds a live trusted-device grant.
 * `code_sent` carries the ticket for the second step; it is not a session, and
 * the app stays signed out until the code is accepted.
 */
export type SignInStep =
  | { kind: 'signed_in' }
  | { kind: 'code_sent'; pending: string; destination: string; resendAfterSeconds: number };

interface AuthCtx { user: User | null; tenant: Tenant | null; loading: boolean;
  /** Set when the session check failed for a reason that is not "signed out" — see retrySession. */
  loadError: string | null;
  /** Runs the session check again, for the banner shown when loadError is set. */
  retrySession: () => void;
  login: (email: string, password: string, opts?: { orgSlug?: string; rememberDevice?: boolean }) => Promise<SignInStep>;
  /** The second step: the six digits emailed after the password was accepted. */
  submitCode: (pending: string, code: string) => Promise<void>;
  register: (b: RegisterInput) => Promise<void>;
  logout: () => void;
  /** Records on the server that the guided tour is done, so it never auto-runs again on any browser. */
  markTourComplete: () => Promise<void>;
  /** Re-reads the tour flag from the server and returns it, for a tab that may hold a stale one. */
  refreshTourStatus: () => Promise<string | null>; }

const Ctx = createContext<AuthCtx | null>(null);
export const useAuth = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider.');
  return ctx;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // A failed check is not a logout. Only the server refusing the credential
  // ends the session (authModel.endsSession); anything else leaves it standing
  // and surfaces a retry, because signing someone out over a 500 loses their
  // work for a fault that has usually already passed.
  const checkSession = useCallback(() => {
    if (!getToken()) { setLoading(false); setLoadError(null); return; }
    setLoading(true);
    setLoadError(null);
    api.get<{ user: User; tenant: Tenant | null }>('/auth/me')
      .then((d) => { setUser(d.user); setTenant(d.tenant); })
      .catch((err: unknown) => {
        if (endsSession(err)) { setToken(null); setUser(null); setTenant(null); return; }
        setLoadError(sessionLoadMessage(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  /** Shared by both ways in: adopt the session the server just handed back. */
  const adopt = async (d: { token: string; user: User }) => {
    setLoadError(null);
    setToken(d.token); setUser(d.user);
    const me = await api.get<{ tenant: Tenant | null }>('/auth/me'); setTenant(me.tenant);
  };

  const login = async (email: string, password: string, opts: { orgSlug?: string; rememberDevice?: boolean } = {}): Promise<SignInStep> => {
    const d = await api.post<{
      token?: string; user?: User; mfa?: string; pending?: string; destination?: string; resendAfterSeconds?: number;
    }>('/auth/login', {
      email, password,
      ...(opts.orgSlug ? { orgSlug: opts.orgSlug } : {}),
      ...(opts.rememberDevice ? { rememberDevice: true } : {}),
    });
    if (d.mfa === 'code_sent' && d.pending) {
      // Deliberately not stored anywhere: the ticket lives in the component
      // that is showing the code field and dies with it. A ticket in
      // localStorage would outlive the page that earned it.
      return { kind: 'code_sent', pending: d.pending, destination: d.destination ?? '', resendAfterSeconds: d.resendAfterSeconds ?? 60 };
    }
    if (!d.token || !d.user) throw new Error('Sign-in failed');
    await adopt({ token: d.token, user: d.user });
    return { kind: 'signed_in' };
  };

  const submitCode = async (pending: string, code: string) => {
    const d = await api.post<{ token: string; user: User }>('/auth/code', { pending, code });
    await adopt(d);
  };
  const register = async (b: RegisterInput) => {
    const d = await api.post<{ token: string; user: User }>('/auth/register', b);
    await adopt(d);
  };
  const logout = () => { setToken(null); setUser(null); setTenant(null); setLoadError(null); };
  // Stable, since the tour keeps it in an effect's dependencies.
  const markTourComplete = useCallback(async () => {
    const d = await api.post<{ tourCompletedAt: string | null }>('/auth/tour/complete');
    setUser((current) => (current ? { ...current, tourCompletedAt: d.tourCompletedAt } : current));
  }, []);

  // A second tab loaded before the tour was finished still holds the old flag,
  // and would run the tour again. The server is the only thing that knows, so
  // it is asked before the tour auto-starts. A failed request is treated as
  // "no new information" and leaves the local answer standing.
  const refreshTourStatus = useCallback(async () => {
    try {
      const d = await api.get<{ user: User }>('/auth/me');
      setUser((current) => (current ? { ...current, tourCompletedAt: d.user.tourCompletedAt } : current));
      return d.user.tourCompletedAt;
    } catch {
      return null;
    }
  }, []);

  return <Ctx.Provider value={{ user, tenant, loading, loadError, retrySession: checkSession, login, submitCode, register, logout, markTourComplete, refreshTourStatus }}>{children}</Ctx.Provider>;
}
