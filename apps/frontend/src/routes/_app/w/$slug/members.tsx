import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/w/$slug/members')({
  component: MembersPage,
});

type Member = {
  userId: string;
  role: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
};

function MembersPage() {
  const { slug } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['members', slug],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${slug}/members`, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json() as Promise<Member[]>;
    },
  });

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Members</h1>
      <p style={{ color: '#666', fontSize: 14, marginTop: 4 }}>
        Everyone in this workspace.
      </p>

      {isLoading && <div style={{ marginTop: 24 }}>Loading…</div>}

      <ul style={{ marginTop: 24, listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        {data?.map((m) => (
          <li
            key={m.userId}
            style={{
              padding: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              background: 'white',
            }}
          >
            {m.avatarUrl && (
              <img src={m.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{m.displayName ?? m.email}</div>
              <div style={{ color: '#666', fontSize: 13 }}>{m.email}</div>
            </div>
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '4px 10px',
                background: '#f3f4f6',
                borderRadius: 999,
                color: '#374151',
              }}
            >
              {m.role}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
