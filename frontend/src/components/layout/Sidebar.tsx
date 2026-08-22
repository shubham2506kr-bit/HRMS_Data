import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Clock,
  CalendarDays,
  MessageSquare,
  Users,
  Briefcase,
  Network,
  HeartPulse,
  TrendingUp,
  ScrollText,
  Wallet,
  UserRound,
  Settings,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../store/auth';
import clsx from 'clsx';

export type PageKey = 'dashboard' | 'attendance' | 'leave' | 'messages' | 'people' | 'projects' | 'organization' | 'care' | 'growth' | 'pay' | 'audit' | 'preview' | 'profile' | 'settings';

const NAV_ITEMS: { key: PageKey; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'My Day', icon: LayoutDashboard },
  { key: 'attendance', label: 'Attendance', icon: Clock },
  { key: 'leave', label: 'Leave', icon: CalendarDays },
  { key: 'messages', label: 'Messages', icon: MessageSquare },
];

const DISCOVER_ITEMS: { key: PageKey; label: string; icon: LucideIcon }[] = [
  { key: 'people', label: 'People', icon: Users },
  { key: 'projects', label: 'Projects', icon: Briefcase },
  { key: 'organization', label: 'Organization', icon: Network },
  { key: 'care', label: 'Care', icon: HeartPulse },
  { key: 'growth', label: 'Growth', icon: TrendingUp },
  { key: 'pay', label: 'Pay', icon: Wallet },
];

const SYSTEM_ITEMS: { key: PageKey; label: string; icon: LucideIcon }[] = [
  { key: 'audit', label: 'Audit', icon: ScrollText },
  { key: 'profile', label: 'Profile', icon: UserRound },
  { key: 'settings', label: 'Settings', icon: Settings },
];

interface SidebarProps {
  currentPage: PageKey;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function NavButton({ item, currentPage, onGo }: { item: { key: PageKey; label: string; icon: LucideIcon }; currentPage: PageKey; onGo: (k: PageKey) => void }) {
  const active = currentPage === item.key;
  return (
    <button
      onClick={() => onGo(item.key)}
      className={clsx('nav-item w-full text-left', active && 'nav-item-active')}
    >
      <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      {item.label}
    </button>
  );
}

export function Sidebar({ currentPage, mobileOpen, onMobileClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const go = (key: PageKey) => {
    navigate('/' + key);
    onMobileClose();
  };

  const content = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="avatar w-9 h-9 rounded-lg bg-brandsoft text-branddeep font-bold text-sm">E</div>
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold text-ink leading-tight">EduRankAI</p>
          <p className="text-2xs uppercase tracking-[0.16em] text-inkfaint">HumanOS</p>
        </div>
      </div>

      <div className="mx-5 h-px bg-line" />

      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4 scrollbar-hide">
        <div>
          <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Workspace</p>
          {NAV_ITEMS.map((item) => (
            <NavButton key={item.key} item={item} currentPage={currentPage} onGo={go} />
          ))}
        </div>
        <div>
          <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Discover</p>
          {DISCOVER_ITEMS.map((item) => (
            <NavButton key={item.key} item={item} currentPage={currentPage} onGo={go} />
          ))}
        </div>
        <div>
          <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">System</p>
          {SYSTEM_ITEMS.map((item) => (
            <NavButton key={item.key} item={item} currentPage={currentPage} onGo={go} />
          ))}
        </div>
      </nav>

      <div className="border-t border-line px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="avatar h-9 w-9 text-sm">
            {user?.preferredName?.[0] || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user?.preferredName || 'Employee'}</p>
            <p className="truncate text-2xs text-inkfaint">{user?.roles?.join(', ') || '—'}</p>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="rounded-md p-1.5 text-inkfaint transition-colors hover:bg-dangersoft hover:text-danger"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-canvas lg:block">
        {content}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-down bg-canvas shadow-modal">
            {content}
          </aside>
        </div>
      )}
    </>
  );
}
