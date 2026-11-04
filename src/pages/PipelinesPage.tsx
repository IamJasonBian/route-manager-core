import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, RefreshCw } from 'lucide-react';
import {
  getPipelineStatus,
  PipelineExecution,
  PipelineStatus,
  runPipeline,
} from '../services/pipelineService';
import { useLivePolling } from '../hooks/useLivePolling';
import ExecutionLogPanel from '../components/pipeline/ExecutionLogPanel';
import { ExecutionStateBadge } from '../components/pipeline/ExecutionStateBadge';

const TOKEN_KEY = 'pipelineTriggerToken';
const POLL_MS = 8000;

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};

const duration = (ex: PipelineExecution) => {
  if (!ex.startTime) return '—';
  const end = ex.completionTime ? new Date(ex.completionTime) : new Date();
  const mins = Math.round((end.getTime() - new Date(ex.startTime).getTime()) / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};

export default function PipelinesPage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [token, setToken] = useState(readToken);
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getPipelineStatus();
      setStatus(next);
      setBrand((b) => b || next.brands[0] || '');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const anyRunning = status?.executions.some((e) => e.state === 'running') ?? false;
  useLivePolling({ enabled: anyRunning, intervalMs: POLL_MS, fetcher: load });

  const onRun = async () => {
    setLaunching(true);
    setLaunchMsg(null);
    try {
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        // storage unavailable — token just won't persist
      }
      const res = await runPipeline(brand, dryRun, token);
      setLaunchMsg(`Started ${res.execution ?? res.operation}`);
      await load();
      if (res.execution) setSelected(res.execution);
    } catch (err) {
      setLaunchMsg(`Launch failed: ${(err as Error).message}`);
    } finally {
      setLaunching(false);
    }
  };

  const selectedExecution = status?.executions.find((e) => e.name === selected) ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">Data pipelines</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">American Airlines pull</h1>
          {status && (
            <p className="mt-1 font-mono text-xs text-slate-500">
              {status.job.project}/{status.job.region}/{status.job.name} · {status.job.image?.split(':').pop()}
              {' · '}
              <span className={status.job.ready ? 'text-emerald-400' : 'text-amber-400'}>
                {status.job.ready ? 'ready' : 'not ready'}
              </span>
            </p>
          )}
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <section className="mt-6 rounded-xl border border-white/10 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Brand
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="rounded-md border border-white/10 bg-slate-950 px-2 py-1.5 text-sm text-white"
            >
              {status?.brands.length ? (
                status.brands.map((b) => <option key={b}>{b}</option>)
              ) : (
                <option value="">no brands configured (AA_BRANDS)</option>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Trigger token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-48 rounded-md border border-white/10 bg-slate-950 px-2 py-1.5 text-sm text-white"
              placeholder="PIPELINE_TRIGGER_TOKEN"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Dry run (no portal access)
          </label>
          <button
            onClick={() => void onRun()}
            disabled={launching || !brand || !token}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run pipeline
          </button>
        </div>
        {launchMsg && <p className="mt-3 text-sm text-slate-300">{launchMsg}</p>}
      </section>

      {error && <p className="mt-6 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p>}

      <section className="mt-6 overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Execution</th>
              <th className="px-4 py-2.5">State</th>
              <th className="hidden px-4 py-2.5 sm:table-cell">Brand</th>
              <th className="hidden px-4 py-2.5 md:table-cell">Started</th>
              <th className="px-4 py-2.5">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {!status && !error && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {status?.executions.map((ex) => (
              <tr
                key={ex.name}
                onClick={() => setSelected(ex.name)}
                className={`cursor-pointer transition-colors hover:bg-white/[0.03] ${
                  selected === ex.name ? 'bg-cyan-400/[0.06]' : ''
                }`}
              >
                <td className="px-4 py-2.5 font-mono text-xs text-slate-200">
                  {ex.name}
                  {ex.dryRun && <span className="ml-2 text-[10px] uppercase text-slate-500">dry</span>}
                </td>
                <td className="px-4 py-2.5">
                  <ExecutionStateBadge state={ex.state} />
                </td>
                <td className="hidden px-4 py-2.5 text-slate-400 sm:table-cell">{ex.brand ?? '—'}</td>
                <td className="hidden px-4 py-2.5 text-slate-400 md:table-cell">
                  {new Date(ex.createTime).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-slate-400">{duration(ex)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ExecutionLogPanel execution={selectedExecution} onClose={() => setSelected(null)} />
    </div>
  );
}
