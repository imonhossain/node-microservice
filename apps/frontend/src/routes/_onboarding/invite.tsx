import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

export function OnboardingInvitePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_onboarding/invite' }) as { slug: string };
  const [emails, setEmails] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    for (const email of emails.filter(Boolean)) {
      await fetch(`/api/workspaces/${search.slug}/invitations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: 'member' }),
      });
    }
    setBusy(false);
    navigate({ to: '/w/$slug', params: { slug: search.slug } });
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 480, margin: '120px auto' }}>
      <h1>Invite your team</h1>
      <p>Optional — you can add people later.</p>
      {emails.map((email, i) => (
        <input
          key={i}
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) =>
            setEmails(emails.map((x, j) => (j === i ? e.target.value : x)))
          }
        />
      ))}
      <button type="button" onClick={() => setEmails([...emails, ''])}>
        + Add another
      </button>
      <button disabled={busy}>Send invites</button>
      <button
        type="button"
        onClick={() =>
          navigate({ to: '/w/$slug', params: { slug: search.slug } })
        }
      >
        Skip for now
      </button>
    </form>
  );
}
