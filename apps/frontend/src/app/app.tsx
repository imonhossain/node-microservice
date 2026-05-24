import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from './login';
import { useMe } from '../hooks/use-me';

const qc = new QueryClient();

function Shell() {
  const { data: me, isLoading } = useMe();

  if (isLoading) return <div>Loading…</div>;
  if (!me) return <LoginPage />;

  return (
    <div style={{ padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {me.avatarUrl && (
          <img src={me.avatarUrl} alt="" width={40} height={40} style={{ borderRadius: '50%' }} />
        )}
        <div>
          <div style={{ fontWeight: 600 }}>{me.displayName ?? me.email}</div>
          <div style={{ color: '#666', fontSize: 14 }}>{me.email}</div>
        </div>
        <form method="post" action="/api/auth/signout" style={{ marginLeft: 'auto' }}>
          <button type="submit">Sign out</button>
        </form>
      </header>
      <main style={{ marginTop: 32 }}>
        <h2>You're signed in 🎉</h2>
        <p>Day 4 brings workspaces and invitations.</p>
      </main>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}