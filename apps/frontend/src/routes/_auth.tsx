import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    // If the user is already signed in, send them to the home shell.
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
    if (me) throw redirect({ to: '/' });
  },
  component: () => <Outlet />,
});
