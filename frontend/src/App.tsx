import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Sidebar, type PageKey } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { BottomNav } from './components/BottomNav';
import { CommandPalette } from './components/CommandPalette';
import { Dashboard } from './pages/Dashboard';
import { Attendance } from './pages/Attendance';
import { Leave } from './pages/Leave';
import { Messages } from './pages/Messages';
import { People } from './pages/People';
import { Projects } from './pages/Projects';
import { Organization } from './pages/Organization';
import { Care } from './pages/Care';
import { Growth } from './pages/Growth';
import { Pay } from './pages/Pay';
import { Preview } from './pages/Preview';
import { Audit } from './pages/Audit';
import { Login } from './pages/Login';
import { Profile } from './pages/Profile';
import { Settings } from './pages/Settings';
import { useAuth } from './store/auth';
import { jwtExpired } from './lib/jwt';

const VALID_PAGES: PageKey[] = ['dashboard', 'attendance', 'leave', 'messages', 'people', 'projects', 'organization', 'care', 'growth', 'pay', 'audit', 'preview', 'profile', 'settings'];

const ProtectedRoute = () => {
  const { user, token, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // Both halves of the session must exist — otherwise redirect once via
  // React state (no hard reload, no loop). An expired token redirects
  // immediately instead of burning a 401 round-trip on every request.
  if (!user || !token || jwtExpired(token)) return <Navigate to="/login" replace />;

  return <Outlet />;
};

function App() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const page = (location.pathname.replace('/', '') || 'dashboard') as PageKey;
  const currentPage = VALID_PAGES.includes(page) ? page : 'dashboard';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isLogin = location.pathname === '/login';

  return (
    <>
      {isLogin ? (
        <Login />
      ) : (
        <div className="min-h-screen bg-canvas lg:pl-60">
          <Sidebar
            currentPage={currentPage}
            mobileOpen={mobileMenuOpen}
            onMobileClose={() => setMobileMenuOpen(false)}
          />
          <Header onMenuClick={() => setMobileMenuOpen(true)} onSearchClick={() => setPaletteOpen(true)} />

          <main className="mx-auto max-w-6xl px-4 py-8 pb-24 lg:px-8 lg:py-10 lg:pb-10">
            <Routes>
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/attendance" element={<Attendance />} />
                <Route path="/leave" element={<Leave />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/people" element={<People />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/organization" element={<Organization />} />
                <Route path="/care" element={<Care />} />
                <Route path="/growth" element={<Growth />} />
                <Route path="/pay" element={<Pay />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/preview" element={<Preview />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Routes>
          </main>

          <BottomNav />
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

export default App;