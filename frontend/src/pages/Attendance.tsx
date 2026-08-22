import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldCheck, Play, Pause, Coffee, Utensils, User, Wind, Clock, ChevronRight, X, LogIn, LogOut,
  Timer, AlertTriangle, MonitorSmartphone, MapPin, Fingerprint,
} from 'lucide-react';
import { api } from '../api/client';
import { formatDateTime, formatTime } from '../lib/format';
import clsx from 'clsx';

// ---------------------------------------------------------------- break catalog
const BREAK_TYPES = [
  { key: 'SHORT', icon: Coffee, label: 'Short break', blurb: 'A quick pause to reset', cls: 'text-inkfaint' },
  { key: 'MEAL', icon: Utensils, label: 'Meal', blurb: 'Recess / meal time', cls: 'text-warn' },
  { key: 'PERSONAL', icon: User, label: 'Personal', blurb: 'Personal errand', cls: 'text-info' },
  { key: 'WELLBEING', icon: Wind, label: 'Wellbeing', blurb: 'Reset or movement', cls: 'text-ok' },
  { key: 'OTHER', icon: Clock, label: 'Other', blurb: 'Other policy-approved reason', cls: 'text-inkfaint' },
] as const;

const BREAK_STYLE: Record<string, { label: string; bar: string; chip: string }> = {
  SHORT: { label: 'Short break', bar: 'bg-mutedfill', chip: 'bg-soft text-inksoft' },
  MEAL: { label: 'Meal', bar: 'bg-warn/50', chip: 'bg-warnsoft text-warn' },
  PERSONAL: { label: 'Personal', bar: 'bg-info/50', chip: 'bg-infosoft text-info' },
  WELLBEING: { label: 'Wellbeing', bar: 'bg-ok/50', chip: 'bg-oksoft text-ok' },
  OTHER: { label: 'Other', bar: 'bg-linestrong', chip: 'bg-soft text-inksoft' },
};

