import axios from 'axios';

// The access token lives in module memory only.
//
// It is deliberately NOT read from localStorage any more: a token in
// localStorage is readable by any injected script and survives the browser
// session, so a closed laptop kept a usable credential on disk. The auth store
// owns the token and pushes it here via setAccessToken(); it is never logged,
// never placed in a URL, and never reaches the service-worker cache (the worker
// refuses to cache anything carrying an Authorization header).
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  // An explicit per-request Authorization header wins (logout uses one to
  // revoke the session it is in the middle of discarding).
  if (accessToken && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// A 401 from these must never trigger a refresh or a recursive teardown.
const AUTH_PATHS = ['/auth/login', '/auth/logout', '/auth/refresh', '/auth/demo'];
const isAuthPath = (url?: string) => AUTH_PATHS.some((p) => (url ?? '').includes(p));

// One refresh in flight at a time, however many requests 401 together.
let refreshInFlight: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = api
      .post('/auth/refresh')
      .then((res) => {
        const next: string | null = res.data?.token ?? null;
        if (next) setAccessToken(next);
        return next;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const config: any = error.config ?? {};

    if (status !== 401 || isAuthPath(config.url)) {
      return Promise.reject(error);
    }

    // Refresh exactly once per request, then fail closed.
    if (!config.__refreshRetried) {
      config.__refreshRetried = true;
      const next = await refreshAccessToken();
      if (next) {
        const { useAuth } = await import('../store/auth');
        useAuth.getState().setToken(next);
        if (!config.headers) config.headers = {};
        config.headers.Authorization = `Bearer ${next}`;
        return api.request(config);
      }
    }

    // Session is gone (expired, revoked, forged) and could not be refreshed.
    // Tear the whole client down so an expired session cannot leave payroll or
    // health data on screen, in the react-query cache, or in the SW cache.
    // No hard `location.href` reload here: that caused a race that interrupted
    // fresh logins and an infinite reload loop (see HUMANOS_STATUS.md §9) — the
    // route guard redirects once off React state instead.
    const { useAuth } = await import('../store/auth');
    await useAuth.getState().logout();
    return Promise.reject(error);
  }
);
