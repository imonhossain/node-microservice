import { useQuery } from '@tanstack/react-query';

export type Workspace = {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: async (): Promise<Workspace[]> => {
      const res = await fetch('/api/workspaces', { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
