import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Briefcase, MessageSquare } from 'lucide-react';
import { api } from '../api/client';
import { Chip, Notice } from '../components/ui/primitives';

export function People() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['people'],
    queryFn: async () => (await api.get('/persons')).data,
  });

  const people = useMemo(() => {
    const arr = Array.isArray(data) ? data : [];
    const q = query.trim().toLowerCase();
    if (!q) return arr;
    return arr.filter((p: any) => {
      const hay = [
        p.preferred_name, p.legal_name, p.position_name, p.department_name,
        ...(Array.isArray(p.skills) ? p.skills : []),
        ...(Array.isArray(p.projects) ? p.projects : []),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [data, query]);

  const selected = people.find((p: any) => p.logical_id === selectedId) || null;

  const onChange = (v: string) => {
    setQuery(v);
    setParams(v ? { q: v } : {}, { replace: true });
  };

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">People</p>
        <h1 className="h-page mt-1">Directory</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Find colleagues by name, role, team, skill or project.
        </p>
      </section>

      <div className="relative max-w-sm animate-slide-up">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkfaint" strokeWidth={1.75} />
        <input
          className="input pl-9"
          placeholder="Search people, roles, teams, skills, projects…"
          value={query}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>

            {isError && (
        <section className="animate-slide-up">
          <Notice
            tone="warn"
            title="Could not load the directory"
            action={
              <button onClick={() => void refetch()} className="btn-ghost btn-sm shrink-0">Retry</button>
            }
          />
        </section>
      )}

      <div className="animate-slide-up grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="elev-1 rounded-lg border border-line bg-surface">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
            </div>
          ) : people.length === 0 ? (
            <div className="empty-state">
              <p className="text-sm font-medium text-ink">No one matches “{query}”</p>
              <p className="mt-1 text-xs text-inkfaint">Try a name, role, department, skill or project.</p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {people.map((p: any) => (
                <button
                  key={p.logical_id}
                  onClick={() => setSelectedId(p.logical_id)}
                  className={`flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-soft/60 ${selectedId === p.logical_id ? 'bg-brandsoft/40' : ''}`}
                >
                  <div className="avatar h-10 w-10 text-sm shrink-0">
                    {(p.preferred_name || p.legal_name || '?')[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{p.preferred_name || p.legal_name}</p>
                    <p className="truncate text-xs text-inkfaint">
                      {p.position_name || 'No role'} · {p.department_name || 'Unassigned'}
                    </p>
                    {query && (Array.isArray(p.skills) ? p.skills : []).some((s: string) => s.toLowerCase().includes(query.trim().toLowerCase())) && (
                      <p className="mt-0.5 text-2xs text-branddeep">
                        Matches skill: {(Array.isArray(p.skills) ? p.skills : []).filter((s: string) => s.toLowerCase().includes(query.trim().toLowerCase())).join(', ')}
                      </p>
                    )}
                    {query && (Array.isArray(p.projects) ? p.projects : []).some((s: string) => s.toLowerCase().includes(query.trim().toLowerCase())) && (
                      <p className="mt-0.5 text-2xs text-branddeep">
                        Matches project: {(Array.isArray(p.projects) ? p.projects : []).filter((s: string) => s.toLowerCase().includes(query.trim().toLowerCase())).join(', ')}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="elev-1 rounded-lg border border-line bg-surface">
          {selected ? (
            <div className="animate-fade-in">
              <div className="border-b border-line px-5 py-4">
                <p className="font-display text-lg font-medium text-ink">{selected.preferred_name || selected.legal_name}</p>
                <p className="mt-0.5 text-xs text-inkfaint">
                  {selected.position_name || 'No role'} · {selected.department_name || 'Unassigned'}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="status status-ok">Active</span>
                  <button
                    onClick={() => navigate('/messages')}
                    className="btn btn-secondary btn-sm ml-auto"
                  >
                    <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.75} /> Message
                  </button>
                </div>
              </div>
              <div className="px-5 py-4">
                {Array.isArray(selected.skills) && selected.skills.length > 0 && (
                  <div className="mb-4">
                    <p className="eyebrow">Skills</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selected.skills.map((s: string) => (
                        <Chip key={s} tone="neutral" onClick={() => onChange(s)}>{s}</Chip>
                      ))}
                    </div>
                  </div>
                )}
                {Array.isArray(selected.projects) && selected.projects.length > 0 && (
                  <div className="mb-4">
                    <p className="eyebrow">Projects</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selected.projects.map((s: string) => (
                        <Chip key={s} tone="neutral" onClick={() => onChange(s)}>
                          <Briefcase className="h-3 w-3" strokeWidth={1.75} /> {s}
                        </Chip>
                      ))}
                    </div>
                  </div>
                )}
                <p className="eyebrow">Visibility</p>
                <div className="mt-2 space-y-2">
                  <p className="text-xs leading-relaxed text-inkfaint">
                    <span className="privacy-tag privacy-internal mr-1.5">Internal</span>
                    Role, team, skills and project memberships are visible to all employees.
                  </p>
                  <p className="text-xs leading-relaxed text-inkfaint">
                    <span className="privacy-tag privacy-confidential mr-1.5">Confidential</span>
                    Personal and employment details require authorization.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p className="text-sm font-medium text-ink">Select a person</p>
              <p className="mt-1 text-xs text-inkfaint">Details will appear here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}