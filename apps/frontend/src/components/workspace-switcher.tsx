import { useNavigate, useParams } from '@tanstack/react-router';
import { useWorkspaces } from '../hooks/use-workspaces';

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false });
  const { data: workspaces } = useWorkspaces();
  if (!workspaces?.length) return null;
  return (
    <select
      value={slug ?? ''}
      onChange={(e) =>
        navigate({ to: '/w/$slug', params: { slug: e.target.value } })
      }
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.slug}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
