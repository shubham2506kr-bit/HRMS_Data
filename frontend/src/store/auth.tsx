import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api, setAccessToken } from '../api/client';
import { queryClient } from '../lib/queryClient';
import { deleteOfflineDb } from '../lib/offline';
import { jwtExpired } from '../lib/jwt';
import type { ReactNode } from 'react';

interface User {
  id: string;
  roles: string[];
  attributes?: Record<string, any>;
  personId: string;
  preferredName: string;
  legalName: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  setToken: (token: string) => void;
  hasRole: (role: string) => boolean;
}

const PERSIST_KEY = 'edurankai-auth';

/**
 * Remove every trace of the previous session from this browser.
 *
 * Logging out used to only drop the token, leaving the react-query cache, the
 * service-worker cache and the IndexedDB outbox full of payroll, health and
 * audit data for whoever used the browser next. Every step is best-effort and
 * independently guarded: one failure must not abort the rest of the teardown.
 */
async function purgeClientState(): Promise<void> {
  // 1. Persisted credentials, including the pre-hardening localStorage keys so
  //    that already-affected browsers are cleaned on the next logout.
  try {
    localStorage.removeItem('token');
    localStorage.removeItem(PERSIST_KEY);
    sessionStorage.removeItem(PERSIST_KEY);
    sessionStorage.removeItem('care-memory'); // health-advisor transcript
  } catch {
    /* storage can be unavailable (private mode, disabled cookies) */
  }

  // 2. In-memory server responses.
  try {
    queryClient.clear();
  } catch {
    /* best effort */
  }

  // 3. Service-worker caches — where API bodies were being archived to disk.
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      (reg?.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'PURGE_CACHES' });
    }
  } catch {
    /* best effort */
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best effort */
  }

  // 4. Offline outbox.
  try {
    await deleteOfflineDb();
  } catch {
    /* best effort */
  }
}

// One teardown at a time: several requests can 401 simultaneously and each
// would otherwise fire its own /auth/logout and its own cache purge.
let teardown: Promise<void> | null = null;

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      loading: false,

      login: async (username: string, password: string) => {
        set({ loading: true });
        try {
          const response = await api.post('/auth/login', { username, password });
          const { token, user } = response.data;

          // A new session must never inherit the previous one's cached data.
          try {
            queryClient.clear();
          } catch {
            /* best effort */
          }

          setAccessToken(token);
          set({ token, user, loading: false });
        } catch (error) {
          set({ loading: false });
          throw error;
        }
      },

      logout: () => {
        if (teardown) return teardown;

        const revoked = get().token;

        // Drop the session synchronously first, so the route guard redirects
        // immediately and no personal data stays on screen while we tear down.
        setAccessToken(null);
        set({ user: null, token: null, loading: false });
        try {
          useAuth.persist.clearStorage();
        } catch {
          /* best effort */
        }

        const running = (async () => {
          // Revoke server-side. Tolerate any failure — the client still ends up
          // clean, and the endpoint may not exist on older backends. The token
          // is passed explicitly because we have already discarded it.
          try {
            await api.post(
              '/auth/logout',
              null,
              revoked ? { headers: { Authorization: `Bearer ${revoked}` } } : undefined
            );
          } catch {
            /* best effort */
          }
          await purgeClientState();
        })().finally(() => {
          teardown = null;
        });

        teardown = running;
        return running;
      },

      setUser: (user) => set({ user }),
      setToken: (token) => {
        setAccessToken(token);
        set({ token });
      },

      hasRole: (role: string) => {
        const { user } = get();
        return user?.roles.includes(role) ?? false;
      },
    }),
    {
      name: PERSIST_KEY,
      // sessionStorage, not localStorage: the session dies with the tab instead
      // of sitting on disk indefinitely, and is not shared across tabs.
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        token: state.token,
        user: state.user,
      }),
    }
  )
);

// Post-rehydration guard, once at module load. An already-expired persisted
// session is dropped rather than restored, so an expired token can never be
// used to render personal data. Also clears the pre-hardening localStorage
// keys, which forces one re-login on upgrade — intentional, that token was
// readable by any injected script.
(() => {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem(PERSIST_KEY);
  } catch {
    /* best effort */
  }

  const persisted = useAuth.getState().token;
  if (!persisted) return;

  if (jwtExpired(persisted)) {
    setAccessToken(null);
    useAuth.setState({ user: null, token: null });
    try {
      useAuth.persist.clearStorage();
    } catch {
      /* best effort */
    }
    return;
  }

  setAccessToken(persisted);
})();

export const useAuthStore = useAuth;

export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
