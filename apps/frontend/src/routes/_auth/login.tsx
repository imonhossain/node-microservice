import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
});

function LoginPage() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/csrf', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { csrfToken: string }) => setCsrfToken(d.csrfToken))
      .catch(() => setCsrfToken(null));
  }, []);

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', textAlign: 'center' }}>
      <h1>Sign in to Syncra</h1>
      <p style={{ color: '#666' }}>Use your GitHub account</p>
      <form method="post" action="/api/auth/signin/github" style={{ marginTop: 16 }}>
        <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
        <input type="hidden" name="callbackUrl" value="/" />
        <button
          type="submit"
          disabled={!csrfToken}
          style={{
            padding: '10px 20px',
            background: '#24292f',
            color: 'white',
            border: 0,
            borderRadius: 6,
            cursor: csrfToken ? 'pointer' : 'not-allowed',
            opacity: csrfToken ? 1 : 0.6,
          }}
        >
          Sign in with GitHub
        </button>
      </form>
    </div>
  );
}
