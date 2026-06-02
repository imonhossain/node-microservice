import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({ slug: z.string() });

export const Route = createFileRoute('/onboarding/invite')({
  validateSearch: searchSchema,
  component: OnboardingInvitePage,
});

function OnboardingInvitePage() {
  const navigate = useNavigate();
  const { slug } = Route.useSearch();
  const [emails, setEmails] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    for (const email of emails.filter(Boolean)) {
      await fetch(`/api/workspaces/${slug}/invitations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: 'member' }),
      });
    }
    setBusy(false);
    navigate({ to: '/w/$slug', params: { slug } });
  }

  return (
    <form
      onSubmit={submit}
      style={{ maxWidth: 480, margin: '80px auto', padding: 32, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12 }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Invite your team</h1>
      <p style={{ color: '#666', fontSize: 14, marginBottom: 24 }}>Optional — you can always add people later.</p>

      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {emails.map((email, i) => (
          <input
            key={i}
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmails(emails.map((x, j) => (j === i ? e.target.value : x)))}
            style={{ padding: '8px 10px', fontSize: 15, border: '1px solid #d1d5db', borderRadius: 6 }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setEmails([...emails, ''])}
        style={{ padding: '6px 12px', background: 'white', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
      >
        + Add another
      </button>

      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        <button
          type="submit"
          disabled={busy || !emails.some(Boolean)}
          style={{ flex: 1, padding: '10px 16px', background: '#2563eb', color: 'white', border: 0, borderRadius: 6, fontWeight: 500, cursor: 'pointer', opacity: busy || !emails.some(Boolean) ? 0.5 : 1 }}
        >
          {busy ? 'Sending…' : 'Send invites'}
        </button>
        <button
          type="button"
          onClick={() => navigate({ to: '/w/$slug', params: { slug } })}
          style={{ padding: '10px 16px', background: 'white', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
        >
          Skip for now
        </button>
      </div>
    </form>
  );
}
