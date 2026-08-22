import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../store/auth';

// Demo affordance. Compiled out of production builds: `import.meta.env.DEV` is
// the literal `false` there, so this block is dead code the bundler drops.
// It lists usernames only — a password must never be embedded in the bundle,
// where anyone can read it out of the shipped JavaScript.
const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true';

const DEMO_ACCOUNTS = [
  { username: 'john', name: 'John · Engineering head' },
  { username: 'jane', name: 'Jane · Marketing head' },
  { username: 'robert', name: 'Robert · Sales head' },
  { username: 'emily', name: 'Emily · Marketing' },
  { username: 'michael', name: 'Michael · Finance head' },
  { username: 'sarah', name: 'Sarah · Finance' },
  { username: 'david', name: 'David · Sales' },
  { username: 'lisa', name: 'Lisa · Engineering' },
];

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(username, password);
      toast.success('Welcome back');
      navigate('/dashboard');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="bg-gradient-surface-soft rounded-xl border border-line p-8 elev-2">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-brandsoft text-lg font-semibold text-branddeep">
            E
          </div>
          <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
            EduRankAI
          </h1>
          <p className="mt-1 text-2xs font-semibold uppercase tracking-[0.2em] text-inkfaint">
            HumanOS · Employee Portal
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. john"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>

          <button
            type="submit"
            className="btn-primary w-full btn-lg"
            disabled={submitting}
          >
            {submitting ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        {DEMO_MODE && (
          <div className="mt-8 rounded-lg border border-line bg-surface p-4">
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-inkfaint">Sandbox accounts</p>
            <p className="mt-1.5 text-xs text-inksoft">
              Pick a username to fill the field. Ask an administrator for the sandbox password — it is not published here.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.username}
                  type="button"
                  onClick={() => setUsername(a.username)}
                  className="text-left text-2xs text-inksoft transition-colors hover:text-branddeep"
                >
                  <span className="font-mono font-medium text-ink">{a.username}</span> · {a.name}
                </button>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}