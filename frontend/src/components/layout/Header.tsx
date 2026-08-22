import { Menu, Search, Bell, Sun, Moon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/auth';
import { useTheme } from '../../store/theme';

interface HeaderProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
}

export function Header({ onMenuClick, onSearchClick }: HeaderProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { theme, toggle } = useTheme();

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-8">
        <button
          onClick={onMenuClick}
          className="rounded-md p-2 text-inksoft hover:bg-soft lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>

        <button
          onClick={onSearchClick}
          className="hidden flex-1 max-w-md items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-inkfaint transition-colors hover:border-linestrong sm:flex"
          aria-label="Open search palette"
        >
          <Search className="h-4 w-4" strokeWidth={1.75} />
          <span className="flex-1 text-left">Search people, leave, pay…</span>
          <span className="kbd">Ctrl K</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={toggle}
          className="rounded-md p-2 text-inksoft hover:bg-soft hover:text-ink"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-5 w-5" strokeWidth={1.75} /> : <Moon className="h-5 w-5" strokeWidth={1.75} />}
        </button>

        <button
          onClick={() => navigate('/messages')}
          className="relative rounded-md p-2 text-inksoft hover:bg-soft hover:text-ink"
          title="Messages and notifications"
          aria-label="Messages and notifications"
        >
          <Bell className="h-5 w-5" strokeWidth={1.75} />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand" />
        </button>

        <button
          onClick={() => navigate('/profile')}
          className="rounded-full transition-opacity hover:opacity-80"
          title={user?.preferredName || 'Employee'}
          aria-label="Open your profile"
        >
          <span className="avatar h-8 w-8 text-xs">{user?.preferredName?.[0] || 'U'}</span>
        </button>
      </div>
    </header>
  );
}
