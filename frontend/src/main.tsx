import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { AuthProvider } from './store/auth';
import { queryClient } from './lib/queryClient';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.DEV) {
      // The dev server serves unbundled, unhashed modules — a service
      // worker's caching would serve stale code forever. Unregister any
      // existing SW and purge caches so development always runs fresh code.
      navigator.serviceWorker.getRegistrations().then((regs) =>
        regs.forEach((r) => r.unregister())
      );
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    } else {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster
            position="bottom-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: 'var(--card)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
              },
              success: {
                iconTheme: {
                  primary: '#2a9d8f',
                  secondary: '#0a0e1a',
                },
              },
              error: {
                iconTheme: {
                  primary: '#ff6b6b',
                  secondary: '#0a0e1a',
                },
              },
            }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
