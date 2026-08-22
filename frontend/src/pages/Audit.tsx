import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ScrollText } from 'lucide-react';
import { api } from '../api/client';
import { formatDateTime } from '../lib/format';

export function Audit() {
  const [query, setQuery] = useState('');
  const [action, setAction] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['audit'],
    queryFn: async () => {
      const me: any = (await api.get('/persons/me')).data;
      return (await api.post('/audit/query', { person_id: me.logical_id })).data;
    },
  });

  const entries = useMemo(() => {
    const arr = Array.isArray(data) ? data : [];
    const q = query.trim().toLowerCase();
    return arr.filter((a: any) => {
      if (action !== 'all' && a.action !== action) return false;
      if (!q) return true;
      return (a.action + ' ' + (a.target_type || '') + ' ' + (a.person_id || '')).toLowerCase().includes(q);
    });
  }, [data, query, action]);

  const actions = useMemo(() => {
    const arr = Array.isArray(data) ? data : [];
    return Array.from(new Set(arr.map((a: any) => a.action))).sort();
  }, [data]);

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <div className="flex flex-wrap items-center gap-3">
          <p className="eyebrow">Audit</p>
          <span className="privacy-tag privacy-restricted">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Confidential · Restricted access
          </span>
        </div>
        <h1 className="h-page mt-1">Audit trail</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Every read, write, grant and refusal — recorded immutably. This view shows activity on your record.
        </p>
      </section>

      <section className="animate-slide-up flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkfaint" strokeWidth={1.75} />
          <input
            className="input pl-9"
            placeholder="Search the trail…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="input w-auto" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="all">All actions</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </section>

      <section className="animate-slide-up elev-1 overflow-x-auto rounded-lg border border-line bg-surface">
        {isLoading ? (
          <div className="space-y-2 p-4">
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-10 w-full" />
          </div>
        ) : isError ? (
          <div className="empty-state">
            <ScrollText className="mx-auto mb-2 h-5 w-5 text-inkfaint" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">Audit access unavailable</p>
            <p className="mt-1 text-xs text-inkfaint">
              This record is confidential. If you believe you should have access, contact HR.
            </p>
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <p className="text-sm font-medium text-ink">No entries match</p>
            <p className="mt-1 text-xs text-inkfaint">Adjust the filters or search to widen the trail.</p>
          </div>
        ) : (
          <table className="data-table min-w-[640px]">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((a: any) => {
                const expanded = expandedId === a.log_id;
                return (
                  <>
                    <tr
                      key={a.log_id}
                      className="cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : a.log_id)}
                    >
                      <td className="tnum text-inksoft">{formatDateTime(a.created_at)}</td>
                      <td>
                        <span className="status status-neutral">{a.action}</span>
                      </td>
                      <td className="text-inksoft">{a.target_type || '—'}</td>
                      <td className="tnum font-mono text-xs text-inkfaint">
                        {a.person_id === '00000000-0000-0000-0000-000000000001' ? 'You' : a.person_id}
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={a.log_id + '-detail'}>
                        <td colSpan={4} className="bg-soft/40 px-4 py-4">
                          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Event detail</p>
                          <dl className="mt-2 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                            <div className="flex gap-2"><dt className="w-24 shrink-0 text-inkfaint">Entry</dt><dd className="tnum font-mono text-xs text-inksoft">{a.log_id}</dd></div>
                            <div className="flex gap-2"><dt className="w-24 shrink-0 text-inkfaint">Actor</dt><dd className="tnum font-mono text-xs text-inksoft">{a.person_id}</dd></div>
                            <div className="flex gap-2"><dt className="w-24 shrink-0 text-inkfaint">Resource</dt><dd className="text-inksoft">{a.target_type || '—'}</dd></div>
                            <div className="flex gap-2"><dt className="w-24 shrink-0 text-inkfaint">Authorization</dt><dd className="text-inksoft">granted (recorded)</dd></div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}