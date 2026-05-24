import { useQuery } from '@tanstack/react-query';

export type Me = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me -> ${res.status}`);
  return (await res.json()) as Me;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    staleTime: 30_000,
    retry: false,
  });
}