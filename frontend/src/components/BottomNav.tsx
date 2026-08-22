import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Clock, HeartPulse, Sparkles, UserRound } from 'lucide-react';
import clsx from 'clsx';

const ITEMS: { label: string; icon: any; path: string }[] = [
  { label: 'Home', icon: LayoutDashboard, path: '/dashboard' },
  { label: 'Work', icon: Clock, path: '/attendance' },
  { label: 'Care', icon: HeartPulse, path: '/care' },
  { label: 'AI', icon: Sparkles, path: '/care#agent' },
  { label: 'Me', icon: UserRound, path: '/profile' },
];

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface lg:hidden">
      <div className="mx-auto grid max-w-lg grid-cols-5">
        {ITEMS.map((item) => {
          const active = path === item.path || (item.path === '/care' && path === '/care');
          return (
            <button
              key={item.label}
              onClick={() => navigate(item.path)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex flex-col items-center gap-1 py-2.5 text-2xs font-medium transition-colors',
                active ? 'text-branddeep' : 'text-inkfaint'
              )}
            >
              <item.icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}