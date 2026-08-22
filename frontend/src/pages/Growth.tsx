import { useEffect, useMemo, useState } from 'react';
import { MapPin, Compass, Award, Plus, Check, ChevronRight, BookOpen, Briefcase, Sparkles, X } from 'lucide-react';
import { api } from '../api/client';
import clsx from 'clsx';

interface GrowthData {
  profile: {
    name: string; role: string | null; grade: number | null; department: string | null;
    joined: string | null; direction: string | null;
  };
  skills: { skill_id: string; name: string; cluster: string; level: number | null }[];
  gaps: { skill_id: string; name: string; cluster: string; relation: string; source_name: string }[];
  paths: {
    position_id: string; role: string; grade: number | null; department: string | null;
    kind: string; vacant: boolean; holder_name: string | null;
    already_demonstrated: string[]; development_areas: string[];
  }[];
  opportunities: { position_id: string; role: string; grade: number | null; department: string | null; head_of_department_id: string | null }[];
  goals: { goal_id: string; title: string; status: string; due_date: string | null }[];
  certifications: { cert_id: string; name: string; issuer: string; issued_on: string; expires_on: string | null }[];
  milestones: { date: string; kind: string; title: string }[];
}

type Goal = { goal_id: string; title: string; description: string | null; due_date: string | null; status: string };
type Cert = { cert_id: string; name: string; issuer: string; issued_on: string; expires_on: string | null; credential_id: string | null };

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const CLUSTER_LABEL: Record<string, string> = {
  engineering: 'Engineering',
  design: 'Design',
  operations: 'Operations',
  leadership: 'Leadership',
  general: 'General',
};

export function Growth() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ kind: string; id: string } | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [certName, setCertName] = useState('');
  const [certIssuer, setCertIssuer] = useState('');
  const [certOn, setCertOn] = useState('');
  const [certExp, setCertExp] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
