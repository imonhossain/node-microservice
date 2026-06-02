import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';

export const Route = createFileRoute('/onboarding/workspace')({
  component: OnboardingWorkspacePage,
});

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function OnboardingWorkspacePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSlug((current) => (!current || current === slugify(name.slice(0, -1)) ? slugify(name) : current));
  }, [name]);

  useEffect(() => {
    if (!slug) { setAvailable(null); return; }
    const handle = setTimeout(async () => {
      const r = await fetch(`/api/workspaces/slug-available?slug=${slug}`, { credentials: 'include' });
      const j = await r.json();
      setAvailable(j.available);
    }, 300);
    return () => clearTimeout(handle);
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, slug }),
    });
    setBusy(false);
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      navigate({ to: '/onboarding/invite', search: { slug } });
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? `Error ${res.status}`);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ maxWidth: 480, margin: '80px auto', padding: 32, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12 }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Create your workspace</h1>
      <p style={{ color: '#666', fontSize: 14, marginBottom: 24 }}>A workspace holds your team, projects, and tasks.</p>

      <label style={{ display: 'block', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Acme Inc."
          style={{ display: 'block', width: '100%', padding: '8px 10px', marginTop: 4, fontSize: 15, border: '1px solid #d1d5db', borderRadius: 6 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>URL slug</span>
        <input
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
          required
          pattern="[a-z0-9-]{2,40}"
          placeholder="acme"
          style={{ display: 'block', width: '100%', padding: '8px 10px', marginTop: 4, fontSize: 15, border: '1px solid #d1d5db', borderRadius: 6 }}
        />
      </label>
      <div style={{ minHeight: 20, fontSize: 13, marginBottom: 16 }}>
        {slug && available === true && <span style={{ color: '#059669' }}>✓ available</span>}
        {slug && available === false && <span style={{ color: '#dc2626' }}>✗ taken</span>}
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <button
        type="submit"
        disabled={!name || !slug || available !== true || busy}
        style={{ width: '100%', padding: '10px 16px', background: '#2563eb', color: 'white', border: 0, borderRadius: 6, fontWeight: 500, cursor: 'pointer', opacity: !name || !slug || available !== true || busy ? 0.5 : 1 }}
      >
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}
