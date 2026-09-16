import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, getToken } from './api/client';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  /** When this user finished or skipped the guided tour; null means it has never run for them. */
  tourCompletedAt: string | null;
}
interface AuthCtx { user: User | null; tenant: { id: string; name: string } | null; loading: boolean;
  login: (email: string, password: string, orgSlug?: string) => Promise<void>;
  register: (b: { email: string; password: string; name: string; tenantName?: string }) => Promise<void>;
  logout: () => void;
  /** Records on the server that the guided tour is done, so it never auto-runs again on any browser. */
  markTourComplete: () => Promise<void>;
  /** Re-reads the tour flag from the server and returns it, for a tab that may hold a stale one. */
  refreshTourStatus: () => Promise<string | null>; }

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api.get<{ user: User; tenant: any }>('/auth/me')
      .then((d) => { setUser(d.user); setTenant(d.tenant); })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string, orgSlug?: string) => {
    const d = await api.post<{ token: string; user: User }>('/auth/login', orgSlug ? { email, password, orgSlug } : { email, password });
    setToken(d.token); setUser(d.user);
    const me = await api.get<{ tenant: any }>('/auth/me'); setTenant(me.tenant);
  };
  const register = async (b: any) => {
    const d = await api.post<{ token: string; user: User }>('/auth/register', b);
    setToken(d.token); setUser(d.user);
    const me = await api.get<{ tenant: any }>('/auth/me'); setTenant(me.tenant);
  };
  const logout = () => { setToken(null); setUser(null); setTenant(null); };
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

  return <Ctx.Provider value={{ user, tenant, loading, login, register, logout, markTourComplete, refreshTourStatus }}>{children}</Ctx.Provider>;
}
