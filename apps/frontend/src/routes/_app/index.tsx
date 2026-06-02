import { Link, createFileRoute } from '@tanstack/react-router';
import { useWorkspaces } from '../../hooks/use-workspaces';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

function Home() {
  const { data: workspaces } = useWorkspaces();
  const first = workspaces?.[0];

  return (
    <div style={{ maxWidth: 720, margin: '40px auto' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Your workspaces</h1>
      <p style={{ color: '#666', marginTop: 8 }}>
        Pick a workspace to continue. Day 4's invitation flow added them all here.
      </p>
      <ul style={{ marginTop: 24, listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
        {workspaces?.map((w) => (
          <li
            key={w.id}
            style={{
              padding: 16,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              background: 'white',
            }}
          >
            <Link
              to="/w/$slug"
              params={{ slug: w.slug }}
              style={{ fontWeight: 600, fontSize: 16, textDecoration: 'none', color: '#111' }}
            >
              {w.name}
            </Link>
            <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
              /w/{w.slug} · role: <strong>{w.role}</strong>
            </div>
          </li>
        ))}
      </ul>
      {first && (
        <Link
          to="/w/$slug"
          params={{ slug: first.slug }}
          style={{
            display: 'inline-block',
            marginTop: 32,
            padding: '10px 18px',
            background: '#2563eb',
            color: 'white',
            borderRadius: 6,
            textDecoration: 'none',
          }}
        >
          Continue to {first.name} →
        </Link>
      )}
    </div>
  );
}
