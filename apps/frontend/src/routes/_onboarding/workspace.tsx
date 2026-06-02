import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';

export function OnboardingWorkspacePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-fill slug from name
  useEffect(() => {
    if (!slug || slug === slugify(name.slice(0, -1))) setSlug(slugify(name));
  }, [name]);

  // Debounced slug availability
  useEffect(() => {
    if (!slug) {
      setAvailable(null);
      return;
    }
    const handle = setTimeout(async () => {
      const r = await fetch(`/api/workspaces/slug-available?slug=${slug}`);
      const j = await r.json();
      setAvailable(j.available);
    }, 300);
    return () => clearTimeout(handle);
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
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
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 480, margin: '120px auto' }}>
      <h1>Create your workspace</h1>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label>
        URL slug
        <input
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
          required
          pattern="[a-z0-9-]{2,40}"
        />
      </label>
      <div>
        {available === null ? null : available ? '✓ available' : '✗ taken'}
      </div>
      <button disabled={!name || !slug || available !== true || busy}>
        Create
      </button>
    </form>
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
