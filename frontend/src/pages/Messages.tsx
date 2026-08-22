import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { formatDateTime } from '../lib/format';
import { isOnline, queueOffline, listQueue, dropQueued, onConnectivityChange } from '../lib/offline';
import { Segmented } from '../components/ui/primitives';
import clsx from 'clsx';

const DEMO_PEOPLE = [
  { id: '00000000-0000-0000-0000-000000000002', name: 'Jane Doe' },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Robert Johnson' },
  { id: '00000000-0000-0000-0000-000000000004', name: 'Emily Davis' },
  { id: '00000000-0000-0000-0000-000000000005', name: 'Michael Brown' },
  { id: '00000000-0000-0000-0000-000000000006', name: 'Sarah Wilson' },
  { id: '00000000-0000-0000-0000-000000000007', name: 'David Martinez' },
  { id: '00000000-0000-0000-0000-000000000008', name: 'Lisa Anderson' },
];

export function Messages() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'inbox' | 'important' | 'sent'>('inbox');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState('');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [search, setSearch] = useState('');
  const [online, setOnline] = useState(isOnline());
  const [pendingCount, setPendingCount] = useState(0);
  const { user } = useAuth();

  const refreshPending = async () => {
    const q = await listQueue();
    setPendingCount(q.length);
  };

  useEffect(() => {
    void refreshPending();
    const off = onConnectivityChange((on) => {
      setOnline(on);
      if (on) void flushQueue();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushQueue = async () => {
    const items = await listQueue<{ recipient_id: string; subject: string; content: string }>();
    for (const item of items) {
      try {
        await api.post('/messages', item.payload);
        await dropQueued(item.id);
      } catch {
        break;
      }
    }
    await refreshPending();
    queryClient.invalidateQueries({ queryKey: ['messages'] });
    queryClient.invalidateQueries({ queryKey: ['messages-sent'] });
  };

  const { data: messages, isLoading } = useQuery({
    queryKey: ['messages'],
    queryFn: async () => (await api.get('/messages')).data,
  });

  const { data: sent } = useQuery({
    queryKey: ['messages-sent'],
    queryFn: async () => (await api.get('/messages', { params: { sent: 'true' } })).data,
  });

  const list = (() => {
    const base = tab === 'sent'
      ? (Array.isArray(sent) ? sent : [])
      : (Array.isArray(messages) ? messages : []);
    const inTab = tab === 'important' ? base.filter((m: any) => (m.priority ?? 'NORMAL') !== 'NORMAL') : base;
    return inTab.filter((m: any) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (m.subject + ' ' + m.content + ' ' + (m.sender_name || '') + ' ' + (m.recipient_name || '')).toLowerCase().includes(q);
    });
  })();

  const selected = list.find((m: any) => m.logical_id === selectedId) || null;

  const sendMessage = useMutation({
    mutationFn: async () =>
      (await api.post('/messages', { recipient_id: recipientId, subject, content })).data,
    onSuccess: () => {
      toast.success('Message sent');
      setSubject('');
      setContent('');
      setRecipientId('');
      setShowCompose(false);
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['messages-sent'] });
    },
    onError: async (err: any) => {
      if (!isOnline()) {
        await queueOffline({ recipient_id: recipientId, subject, content });
        await refreshPending();
        toast.success('Saved offline — will send when you are back online');
        setSubject('');
        setContent('');
        setRecipientId('');
        setShowCompose(false);
      } else {
        toast.error(err?.response?.data?.message || 'Failed to send message');
      }
    },
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => (await api.put(`/messages/${id}/read`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['messages-sent'] });
    },
  });

  const openMessage = (m: any) => {
    setSelectedId(m.logical_id);
    if (tab === 'inbox' && !m.read_status) markRead.mutate(m.logical_id);
  };

  const recipients = user ? DEMO_PEOPLE.filter((p) => p.id !== user.personId) : DEMO_PEOPLE;

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4 animate-fade-in">
        <div>
          <p className="eyebrow">Messages</p>
          <h1 className="h-page mt-1">Inbox</h1>
        </div>
        <button className="btn-primary" onClick={() => setShowCompose((v) => !v)}>
          {showCompose ? 'Cancel' : 'New message'}
        </button>
      </section>

      {!online && (
        <section className="animate-slide-up flex items-center gap-3 rounded-lg border border-warn/40 bg-warnsoft/60 px-5 py-3" role="status">
          <WifiOff className="h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
          <p className="flex-1 text-sm text-inksoft">
            You are offline. The app shell works from cache; messages you send are saved and delivered when the
            connection returns.
          </p>
          <span className="rounded-full bg-surface px-2.5 py-1 text-2xs font-medium text-warn">
            {pendingCount} queued
          </span>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] animate-slide-up">
        <div className="card overflow-hidden">
          <div className="border-b border-line p-3">
            <Segmented
              label="Message folders"
              value={tab}
              onChange={(v) => { setTab(v); setSelectedId(null); }}
              options={[
                { value: 'inbox', label: 'Inbox' },
                { value: 'important', label: 'Important' },
                { value: 'sent', label: 'Sent' },
              ]}
            />
          </div>

          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkfaint" strokeWidth={1.75} />
              <input
                className="input pl-8 py-1.5 text-xs"
                placeholder="Search messages…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="max-h-[480px] divide-y divide-line overflow-y-auto">
            {isLoading ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-12 w-full" />
                <div className="skeleton h-12 w-full" />
                <div className="skeleton h-12 w-full" />
              </div>
            ) : list.length === 0 ? (
              <div className="empty-state">
                <p className="text-sm font-medium text-ink">
                  {tab === 'inbox' ? 'Nothing in your inbox' : tab === 'important' ? 'No important messages' : 'Nothing sent yet'}
                </p>
                <p className="mt-1 text-xs text-inkfaint">
                  {tab === 'sent' ? 'Messages you send will appear here.' : 'Messages from your manager and team appear here.'}
                </p>
              </div>
            ) : (
              list.map((m: any) => (
                <button
                  key={m.logical_id}
                  onClick={() => openMessage(m)}
                  className={clsx(
                    'block w-full px-4 py-3 text-left transition-colors hover:bg-soft/60',
                    selectedId === m.logical_id && 'bg-brandsoft/50'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className={clsx('truncate text-sm', m.read_status ? 'font-normal text-inksoft' : 'font-semibold text-ink')}>
                      {m.subject}
                    </p>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {(m.priority ?? 'NORMAL') !== 'NORMAL' && (
                        <span className="rounded-full bg-warnsoft/70 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.1em] text-warn">
                          {m.priority}
                        </span>
                      )}
                      {!m.read_status && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-inkfaint">
                    {tab === 'inbox' ? `From ${m.sender_name || '—'}` : `To ${m.recipient_name || '—'}`}
                  </p>
                  <p className="mt-0.5 text-2xs text-inkfaint">{formatDateTime(m.created_at)}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="card overflow-hidden">
          {selected ? (
            <div className="flex h-full min-h-[320px] flex-col animate-fade-in">
              <div className="border-b border-line px-5 py-4">
                <p className="font-display text-lg font-medium text-ink">{selected.subject}</p>
                <p className="mt-0.5 text-xs text-inkfaint">
                  {tab === 'inbox' ? `From ${selected.sender_name || '—'}` : `To ${selected.recipient_name || '—'}`} · {formatDateTime(selected.created_at)}
                </p>
              </div>
              <div className="flex-1 whitespace-pre-wrap px-5 py-5 text-sm leading-relaxed text-inksoft">
                {selected.content}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[320px] items-center justify-center p-8">
              <div className="text-center">
                <p className="text-sm font-medium text-ink">Select a message</p>
                <p className="mt-1 text-xs text-inkfaint">Conversation will appear here.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showCompose && (
        <section className="animate-slide-up elev-1 rounded-lg border border-line bg-surface p-6">
          <div className="section-rule">
            <h2 className="h-section">New message</h2>
          </div>
          <div className="mt-5 space-y-4">
            <div>
              <label className="label">To</label>
              <select className="input" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
                <option value="">Select a colleague…</option>
                {recipients.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Subject</label>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div>
              <label className="label">Message</label>
              <textarea className="input" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
            </div>
            <div className="flex gap-3">
              <button
                className="btn-primary"
                disabled={sendMessage.isPending || !recipientId || !subject || !content}
                onClick={() => sendMessage.mutate()}
              >
                Send message
              </button>
              <button className="btn-ghost" onClick={() => setShowCompose(false)}>Cancel</button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}