import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

export function MembersPage() {
  const { slug } = useParams({ from: '/_app/w/$slug/members' });
  const { data } = useQuery({
    queryKey: ['members', slug],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${slug}/members`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json() as Promise<
        Array<{
          userId: string;
          role: string;
          email: string;
          displayName: string | null;
          avatarUrl: string | null;
          joinedAt: string;
        }>
      >;
    },
  });
  return (
    <div>
      <h1>Members</h1>
      <ul>
        {data?.map((m) => (
          <li key={m.userId}>
            {m.displayName ?? m.email} — <em>{m.role}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}