interface Segment { type: 'WORK' | 'BREAK'; breakType: string | null; from: string; to: string | null; minutes: number }
interface TodayData {
  state: 'OFF_CLOCK' | 'WORKING' | 'ON_BREAK';
  active_break_type: string | null;
  break_label: string | null;
  segments: Segment[];
  worked_minutes: number;
  break_minutes: number;
  break_count: number;
  anomalies: string[];
  is_clocked_in: boolean;
  events: any[];
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function useNowTick(enabled: boolean) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => force((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
}

// ---------------------------------------------------------------- timeline
function SessionTimeline({ segments, state, workedMin }: { segments: Segment[]; state: string; workedMin: number }) {
  const nowMs = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(); dayEnd.setHours(23, 59, 0, 0);
  const span = dayEnd.getTime() - dayStart.getTime();
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - dayStart.getTime()) / span) * 100));

  return (
    <div className="mt-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Session today</p>
          <p className="tnum mt-1 font-display text-2xl font-semibold text-ink">{fmtMin(workedMin)}</p>
          <p className="text-xs text-inkfaint">worked{state !== 'OFF_CLOCK' ? ' and counting' : ''} · scheduled 8h</p>
        </div>
      </div>

      <div className="relative mt-4 h-9 overflow-hidden rounded-lg bg-soft ring-1 ring-line/70">
        {segments.map((s, i) => {
          const from = new Date(s.from).getTime();
          const to = s.to ? new Date(s.to).getTime() : nowMs;
          const left = pct(from);
          const width = pct(to) - pct(from);
          const isWork = s.type === 'WORK';
          const style = isWork
            ? 'bg-gradient-to-r from-brand/85 to-brand/60'
            : (BREAK_STYLE[s.breakType ?? 'OTHER']?.bar ?? 'bg-slate-300');
          return (
            <div
              key={i}
              className={clsx('absolute inset-y-1 rounded-sm transition-all', style)}
              style={{ left: `${left}%`, width: `${Math.max(0, width)}%` }}
              title={`${isWork ? 'Work' : s.breakType ?? 'Break'} · ${fmtMin(s.minutes)}`}
            />
          );
        })}
        {state !== 'OFF_CLOCK' && (
          <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${pct(nowMs)}%` }}>
            <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-ink" />
          </div>
        )}
      </div>

      {segments.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {segments.map((s, i) => {
            const isWork = s.type === 'WORK';
            const start = formatTime(s.from);
            const end = s.to ? formatTime(s.to) : state === 'ON_BREAK' && !isWork ? 'now' : state === 'WORKING' && isWork ? 'now' : '';
            const label = isWork ? 'Work session' : (BREAK_STYLE[s.breakType ?? 'OTHER']?.label ?? 'Break');
            return (
              <div key={i} className="flex items-center gap-2.5 text-2xs">
                <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', isWork ? 'bg-brand' : (BREAK_STYLE[s.breakType ?? 'OTHER']?.bar ?? 'bg-slate-300'))} />
                <span className="w-28 shrink-0 font-medium text-ink">{label}</span>
                <span className="tnum text-inkfaint">{start} → {end}</span>
                <span className="ml-auto tnum font-medium text-inksoft">{fmtMin(s.minutes)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- main
export function Attendance() {
  const queryClient = useQueryClient();
  const [imagePath, setImagePath] = useState('https://demo.edurankai.local/photos/webcam_capture.jpg');
  const [breakOpen, setBreakOpen] = useState(false);
  const [detailEvent, setDetailEvent] = useState<any | null>(null);
  const [otherReason, setOtherReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['attendance'],
    queryFn: async () => (await api.get('/attendance')).data,
  });

  const { data: today } = useQuery({
    queryKey: ['attendance-today'],
    queryFn: async () => (await api.get('/attendance/today')).data,
  });

  const { data: summary } = useQuery({
    queryKey: ['attendance-summary'],
    queryFn: async () => (await api.get('/attendance/summary')).data,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['attendance'] });
    queryClient.invalidateQueries({ queryKey: ['attendance-today'] });
    queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
  };

  const clockIn = useMutation({
    mutationFn: async () =>
      (await api.post('/attendance/clock-in', { location: 'Office', device_id: 'WEB-001', captured_image_path: imagePath })).data,
    onSuccess: () => { toast.success('Clocked in — welcome to your work session'); invalidate(); },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Clock-in failed'),
  });

  const clockOut = useMutation({
    mutationFn: async () => (await api.post('/attendance/clock-out', { location: 'Office', device_id: 'WEB-001' })).data,
    onSuccess: () => { toast.success('Clocked out — good work today'); invalidate(); },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Clock-out failed'),
  });

  const breakStart = useMutation({
    mutationFn: async (payload: { break_type: string; reason?: string }) =>
      (await api.post('/attendance/break/start', payload)).data,
    onSuccess: () => { toast.success('Break started — take the time you need'); setBreakOpen(false); setOtherReason(''); invalidate(); },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Could not start break'),
  });

  const breakEnd = useMutation({
    mutationFn: async () => (await api.post('/attendance/break/end', {})).data,
    onSuccess: () => { toast.success('Resumed work'); invalidate(); },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Could not resume'),
  });

  const t = (today ?? {}) as TodayData;
  const state = t.state ?? 'OFF_CLOCK';
  const onBreak = state === 'ON_BREAK';
  const working = state === 'WORKING';

  // Live break timer (counts up while on break).
  useNowTick(onBreak);
  const activeBreakFrom = useRef<string | null>(null);
  useEffect(() => {
    if (onBreak) {
      const s = [...(t.segments ?? [])].reverse().find((x) => x.type === 'BREAK');
      activeBreakFrom.current = s?.from ?? null;
    }
  }, [onBreak, t.segments]);
  const breakElapsed = activeBreakFrom.current && onBreak
    ? Math.max(0, Math.round((Date.now() - new Date(activeBreakFrom.current).getTime()) / 60000))
    : 0;

  const events = (Array.isArray(data) ? data : []) as any[];

  return (
    <div className="space-y-6">
      <section className="animate-fade-in">
        <p className="eyebrow">Attendance</p>
        <h1 className="h-page mt-1">Your day in sessions</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Work, breaks, meal and recovery — your day as it actually unfolds, not two timestamps.
        </p>
      </section>

      <section className="animate-slide-up grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* ------------------------------------------------ session card */}
        <div className="relative overflow-hidden rounded-2xl border border-line bg-surface elev-1 p-6">
          {working && (
            <div className="pointer-events-none absolute -right-10 -top-16 h-44 w-52 rotate-12 bg-gradient-brand-fade" aria-hidden="true" />
          )}
          {onBreak && (
            <div className="pointer-events-none absolute -right-12 -top-14 h-40 w-40 rounded-full bg-ok/10 blur-2xl" aria-hidden="true" />
          )}
          <div className={clsx('absolute inset-x-0 top-0 h-1 transition-colors duration-500',
            onBreak ? 'bg-ok' : working ? 'bg-gradient-to-r from-brand to-accent' : 'bg-line')} aria-hidden="true" />

          <div className="relative">
            <p className="flex items-center gap-2 eyebrow">
              Session
              {working && (
                <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
                </span>
              )}
              {onBreak && <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />}
            </p>
            <p className="mt-3 font-display text-3xl font-semibold text-ink">
              {onBreak ? 'On break' : working ? 'Working' : 'Not clocked in'}
            </p>
            <p className="mt-1 text-sm text-inksoft">
              {onBreak
                ? `${t.break_label ?? 'Break'} in progress`
                : working
                  ? `Clocked in at ${formatTime(t.events?.find((e) => e.event_type === 'CLOCK_IN')?.occurred_at)}`
                  : 'Start your work session to begin recording'}
            </p>
          </div>

          {onBreak && (
            <div className="animate-slide-down mt-4 rounded-xl border border-ok/30 bg-oksoft/50 p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-ok">
                <Timer className="h-4 w-4" strokeWidth={1.75} />
                {fmtMin(breakElapsed)} elapsed
              </p>
              <p className="mt-1 text-2xs text-inksoft">Recovery is part of the work. Come back when you're ready.</p>
              <button
                onClick={() => breakEnd.mutate()}
                disabled={breakEnd.isPending}
                className="btn btn-ink mt-3 w-full"
              >
                <Play className="h-4 w-4" strokeWidth={2} /> {breakEnd.isPending ? 'Resuming…' : 'Resume work'}
              </button>
            </div>
          )}

          {!onBreak && (
            <div className="mt-5 space-y-3">
              {working ? (
                <>
                  <button
                    onClick={() => setBreakOpen(true)}
                    className="btn btn-ink w-full"
                  >
                    <Pause className="h-4 w-4" strokeWidth={2} /> Take a break
                  </button>
                  <button
                    onClick={() => clockOut.mutate()}
                    disabled={clockOut.isPending}
                    className="btn btn-secondary w-full"
                  >
                    <LogOut className="h-4 w-4" strokeWidth={2} /> {clockOut.isPending ? 'Clocking out…' : 'End work session'}
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <label className="label">Photo path (for capture)</label>
                    <input className="input" value={imagePath} onChange={(e) => setImagePath(e.target.value)} />
                    <p className="hint">Demo capture source — your device camera replaces this in production.</p>
                  </div>
                  <button
                    onClick={() => clockIn.mutate()}
                    disabled={clockIn.isPending}
                    className="btn btn-ink w-full"
                  >
                    <LogIn className="h-4 w-4" strokeWidth={2} /> {clockIn.isPending ? 'Clocking in…' : 'Start work session'}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="mt-5 grid grid-cols-3 gap-2">
            <div className="stat p-3 text-center">
              <p className="eyebrow">Worked</p>
              <p className="stat-value mt-1 text-lg">{fmtMin(t.worked_minutes ?? 0)}</p>
            </div>
            <div className="stat p-3 text-center">
              <p className="eyebrow">Break</p>
              <p className="stat-value mt-1 text-lg">{fmtMin(t.break_minutes ?? 0)}</p>
            </div>
            <div className="stat p-3 text-center">
              <p className="eyebrow">Breaks</p>
              <p className="stat-value mt-1 text-lg">{t.break_count ?? 0}</p>
            </div>
          </div>

          {(t.anomalies ?? []).length > 0 && (
            <div className="mt-4 space-y-1.5">
              {(t.anomalies ?? []).map((a, i) => (
                <p key={i} className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warnsoft/50 px-3 py-2 text-2xs leading-relaxed text-warn">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} /> {a}
                </p>
              ))}
            </div>
          )}

          <p className="mt-5 flex items-center gap-1.5 text-2xs leading-relaxed text-inkfaint">
            <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            Policy §10 requires a captured image at clock-in. Every event is append-only and audited.
          </p>
        </div>

        {/* ------------------------------------------------ timeline + history */}
        <div className="min-w-0 flex-1 space-y-4">
          {t.segments && t.segments.length > 0 && (
            <div className="animate-slide-up rounded-2xl border border-line bg-surface p-5">
              <SessionTimeline segments={t.segments} state={state} workedMin={t.worked_minutes ?? 0} />
            </div>
          )}

          {summary && summary.events_count > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-soft/40 px-4 py-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-ok" strokeWidth={1.75} />
              <p className="text-xs leading-relaxed text-inksoft">
                <span className="font-medium text-ink">Record verified.</span> {summary.events_count} events,{' '}
                {summary.days_with_events} active day{summary.days_with_events > 1 ? 's' : ''} in 30 days ·
                device on {summary.coverage.device_pct}% · location on {summary.coverage.location_pct}%.
              </p>
            </div>
          )}

          {summary && summary.events_count > 0 && (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="stat">
                <p className="eyebrow">Worked · 30d</p>
                <p className="stat-value">{summary.total_worked_hours}h</p>
                <p className="stat-sub">{summary.avg_hours_per_active_day}h per active day</p>
              </div>
              <div className="stat">
                <p className="eyebrow">Active days</p>
                <p className="stat-value">{summary.days_with_events}</p>
                <p className="stat-sub">of the last 30</p>
              </div>
              <div className="stat">
                <p className="eyebrow">Late-night events</p>
                <p className="stat-value">{summary.late_night_events}</p>
                <p className="stat-sub">after 22:00 or before 05:00</p>
              </div>
              <div className="stat">
                <p className="eyebrow">Source coverage</p>
                <p className="stat-value">{summary.coverage.device_pct}%</p>
                <p className="stat-sub">events with device id</p>
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            {isLoading ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : events.length === 0 ? (
              <div className="empty-state">
                <p className="text-sm font-medium text-ink">No attendance events yet</p>
                <p className="mt-1 text-xs text-inkfaint">Start a work session to begin recording.</p>
              </div>
            ) : (
              <table className="data-table min-w-[540px]">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Time</th>
                    <th>Location</th>
                    <th>Device</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 50).map((a: any) => {
                    const label =
                      a.event_type === 'CLOCK_IN' ? 'Work session' :
                      a.event_type === 'CLOCK_OUT' ? 'End work' :
                      a.event_type === 'BREAK_START' ? `Break · ${a.metadata?.break_type ?? ''}` :
                      a.event_type === 'BREAK_END' ? 'Resume work' : a.event_type;
                    return (
                      <tr key={a.logical_id} className="cursor-pointer transition-colors hover:bg-soft/40" onClick={() => setDetailEvent(a)}>
                        <td>
                          <span className={clsx(
                            'status',
                            a.event_type === 'CLOCK_IN' ? 'status-ok' :
                            a.event_type === 'BREAK_START' ? 'status-info' : 'status-neutral'
                          )}>
                            {label}
                          </span>
                        </td>
                        <td className="tnum text-inksoft">{formatDateTime(a.occurred_at)}</td>
                        <td className="text-inksoft">{a.location || '—'}</td>
                        <td className="text-inkfaint">{a.device_id || '—'}</td>
                        <td className="text-right">
                          <ChevronRight className="ml-auto h-4 w-4 text-inkfaint" strokeWidth={2} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="px-1 text-2xs text-inkfaint">Tap any event for full details — timestamp, location, device and capture method.</p>
        </div>
      </section>

      {/* ------------------------------------------------ break drawer (§34) */}
      {breakOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Take a break">
          <div className="w-full max-w-md animate-slide-up overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="border-b border-line/70 bg-soft/30 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-base font-semibold text-ink">Take a break</p>
                <button onClick={() => setBreakOpen(false)} className="text-inkfaint transition-colors hover:text-ink" aria-label="Close">
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <p className="mt-1 text-xs text-inksoft">Choose the kind of break — it stays visible in your session timeline.</p>
            </div>
            <div className="space-y-2 p-4">
              {BREAK_TYPES.map((b) => (
                <button
                  key={b.key}
                  onClick={() => breakStart.mutate({ break_type: b.key, reason: b.key === 'OTHER' && otherReason.trim() ? otherReason.trim() : undefined })}
                  disabled={breakStart.isPending}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-soft/30 p-3.5 text-left transition-all duration-200 hover:border-inkfaint hover:bg-soft disabled:opacity-40"
                >
                  <div className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', b.key === 'WELLBEING' ? 'bg-teal-100' : b.key === 'MEAL' ? 'bg-amber-100' : b.key === 'PERSONAL' ? 'bg-violet-100' : 'bg-soft')}>
                    <b.icon className={clsx('h-4 w-4', b.cls)} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{b.label}</p>
                    <p className="text-2xs text-inkfaint">{b.blurb}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-inkfaint" strokeWidth={2} />
                </button>
              ))}
              {otherReason && (
                <div className="animate-slide-down px-1">
                  <input
                    value={otherReason}
                    onChange={(e) => setOtherReason(e.target.value)}
                    placeholder="Reason (policy-approved)"
                    className="input w-full"
                    aria-label="Break reason"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ event details drawer (§36-37) */}
      {detailEvent && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink/30 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Event details">
          <button className="absolute inset-0" onClick={() => setDetailEvent(null)} aria-label="Close" />
          <div className="animate-slide-left relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-base font-semibold text-ink">
                <Clock className="h-4 w-4 text-inkfaint" strokeWidth={1.75} /> Event details
              </p>
              <button onClick={() => setDetailEvent(null)} className="text-inkfaint transition-colors hover:text-ink" aria-label="Close">
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            <span className={clsx('mt-3 inline-block rounded-full px-2.5 py-0.5 text-2xs font-medium', detailEvent.event_type === 'CLOCK_IN' ? 'bg-oksoft text-ok' : detailEvent.event_type === 'BREAK_START' ? 'bg-teal-100 text-teal-800' : 'bg-soft text-inkfaint')}>
              {detailEvent.event_type.replace(/_/g, ' ')}
            </span>
            <div className="mt-4 space-y-2">
              <div className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
                <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">Timestamp</p>
                <p className="mt-0.5 text-sm font-medium text-ink">{formatDateTime(detailEvent.occurred_at)}</p>
              </div>
              <div className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
                <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">
                  <MapPin className="h-3 w-3" strokeWidth={1.75} /> Location
                </p>
                <p className="mt-0.5 text-sm text-ink">{detailEvent.location || 'Not recorded'}</p>
              </div>
              <div className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
                <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">
                  <MonitorSmartphone className="h-3 w-3" strokeWidth={1.75} /> Verified from
                </p>
                <p className="mt-0.5 text-sm text-ink">{detailEvent.device_id || '—'}</p>
                {detailEvent.metadata?.user_agent && (
                  <p className="text-2xs text-inkfaint">{detailEvent.metadata.user_agent}</p>
                )}
              </div>
              <div className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
                <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">
                  <Fingerprint className="h-3 w-3" strokeWidth={1.75} /> Capture method
                </p>
                <p className="mt-0.5 text-sm text-ink">
                  {detailEvent.captured_image_path ? 'Captured image on record' : 'API event (no image required)'}
                </p>
              </div>
              {detailEvent.metadata?.ip && (
                <div className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
                  <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">Network</p>
                  <p className="mt-0.5 text-sm text-ink">recorded · authorization-controlled</p>
                  <p className="text-2xs text-inkfaint">IP details are retained for audit, never shown in your primary view.</p>
                </div>
              )}
            </div>
            <p className="mt-4 flex items-start gap-1.5 rounded-xl border border-line bg-soft/40 px-4 py-3 text-2xs leading-relaxed text-inkfaint">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} />
              Events are append-only and audited. Nothing here is shared with colleagues.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}