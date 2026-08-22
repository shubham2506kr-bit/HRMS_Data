import { useMemo, useState } from 'react';
import { FlaskConical, UserRound, Activity, Eye, RefreshCcw, Scale, MessageCircleHeart, Play, Check } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import clsx from 'clsx';

// Persona switching is passwordless identity takeover against a sandbox
// account. The server only exposes /api/auth/demo outside production; this flag
// keeps the affordance out of the production bundle as well. `import.meta.env`
// is statically replaced, so the section is dead code a production build drops.
const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true';

const PERSONAS = [
  { username: 'john', role: 'Engineering lead', blurb: 'Head of Engineering — sees team data, approves leave.' },
  { username: 'jane', role: 'Senior engineer', blurb: 'IC with department-head visibility. Sees only her own records.' },
  { username: 'lisa', role: 'Operations', blurb: 'Has a certification expiring soon — proactive reminders land here.' },
  { username: 'emily', role: 'Design', blurb: 'Design IC. Check what a colleague sees of your sensitive records.' },
] as const;

const PRIVACY_MATRIX = [
  { field: 'Sick-leave reason', self: 'Full', manager: 'Masked (AWAY)', hr: 'Full', others: '—' },
  { field: 'Date of birth', self: 'Full', manager: 'Trimmed', hr: 'Full', others: '—' },
  { field: 'Payslip (net amount)', self: 'Full', manager: '—', hr: 'Finance role', others: '—' },
  { field: 'Certifications', self: 'Full', manager: '—', hr: 'Full', others: '—' },
  { field: 'Health advisor queries', self: 'Full', manager: '—', hr: '—', others: '—' },
  { field: 'Wallet balance', self: 'Full', manager: '—', hr: '—', others: '—' },
  { field: 'Team health aggregates', self: '—', manager: 'Head only, ≥5 group', hr: '—', others: '—' },
] as const;

const AGENT_PROMPTS = [
  'I feel sick',
  "I'm sleepy",
  "I'm exhausted",
  'I feel stressed',
  "I can't sleep",
  'I need a reset',
  'Give me a simple traditional morning routine',
  'What do the Vedas say about wellbeing?',
  'What can I do at home for a mild everyday discomfort?',
  'Is there a traditional practice that supports calm and focus?',
  'I want to try something traditional — show me my options',
  'What about herbal tea for sleep?',
  'I am pregnant — is a herbal remedy safe?',
  'My doctor prescribed medication — can I combine it with herbs?',
] as const;

type Level = 'LOW' | 'MEDIUM' | 'HIGH';
const levelOf = (late: number, streak: number, gap: number): Level => {
  if (late >= 3 || streak >= 6) return 'HIGH';
  if (late >= 1 || streak >= 5 || gap < 7) return 'MEDIUM';
  return 'LOW';
};