const [g, gl, ce] = await Promise.all([
        api.get('/growth/me'),
        api.get('/goals'),
        api.get('/certifications'),
      ]);
      setData(g.data);
      setGoals(gl.data.goals ?? []);
      setCerts(ce.data.certifications ?? []);
    } catch (e) {
      setError('Could not load your growth data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const addGoal = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/goals', { title: title.trim(), due_date: due || undefined });
      setTitle('');
      setDue('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message ?? 'Could not create goal.');
    } finally {
      setBusy(false);
    }
  };

  const setGoalStatus = async (goal: Goal, status: string) => {
    try {
      await api.patch(`/goals/${goal.goal_id}`, { status });
      await load();
    } catch {
      setError('Could not update the goal.');
    }
  };

  const addCert = async () => {
    if (!certName.trim() || !certIssuer.trim() || !certOn) return;
    setBusy(true);
    try {
      await api.post('/certifications', {
        name: certName.trim(), issuer: certIssuer.trim(), issued_on: certOn,
        expires_on: certExp || null,
      });
      setCertName(''); setCertIssuer(''); setCertOn(''); setCertExp('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message ?? 'Could not add certification.');
    } finally {
      setBusy(false);
    }
  };

  const mySkills = data?.skills ?? [];
  const myGaps = data?.gaps ?? [];
  const paths = data?.paths ?? [];
  const opportunities = data?.opportunities ?? [];
  const milestones = data?.milestones ?? [];
  const clusters = useMemo(() => {
    const map = new Map<string, { total: number; count: number; skills: typeof mySkills }>();
    for (const s of mySkills) {
      const cur = map.get(s.cluster) ?? { total: 0, count: 0, skills: [] as typeof mySkills };
      cur.total += s.level ?? 0;
      cur.count += 1;
      cur.skills.push(s);
      map.set(s.cluster, cur);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total / b[1].count - a[1].total / a[1].count);
  }, [mySkills]);

  const selectedGap = detail?.kind === 'gap' ? myGaps.find((g) => g.skill_id === detail.id) : null;

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">Growth</p>
        <h1 className="h-page mt-1">My growth</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Where you are, what you know, what you need next — and where the organization can take you.
        </p>
      </section>

      {loading ? (
        <div className="space-y-4">
          <div className="skeleton h-40" />
          <div className="skeleton h-64" />
          <div className="skeleton h-64" />
        </div>
      ) : error ? (
        <div className="empty-state">
          <p className="text-sm font-medium text-ink">{error}</p>
<button onClick={() => void load()} className="btn btn-ink btn-sm mt-3">Try again</button>
        </div>
      ) : !data ? (
        <div className="empty-state">
          <p className="text-sm font-medium text-ink">No growth profile</p>
          <p className="mt-1 text-xs text-inkfaint">Your employment profile has not been provisioned yet.</p>
        </div>
) : (
        <>
          {/* JOURNEY STRIP */}
          <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-5">
            <p className="eyebrow">Your growth journey</p>
            <ol className="mt-4 flex flex-wrap items-center gap-y-3">
              {[
                { label: 'Current role', detail: data.profile.role ?? 'Unassigned', icon: MapPin },
                { label: 'Strengths', detail: `${mySkills.filter((s) => (s.level ?? 0) >= 3).length} skills at L3+`, icon: Award },
                { label: 'Gaps', detail: `${myGaps.length} to close`, icon: Sparkles },
                { label: 'Learning', detail: `${myGaps.length} suggested next step${myGaps.length === 1 ? '' : 's'}`, icon: BookOpen },
                { label: 'Career options', detail: `${paths.length} pathway${paths.length === 1 ? '' : 's'} · ${opportunities.length} open`, icon: Compass },
              ].map((step, i) => (
                <li key={step.label} className="flex items-center">
                  <span className={clsx('flex items-center gap-2.5 rounded-md border px-3 py-2', i === 0 ? 'border-ink/15 bg-ink text-surface' : 'border-line bg-soft/40')}>
                    <step.icon className={clsx('h-3.5 w-3.5', i === 0 ? 'text-surface/80' : 'text-inkfaint')} strokeWidth={1.75} />
                    <span className="text-xs">
                      <span className={clsx('block font-medium', i === 0 ? 'text-surface' : 'text-ink')}>{step.label}</span>
                      <span className={clsx('block text-2xs', i === 0 ? 'text-surface/70' : 'text-inkfaint')}>{step.detail}</span>
                    </span>
                  </span>
                  {i < 4 && <ChevronRight className="mx-1.5 h-3.5 w-3.5 text-inkfaint" strokeWidth={2} />}
                </li>
              ))}
            </ol>
          </section>

          {/* WHERE I AM */}
<section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-5">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
              <p className="eyebrow">Where I am</p>
            </div>
<div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="stat">
                <p className="eyebrow">Role</p>
                <p className="stat-value text-base">{data.profile.role ?? 'Unassigned'}</p>
              </div>
              <div className="stat">
                <p className="eyebrow">Level</p>
                <p className="stat-value text-base">
                  {data.profile.grade != null ? `Grade ${data.profile.grade}` : '—'}
                </p>
              </div>
              <div className="stat">
                <p className="eyebrow">Department</p>
                <p className="stat-value text-base">{data.profile.department ?? '—'}</p>
              </div>
              <div className="stat">
                <p className="eyebrow">Career direction</p>
                <p className="stat-value text-base capitalize">
                  {data.profile.direction ? CLUSTER_LABEL[data.profile.direction] ?? data.profile.direction : '—'}
                </p>
              </div>
            </div>
          </section>

{/* WHAT I KNOW */}
          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">What I know</h2>
            </div>
            {mySkills.length > 0 && (
              <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
                <div className="flex items-center gap-2">
                  <Award className="h-4 w-4 text-brand" strokeWidth={1.75} />
                  <p className="eyebrow">Strengths · your highest-rated capabilities</p>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {[...mySkills].sort((a, b) => (b.level ?? 0) - (a.level ?? 0)).slice(0, 3).map((s, i) => (
                    <div key={s.skill_id} className={clsx('rounded-md border p-3', i === 0 ? 'border-brand/40 bg-brandsoft/40' : 'border-line bg-soft/30')}>
                      <p className="flex items-center justify-between text-xs font-medium text-ink">
                        {s.name}
                        {i === 0 && <span className="rounded-full bg-brand px-2 py-0.5 text-2xs font-medium text-surface">Top</span>}
                      </p>
                      <p className="mt-1 text-2xs text-inkfaint capitalize">
                        {CLUSTER_LABEL[s.cluster] ?? s.cluster} · L{s.level ?? 0}/5
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {clusters.map(([cluster, info]) => (
                <div key={cluster} className="elev-1 rounded-lg border border-line bg-surface p-5">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-semibold text-ink capitalize">{CLUSTER_LABEL[cluster] ?? cluster}</p>
                    <p className="text-2xs text-inkfaint">{info.count} skill{info.count > 1 ? 's' : ''} · avg {Math.round((info.total / info.count) * 10) / 10}/5</p>
                  </div>
                  <div className="mt-3 space-y-2.5">
                    {info.skills.map((s) => {
                      const open = detail?.kind === 'skill' && detail.id === s.skill_id;
                      return (
                        <div key={s.skill_id}>
                          <button
                            onClick={() => setDetail(open ? null : { kind: 'skill', id: s.skill_id })}
                            className="group w-full text-left"
                            aria-expanded={open}
                          >
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-ink group-hover:text-branddeep">{s.name}</span>
                              <span className="text-inkfaint">L{s.level ?? 0} / 5</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft" role="progressbar" aria-valuenow={s.level ?? 0} aria-valuemin={0} aria-valuemax={5} aria-label={`${s.name} level`}>
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${((s.level ?? 0) / 5) * 100}%`, background: 'linear-gradient(90deg, #FF5A1F, #F4A261)' }}
                              />
                            </div>
                          </button>
                          {open && (
                            <SkillDetail name={s.name} cluster={cluster} level={s.level} onClose={() => setDetail(null)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* WHAT I NEED */}
          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">What I need</h2>
            </div>
<div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
              {myGaps.length === 0 ? (
                <p className="text-sm text-inkfaint">No skill gaps detected — every related skill in your domain is already covered.</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  {myGaps.map((g) => {
                    const open = detail?.kind === 'gap' && detail.id === g.skill_id;
                    return (
                      <button
                        key={g.skill_id}
                        onClick={() => setDetail(open ? null : { kind: 'gap', id: g.skill_id })}
                        className={clsx('rounded-md border p-4 text-left transition-colors', open ? 'border-brand bg-brandsoft/60' : 'border-line bg-soft/30 hover:border-inkfaint')}
                        aria-expanded={open}
                      >
                        <p className="text-sm font-semibold text-ink">{g.name}</p>
                        <p className="mt-0.5 text-2xs text-inkfaint capitalize">
                          {CLUSTER_LABEL[g.cluster] ?? g.cluster} · related to your {g.source_name}
                        </p>
                        <ChevronRight className={clsx('mt-2 h-3.5 w-3.5 text-inkfaint transition-transform', open && 'rotate-90')} strokeWidth={2} />
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedGap && (
                <GapDetail gap={selectedGap} onClose={() => setDetail(null)} />
              )}
            </div>
          </section>

          {/* WHAT I CAN LEARN */}
          <section className="animate-slide-up">
            <div className="section-rule">
<h2 className="h-section">What I can learn</h2>
            </div>
            <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
              {myGaps.length === 0 ? (
                <p className="text-sm text-inkfaint">Your current gaps are the honest learning list — nothing pending right now.</p>
              ) : (
                <div className="divide-y divide-line/70">
                  {myGaps.map((g) => (
                    <div key={g.skill_id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brandsoft">
                        <BookOpen className="h-3.5 w-3.5 text-branddeep" strokeWidth={2} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">Build {g.name}</p>
                        <p className="text-xs text-inkfaint">
                          It extends {g.source_name}, which you already use. A focused project or course is the suggested next step.
                        </p>
                      </div>
<button
                        onClick={() => setDetail(detail?.kind === 'gap' && detail.id === g.skill_id ? null : { kind: 'gap', id: g.skill_id })}
                        className="btn btn-secondary btn-sm"
                      >
                        Learning note
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* WHERE I CAN GO */}
          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">Where I can go</h2>
            </div>
            <div className="mt-4 space-y-3">
              {paths.length === 0 ? (
                <div className="rounded-lg border border-line bg-surface p-5">
                  <p className="text-sm text-inkfaint">No defined next steps above your current role yet.</p>
                </div>
              ) : (
                paths.map((p, i) => {
                  const open = detail?.kind === 'path' && detail.id === p.position_id;
                  return (
                    <div key={p.position_id} className="rounded-lg border border-line bg-surface">
                      <button
                        onClick={() => setDetail(open ? null : { kind: 'path', id: p.position_id })}
                        className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left"
                        aria-expanded={open}
                      >
                        <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border', p.kind === 'leadership' ? 'border-brand bg-brandsoft text-branddeep' : 'border-line bg-soft text-inkfaint')}>
                          <Compass className="h-3.5 w-3.5" strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-ink">
                            {p.role}
                            {p.vacant && <span className="ml-2 rounded-full bg-brandsoft px-2 py-0.5 text-2xs font-medium text-branddeep">Open</span>}
                          </p>
                          <p className="text-xs text-inkfaint">
                            {p.department} · {p.kind === 'leadership' ? 'the seat your role reports to' : 'one grade up'}
                            {p.grade != null ? ` · Grade ${p.grade}` : ''}
                          </p>
                        </div>
                        {i < paths.length - 1 ? (
                          <ChevronRight className="h-4 w-4 text-inkfaint" strokeWidth={2} />
                        ) : (
                          <Sparkles className="h-4 w-4 text-brand" strokeWidth={2} />
                        )}
                      </button>
                      {open && <PathDetail path={p} onClose={() => setDetail(null)} />}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* INTERNAL OPPORTUNITIES */}
          <section className="animate-slide-up">
            <div className="section-rule">
<h2 className="h-section">Internal opportunities</h2>
            </div>
            <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
              {opportunities.length === 0 ? (
                <p className="text-sm text-inkfaint">No open positions recorded right now.</p>
              ) : (
                <div className="divide-y divide-line/70">
                  {opportunities.map((o) => {
                    const open = detail?.kind === 'opp' && detail.id === o.position_id;
                    return (
                      <div key={o.position_id}>
                        <button
                          onClick={() => setDetail(open ? null : { kind: 'opp', id: o.position_id })}
                          className="flex w-full items-center gap-3 py-3 text-left first:pt-0 last:pb-0"
                          aria-expanded={open}
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-soft">
                            <Briefcase className="h-3.5 w-3.5 text-inkfaint" strokeWidth={2} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink">{o.role}</p>
                            <p className="text-xs text-inkfaint">
                              {o.department ?? '—'} · vacant
                            </p>
                          </div>
                          <ChevronRight className={clsx('h-4 w-4 text-inkfaint transition-transform', open && 'rotate-90')} strokeWidth={2} />
                        </button>
                        {open && <OpportunityDetail opp={o} onClose={() => setDetail(null)} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* MILESTONES */}
          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">Progress & milestones</h2>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-line bg-surface p-5">
                <p className="eyebrow">Milestone track</p>
                <ol className="mt-4 space-y-4">
                  {milestones.map((m, i) => (
                    <li key={i} className="relative flex gap-3">
                      <span className="flex flex-col items-center">
                        <span className={clsx('mt-1 h-2.5 w-2.5 rounded-full', m.kind === 'certification' ? 'bg-brand' : m.kind === 'joined' ? 'bg-ink' : 'bg-inkfaint')} />
                        {i < milestones.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
                      </span>
                      <div className="pb-2">
                        <p className="text-xs font-medium text-ink">{m.title}</p>
                        <p className="mt-0.5 text-2xs text-inkfaint">{fmtDate(m.date)}</p>
                      </div>
                    </li>
                  ))}
                  {milestones.length === 0 && <p className="text-sm text-inkfaint">No milestones recorded yet.</p>}
                </ol>
              </div>

              <div className="rounded-lg border border-line bg-surface p-5">
                <p className="eyebrow">Certifications</p>
                <div className="mt-3 space-y-2">
                  {certs.map((c) => (
                    <div key={c.cert_id} className="flex items-center gap-2.5 rounded-md border border-line bg-soft/30 px-3 py-2">
                      <Award className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-ink">{c.name}</p>
                        <p className="text-2xs text-inkfaint">{c.issuer} · {fmtDate(c.issued_on)}{c.expires_on ? ` · expires ${fmtDate(c.expires_on)}` : ''}</p>
                      </div>
                    </div>
                  ))}
                  {certs.length === 0 && <p className="text-sm text-inkfaint">None recorded.</p>}
                </div>
                <form
                  onSubmit={(e) => { e.preventDefault(); void addCert(); }}
                  className="mt-4 grid gap-2 sm:grid-cols-2"
                >
                  <input value={certName} onChange={(e) => setCertName(e.target.value)} placeholder="Certification name" className="input" aria-label="Certification name" />
                  <input value={certIssuer} onChange={(e) => setCertIssuer(e.target.value)} placeholder="Issuer" className="input" aria-label="Issuer" />
                  <input value={certOn} onChange={(e) => setCertOn(e.target.value)} type="date" className="input" aria-label="Issued on" />
                  <input value={certExp} onChange={(e) => setCertExp(e.target.value)} type="date" className="input" aria-label="Expires on (optional)" />
                  <button type="submit" disabled={busy || !certName.trim() || !certIssuer.trim() || !certOn} className="btn-primary sm:col-span-2">
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} /> {busy ? 'Adding…' : 'Add certification'}
                  </button>
                </form>
              </div>

              <div className="rounded-lg border border-line bg-surface p-5 lg:col-span-2">
                <p className="eyebrow">Goals</p>
                <div className="mt-3 space-y-2">
                  {goals.map((g) => (
                    <div key={g.goal_id} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-soft/30 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className={clsx('text-xs font-medium', g.status === 'DONE' ? 'text-inkfaint line-through' : 'text-ink')}>{g.title}</p>
                        <p className="text-2xs text-inkfaint">{g.status} · due {fmtDate(g.due_date)}</p>
                      </div>
                      {g.status !== 'DONE' && (
                        <button
                          onClick={() => void setGoalStatus(g, 'DONE')}
                          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-2xs text-inksoft transition-colors hover:border-brand hover:text-branddeep"
                        >
                          <Check className="h-3 w-3" strokeWidth={2} /> Complete
                        </button>
                      )}
                    </div>
                  ))}
                  {goals.length === 0 && <p className="text-sm text-inkfaint">No goals yet — set one below.</p>}
                </div>
                <form
                  onSubmit={(e) => { e.preventDefault(); void addGoal(); }}
                  className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
                >
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A goal worth growing toward…" className="input" aria-label="New goal" />
                  <input value={due} onChange={(e) => setDue(e.target.value)} type="date" className="input sm:w-40" aria-label="Goal due date" />
                  <button type="submit" disabled={busy || !title.trim()} className="btn-primary sm:col-span-2">
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} /> {busy ? 'Adding…' : 'Set goal'}
                  </button>
                </form>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SkillDetail({ name, cluster, level, onClose }: { name: string; cluster: string; level: number | null; onClose: () => void }) {
  return (
    <div className="animate-slide-down mt-2 rounded-md border border-line bg-soft/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink">{name}</p>
          <p className="mt-0.5 text-2xs text-inkfaint capitalize">{CLUSTER_LABEL[cluster] ?? cluster} cluster · proficiency {level ?? 0}/5</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-inkfaint hover:text-ink" aria-label="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-inksoft">
        A {cluster} capability. Your recorded level is {level ?? 0}/5. Skills in the same cluster build on each other — see "What I need" for the related skills you can add.
      </p>
    </div>
  );
}

function GapDetail({ gap, onClose }: { gap: { name: string; cluster: string; source_name: string }; onClose: () => void }) {
  return (
    <div className="animate-slide-down mt-3 rounded-md border border-brand/40 bg-brandsoft/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Learning focus: {gap.name}</p>
        <button onClick={onClose} className="rounded p-1 text-inkfaint hover:text-ink" aria-label="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-inksoft">
        <span className="font-medium text-ink">Why:</span> it extends {gap.source_name}, which you already use.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-inksoft">
        <span className="font-medium text-ink">Next:</span> apply it in a real piece of work — a small project using {gap.name} alongside {gap.source_name} is the honest path. Record it as a goal or certification above.
      </p>
    </div>
  );
}

function PathDetail({ path, onClose }: { path: { role: string; department: string | null; kind: string; vacant: boolean; holder_name: string | null; already_demonstrated: string[]; development_areas: string[] }; onClose: () => void }) {
  const overlap = path.already_demonstrated.length;
  const missing = path.development_areas.length;
  const readiness = overlap + missing > 0 ? Math.round((overlap / (overlap + missing)) * 100) : 100;
  return (
    <div className="animate-slide-down border-t border-line/70 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">Pathway explanation</p>
        <button onClick={onClose} className="rounded p-1 text-inkfaint hover:text-ink" aria-label="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-inksoft">
        {path.vacant
          ? `This seat is open in ${path.department ?? 'the organization'}.`
          : `${path.holder_name ?? 'The current holder'} sits in this role in ${path.department ?? 'the organization'}.`}{' '}
        {path.kind === 'leadership' ? 'It is the seat your role reports into — the leadership step directly above you.' : 'It is the next grade step within reach.'}
      </p>

      {/* ROLE COMPARISON */}
      <div className="mt-4 rounded-md border border-line bg-soft/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-2xs uppercase tracking-[0.14em] text-inkfaint">You vs {path.role} · skill overlap</p>
          <span className={clsx('rounded-full px-2.5 py-0.5 text-2xs font-medium uppercase tracking-[0.12em]', readiness >= 70 ? 'bg-oksoft text-ok' : readiness >= 40 ? 'bg-warnsoft text-warn' : 'bg-dangersoft text-danger')}>
            {readiness}% ready
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/60" role="progressbar" aria-valuenow={readiness} aria-valuemin={0} aria-valuemax={100} aria-label={`Skill overlap with ${path.role}`}>
          <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${readiness}%` }} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-2xs font-medium uppercase tracking-[0.12em] text-inkfaint">You already demonstrate</p>
            <ul className="mt-2 space-y-1.5">
              {path.already_demonstrated.map((s) => (
                <li key={s} className="flex items-center gap-2 text-xs text-inksoft">
                  <Check className="h-3.5 w-3.5 shrink-0 text-ok" strokeWidth={2} /> {s}
                </li>
              ))}
              {overlap === 0 && <li className="text-2xs text-inkfaint">No overlap recorded with this role's skills.</li>}
            </ul>
          </div>
          <div>
            <p className="text-2xs font-medium uppercase tracking-[0.12em] text-inkfaint">Development areas</p>
            <ul className="mt-2 space-y-1.5">
              {path.development_areas.map((s) => (
                <li key={s} className="flex items-center gap-2 text-xs text-inksoft">
                  <Plus className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2} /> {s}
                </li>
              ))}
              {missing === 0 && <li className="text-2xs text-inkfaint">No gaps recorded against this role.</li>}
            </ul>
          </div>
        </div>
        <p className="mt-3 text-2xs leading-relaxed text-inkfaint">
          Readiness is the share of this role's known skills you already record, computed from your skill profile — no judgement, just the comparison.
        </p>
      </div>
    </div>
  );
}

function OpportunityDetail({ opp, onClose }: { opp: { role: string; department: string | null; grade: number | null; head_of_department_id: string | null }; onClose: () => void }) {
  return (
    <div className="animate-slide-down border-t border-line/70 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">Opportunity</p>
        <button onClick={onClose} className="rounded p-1 text-inkfaint hover:text-ink" aria-label="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-inksoft">
        {opp.role} is an open role in {opp.department ?? 'the organization'}
        {opp.grade != null ? ` at grade ${opp.grade}` : ''}. {opp.head_of_department_id ? 'This seat carries department-lead responsibility.' : 'This is a regular open position.'}
      </p>
      <p className="mt-1 text-2xs text-inkfaint">To pursue it: discuss with your manager, then compare the pathway above for required skills.</p>
    </div>
  );
}
