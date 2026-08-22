import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { formatLongDate, ageFrom, formatDateTime } from '../lib/format';

export function Profile() {
  const { user, setUser } = useAuth();
  const queryClient = useQueryClient();
  const [preferredName, setPreferredName] = useState(user?.preferredName || '');
  const [editingName, setEditingName] = useState(false);

  const { data: person, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/persons/me')).data,
  });

  const updateProfile = useMutation({
    mutationFn: async () => (await api.patch('/persons/me', { preferred_name: preferredName })).data,
    onSuccess: (data) => {
      toast.success('Preferred name updated');
      setUser({ ...user!, preferredName: data.preferred_name });
      setEditingName(false);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Update failed'),
  });

  const age = ageFrom(person?.date_of_birth);

  return (
    <div className="space-y-10">
      <section className="animate-fade-in">
        <p className="eyebrow">Profile</p>

        <div className="mt-4 flex flex-wrap items-center gap-5 rounded-lg border border-line bg-surface p-6">
          <div className="avatar h-16 w-16 text-xl">
            {(person?.preferred_name || user?.preferredName || 'U')[0]}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
              {person?.legal_name || user?.preferredName || '—'}
            </h1>
            <p className="mt-1 text-sm text-inksoft">
              Employee · {user?.roles?.join(', ') || '—'}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Active
            </p>
          </div>
          <span className="privacy-tag privacy-confidential">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" /> Confidential record
          </span>
        </div>
      </section>

      {isLoading ? (
        <div className="space-y-3">
          <div className="skeleton h-10 w-1/3" />
          <div className="skeleton h-40 w-full" />
        </div>
      ) : (
        <>
          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">Personal basics</h2>
            </div>
            <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
              <div className="list-row">
                <p className="w-40 shrink-0 text-sm text-inkfaint">Legal name</p>
                <p className="flex-1 text-sm font-medium text-ink">{person?.legal_name || '—'}</p>
              </div>
              <div className="list-row">
                <p className="w-40 shrink-0 text-sm text-inkfaint">Date of birth</p>
                <p className="flex-1 text-sm text-ink">
                  {formatLongDate(person?.date_of_birth)}
                  {age !== null && <span className="text-inkfaint"> · Age {age}</span>}
                </p>
                <span className="privacy-tag privacy-restricted">Restricted</span>
              </div>
              <div className="list-row">
                <p className="w-40 shrink-0 text-sm text-inkfaint">Timezone</p>
                <p className="flex-1 text-sm text-ink">{person?.timezone || '—'}</p>
              </div>
              <div className="list-row">
                <p className="w-40 shrink-0 text-sm text-inkfaint">Record created</p>
                <p className="flex-1 text-sm text-ink">{formatDateTime(person?.created_at)}</p>
              </div>
            </div>
          </section>

          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">Preferences</h2>
            </div>
            <div className="elev-1 mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
              <div className="list-row">
                <p className="w-40 shrink-0 text-sm text-inkfaint">Preferred name</p>
                <div className="flex-1">
                  {editingName ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="input max-w-[220px]"
                        value={preferredName}
                        onChange={(e) => setPreferredName(e.target.value)}
                      />
                      <button
                        className="btn-primary btn-sm"
                        disabled={updateProfile.isPending || !preferredName}
                        onClick={() => updateProfile.mutate()}
                      >
                        Save
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => { setPreferredName(user?.preferredName || ''); setEditingName(false); }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="text-sm text-ink hover:underline" onClick={() => setEditingName(true)}>
                      {preferredName || 'Set preferred name'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="animate-slide-up">
            <div className="section-rule">
              <h2 className="h-section">Who can see this</h2>
            </div>
            <div className="elev-1 mt-4 rounded-lg border border-line bg-surface p-5">
              <p className="text-sm font-medium text-ink">Employment and personal details</p>
              <p className="mt-1 text-sm text-inksoft">
                <span className="privacy-tag privacy-confidential mr-2">Confidential</span>
                Visible to you, your manager, and HR. Not visible to general colleagues.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}