export function Preview() {
  const [switching, setSwitching] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [late, setLate] = useState(1);
  const [streak, setStreak] = useState(3);
  const [gap, setGap] = useState(9);
  const [privacyField, setPrivacyField] = useState(0);
  const [parity, setParity] = useState<{ state: string; rules: string[] } | null>(null);
  const [parityErr, setParityErr] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [agentTurn, setAgentTurn] = useState<{ phase: string; mode: string; reply: string; chips: { label: string }[] } | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState(false);

  const switchTo = async (username: string) => {
    setSwitching(username);
    setErr(null);
    try {
      const res = await api.post('/auth/demo', { username });
      const { token, user } = res.data ?? {};
      if (!token || !user) throw new Error('Incomplete session response');

      // Full teardown before adopting the new identity: the outgoing persona's
      // cached payroll, health and audit responses must not survive the switch,
      // and its server-side session is revoked. Only then is the new token
      // stored — in the auth store (sessionStorage), never in localStorage.
      const auth = useAuth.getState();
      await auth.logout();
      auth.setToken(token);
      auth.setUser(user);
      window.location.href = '/dashboard';
    } catch (e: any) {
      setErr(e.response?.data?.message ?? 'Could not switch persona.');
      setSwitching(null);
    }
  };

  const checkParity = async () => {
    setParityErr(false);
    try {
      const res = await api.get('/workload/me');
      setParity({
        state: (res.data as { state: string }).state,
        rules: (res.data as { triggered_rules?: { rule: string }[] }).triggered_rules?.map((r) => r.rule) ?? [],
      });
    } catch {
      setParityErr(true);
    }
  };

  const runAgent = async (prompt: string) => {
    setAgentPrompt(prompt);
    setAgentBusy(true);
    setAgentErr(false);
    try {
      const res = await api.post('/care/agent', { message: prompt });
      setAgentTurn({
        phase: res.data.phase,
        mode: res.data.mode,
        reply: res.data.reply,
        chips: res.data.chips ?? [],
      });
    } catch {
      setAgentErr(true);
    } finally {
      setAgentBusy(false);
    }
  };

  const clearAgent = async () => {
    setAgentBusy(true);
    try {
      await api.post('/care/agent', { message: 'clear', clear: true });
      setAgentTurn(null);
      setAgentPrompt(null);
    } finally {
      setAgentBusy(false);
    }
  };

  const level = levelOf(late, streak, gap);
  const signals = useMemo(() => {
    const list: { label: string; sev: string }[] = [];
    if (late >= 3) list.push({ label: `${late} late-night clock events`, sev: 'HIGH' });
    else if (late >= 1) list.push({ label: `${late} late-night clock event(s)`, sev: 'MEDIUM' });
    if (streak >= 6) list.push({ label: `${streak}-day work streak`, sev: 'HIGH' });
    else if (streak >= 5) list.push({ label: `${streak}-day work streak`, sev: 'MEDIUM' });
    if (gap < 7) list.push({ label: `${gap}h rest between days`, sev: 'MEDIUM' });
    if (list.length === 0) list.push({ label: 'No red flags', sev: 'LOW' });
    return list;
  }, [late, streak, gap]);

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">Preview sandbox</p>
        <h1 className="h-page mt-1">Try it as someone else</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Live simulations against the real system — same APIs, same data, same rules. Nothing simulated here is
          written to the database.
        </p>
      </section>

      {err && (
        <section className="animate-slide-up rounded-lg border border-line bg-surface p-4">
          <p className="text-sm text-inksoft">{err}</p>
        </section>
      )}

      {DEMO_MODE && (
      <section className="animate-slide-up rounded-lg border border-line bg-surface p-5">
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          <p className="eyebrow">Persona switch</p>
        </div>
        <p className="mt-1 text-sm text-inksoft">
          Sign in as a different account (real authentication, sandbox accounts) and see exactly what they see.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PERSONAS.map((p) => (
            <button
              key={p.username}
              onClick={() => switchTo(p.username)}
              disabled={switching !== null}
              className="rounded-lg border border-line p-4 text-left transition-colors hover:bg-soft/60 disabled:opacity-50"
            >
              <div className="flex items-center gap-2.5">
                <div className="avatar h-8 w-8 text-xs">{p.username[0].toUpperCase()}</div>
                <div className="min-w-0">
                  <p className="text-sm font-medium capitalize text-ink">{p.username}</p>
                  <p className="text-2xs text-inkfaint">{p.role}</p>
                </div>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-inksoft">{p.blurb}</p>
            </button>
          ))}
        </div>
        <p className="mt-3 text-2xs text-inkfaint">
          {switching ? `Signing in as ${switching}…` : 'This performs a real login — the token is issued by the auth service.'}
        </p>
      </section>
      )}

      <section className="animate-slide-up grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
            <p className="eyebrow">Workload simulator</p>
          </div>
          <p className="mt-1 text-sm text-inksoft">
            Adjust the signals below — the workload level re-computes locally with the same thresholds the API uses.
          </p>
          <div className="mt-5 space-y-5">
            <label className="block">
              <div className="flex items-center justify-between text-sm text-ink">
                <span>Late-night clock events</span>
                <span className="tabular-nums text-inkfaint">{late}</span>
              </div>
              <input type="range" min={0} max={6} value={late} onChange={(e) => setLate(Number(e.target.value))} className="mt-2 w-full accent-[#FF5A1F]" />
            </label>
            <label className="block">
              <div className="flex items-center justify-between text-sm text-ink">
                <span>Consecutive work days</span>
                <span className="tabular-nums text-inkfaint">{streak}</span>
              </div>
              <input type="range" min={1} max={10} value={streak} onChange={(e) => setStreak(Number(e.target.value))} className="mt-2 w-full accent-[#FF5A1F]" />
            </label>
            <label className="block">
              <div className="flex items-center justify-between text-sm text-ink">
                <span>Rest hours between days</span>
                <span className="tabular-nums text-inkfaint">{gap}h</span>
              </div>
              <input type="range" min={4} max={16} value={gap} onChange={(e) => setGap(Number(e.target.value))} className="mt-2 w-full accent-[#FF5A1F]" />
            </label>
          </div>
          <div className="mt-5 flex items-center justify-between rounded-md border border-line bg-soft/40 px-4 py-3">
            <p className="text-sm text-inksoft">Computed level</p>
            <span className={clsx('rounded-full px-3 py-1 text-2xs font-medium uppercase tracking-[0.14em]', level === 'LOW' && 'bg-soft text-inkfaint', level === 'MEDIUM' && 'bg-warnsoft text-warn', level === 'HIGH' && 'bg-dangersoft text-danger')}>
              {level}
            </span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {signals.map((s) => (
              <li key={s.label} className="flex items-center justify-between text-xs text-inksoft">
                <span>{s.label}</span>
                <span className="text-2xs uppercase tracking-[0.12em] text-inkfaint">{s.sev}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-md border border-line bg-surface p-3">
            <div className="flex items-center gap-2">
              <Scale className="h-3.5 w-3.5 text-inkfaint" strokeWidth={1.75} />
              <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Policy parity check</p>
            </div>
            <p className="mt-1.5 text-xs text-inksoft">
              Your real level, computed by the API with the production thresholds — proof the simulator matches the policy.
            </p>
            {parity ? (
              <div className="mt-2 space-y-1.5">
                <p className="text-xs text-ink">
                  API state: <span className="font-medium uppercase">{parity.state}</span>
                </p>
                {parity.rules.length > 0 && (
                  <ul className="list-inside list-disc space-y-0.5 text-2xs text-inkfaint">
                    {parity.rules.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                )}
              </div>
            ) : (
              <button
                onClick={() => void checkParity()}
                className="mt-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-soft"
              >
                Check my real level
              </button>
            )}
            {parityErr && <p className="mt-2 text-2xs text-warn">Could not reach the workload API.</p>}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
            <p className="eyebrow">Privacy viewer</p>
          </div>
          <p className="mt-1 text-sm text-inksoft">
            What each role can actually see of a sensitive record — the same rules enforced by the API.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {PRIVACY_MATRIX.map((row, i) => (
              <button
                key={row.field}
                onClick={() => setPrivacyField(i)}
                className={clsx(
                  'rounded-full border px-3 py-1 text-2xs transition-colors',
                  privacyField === i ? 'border-ink bg-ink text-surface' : 'border-line text-inksoft hover:border-inkfaint'
                )}
              >
                {row.field}
              </button>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-2xs uppercase tracking-[0.14em] text-inkfaint">
                  <th className="pb-2 pr-4 font-medium">Viewer</th>
                  <th className="pb-2 font-medium">Visibility</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {(['self', 'manager', 'hr', 'others'] as const).map((v) => (
                  <tr key={v}>
                    <td className="py-2.5 pr-4 capitalize text-inksoft">{v}</td>
                    <td className={clsx('py-2.5', PRIVACY_MATRIX[privacyField][v] === '—' ? 'text-inkfaint' : 'text-ink')}>
                      {PRIVACY_MATRIX[privacyField][v]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-2xs text-inkfaint">Example: when John reviews team leave, sensitive types are masked to “AWAY” — he never sees the reason.</p>
        </div>
      </section>

      <section className="animate-slide-up rounded-lg border border-line bg-surface p-5">
        <div className="flex items-center gap-2">
          <MessageCircleHeart className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          <p className="eyebrow">Health advisor · live scenario</p>
        </div>
        <p className="mt-1 text-sm text-inksoft">
          Send one of the preview prompts to the real agent engine — the state machine, clarification, refusal and
          provenance rules all run server-side against the WHO registry and the governed traditional-knowledge
          library. Traditional answers always show their source, evidence level and safety review.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {AGENT_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => void runAgent(p)}
              disabled={agentBusy}
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs text-inksoft transition-colors hover:border-brand hover:bg-brandsoft disabled:opacity-40"
            >
              <Play className="h-3 w-3" strokeWidth={2} /> {p}
            </button>
          ))}
        </div>
        {agentTurn && (
          <div className="mt-4 overflow-hidden rounded-md border border-line">
            <div className="flex items-center justify-between gap-3 border-b border-line/70 bg-soft/40 px-4 py-2.5">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-inkfaint">
                “{agentPrompt}”
              </p>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-soft px-2 py-0.5 text-2xs uppercase tracking-[0.12em] text-inkfaint">{agentTurn.phase}</span>
                <span className="rounded-full bg-brandsoft px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.12em] text-branddeep">{agentTurn.mode}</span>
                <button onClick={() => void clearAgent()} disabled={agentBusy} className="rounded-md p-1 text-inkfaint transition-colors hover:bg-soft hover:text-ink" aria-label="Clear conversation">
                  <RefreshCcw className="h-3 w-3" strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-sm leading-relaxed text-ink">{agentTurn.reply}</p>
              {agentTurn.chips.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {agentTurn.chips.map((c) => (
                    <span key={c.label} className="rounded-full border border-line px-2.5 py-0.5 text-2xs text-inksoft">{c.label}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {agentErr && <p className="mt-3 text-2xs text-warn">Could not reach the advisor API.</p>}
        {agentBusy && !agentTurn && <p className="mt-3 text-2xs text-inkfaint">Advisor is thinking…</p>}
        <p className="mt-3 text-2xs text-inkfaint">
          These turns write a real advisor-query record and audit entry — exactly what the Care page does.
          <a href="/care#advisor" className="ml-1 inline-flex items-center gap-0.5 font-medium text-branddeep underline decoration-line underline-offset-2 hover:decoration-brand">
            Open the full conversation surface <Check className="h-2.5 w-2.5" strokeWidth={2} />
          </a>
        </p>
      </section>

      <section className="animate-slide-up flex items-center gap-3 rounded-lg border border-line bg-surface px-5 py-4">
        <FlaskConical className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
        <p className="flex-1 text-sm text-inksoft">
          The simulators are honest by construction: they change nothing, they only preview. Persona switches are
          real sessions — sign out at any time.
        </p>
        <button
          onClick={() => { setLate(1); setStreak(3); setGap(9); }}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-inksoft transition-colors hover:bg-soft"
        >
          <RefreshCcw className="h-3.5 w-3.5" strokeWidth={2} /> Reset simulators
        </button>
      </section>
    </div>
  );
}