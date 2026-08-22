import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Activity, Clock, HeartHandshake, TrendingUp, Wallet, ShieldAlert, Network } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { formatDate, formatTime, relativeDay } from '../lib/format';
import { MotivationPanel } from '../components/motivation/MotivationPanel';
import { Notice } from '../components/ui/primitives';
import { fetchExplorer } from '../components/org/OrgExplorer';
import clsx from 'clsx';

const STATE_STATUS: Record<string, string> = {
  NORMAL: 'status-ok',
  WATCH: 'status-info',
  ELEVATED: 'status-warn',
  HIGH: 'status-warn',
  CRITICAL: 'status-danger',
};

const STATE_LABEL: Record<string, string> = {
  NORMAL: 'Balanced',
  WATCH: 'Watch',
  ELEVATED: 'Elevated',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: attendance, isError: attendanceError } = useQuery({
    queryKey: ['attendance'],
    queryFn: async () => (await api.get('/attendance')).data,
  });

  const { data: leave, isError: leaveError } = useQuery({
    queryKey: ['leave'],
    queryFn: async () => (await api.get('/leave-requests')).data,
  });

  const { data: messages, isError: messagesError } = useQuery({
    queryKey: ['messages'],
    queryFn: async () => (await api.get('/messages')).data,
  });

  const { data: notifications, isError: notificationsError } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications')).data,
  });

  const { data: teamLeave } = useQuery({
    queryKey: ['leave-team'],
    queryFn: async () => (await api.get('/leave-requests', { params: { scope: 'team' } })).data,
  });

  const { data: workload } = useQuery({
    queryKey: ['workload'],
    queryFn: async () => (await api.get('/workload/me')).data,
  });

  const { data: payslips } = useQuery({
    queryKey: ['payslips-summary'],
    queryFn: async () => (await api.get('/payroll/my-payslips')).data,
    retry: false,
  });

  const { data: growth } = useQuery({
    queryKey: ['growth-summary'],
    queryFn: async () => (await api.get('/growth/me')).data,
    retry: false,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects-day'],
    queryFn: async () => (await api.get('/projects')).data,
    retry: false,
  });

  const { data: explorer } = useQuery({
    queryKey: ['org-explorer-dash'],
    queryFn: fetchExplorer,
    retry: false,
    staleTime: 120000,
  });

  const myDept = (explorer?.departments ?? []).find((d: any) => d.head_person_id === user?.personId);

  const { data: envScorecard } = useQuery({
    queryKey: ['env-scorecard', myDept?.id ?? ''],
    queryFn: async () => (await api.get('/leadership/scorecard', { params: { department_id: myDept!.id } })).data,
    enabled: Boolean(myDept),
    retry: false,
  });

  const events = Array.isArray(attendance) ? attendance : [];
  const requests = Array.isArray(leave) ? leave : [];
  const inbox = Array.isArray(messages) ? messages : [];
  const updates = Array.isArray(notifications) ? notifications : [];
  const teamPending = (Array.isArray(teamLeave) ? teamLeave : []).filter((l: any) => l.status === 'PENDING').length;

  const todayKey = new Date().toISOString().split('T')[0];
  const todayEvents = events.filter((e: any) => e.occurred_at?.startsWith(todayKey));
  const clockIn = todayEvents.find((e: any) => e.event_type === 'CLOCK_IN');
  const clockOut = todayEvents.find((e: any) => e.event_type === 'CLOCK_OUT');
  const isClockedIn = todayEvents.length % 2 === 1;

  const unread = inbox.filter((m: any) => !m.read_status).length;
  const pendingLeave = requests.filter((l: any) => l.status === 'PENDING').length;
  const upcoming = requests
    .filter((l: any) => l.status === 'APPROVED' && new Date(l.start_date) >= new Date(new Date().toDateString()))
    .sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  // ---- adaptive operating state ----
  const state = workload?.state ?? 'NORMAL';
  const needsCare = state === 'ELEVATED' || state === 'HIGH' || state === 'CRITICAL';
  const activeProjects = Array.isArray(projects) ? projects : [];
  const myProjects = activeProjects.filter((p: any) => (p.members ?? []).some((m: any) => m.logical_id === user?.id || m.name === user?.preferredName) || p.owner_name === user?.preferredName).length;
  const moneyAvailable = Array.isArray(payslips) && payslips.length > 0;

  const surface = [
    {
      key: 'work',
      label: 'Work',
      sub: myProjects > 0 ? `${myProjects} project${myProjects > 1 ? 's' : ''} on your plate` : 'No active project on your plate',
      status: state === 'NORMAL' ? 'status-ok' : state === 'WATCH' ? 'status-info' : 'status-warn',
      statusText: STATE_LABEL[state],
      icon: Activity,
      to: '/projects',
      emphasis: false,
    },
    {
      key: 'time',
      label: 'Time',
      sub: isClockedIn ? `Clocked in at ${formatTime(clockIn?.occurred_at)}` : 'Not clocked in yet today',
      status: isClockedIn ? 'status-ok' : 'status-neutral',
      statusText: isClockedIn ? 'Clocked in' : 'Open',
      icon: Clock,
      to: '/attendance',
      emphasis: false,
    },
    {
      key: 'care',
      label: 'Care',
      sub: needsCare
        ? `Your workload is ${STATE_LABEL[state].toLowerCase()} — a reset is right here`
        : 'Reset, advisor and field safety — private to you',
      status: needsCare ? 'status-warn' : 'status-neutral',
      statusText: needsCare ? 'Needs attention' : 'Quiet',
      icon: HeartHandshake,
      to: '/care',
      emphasis: needsCare,
    },
    {
      key: 'growth',
      label: 'Growth',
      sub: growth?.opportunities?.length
        ? `${growth.opportunities.length} open opportunity ${growth.opportunities.length > 1 ? 's' : ''} within reach`
        : 'Your growth path is ready when you are',
      status: 'status-neutral',
      statusText: growth?.gaps?.length ? `${growth.gaps.length} gaps` : 'Clear',
      icon: TrendingUp,
      to: '/growth',
      emphasis: false,
    },
    {
      key: 'money',
      label: 'Money',
      sub: moneyAvailable ? 'Payslips reviewed and private' : 'Wallet and payslips are private to you',
      status: 'status-neutral',
      statusText: moneyAvailable ? `${payslips!.length} slips` : '—',
      icon: Wallet,
      to: '/pay',
      emphasis: false,
    },
  ].sort((a, b) => Number(b.emphasis) - Number(a.emphasis));

  return (
    <div className="space-y-10">
      <section className="animate-fade-in">
        <p className="flex items-center gap-2 eyebrow">
          <span className="bg-gradient-warm inline-block h-1 w-6 rounded-full" aria-hidden="true" />
          {today}
          <span
            className={clsx('ml-1 inline-block h-1.5 w-1.5 rounded-full',
              attendanceError || leaveError || messagesError || notificationsError ? 'bg-warn' : 'bg-ok')}
            aria-hidden="true"
          />
        </p>
        <h1 className="text-gradient-warm h-page mt-1">
          {greeting}, {user?.preferredName || 'there'}.
        </h1>
        <p className="prose-muted mt-2 max-w-xl">
          Your operating surface — where your day stands, adaptively ordered by what needs you most.
        </p>
        {(attendanceError || leaveError || messagesError || notificationsError) && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-line bg-warnsoft px-3 py-2 text-xs text-warn">
            Some live data is unavailable right now — the rest of your day is still here.
          </p>
        )}
      </section>

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">State at a glance</h2>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {surface.map((s) => (
            <button
              key={s.key}
              onClick={() => navigate(s.to)}
              className={clsx(
                'group relative overflow-hidden rounded-lg border p-4 text-left transition-all hover:-translate-y-0.5',
                s.emphasis ? 'border-brand bg-brandsoft/60 shadow-[0_10px_30px_-12px_rgba(255,90,31,0.45)]' : 'elev-1 border-line bg-surface hover:border-inkfaint'
              )}
            >
              {s.emphasis && <span className="absolute inset-x-0 top-0 h-1 bg-gradient-warm" aria-hidden="true" />}
              <div className="flex items-center gap-2">
                <s.icon className={clsx('h-3.5 w-3.5', s.emphasis ? 'text-brand' : 'text-inkfaint')} strokeWidth={1.75} />
                <p className="text-2xs uppercase tracking-[0.14em] text-inkfaint">{s.label}</p>
              </div>
              <p className="mt-2 font-display text-lg font-medium text-ink">{s.statusText}</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-inksoft">{s.sub}</p>
            </button>
          ))}
        </div>
      </section>

      {needsCare && (
        <section className="animate-slide-up">
          <Notice
            tone="warn"
            icon={<ShieldAlert className="h-4.5 w-4.5" strokeWidth={1.75} />}
            title={`Your workload reads ${STATE_LABEL[state].toLowerCase()} right now`}
            action={
              <button onClick={() => navigate('/care#reset')} className="btn-ink btn-sm shrink-0">
                Open a reset
              </button>
            }
          >
            This surface put Care first for a reason. A three-minute reset is available — private, no performance judgement.
          </Notice>
        </section>
      )}

      {envScorecard && !envScorecard.masked && envScorecard.index && (
        <section className="animate-slide-up rounded-lg border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
              <div>
                <p className="eyebrow">Team environment · {myDept?.name}</p>
                <p className="mt-0.5 text-2xs text-inkfaint">
                  An explainable composite — every number below comes from attendance and leave records, never from guesses.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={clsx('rounded-full px-2.5 py-0.5 text-2xs font-medium uppercase tracking-[0.12em]', envScorecard.index.band === 'HEALTHY' && 'bg-oksoft text-ok', envScorecard.index.band === 'STABLE' && 'bg-brandsoft text-branddeep', envScorecard.index.band === 'STRAINED' && 'bg-warnsoft text-warn', envScorecard.index.band === 'STRESSED' && 'bg-dangersoft text-danger')}>
                {envScorecard.index.band}
              </span>
              <p className="font-display text-3xl leading-none text-ink">{envScorecard.index.index}<span className="text-base text-inkfaint">/100</span></p>
            </div>
          </div>
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {envScorecard.index.components.map((c: any) => (
              <div key={c.key} className="rounded-md border border-line bg-soft/40 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-2xs font-medium uppercase tracking-[0.12em] text-inksoft">{c.label} <span className="text-inkfaint">· {c.weight}%</span></p>
                  <p className="text-2xs text-inksoft">{c.score}/100</p>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/60">
                  <div className={clsx('h-full rounded-full', c.score >= 80 ? 'bg-ok' : c.score >= 60 ? 'bg-brand' : c.score >= 40 ? 'bg-warn' : 'bg-danger')} style={{ width: `${c.score}%` }} />
                </div>
                <p className="mt-1.5 text-2xs leading-relaxed text-inkfaint">{c.formula}</p>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigate('/organization')}
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-branddeep hover:underline"
          >
            Open the team environment <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </section>
      )}

      <MotivationPanel />

      {pendingLeave > 0 && (
        <section className="animate-slide-up">
          <Notice
            tone="warn"
            title={`${pendingLeave} of your leave request${pendingLeave > 1 ? 's' : ''} await${pendingLeave > 1 ? '' : 's'} your manager's decision`}
            action={
              <button onClick={() => navigate('/leave')} className="btn-ghost btn-sm shrink-0">
                View <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            }
          >
            They stay visible here until the decision lands.
          </Notice>
        </section>
      )}

      {teamPending > 0 && (
        <section className="animate-slide-up">
          <Notice
            tone="warn"
            title={`${teamPending} team leave request${teamPending > 1 ? 's' : ''} awaiting your decision`}
            action={
              <button onClick={() => navigate('/leave')} className="btn-ghost btn-sm shrink-0">
                Review now <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            }
          >
            Your team is waiting on you — a quick review keeps their plans moving.
          </Notice>
        </section>
      )}

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">Your day</h2>
        </div>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          <button
            onClick={() => navigate('/attendance')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Attendance</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {clockIn
                  ? `Clocked in at ${formatTime(clockIn.occurred_at)}${clockOut ? ` · out at ${formatTime(clockOut.occurred_at)}` : ''}`
                  : 'Not clocked in yet today'}
              </p>
            </div>
            <span className={`status ${isClockedIn ? 'status-ok' : 'status-neutral'}`}>
              {isClockedIn ? 'Clocked in' : 'Not clocked in'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/leave')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Leave</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {upcoming.length > 0
                  ? `${upcoming[0].leave_type} · ${relativeDay(upcoming[0].start_date)} for ${upcoming[0].days_requested} day${upcoming[0].days_requested > 1 ? 's' : ''}`
                  : 'No approved time away coming up'}
              </p>
            </div>
            <span className={`status ${pendingLeave > 0 ? 'status-warn' : 'status-neutral'}`}>
              {pendingLeave > 0 ? `${pendingLeave} pending` : 'Clear'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/messages')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Messages</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {unread > 0 ? `${unread} unread message${unread > 1 ? 's' : ''} from colleagues` : 'Inbox is clear'}
              </p>
            </div>
            <span className={`status ${unread > 0 ? 'status-info' : 'status-neutral'}`}>
              {unread > 0 ? `${unread} unread` : 'All read'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/pay')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Pay</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {Array.isArray(payslips) && payslips.length > 0
                  ? `${payslips.length} payslip${payslips.length > 1 ? 's' : ''} available`
                  : 'Your payslips are private and reviewed'}
              </p>
            </div>
            <span className="status status-neutral">
              {Array.isArray(payslips) ? `${payslips.length} slips` : '—'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/growth')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Growth</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {growth?.opportunities?.length
                  ? `${growth.opportunities.length} open opportunity ${growth.opportunities.length > 1 ? 's' : ''} you could pursue`
                  : 'Your growth path is ready when you are'}
              </p>
            </div>
            <span className="status status-neutral">
              {growth?.gaps?.length ? `${growth.gaps.length} gaps to close` : '—'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/projects')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Focus</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {myProjects > 0
                  ? `${myProjects} active project${myProjects > 1 ? 's' : ''} carrying your work today`
                  : 'No active project on your plate today'}
              </p>
            </div>
            <span className={`status ${myProjects > 0 ? 'status-info' : 'status-neutral'}`}>
              {myProjects > 0 ? `${myProjects} active` : 'Open'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>

          <button
            onClick={() => navigate('/care')}
            className="list-row w-full text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Care slot</p>
              <p className="mt-0.5 text-xs text-inkfaint">
                {needsCare
                  ? `Your workload reads ${STATE_LABEL[state].toLowerCase()} — a short reset is the honest next step`
                  : 'A quiet reset is available — 30 seconds to 5 minutes, private to you'}
              </p>
            </div>
            <span className={`status ${needsCare ? 'status-warn' : 'status-neutral'}`}>
              {needsCare ? 'Reset recommended' : 'Check-in'}
            </span>
            <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          </button>
        </div>
      </section>

      {updates.filter((n: any) => !n.read_status).length > 0 && (
        <section className="animate-slide-up">
          <div className="section-rule">
            <h2 className="h-section">Updates</h2>
            <p className="text-2xs text-inkfaint">System notifications for you</p>
          </div>
          <div className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
            {updates
              .filter((n: any) => !n.read_status)
              .slice(0, 3)
              .map((n: any) => (
                <button
                  key={n.logical_id}
                  onClick={() => navigate('/messages')}
                  className="list-row w-full text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{n.title}</p>
                    <p className="mt-0.5 text-xs text-inkfaint">{n.message}</p>
                  </div>
                  <span className="status status-info">{n.type.replace(/_/g, ' ')}</span>
                  <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
                </button>
              ))}
          </div>
        </section>
      )}

      {workload && workload.signals?.length > 0 && (
        <section className="animate-slide-up">
          <div className="section-rule">
            <h2 className="h-section">Workload state</h2>
            <span className={`status ${STATE_STATUS[workload.state] ?? 'status-ok'}`}>
              {workload.state}
            </span>
          </div>
          <p className="mt-1 text-xs text-inkfaint">
            A defensible policy score from your attendance records (30-day lookback).
            {workload.score > 0 && ` Score ${workload.score}: ${workload.triggered_rules?.join(', ')}`}
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {workload.signals.map((s: any) => (
              <div key={s.code} className="rounded-lg border border-line bg-surface p-4">
                <p className="text-sm font-medium text-ink">{s.label}</p>
                <p className="mt-1 text-xs text-inksoft">{s.detail}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs text-inkfaint">
            Computed from your attendance records. Visible only to you.
            {(workload.state === 'ELEVATED' || workload.state === 'HIGH' || workload.state === 'CRITICAL') && (
              <span className="text-inksoft">
                {' '}If this state persists, your manager or team lead may discreetly see that your workload is
                elevated — without seeing the underlying signals.
              </span>
            )}
          </p>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="animate-slide-up">
          <div className="section-rule">
            <h2 className="h-section">Upcoming time away</h2>
          </div>
          <div className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
            {upcoming.slice(0, 3).map((l: any) => (
              <button key={l.logical_id} onClick={() => navigate('/leave')} className="list-row w-full text-left">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{l.leave_type}</p>
                  <p className="mt-0.5 text-xs text-inkfaint">
                    {relativeDay(l.start_date)} · {formatDate(l.start_date)} – {formatDate(l.end_date)} · {l.days_requested} day{l.days_requested > 1 ? 's' : ''}
                  </p>
                </div>
                <span className="status status-ok">Approved</span>
                <ArrowUpRight className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">Recent activity</h2>
        </div>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {inbox.slice(0, 3).map((m: any) => (
            <button
              key={m.logical_id}
              onClick={() => navigate('/messages')}
              className="list-row w-full text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{m.subject}</p>
                <p className="mt-0.5 truncate text-xs text-inkfaint">{m.content}</p>
              </div>
              <div className="text-right">
                {!m.read_status && <span className="mb-1 block h-1.5 w-1.5 rounded-full bg-brand" />}
                <p className="text-2xs text-inkfaint">{m.sender_name}</p>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}