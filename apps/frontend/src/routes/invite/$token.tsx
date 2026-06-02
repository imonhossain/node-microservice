import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMe } from '../../hooks/use-me';

export const Route = createFileRoute('/invite/$token')({
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const navigate = useNavigate();
  const { token } = Route.useParams();
  const { data: me, isLoading } = useMe();

  useEffect(() => {
    if (isLoading) return;
    if (!me) {
      window.location.href = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
      return;
    }
    (async () => {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const { workspaceSlug } = (await res.json()) as { workspaceSlug: string };
        navigate({ to: '/w/$slug', params: { slug: workspaceSlug } });
      } else {
        navigate({ to: '/' });
      }
    })();
  }, [me, isLoading, token, navigate]);

  return <div style={{ padding: 80, textAlign: 'center' }}>Accepting invitation…</div>;
}
