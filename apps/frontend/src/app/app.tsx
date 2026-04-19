import { useQuery } from '@tanstack/react-query';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

type HealthResponse = { status: string; uptime: number };

function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/health`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
  });
}

export function App() {
  const { data, isLoading, isError, error, refetch, isFetching } = useHealth();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900/80 ring-1 ring-slate-800 p-8 shadow-xl">
        <h1 className="text-3xl font-semibold tracking-tight">Syncra</h1>
        <p className="mt-1 text-slate-400">
          Nx monorepo · React 19 · Tailwind · TanStack Query 3
        </p>

        <div className="mt-6 rounded-xl bg-slate-950/60 ring-1 ring-slate-800 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Backend health</h2>
            <button
              onClick={() => refetch()}
              className="rounded-md bg-indigo-500 hover:bg-indigo-400 transition px-3 py-1.5 text-sm font-medium"
            >
              {isFetching ? 'Refreshing…' : 'Refetch'}
            </button>
          </div>

          <div className="mt-4 text-sm">
            {isLoading && <p className="text-slate-400">Loading…</p>}
            {isError && (
              <p className="text-rose-400">
                {(error as Error).message} — is the backend running?
              </p>
            )}
            {data && (
              <pre className="text-emerald-300 whitespace-pre-wrap break-words">
                {JSON.stringify(data, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
