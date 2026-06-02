import { useNavigate, useParams } from '@tanstack/react-router';
import { useWorkspaces } from '../hooks/use-workspaces';

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  // `strict: false` means we don't require the route to be one with a `:slug` param.
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const { data: workspaces } = useWorkspaces();
  if (!workspaces || workspaces.length === 0) return null;

  return (
    <select
      value={slug ?? workspaces[0].slug}
      onChange={(e) => navigate({ to: '/w/$slug', params: { slug: e.target.value } })}
      style={{
        padding: '6px 10px',
        border: '1px solid #d1d5db',
        borderRadius: 6,
        background: 'white',
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.slug}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
