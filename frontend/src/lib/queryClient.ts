import { QueryClient } from '@tanstack/react-query';

// Single shared query client. It lives here rather than inside main.tsx so the
// auth store can call `queryClient.clear()` during logout / 401 teardown —
// react-query's cache holds payroll, health and audit payloads in memory and
// must not survive a session change.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
