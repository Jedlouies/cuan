import { useState, type FormEvent } from 'react';
import { AlertCircle, Loader2, Lock, Mail } from 'lucide-react';
import { supabase } from '../../lib/supabase';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage(null);
    setSubmitting(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) setErrorMessage(error.message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-slate-900 lg:grid lg:grid-cols-2">
      {/* Brand panel: Barangay and SK identity are centered on the left. */}
      <section className="relative flex min-h-[42vh] items-center justify-center overflow-hidden bg-gradient-to-br from-sky-950 via-blue-900 to-indigo-950 px-6 py-10 text-white lg:min-h-screen lg:px-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/brgy-building.jpg')" }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-950/90 via-blue-900/82 to-indigo-950/88" />
        <div aria-hidden="true" className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full border border-white/10" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-36 -right-20 h-96 w-96 rounded-full border border-white/10" />
        <div className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center text-center">
          <div className="mb-8 flex items-center justify-center gap-5 sm:gap-8">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white p-2 shadow-xl sm:h-32 sm:w-32">
              <img
                src="/brgy-logo.png"
                alt="Barangay Kauswagan Seal"
                className="h-full w-full object-contain"
              />
            </div>
            <div className="h-20 w-px bg-white/30 sm:h-28" />
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white p-2 shadow-xl sm:h-32 sm:w-32">
              <img
                src="/sk-logo.png"
                alt="Sangguniang Kabataan Logo"
                className="h-full w-full object-contain"
              />
            </div>
          </div>

          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-200 sm:text-xs">
            Republic of the Philippines
          </p>
          <p className="mt-1 text-xs font-medium tracking-wide text-white/80 sm:text-sm">
            City of Cagayan de Oro
          </p>
          <h1 className="mt-3 text-2xl font-extrabold uppercase tracking-wide sm:text-3xl lg:text-4xl">
            Barangay Kauswagan
          </h1>
          <div className="mx-auto mt-4 h-1 w-20 rounded-full bg-sky-300" />
          <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-sky-100 sm:text-base">
            Sangguniang Kabataan
          </h2>
          <p className="mt-2 text-xs tracking-wide text-white/65 sm:text-sm">
            Kauswagan SK Desk
          </p>
        </div>
      </section>

      {/* Login panel: plain white background, no image or translucent overlay. */}
      <section className="flex min-h-[58vh] items-center justify-center bg-white px-6 py-12 sm:px-10 lg:min-h-screen lg:px-16">
        <div className="w-full max-w-md">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
              Kauswagan SK Desk
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Welcome back
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              Sign in using your authorized SK account to continue to the workspace.
            </p>
          </div>

          {errorMessage && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-email" className="block text-sm font-semibold text-slate-700">
                Email Address
              </label>
              <div className="relative mt-2">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="login-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@kauswagansk.ph"
                  className="w-full rounded-lg border border-slate-300 bg-white py-3 pl-11 pr-4 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-600 focus:ring-2 focus:ring-sky-100"
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="block text-sm font-semibold text-slate-700">
                Password
              </label>
              <div className="relative mt-2">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full rounded-lg border border-slate-300 bg-white py-3 pl-11 pr-4 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-600 focus:ring-2 focus:ring-sky-100"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-800 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="mt-10 border-t border-slate-100 pt-5 text-center text-[11px] text-slate-400">
            Authorized access only · Sangguniang Kabataan, Barangay Kauswagan
          </p>
        </div>
      </section>
    </main>
  );
}
