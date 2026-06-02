import { Link, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { WorkspaceSwitcher } from '../components/workspace-switcher';
import { useMe } from '../hooks/use-me';
import { useWorkspaces } from '../hooks/use-workspaces';

export const Route = createFileRoute('/_app')({
  /**
   * Two-step guard:
   *   1. signed-in? → if not, send to /login
   *   2. has memberships? → if not, force the onboarding flow
   * Onboarding pages are exempt because they live under /_onboarding,
   * which is a sibling group with its own (looser) guard.
   */
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.fetchQuery({
      queryKey: ['me'],
      queryFn: async () => {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
      staleTime: 30_000,
    });
    if (!me) {
      throw redirect({ to: '/login' });
    }

    const memberships = await context.queryClient.fetchQuery({
      queryKey: ['workspaces'],
      queryFn: async () => {
        const r = await fetch('/api/workspaces', { credentials: 'include' });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<Array<{ id: string; slug: string; name: string; role: string }>>;
      },
      staleTime: 30_000,
    });
    if (memberships.length === 0 && !location.pathname.startsWith('/onboarding')) {
      throw redirect({ to: '/onboarding/workspace' });
    }
  },
  component: AppShell,
});

function AppShell() {
  const { data: me } = useMe();
  const { data: workspaces } = useWorkspaces();
  const navigate = useNavigate();
  const activeWs = workspaces?.[0];

  if (!me) return null;

  return (
    <div>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '12px 24px',
          borderBottom: '1px solid #e5e7eb',
          background: 'white',
        }}
      >
        <Link to="/" style={{ fontWeight: 700, fontSize: 18, textDecoration: 'none', color: '#111' }}>
          Syncra
        </Link>

        <WorkspaceSwitcher />

        {activeWs && (
          <nav style={{ display: 'flex', gap: 16, marginLeft: 24 }}>
            <Link
              to="/w/$slug"
              params={{ slug: activeWs.slug }}
              activeProps={{ style: { fontWeight: 600, color: '#2563eb' } }}
              style={{ color: '#444', textDecoration: 'none' }}
            >
              Overview
            </Link>
            <Link
              to="/w/$slug/members"
              params={{ slug: activeWs.slug }}
              activeProps={{ style: { fontWeight: 600, color: '#2563eb' } }}
              style={{ color: '#444', textDecoration: 'none' }}
            >
              Members
            </Link>
          </nav>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {me.avatarUrl && (
            <img
              src={me.avatarUrl}
              alt=""
              width={32}
              height={32}
              style={{ borderRadius: '50%' }}
            />
          )}
          <div style={{ fontSize: 14 }}>
            <div style={{ fontWeight: 500 }}>{me.displayName ?? me.email}</div>
            <div style={{ color: '#666', fontSize: 12 }}>{me.email}</div>
          </div>
          <form method="post" action="/api/auth/signout">
            <button
              type="submit"
              style={{
                padding: '6px 12px',
                background: 'white',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
