import { useEffect, useState } from 'react';
import { Wallet as WalletIcon, FileText, ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Notice } from '../components/ui/primitives';
import clsx from 'clsx';

type Txn = { txn_id: string; txn_type: string; amount: number; reference_type: string; status: string; created_at: string };
type Payslip = {
  payslip_id: string; issued_at: string; period_start: string; period_end: string; run_status: string;
  salary_amount: number; unpaid_leave_days: number; gross_amount: number; tax_amount: number; net_amount: number;
  breakdown?: Record<string, unknown>;
};
type Wallet = { wallet_id: string; balance: number } | null;

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function Pay() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState<Wallet>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [openSlip, setOpenSlip] = useState<string | null>(null);
  const [openAmount, setOpenAmount] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [walletRes, slipsRes] = await Promise.all([
        api.get('/wallet'),
        api.get('/payroll/my-payslips'),
      ]);
      setWallet(walletRes.data.wallet);
      setTxns(walletRes.data.transactions ?? []);
      setPayslips(slipsRes.data ?? []);
    } catch (e) {
      setError('Could not load your financial data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const transfer = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await api.post('/wallet/transfer', {
        recipient_username: recipient.trim(),
        amount: Number(amount),
        idempotency_key: crypto.randomUUID(),
      });
      setMessage(res.data.duplicate ? 'This transfer was already recorded (duplicate ignored).' : `Sent ${fmtMoney(Number(amount))} to ${res.data.recipient_username}.`);
      setRecipient('');
      setAmount('');
      setTransferOpen(false);
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message ?? 'Transfer failed.');
    } finally {
      setBusy(false);
    }
  };

  const latest = payslips[0];
  const previous = payslips[1];
  const netDelta = latest && previous ? latest.net_amount - previous.net_amount : null;

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">Pay</p>
        <h1 className="h-page mt-1">Your money</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Wallet balance, payslips and what changed between runs — {user?.preferredName || 'there'}.
        </p>
      </section>

      {error && (
        <section className="animate-slide-up">
          <Notice
            tone="warn"
            title="Some pay data is unavailable"
            action={
              <button onClick={() => void load()} className="btn-ghost btn-sm shrink-0">Retry</button>
            }
          >
            {error}
          </Notice>
        </section>
      )}

      {loading && (
        <section className="grid gap-4 md:grid-cols-3" aria-label="Loading your pay">
          <div className="skeleton h-32" />
          <div className="skeleton h-32" />
          <div className="skeleton h-32" />
        </section>
      )}

      {!loading && (
      <section className="animate-slide-up grid gap-4 md:grid-cols-3">
        <div className="relative overflow-hidden rounded-lg bg-ink p-5 text-surface shadow-sm md:col-span-3 lg:col-span-1">
          <div className="pointer-events-none absolute -right-10 -top-16 h-44 w-52 rotate-12 bg-gradient-brand-fade blur-sm" aria-hidden="true" />
          <div className="relative">
            <div className="flex items-center gap-2">
              <WalletIcon className="h-4 w-4 text-surface/60" strokeWidth={1.75} />
              <p className="eyebrow text-surface/60">Wallet</p>
            </div>
            <p className="mt-3 font-display text-4xl tracking-tight">{fmtMoney(wallet?.balance)}</p>
            <p className="mt-1 text-2xs text-surface/60">Money you can actually move. Every payment is ledgered.</p>
          </div>
        </div>

        <div className="stat">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
            <p className="eyebrow">Latest payslip</p>
          </div>
          {latest ? (
            <>
              <p className="stat-value mt-2 text-3xl">{fmtMoney(latest.net_amount)}</p>
              <p className="stat-sub">
                {fmtDate(latest.period_start)} – {fmtDate(latest.period_end)}
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-inkfaint">No payslips yet.</p>
          )}
        </div>

        <div className="stat">
          <p className="eyebrow">Change vs last run</p>
          {netDelta == null ? (
            <p className="mt-3 text-sm text-inkfaint">Nothing to compare yet.</p>
          ) : (
            <>
              <p className={clsx('stat-value mt-2 text-3xl', netDelta >= 0 ? 'text-ink' : 'text-brand')}>
                {netDelta >= 0 ? '+' : '−'}{fmtMoney(Math.abs(netDelta))}
              </p>
              <p className="stat-sub">Your previous net was {fmtMoney(previous!.net_amount)}.</p>
            </>
          )}
        </div>
      </section>
      )}

      <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-5">
        <p className="eyebrow">Understand your pay</p>
        <p className="mt-1 text-2xs text-inkfaint">
          Tap any amount to see exactly what it means. {latest ? `From the ${fmtDate(latest.period_start)} – ${fmtDate(latest.period_end)} run.` : 'No payslip yet.'}
        </p>
        {latest && (
          <div className="mt-4 divide-y divide-line/70 rounded-md border border-line">
            {[
              { key: 'salary', label: 'Monthly salary', value: fmtMoney(latest.salary_amount), note: 'Your contract base salary for the period, before any deductions. This is the starting point of every run.' },
              { key: 'unpaid', label: 'Unpaid leave deduction', value: latest.unpaid_leave_days > 0 ? `−${fmtMoney(latest.gross_amount === latest.salary_amount ? 0 : latest.salary_amount - latest.gross_amount)}` : 'None', note: latest.unpaid_leave_days > 0 ? `${latest.unpaid_leave_days} day(s) of approved unpaid leave in this period, deducted at the daily rate (salary ÷ working days).` : 'No unpaid leave in this period — nothing deducted.' },
              { key: 'gross', label: 'Gross pay', value: fmtMoney(latest.gross_amount), note: 'What you earned after the unpaid-leave adjustment, before tax. Shown on the payslip line "gross".' },
              { key: 'tax', label: 'Tax (10%)', value: `−${fmtMoney(latest.tax_amount)}`, note: 'Statutory withholding at the configured 10% rate, applied to your gross pay. Payroll never keeps it — it is recorded as a deduction on the run.' },
              { key: 'net', label: 'Net pay', value: fmtMoney(latest.net_amount), note: 'The final amount credited to your wallet for this run. Net = gross − tax.' },
            ].map((row) => {
              const open = openAmount === row.key;
              return (
                <button
                  key={row.key}
                  onClick={() => setOpenAmount(open ? null : row.key)}
                  className="block w-full px-5 py-3 text-left transition-colors hover:bg-soft/50"
                  aria-expanded={open}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-inksoft">{row.label}</span>
                    <span className="tnum text-sm font-medium text-ink">{row.value}</span>
                  </div>
                  {open && (
                    <p className="animate-slide-down mt-2 rounded-md border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-inksoft">
                      {row.note}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="animate-slide-up grid gap-4 lg:grid-cols-2">
        <div className="elev-1 rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <p className="eyebrow">Recent movements</p>
            <button
              onClick={() => setTransferOpen((v) => !v)}
              className="btn btn-secondary btn-sm"
            >
              Send money
            </button>
          </div>

          {transferOpen && (
            <div className="animate-slide-down space-y-3 border-b border-line/70 px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Recipient username (e.g. jane)"
                  className="input"
                />
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount (e.g. 50)"
                  inputMode="decimal"
                  className="input"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-2xs text-inkfaint">Transfers are atomic, idempotent and audited.</p>
                <button
                  onClick={transfer}
                  disabled={busy || !recipient.trim() || !Number(amount)}
                  className="btn btn-ink btn-sm"
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}

          {message && (
            <div className="border-b border-line/70 px-5 py-3">
              <p className="text-xs text-inksoft">{message}</p>
            </div>
          )}

          <div className="max-h-80 divide-y divide-line/60 overflow-y-auto">
            {txns.length === 0 && (
              <p className="px-5 py-6 text-sm text-inkfaint">No transactions yet. Your payroll will appear here.</p>
            )}
            {txns.map((t) => (
              <div key={t.txn_id} className="flex items-center gap-3 px-5 py-3">
                {t.txn_type === 'CREDIT' ? (
                  <ArrowDownLeft className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
                ) : (
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-inkfaint" strokeWidth={1.75} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{t.reference_type.replace('_', ' ')}</p>
                  <p className="text-2xs text-inkfaint">{fmtDate(t.created_at)}</p>
                </div>
                <p className={clsx('tnum text-sm', t.txn_type === 'CREDIT' ? 'text-ink' : 'text-brand')}>
                  {t.txn_type === 'CREDIT' ? '+' : '−'}{fmtMoney(t.amount)}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line/70 px-5 py-4">
            <p className="eyebrow">Payslips</p>
            <p className="mt-1 text-2xs text-inkfaint">Tap a payslip to see why the amount changed.</p>
          </div>
          <div className="max-h-96 divide-y divide-line/60 overflow-y-auto">
            {payslips.length === 0 && (
              <p className="px-5 py-6 text-sm text-inkfaint">No payslips yet. They appear after a payroll run is paid.</p>
            )}
            {payslips.map((p) => {
              const open = openSlip === p.payslip_id;
              const idx = payslips.indexOf(p);
              const prevSlip = payslips[idx + 1];
              const delta = prevSlip ? p.net_amount - prevSlip.net_amount : null;
              return (
                <div key={p.payslip_id}>
                  <button
                    onClick={() => setOpenSlip(open ? null : p.payslip_id)}
                    className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-soft/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                      </p>
                      <p className="text-2xs text-inkfaint">
                        Gross {fmtMoney(p.gross_amount)} · Tax {fmtMoney(p.tax_amount)}
                      </p>
                    </div>
                    <p className="text-sm tnum text-ink">{fmtMoney(p.net_amount)}</p>
                    {delta != null && delta !== 0 && (
                      <span className={clsx('text-2xs tnum', delta > 0 ? 'text-ink' : 'text-brand')}>
                        {delta > 0 ? '+' : '−'}{fmtMoney(Math.abs(delta))}
                      </span>
                    )}
                    <ChevronDown className={clsx('h-4 w-4 text-inkfaint transition-transform', open && 'rotate-180')} strokeWidth={1.75} />
                  </button>
                  {open && (
                    <div className="animate-slide-down space-y-3 border-t border-line/70 bg-soft/30 px-5 py-4">
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                        <p className="text-inkfaint">Monthly salary</p>
                        <p className="text-right tnum text-ink">{fmtMoney(p.salary_amount)}</p>
                        <p className="text-inkfaint">Unpaid leave days</p>
                        <p className="text-right tnum text-ink">{p.unpaid_leave_days}</p>
                        <p className="text-inkfaint">Tax (10%)</p>
                        <p className="text-right tnum text-ink">−{fmtMoney(p.tax_amount)}</p>
                        <p className="border-t border-line/70 pt-2 font-medium text-ink">Net</p>
                        <p className="border-t border-line/70 pt-2 text-right font-medium tnum text-ink">{fmtMoney(p.net_amount)}</p>
                      </div>
                      {delta != null && delta !== 0 && (
                        <div className="rounded-md border border-line bg-surface px-3 py-2">
                          <p className="text-2xs uppercase tracking-[0.14em] text-inkfaint">Why did my pay change?</p>
                          <p className="mt-1 text-xs text-inksoft">
                            {delta < 0
                              ? `${Math.abs(delta / (p.salary_amount || 1) * 100).toFixed(1)}% lower than the previous run${prevSlip && p.unpaid_leave_days > prevSlip.unpaid_leave_days ? ` — ${p.unpaid_leave_days - prevSlip.unpaid_leave_days} more unpaid leave day(s) deducted.` : '.'}`
                              : `Higher than the previous run (${p.net_amount - prevSlip!.net_amount > 0 ? '+' : ''}${fmtMoney(p.net_amount - prevSlip!.net_amount)}).`}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}