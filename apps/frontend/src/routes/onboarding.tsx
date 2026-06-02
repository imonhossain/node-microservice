import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/onboarding')({
  // Onboarding pages require a signed-in user but NOT an existing workspace.
  beforeLoad: async ({ context }) => {
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
    if (!me) throw redirect({ to: '/login' });
  },
  component: () => (
    <div style={{ padding: 24 }}>
      <Outlet />
    </div>
  ),
});
