import { Link, createFileRoute } from '@tanstack/react-router';
import { useWorkspaces } from '../../../../hooks/use-workspaces';

export const Route = createFileRoute('/_app/w/$slug/')({
  component: WorkspaceHome,
});

function WorkspaceHome() {
  const { slug } = Route.useParams();
  const { data: workspaces } = useWorkspaces();
  const ws = workspaces?.find((w) => w.slug === slug);

  if (!ws) return <div>Workspace not found.</div>;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>{ws.name}</h1>
      <p style={{ color: '#666', fontSize: 14, marginTop: 4 }}>
        Your role: <strong>{ws.role}</strong>
      </p>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>What's next</h2>
        <ul style={{ marginTop: 12, lineHeight: 1.8 }}>
          <li>
            <Link
              to="/w/$slug/members"
              params={{ slug }}
              style={{ color: '#2563eb' }}
            >
              View members
            </Link>{' '}
            — Day 4's invitation flow added them.
          </li>
          <li>Day 8 brings projects + tasks here.</li>
          <li>Day 15 brings real-time collaboration via Yjs.</li>
        </ul>
      </section>
    </div>
  );
}
