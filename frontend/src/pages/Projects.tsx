import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { formatDate, relativeDay } from '../lib/format';
import clsx from 'clsx';

const STATUSES = ['ALL', 'ONGOING', 'PLANNED', 'FINISHED'] as const;
const STATUS_CLASS: Record<string, string> = {
  ONGOING: 'status-ok',
  PLANNED: 'status-info',
  FINISHED: 'status-neutral',
};

const MILESTONE_STATUS = ['PLANNED', 'IN_PROGRESS', 'DONE'] as const;

export function Projects() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('ONGOING');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [newMilestone, setNewMilestone] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await api.get('/projects')).data,
  });

  const { data: members } = useQuery({
    queryKey: ['project-members', expandedId],
    queryFn: async () => (expandedId ? (await api.get(`/projects/${expandedId}/members`)).data : []),
    enabled: !!expandedId,
  });

  const { data: milestones } = useQuery({
    queryKey: ['project-milestones', expandedId],
    queryFn: async () => (expandedId ? (await api.get(`/projects/${expandedId}/milestones`)).data : { milestones: [], progress: null }),
    enabled: !!expandedId,
  });

  const { data: dependencies } = useQuery({
    queryKey: ['project-dependencies'],
    queryFn: async () => (await api.get('/projects/dependencies')).data,
  });

  const addMilestone = useMutation({
    mutationFn: async (title: string) =>
      (await api.post(`/projects/${expandedId}/milestones`, { title, status: 'PLANNED' })).data,
    onSuccess: () => {
      toast.success('Milestone added');
      setNewMilestone('');
      queryClient.invalidateQueries({ queryKey: ['project-milestones', expandedId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to add milestone'),
  });

  const setMilestoneStatus = useMutation({
    mutationFn: async ({ id, status: st }: { id: number; status: string }) =>
      (await api.put(`/projects/${expandedId}/milestones/${id}`, { status: st })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-milestones', expandedId] }),
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to update milestone'),
  });

  const projects = useMemo(() => {
    const arr = Array.isArray(data) ? data : [];
    return filter === 'ALL' ? arr : arr.filter((p: any) => p.status === filter);
  }, [data, filter]);

  const createProject = useMutation({
    mutationFn: async () =>
      (await api.post('/projects', { name, description, status, start_date: startDate, end_date: endDate })).data,
    onSuccess: () => {
      toast.success('Project created');
      setShowForm(false);
      setName(''); setDescription(''); setStartDate(''); setEndDate('');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to create project'),
  });

  const depsFor = (projectId: string) =>
    (Array.isArray(dependencies) ? dependencies : []).filter((d: any) => d.project_id === projectId || d.depends_on_project_id === projectId);

  const projectName = (id: string) =>
    (Array.isArray(data) ? data : []).find((p: any) => p.logical_id === id)?.name ?? id;

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4 animate-fade-in">
        <div>
          <p className="eyebrow">Projects</p>
          <h1 className="h-page mt-1">Company projects</h1>
          <p className="prose-muted mt-2 max-w-xl">
            Timelines, teams and staffing across the organization.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New project'}
        </button>
      </section>

      <section className="animate-slide-up flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={clsx(
              'rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              filter === s ? 'bg-brandsoft text-branddeep' : 'text-inksoft hover:bg-soft hover:text-ink'
            )}
          >
            {s === 'ALL' ? 'All' : s.toLowerCase()}
          </button>
        ))}
      </section>

      {showForm && (
        <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-6">
          <div className="section-rule">
            <h2 className="h-section">New project</h2>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="PLANNED">Planned</option>
                <option value="ONGOING">Ongoing</option>
                <option value="FINISHED">Finished</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description</label>
              <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="label">Start</label>
              <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="label">End</label>
              <input type="date" className="input" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="mt-5 flex gap-3">
            <button
              className="btn-primary"
              disabled={createProject.isPending || !name}
              onClick={() => createProject.mutate()}
            >
              Create project
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </section>
      )}

      {isError && (
        <section className="animate-slide-up flex items-center gap-3 rounded-lg border border-line bg-warnsoft px-4 py-3">
          <p className="flex-1 text-sm text-warn">Could not load projects.</p>
          <button onClick={() => void refetch()} className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-surface transition-opacity hover:opacity-90">
            Retry
          </button>
        </section>
      )}

      <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface">
        {isLoading ? (
          <div className="space-y-2 p-4">
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <p className="text-sm font-medium text-ink">No {filter === 'ALL' ? '' : filter.toLowerCase() + ' '}projects</p>
            <p className="mt-1 text-xs text-inkfaint">Create one to begin planning.</p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {projects.map((p: any) => {
              const expanded = expandedId === p.logical_id;
              const team = (Array.isArray(members) ? members : []) as any[];
              return (
                <div key={p.logical_id}>
                  <button
                    onClick={() => setExpandedId(expanded ? null : p.logical_id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-soft/60 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                      <p className="mt-0.5 truncate text-xs text-inkfaint">{p.description || 'No description'}</p>
                    </div>
                    <div className="hidden text-xs text-inksoft sm:block">
                      {formatDate(p.start_date)} – {formatDate(p.end_date)}
                      {p.start_date && <span className="ml-2 text-inkfaint">({relativeDay(p.start_date)})</span>}
                    </div>
                    <div className="hidden sm:block">
                      <span className="text-xs text-inksoft">
                        {p.people_count} people{p.lead_name ? ` · led by ${p.lead_name}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`status ${STATUS_CLASS[p.status] || 'status-neutral'}`}>
                        {p.status === 'ONGOING' ? 'Ongoing' : p.status === 'PLANNED' ? 'Planned' : 'Finished'}
                      </span>
                    </div>
                  </button>

                  {expanded && (
                    <div className="animate-slide-down border-t border-line bg-soft/30 px-4 py-4">
                      <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Timeline</p>
                      <div className="mt-2 flex items-center gap-3 rounded-md border border-line bg-surface px-4 py-3">
                        <span className="text-xs text-inksoft">Start</span>
                        <span className="tnum text-sm font-medium text-ink">{p.start_date ? formatDate(p.start_date) : '—'}</span>
                        <div className="h-1.5 min-w-[80px] flex-1 rounded-full bg-soft">
                          <div
                            className="h-full rounded-full bg-brand/70"
                            style={{
                              width: p.start_date && p.end_date
                                ? `${Math.min(100, Math.max(8, ((new Date().getTime() - new Date(p.start_date).getTime()) / (new Date(p.end_date).getTime() - new Date(p.start_date).getTime())) * 100))}%`
                                : '8%',
                            }}
                          />
                        </div>
                        <span className="tnum text-sm font-medium text-ink">{p.end_date ? formatDate(p.end_date) : '—'}</span>
                        <span className="text-xs text-inkfaint">End</span>
                      </div>

                      <div className="mt-4 grid gap-4 lg:grid-cols-2">
                        <div>
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Milestones</p>
                            {milestones?.progress && (
                              <span className="text-2xs tabular-nums text-inksoft">
                                {milestones.progress.done}/{milestones.progress.total} done
                              </span>
                            )}
                          </div>
                          {milestones?.progress && (
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-soft">
                              <div
                                className="h-full rounded-full bg-ok"
                                style={{ width: `${(milestones.progress.done / milestones.progress.total) * 100}%` }}
                              />
                            </div>
                          )}
                          {milestones?.milestones?.length ? (
                            <div className="mt-2 divide-y divide-line/70 rounded-md border border-line bg-surface">
                              {milestones.milestones.map((m: any) => (
                                <div key={m.milestone_id} className="flex items-center gap-3 px-4 py-2.5">
                                  <div className="min-w-0 flex-1">
                                    <p className={clsx('text-sm', m.status === 'DONE' ? 'text-inkfaint line-through' : 'text-ink')}>{m.title}</p>
                                    <p className="text-2xs text-inkfaint">{m.due_date ? `Due ${formatDate(m.due_date)}` : 'No due date'}</p>
                                  </div>
                                  <select
                                    value={m.status}
                                    onChange={(e) => setMilestoneStatus.mutate({ id: m.milestone_id, status: e.target.value })}
                                    className="rounded-md border border-line bg-surface px-2 py-1 text-2xs text-inksoft outline-none focus:border-inkfaint"
                                    aria-label={`Status of ${m.title}`}
                                  >
                                    {MILESTONE_STATUS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                                  </select>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-sm text-inkfaint">No milestones yet.</p>
                          )}
                          <div className="mt-2 flex gap-2">
                            <input
                              value={newMilestone}
                              onChange={(e) => setNewMilestone(e.target.value)}
                              placeholder="Add a milestone…"
                              className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-inkfaint"
                            />
                            <button
                              onClick={() => newMilestone.trim() && addMilestone.mutate(newMilestone.trim())}
                              disabled={!newMilestone.trim() || addMilestone.isPending}
                              className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
                            >
                              Add
                            </button>
                          </div>
                        </div>

                        <div>
                          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Team</p>
                          {team.length === 0 ? (
                            <p className="mt-2 text-sm text-inkfaint">No members assigned yet.</p>
                          ) : (
                            <div className="mt-2 divide-y divide-line/70 rounded-md border border-line bg-surface">
                              {team.map((m: any) => (
                                <div key={m.person_id} className="flex items-center gap-3 px-4 py-2.5">
                                  <div className="avatar h-7 w-7 text-xs">{m.name?.[0]}</div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-ink">{m.name}</p>
                                    <p className="text-2xs text-inkfaint">
                                      {m.position_name || 'No role'} · {m.department_name || 'Unassigned'}
                                    </p>
                                  </div>
                                  <span className="text-xs text-inksoft">{m.role || 'Member'}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <p className="mt-4 text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Dependencies</p>
                          {depsFor(p.logical_id).length === 0 ? (
                            <p className="mt-2 text-sm text-inkfaint">No inter-project dependencies.</p>
                          ) : (
                            <div className="mt-2 space-y-1.5">
                              {depsFor(p.logical_id).map((d: any) => (
                                <p key={`${d.project_id}-${d.depends_on_project_id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-inksoft">
                                  {d.project_id === p.logical_id
                                    ? `${projectName(p.logical_id)} waits on ${d.depends_on_name}`
                                    : `${d.project_name} waits on ${projectName(p.logical_id)}`}
                                </p>
                              ))}
                            </div>
                          )}

                          <p className="mt-3 text-2xs text-inkfaint">
                            Department: {p.department_name || 'Unassigned'} · {p.people_count} people on the project
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}