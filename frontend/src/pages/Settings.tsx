import { Database, ShieldCheck, SlidersHorizontal, Building2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useTheme } from '../store/theme';

export function Settings() {
  const { user } = useAuth();
  const { theme, toggle } = useTheme();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get('/health')).data,
    retry: false,
  });

  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/departments')).data,
  });

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">Settings</p>
        <h1 className="h-page mt-1">Preferences and system</h1>
      </section>

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">Preferences</h2>
        </div>
        <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <SlidersHorizontal className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Theme</p>
            </div>
            <button className="btn-secondary btn-sm" onClick={toggle}>
              {theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            </button>
          </div>
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Building2 className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Organization units</p>
            </div>
            <span className="tnum text-sm text-inksoft">{Array.isArray(departments) ? departments.length : '—'}</span>
          </div>
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <SlidersHorizontal className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Your roles</p>
            </div>
            <span className="text-sm text-inksoft">{user?.roles?.join(', ') || '—'}</span>
          </div>
        </div>
      </section>

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">System</h2>
        </div>
        <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Database className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Database</p>
            </div>
            <span className={`status ${health?.services?.database === 'healthy' ? 'status-ok' : 'status-warn'}`}>
              {health?.services?.database || 'unknown'}
            </span>
          </div>
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Authorization engine</p>
            </div>
            <span className={`status ${health?.services?.cerbos === 'healthy' ? 'status-ok' : 'status-neutral'}`}>
              {health?.services?.cerbos === 'healthy' ? 'healthy' : 'standby (demo)'}
            </span>
          </div>
          <div className="list-row">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
              <p className="text-sm text-ink">Jurisdiction</p>
            </div>
            <span className="privacy-tag privacy-internal">IN — frozen</span>
          </div>
        </div>
      </section>

      <p className="text-xs leading-relaxed text-inkfaint">
        EduRankAI HumanOS demo build — payroll and health data modules are intentionally out of scope per project specification.
      </p>
    </div>
  );
}