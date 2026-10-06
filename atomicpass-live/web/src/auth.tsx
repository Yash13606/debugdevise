import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, get, getToken, setToken } from './api';

export interface User {
  id: string;
  phone: string;
  name: string;
  role: 'BUYER' | 'ORGANISER';
  org_name: string | null;
}

interface AuthState {
  user: User | null;
  ready: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => void;
  setUser: (u: User) => void;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) return setReady(true);
    get<{ user: User }>('/me').then(
      (r) => setUser(r.user),
      (e) => {
        if (e instanceof ApiError && e.status === 401) setToken(null);
      },
    ).finally(() => setReady(true));
  }, []);

  const signIn = useCallback((token: string, u: User) => {
    setToken(token);
    setUser(u);
  }, []);
  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, signIn, signOut, setUser }}>{children}</Ctx.Provider>;
}
