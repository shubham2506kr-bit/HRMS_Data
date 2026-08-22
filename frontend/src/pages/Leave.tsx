import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { daysBetween, formatDate, relativeDay } from '../lib/format';

const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'PARENTAL', 'BEREAVEMENT', 'MATERNITY', 'PATERNITY', 'UNPAID'];
const ANNUAL_ALLOWANCE = 20;

const LEAVE_POLICY: Record<string, { allowance: number | null; note: string }> = {
  ANNUAL: { allowance: 20, note: 'Per calendar year; unused days do not carry over.' },
  SICK: { allowance: 10, note: 'Certification may be requested after extended absence.' },
  CASUAL: { allowance: 12, note: 'Short-notice personal time.' },
  PARENTAL: { allowance: 30, note: 'Shared parental leave per policy.' },
  MATERNITY: { allowance: 90, note: 'Statutory maternity leave.' },
  PATERNITY: { allowance: 15, note: 'Paternity leave per policy.' },
  BEREAVEMENT: { allowance: 3, note: 'Immediate family; extended in compassionate circumstances.' },
  UNPAID: { allowance: null, note: 'Unpaid time, subject to manager approval.' },
};

export function Leave() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [leaveType, setLeaveType] = useState('ANNUAL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['leave'],
    queryFn: async () => (await api.get('/leave-requests')).data,
  });

  const { data: teamData } = useQuery({
    queryKey: ['leave-team'],
    queryFn: async () => (await api.get('/leave-requests', { params: { scope: 'team' } })).data,
  });

  const requests = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const teamRequests = useMemo(
    () => (Array.isArray(teamData) ? teamData : []).filter((l: any) => l.status === 'PENDING'),
    [teamData]
  );

  const year = new Date().getFullYear();
  const approvedDays = requests
    .filter((l: any) => l.status === 'APPROVED' && new Date(l.start_date).getFullYear() === year)
    .reduce((sum: number, l: any) => sum + (l.days_requested || 0), 0);
  const pendingDays = requests
    .filter((l: any) => l.status === 'PENDING')
    .reduce((sum: number, l: any) => sum + (l.days_requested || 0), 0);

  const upcoming = requests
    .filter((l: any) => l.status === 'APPROVED' && new Date(l.start_date) >= new Date(new Date().toDateString()))
    .sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  const draftDays = startDate && endDate ? daysBetween(startDate, endDate) : 0;
  const remainingAfter = ANNUAL_ALLOWANCE - approvedDays - draftDays;

  const createLeave = useMutation({
    mutationFn: async () =>
      (await api.post('/leave-requests', { leave_type: leaveType, start_date: startDate, end_date: endDate, reason })).data,
    onSuccess: () => {
      toast.success('Leave request submitted');
      setShowForm(false);
      setStartDate('');
      setEndDate('');
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to submit request'),
  });

  const approve = useMutation({
    mutationFn: async (id: string) => (await api.put(`/leave-requests/${id}/approve`)).data,
    onSuccess: () => {
      toast.success('Request approved');
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Approval failed'),
  });

  const reject = useMutation({
    mutationFn: async (id: string) => (await api.put(`/leave-requests/${id}/reject`, { rejection_reason: 'Rejected by manager' })).data,
    onSuccess: () => {
      toast.success('Request rejected');
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Rejection failed'),
  });

  const statusClass = (s: string) =>
    s === 'APPROVED' ? 'status-ok' : s === 'PENDING' ? 'status-warn' : 'status-danger';

  const timelineYear = new Date().getFullYear();
  const approvedByMonth: number[] = new Array(12).fill(0);
  for (const l of requests) {
    if (l.status !== 'APPROVED') continue;
    const d = new Date(l.start_date);
    if (d.getFullYear() !== timelineYear) continue;
    approvedByMonth[d.getMonth()] += (l.days_requested || 0);
  }
  const maxMonthDays = Math.max(1, ...approvedByMonth);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthNow = new Date().getMonth();

  const draftOverlap = requests.filter((l: any) => {
    if (!startDate || !endDate) return false;
    const a = new Date(l.start_date + 'T00:00:00');
    const b = new Date(l.end_date + 'T00:00:00');
    const s = new Date(startDate + 'T00:00:00');
    const e = new Date(endDate + 'T00:00:00');
    return l.status !== 'REJECTED' && s <= b && e >= a;
  });

  return (
    <div className="space-y-10">
      <section className="flex flex-wrap items-end justify-between gap-4 animate-fade-in">
        <div>
          <p className="eyebrow">Leave</p>
          <h1 className="h-page mt-1">Time away</h1>
          <p className="prose-muted mt-2 max-w-xl">
            Balance, upcoming time away, and requests — all in one place.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel request' : 'New request'}
        </button>
      </section>

      <section className="animate-slide-up">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card p-5">
            <p className="eyebrow">Annual leave · {year}</p>
            <p className="tnum mt-2 font-display text-3xl font-semibold text-ink">
              {Math.max(ANNUAL_ALLOWANCE - approvedDays, 0)}
              <span className="ml-1 text-sm font-normal text-inkfaint">days remaining</span>
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-soft">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${Math.min(100, (approvedDays / ANNUAL_ALLOWANCE) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-inkfaint">{approvedDays} of {ANNUAL_ALLOWANCE} days used</p>
          </div>
          <div className="card p-5">
            <p className="eyebrow">Pending approval</p>
            <p className="tnum mt-2 font-display text-3xl font-semibold text-ink">
              {pendingDays}
              <span className="ml-1 text-sm font-normal text-inkfaint">days</span>
            </p>
            <p className="mt-1 text-xs text-inkfaint">Waiting for your manager</p>
          </div>
          <div className="card p-5">
            <p className="eyebrow">Next time away</p>
            <p className="mt-2 font-display text-3xl font-semibold text-ink">
              {upcoming.length > 0 ? relativeDay(upcoming[0].start_date) : '—'}
            </p>
            <p className="mt-1 text-xs text-inkfaint">
              {upcoming.length > 0
                ? `${upcoming[0].leave_type} · ${upcoming[0].days_requested} day${upcoming[0].days_requested > 1 ? 's' : ''}`
                : 'No approved leave ahead'}
            </p>
          </div>
        </div>

        <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Your year · {year}</p>
            <p className="text-2xs text-inkfaint">Approved days by month</p>
          </div>
          <div className="mt-4 flex items-end gap-2">
            {approvedByMonth.map((days, m) => (
              <div key={m} className="flex flex-1 flex-col items-center gap-1">
                <span className="tnum text-2xs text-inkfaint">{days > 0 ? days : ''}</span>
                <div
                  className={`w-full rounded-sm ${days > 0 ? 'bg-brand/80' : 'bg-soft'} ${m === monthNow ? 'ring-1 ring-linestrong' : ''}`}
                  style={{ height: Math.max(4, (days / maxMonthDays) * 44) }}
                  title={`${monthNames[m]} · ${days} day${days === 1 ? '' : 's'}`}
                />
                <span className={`text-2xs ${m === monthNow ? 'font-semibold text-ink' : 'text-inkfaint'}`}>
                  {monthNames[m]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
          <p className="eyebrow">Balance by type · {year}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="data-table min-w-[520px]">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="text-right">Allowance</th>
                  <th className="text-right">Used</th>
                  <th className="text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(LEAVE_POLICY).map(([type, pol]) => {
                  const used = requests
                    .filter((l: any) => l.leave_type === type && l.status === 'APPROVED' && new Date(l.start_date).getFullYear() === year)
                    .reduce((sum: number, l: any) => sum + (l.days_requested || 0), 0);
                  const remaining = pol.allowance == null ? null : Math.max(pol.allowance - used, 0);
                  return (
                    <tr key={type}>
                      <td>
                        <span className="font-medium text-ink">{type}</span>
                        <p className="max-w-[260px] text-2xs text-inkfaint">{pol.note}</p>
                      </td>
                      <td className="tnum text-right text-inksoft">{pol.allowance == null ? '—' : pol.allowance}</td>
                      <td className="tnum text-right text-inksoft">{used || '—'}</td>
                      <td className={`tnum text-right font-medium ${remaining != null && remaining === 0 ? 'text-warn' : 'text-ink'}`}>
                        {remaining == null ? '—' : remaining}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {showForm && (
        <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-6">
          <div className="section-rule">
            <h2 className="h-section">New leave request</h2>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Leave type</label>
              <select className="input" value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                {LEAVE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Reason</label>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional note for your manager" />
            </div>
            <div>
              <label className="label">Start date</label>
              <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="label">End date</label>
              <input type="date" className="input" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <div className="mt-4 rounded-md bg-soft/70 px-4 py-3 text-sm">
            {draftDays > 0 ? (
              <div className="space-y-1.5">
                <p className="text-inksoft">
                  {leaveType} · {formatDate(startDate)} – {formatDate(endDate)} · <span className="tnum font-medium text-ink">{draftDays} day{draftDays > 1 ? 's' : ''}</span>
                </p>
                <p className="text-ink">
                  After this request you will have {remainingAfter} annual day{remainingAfter === 1 ? '' : 's'} remaining.
                </p>
                {draftOverlap.length > 0 ? (
                  <p className="font-medium text-warn">
                    Overlaps {draftOverlap.length} existing request{draftOverlap.length > 1 ? 's' : ''} ({draftOverlap.map((l: any) => l.leave_type).join(', ')}).
                  </p>
                ) : (
                  <p className="text-ok">No overlap with existing requests.</p>
                )}
                <p className="text-inkfaint">Approval path: your manager, then HR records.</p>
              </div>
            ) : (
              <p className="text-inkfaint">Select dates to see duration, balance impact and conflicts.</p>
            )}
          </div>

          <div className="mt-5 flex gap-3">
            <button
              className="btn-primary"
              disabled={createLeave.isPending || !startDate || !endDate || draftDays < 1}
              onClick={() => createLeave.mutate()}
            >
              {createLeave.isPending ? 'Submitting…' : 'Submit request'}
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="animate-slide-up">
          <div className="section-rule">
            <h2 className="h-section">Upcoming time away</h2>
          </div>
          <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
            {upcoming.map((l: any) => (
              <div key={l.logical_id} className="list-row">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{l.leave_type}</p>
                  <p className="mt-0.5 text-xs text-inkfaint">
                    {relativeDay(l.start_date)} · {formatDate(l.start_date)} – {formatDate(l.end_date)}
                  </p>
                </div>
                <span className="tnum text-sm text-inksoft">{l.days_requested} days</span>
                <span className="status status-ok">Approved</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {teamRequests.length > 0 && (
        <section className="animate-slide-up">
          <div className="section-rule">
            <h2 className="h-section">Team review</h2>
            <p className="text-2xs text-inkfaint">Pending requests from your team. Sensitive leave types are shown as Away.</p>
          </div>
          <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
            {teamRequests.map((l: any) => (
              <div key={l.logical_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{l.person_name}</p>
                  <p className="mt-0.5 text-xs text-inkfaint">
                    {l.leave_type} · {formatDate(l.start_date)} – {formatDate(l.end_date)} · {l.days_requested} day{l.days_requested > 1 ? 's' : ''}
                  </p>
                </div>
                <span className="status status-warn">Pending</span>
                <div className="inline-flex gap-2">
                  <button className="btn-secondary btn-sm" onClick={() => approve.mutate(l.logical_id)}>Approve</button>
                  <button className="btn-danger btn-sm" onClick={() => reject.mutate(l.logical_id)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="animate-slide-up">
        <div className="section-rule">
          <h2 className="h-section">Requests</h2>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
            </div>
          ) : requests.length === 0 ? (
            <div className="empty-state">
              <p className="text-sm font-medium text-ink">No leave requests yet</p>
              <p className="mt-1 text-xs text-inkfaint">Start one when you need time away — your manager will be notified.</p>
            </div>
          ) : (
            <table className="data-table min-w-[640px]">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Dates</th>
                  <th className="text-right">Days</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((l: any) => (
                  <tr key={l.logical_id}>
                    <td className="font-medium text-ink">{l.leave_type}</td>
                    <td className="text-inksoft">
                      {formatDate(l.start_date)} – {formatDate(l.end_date)}
                    </td>
                    <td className="tnum text-right text-inksoft">{l.days_requested}</td>
                    <td>
                      <span className={`status ${statusClass(l.status)}`}>
                        {l.status === 'APPROVED' ? 'Approved' : l.status === 'PENDING' ? 'Pending' : 'Rejected'}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate text-inksoft">{l.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}