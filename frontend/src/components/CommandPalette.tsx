import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft, LayoutDashboard, Clock, CalendarDays, MessageSquare, Users, Briefcase, Network, HeartPulse, TrendingUp, Wallet, ScrollText, UserRound, Settings } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import clsx from 'clsx';

interface Command {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: any;
  run: () => void;
}

function intentMatch(q: string, ...needles: string[]): boolean {
  return needles.some((n) => q.includes(n));
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: people } = useQuery({
    queryKey: ['people'],
    queryFn: async () => (await api.get('/persons')).data,
    enabled: open,
  });

  const commands = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    const base: Command[] = [];

    if (!q) {
      return [
        { id: 'day', label: 'Open My Day', hint: 'dashboard', group: 'Go to', icon: LayoutDashboard, run: () => navigate('/dashboard') },
        { id: 'clock', label: 'Clock in / out', hint: 'attendance', group: 'Actions', icon: Clock, run: () => navigate('/attendance') },
        { id: 'leave', label: 'Start a leave request', hint: 'leave', group: 'Actions', icon: CalendarDays, run: () => navigate('/leave') },
        { id: 'msg', label: 'Open messages', hint: 'messages', group: 'Go to', icon: MessageSquare, run: () => navigate('/messages') },
        { id: 'people', label: 'Browse the directory', hint: 'people', group: 'Go to', icon: Users, run: () => navigate('/people') },
        { id: 'proj', label: 'View projects', hint: 'projects', group: 'Go to', icon: Briefcase, run: () => navigate('/projects') },
        { id: 'org', label: 'Explore the organization', hint: 'organization · 3D', group: 'Go to', icon: Network, run: () => navigate('/organization') },
        { id: 'care', label: 'Open Care', hint: 'wellbeing', group: 'Go to', icon: HeartPulse, run: () => navigate('/care') },
        { id: 'growth', label: 'Open my growth', hint: 'skills · pathways', group: 'Go to', icon: TrendingUp, run: () => navigate('/growth') },
        { id: 'pay', label: 'Open Pay', hint: 'wallet · payslips', group: 'Go to', icon: Wallet, run: () => navigate('/pay') },
        { id: 'audit', label: 'View audit trail', hint: 'audit', group: 'Go to', icon: ScrollText, run: () => navigate('/audit') },
        { id: 'prof', label: 'Open my profile', hint: 'profile', group: 'Go to', icon: UserRound, run: () => navigate('/profile') },
        { id: 'set', label: 'Open settings', hint: 'settings', group: 'Go to', icon: Settings, run: () => navigate('/settings') },
      ];
    }

    if (intentMatch(q, 'apply', 'request', 'book', 'leave')) {
      base.push({ id: 'nl-leave', label: 'Apply for leave', hint: 'Open the leave workspace', group: 'Intent', icon: CalendarDays, run: () => navigate('/leave') });
    }
    if (intentMatch(q, 'clock', 'check in', 'check out', 'punch')) {
      base.push({ id: 'nl-clock', label: 'Clock in or out', hint: 'Time at work', group: 'Intent', icon: Clock, run: () => navigate('/attendance') });
    }
    if (intentMatch(q, 'payslip', 'salary', 'pay')) {
      base.push({ id: 'nl-pay', label: 'See my pay', hint: 'Wallet, payslips and transfers', group: 'Intent', icon: Wallet, run: () => navigate('/pay') });
    }
    if (intentMatch(q, 'wellbeing', 'care', 'health')) {
      base.push({ id: 'nl-care', label: 'Open Care', hint: 'Wellbeing domains', group: 'Intent', icon: HeartPulse, run: () => navigate('/care') });
    }
    if (intentMatch(q, 'project')) {
      base.push({ id: 'nl-proj', label: 'View company projects', hint: 'Timelines and teams', group: 'Intent', icon: Briefcase, run: () => navigate('/projects') });
    }
    if (intentMatch(q, 'policy', 'maternity')) {
      base.push({ id: 'nl-policy', label: 'Read policy rules', hint: 'Policy text lives on each surface — e.g. Leave shows balance rules', group: 'Intent', icon: ScrollText, run: () => navigate('/leave') });
    }

    const personHits = intentMatch(q, 'find', 'search', 'who') || (people || []).some((p: any) =>
      (p.preferred_name || '').toLowerCase().includes(q) || (p.legal_name || '').toLowerCase().includes(q)
    );
    if (personHits) {
      for (const p of (Array.isArray(people) ? people : [])) {
        const name = (p.preferred_name || p.legal_name || '').toLowerCase();
        if (!name.includes(q) && !q.includes(name)) continue;
        base.push({
          id: 'person-' + p.logical_id,
          label: p.preferred_name || p.legal_name,
          hint: `${p.position_name || 'No role'} · ${p.department_name || 'Unassigned'}`,
          group: 'People',
          icon: Users,
          run: () => navigate('/people?q=' + encodeURIComponent(p.preferred_name || p.legal_name)),
        });
      }
    }

    const pages: Command[] = [
      { id: 'day', label: 'My Day', hint: 'dashboard', group: 'Go to', icon: LayoutDashboard, run: () => navigate('/dashboard') },
      { id: 'att', label: 'Attendance', hint: 'time at work', group: 'Go to', icon: Clock, run: () => navigate('/attendance') },
      { id: 'leave', label: 'Leave', hint: 'time away', group: 'Go to', icon: CalendarDays, run: () => navigate('/leave') },
      { id: 'msg', label: 'Messages', hint: 'inbox', group: 'Go to', icon: MessageSquare, run: () => navigate('/messages') },
      { id: 'people', label: 'People', hint: 'directory', group: 'Go to', icon: Users, run: () => navigate('/people') },
      { id: 'proj', label: 'Projects', hint: 'timelines and teams', group: 'Go to', icon: Briefcase, run: () => navigate('/projects') },
      { id: 'org', label: 'Organization', hint: 'universe · 2D/3D', group: 'Go to', icon: Network, run: () => navigate('/organization') },
      { id: 'care', label: 'Care', hint: 'wellbeing', group: 'Go to', icon: HeartPulse, run: () => navigate('/care') },
      { id: 'growth', label: 'Growth', hint: 'skills and pathways', group: 'Go to', icon: TrendingUp, run: () => navigate('/growth') },
      { id: 'pay', label: 'Pay', hint: 'wallet and payslips', group: 'Go to', icon: Wallet, run: () => navigate('/pay') },
      { id: 'audit', label: 'Audit', hint: 'trail', group: 'Go to', icon: ScrollText, run: () => navigate('/audit') },
      { id: 'prof', label: 'Profile', hint: 'me', group: 'Go to', icon: UserRound, run: () => navigate('/profile') },
      { id: 'set', label: 'Settings', hint: 'preferences', group: 'Go to', icon: Settings, run: () => navigate('/settings') },
    ];

    return [...base, ...pages.filter((c) => (c.label + ' ' + c.hint).toLowerCase().includes(q))];
  }, [query, people, navigate]);

  const results = commands;

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      if (e.key === 'Enter' && results[index]) {
        results[index].run();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, index, onClose]);

  if (!open) return null;

  const groups = results.reduce<Record<string, Command[]>>((acc, c) => {
    (acc[c.group] ||= []).push(c);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-lg animate-scale-in rounded-lg bg-surface shadow-modal">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            placeholder="Ask or search — “apply leave”, “find Priya”, “projects”…"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-inkfaint focus:outline-none"
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="max-h-[46vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-inkfaint">No matches for “{query}”.</p>
          ) : (
            Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <p className="px-4 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">{group}</p>
                {items.map((c) => {
                  const active = c.id === results[index]?.id;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setIndex(results.findIndex((r) => r.id === c.id))}
                      onClick={() => { c.run(); onClose(); }}
                      className={clsx(
                        'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
                        active ? 'bg-brandsoft text-branddeep' : 'text-inksoft'
                      )}
                    >
                      <c.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      <span className="flex-1">{c.label}</span>
                      <span className="hidden truncate text-2xs text-inkfaint sm:block">{c.hint}</span>
                      {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-2xs text-inkfaint">
          <span><span className="kbd mr-1">↑↓</span>navigate</span>
          <span><span className="kbd mr-1">↵</span>open</span>
          <span className="ml-auto">Commands respect your access rights</span>
        </div>
      </div>
    </div>
  );
}