import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Quote as QuoteIcon, X, Settings2, Award, PartyPopper, Flag, CalendarDays, Bookmark, Send, ThumbsDown, RefreshCw, HelpCircle, Check } from 'lucide-react';
import { api } from '../../api/client';
import { formatDate } from '../../lib/format';
import clsx from 'clsx';
import { useState } from 'react';

const FREQUENCIES = [
  { value: 'off', label: 'Off' },
  { value: 'occasional', label: 'Occasional' },
  { value: 'daily', label: 'Daily' },
  { value: 'milestone', label: 'Milestone only' },
] as const;

const MOMENT_ICONS: Record<string, typeof Award> = {
  joined: Flag,
  anniversary: PartyPopper,
  certification: Award,
  goal: Flag,
};

interface QuoteShape {
  quote_id: number;
  text: string;
  source: string;
  original: boolean;
  category: string;
}

export function MotivationPanel() {
  const qc = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['motivation-quote'],
    queryFn: async () => (await api.get('/motivation/quote')).data,
  });

  const { data: settings } = useQuery({
    queryKey: ['motivation-settings'],
    queryFn: async () => (await api.get('/motivation/settings')).data,
  });

  const saveSettings = useMutation({
    mutationFn: async (frequency: string) => (await api.post('/motivation/settings', { frequency })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['motivation-settings'] });
      void qc.invalidateQueries({ queryKey: ['motivation-quote'] });
      setSettingsOpen(false);
    },
  });

  const dismiss = useMutation({
    mutationFn: async () => {
      const until = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      return (await api.post('/motivation/dismiss', { until })).data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['motivation-quote'] }),
  });

  const favorite = useMutation({
    mutationFn: async (quoteId: number) =>
      (await api.post(`/motivation/favorites/${quoteId}`)).data,
    onSuccess: () => {
      setFeedback('Saved to your favorites');
      setTimeout(() => setFeedback(null), 2000);
    },
  });

  const unfavorite = useMutation({
    mutationFn: async (quoteId: number) =>
      (await api.delete(`/motivation/favorites/${quoteId}`)).data,
    onSuccess: () => {
      setFeedback('Removed from favorites');
      setTimeout(() => setFeedback(null), 2000);
    },
  });

  const share = useMutation({
    mutationFn: async (quoteId: number) =>
      (await api.post(`/motivation/quotes/${quoteId}/share`)).data,
    onSuccess: (res: any) => {
      setFeedback(res.shared ? 'Shared with your manager' : res.message ?? 'Could not share');
      setTimeout(() => setFeedback(null), 2600);
    },
    onError: () => {
      setFeedback('Sharing is unavailable right now');
      setTimeout(() => setFeedback(null), 2600);
    },
  });

  const skip = useMutation({
    mutationFn: async (quoteId: number) =>
      (await api.post(`/motivation/quotes/${quoteId}/skip`)).data,
    onSuccess: () => {
      setFeedback('Noted — a different thought will come later');
      setTimeout(() => setFeedback(null), 2000);
      void qc.invalidateQueries({ queryKey: ['motivation-quote'] });
    },
  });

  const next = useMutation({
    mutationFn: async () => (await api.get('/motivation/quote')).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['motivation-quote'] }),
  });

  const { data: whyData, refetch: fetchWhy } = useQuery({
    queryKey: ['motivation-why'],
    queryFn: async () => (await api.post(`/motivation/quotes/${quote?.quote_id ?? 0}/why`)).data,
    enabled: false,
  });

  if (isLoading) {
    return (
      <section className="animate-slide-up rounded-lg border border-line bg-surface p-5">
        <div className="h-16 animate-pulse rounded-md bg-soft" aria-hidden="true" />
      </section>
    );
  }

  if (!data?.quote && (data?.moments ?? []).length === 0) {
    return null;
  }

  const quote = (data.quote as QuoteShape | null) ?? null;
  const moments = (data.moments ?? []) as { kind: string; title: string; occurred_at: string }[];
  const frequency = settings?.settings?.frequency ?? 'daily';

  const isFavorited = (id: number | undefined) => id != null && Boolean(favorite.data?.quote_id === id);

  return (
    <section className="animate-slide-up overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 px-5 py-3">
        <p className="flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-inkfaint">
          <QuoteIcon className="h-3.5 w-3.5" strokeWidth={1.75} /> Your moments
        </p>
        <div className="flex items-center gap-1">
          {quote && (
            <button
              onClick={() => dismiss.mutate()}
              className="rounded-md p-1.5 text-inkfaint transition-colors hover:bg-soft hover:text-ink"
              aria-label="Dismiss for today"
              title="Dismiss for today"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className={clsx(
              'rounded-md p-1.5 transition-colors',
              settingsOpen ? 'bg-soft text-ink' : 'text-inkfaint hover:bg-soft hover:text-ink'
            )}
            aria-label="Motivation settings"
            title="Motivation settings"
          >
            <Settings2 className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="animate-slide-down border-b border-line/70 bg-soft/30 px-5 py-3">
          <p className="text-2xs font-medium uppercase tracking-[0.14em] text-inkfaint">Show frequency</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {FREQUENCIES.map((f) => (
              <button
                key={f.value}
                onClick={() => saveSettings.mutate(f.value)}
                className={clsx(
                  'rounded-full border px-3 py-1.5 text-xs transition-colors',
                  frequency === f.value
                    ? 'border-ink bg-ink text-surface'
                    : 'border-line bg-surface text-inksoft hover:border-inkfaint'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-2xs text-inkfaint">
            Milestone mode shows a thought only when you have a verified moment — a certification, a completed goal,
            a work anniversary. Moments are always real events recorded in your employee record.
          </p>
        </div>
      )}

      {feedback && (
        <div className="flex items-center gap-2 border-b border-line/70 bg-ok/10 px-5 py-2 text-xs text-ink">
          <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2} /> {feedback}
        </div>
      )}

      <div className="px-5 py-4">
        {quote ? (
          <figure className="relative pl-3">
            <span className="bg-gradient-warm absolute -left-0 top-0 h-full w-0.5 rounded-full opacity-70" aria-hidden="true" />
            <blockquote className="text-sm leading-relaxed text-ink">
              &ldquo;{quote.text}&rdquo;
            </blockquote>
            <figcaption className="mt-2 text-2xs text-inkfaint">
              {quote.source === 'EduRankAI' ? 'From EduRankAI' : quote.source}
              {!quote.original && ' · public-domain quote'}
              <span className="ml-1.5 rounded-full bg-soft px-1.5 py-0.5 capitalize">{quote.category}</span>
            </figcaption>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => (isFavorited(quote.quote_id) ? unfavorite.mutate(quote.quote_id) : favorite.mutate(quote.quote_id))}
                className={clsx(
                  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-2xs transition-colors',
                  isFavorited(quote.quote_id)
                    ? 'border-brand bg-brandsoft text-branddeep'
                    : 'border-line text-inksoft hover:border-inkfaint hover:text-ink'
                )}
                aria-pressed={isFavorited(quote.quote_id)}
              >
                <Bookmark className={clsx('h-3 w-3', isFavorited(quote.quote_id) && 'fill-brand text-brand')} strokeWidth={2} />
                {isFavorited(quote.quote_id) ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={() => share.mutate(quote.quote_id)}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-2xs text-inksoft transition-colors hover:border-inkfaint hover:text-ink"
              >
                <Send className="h-3 w-3" strokeWidth={2} /> Share internally
              </button>
              <button
                onClick={() => skip.mutate(quote.quote_id)}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-2xs text-inksoft transition-colors hover:border-inkfaint hover:text-ink"
              >
                <ThumbsDown className="h-3 w-3" strokeWidth={2} /> Not for me
              </button>
              <button
                onClick={() => next.mutate()}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-2xs text-inksoft transition-colors hover:border-inkfaint hover:text-ink"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={2} /> Show me another
              </button>
              <button
                onClick={() => {
                  setWhyOpen((v) => !v);
                  if (!whyData) void fetchWhy();
                }}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-2xs text-inksoft transition-colors hover:border-inkfaint hover:text-ink"
                aria-expanded={whyOpen}
              >
                <HelpCircle className="h-3 w-3" strokeWidth={2} /> Why this appeared
              </button>
            </div>

            {whyOpen && (
              <div className="animate-slide-down mt-3 rounded-md border border-line bg-soft/40 p-3">
                {whyData?.explanation ? (
                  <>
                    <p className="text-xs leading-relaxed text-inksoft">{whyData.explanation}</p>
                    <p className="mt-1.5 text-2xs text-inkfaint">
                      Seen {whyData.times_seen} time{whyData.times_seen === 1 ? '' : 's'} by you
                      {whyData.audience_tags?.length > 0 ? ` · audience tags: ${whyData.audience_tags.join(', ')}` : ''}.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-inkfaint">Loading the reasoning…</p>
                )}
              </div>
            )}
          </figure>
        ) : (
          <p className="text-sm text-inksoft">
            Motivation is set to milestone mode — nothing until you earn a verified moment.
          </p>
        )}
      </div>

      {moments.length > 0 && (
        <div className="border-t border-line/70 px-5 py-4">
          <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-inkfaint">
            <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.75} /> Verified moments
          </p>
          <ul className="mt-2 space-y-2">
            {moments.slice(0, 5).map((m, i) => {
              const Icon = MOMENT_ICONS[m.kind] ?? Flag;
              return (
                <li key={`${m.kind}-${i}`} className="flex items-center gap-3 text-sm">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">{m.title}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-inkfaint">
                    {formatDate(m.occurred_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}