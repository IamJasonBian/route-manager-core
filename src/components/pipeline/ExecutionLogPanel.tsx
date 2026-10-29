import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { getExecutionLogs, PipelineExecution, PipelineLogEntry } from '../../services/pipelineService';
import { useLivePolling } from '../../hooks/useLivePolling';
import LiveStatusIndicator from '../LiveStatusIndicator';
import { ExecutionStateBadge } from './ExecutionStateBadge';

const POLL_MS = 4000;

const severityClass: Record<string, string> = {
  ERROR: 'text-rose-300',
  CRITICAL: 'text-rose-300',
  WARNING: 'text-amber-300',
  INFO: 'text-slate-200',
  DEBUG: 'text-slate-500',
};

interface ExecutionLogPanelProps {
  execution: PipelineExecution | null;
  onClose: () => void;
}

// Right-hand slide-over that tails Cloud Logging for one execution. Polls only
// while the execution is running; finished runs load once.
export default function ExecutionLogPanel({ execution, onClose }: ExecutionLogPanelProps) {
  const [entries, setEntries] = useState<PipelineLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef<string | undefined>(undefined);

  const fetchNew = useCallback(async () => {
    if (!execution) return;
    try {
      const next = await getExecutionLogs(execution.name, lastTsRef.current);
      if (next.length) {
        lastTsRef.current = next[next.length - 1].timestamp;
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...next.filter((e) => !seen.has(e.id))];
        });
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [execution]);

  useEffect(() => {
    setEntries([]);
    setError(null);
    lastTsRef.current = undefined;
    if (!execution) return;
    setLoading(true);
    void fetchNew().finally(() => setLoading(false));
  }, [execution, fetchNew]);

  const { isRefreshing, lastUpdated } = useLivePolling({
    enabled: execution?.state === 'running',
    intervalMs: POLL_MS,
    fetcher: fetchNew,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = execution !== null;

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-white/10 bg-slate-950 shadow-2xl transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-label="Execution logs"
        aria-hidden={!open}
      >
        {execution && (
          <>
            <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-mono text-sm text-white">{execution.name}</h2>
                  <ExecutionStateBadge state={execution.state} />
                  {execution.dryRun && (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">dry run</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {execution.brand ?? 'unknown brand'} · started {new Date(execution.createTime).toLocaleString()}
                </p>
                {execution.message && <p className="mt-2 text-xs text-rose-300/90">{execution.message}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={execution.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
                  title="Open in Cloud Console"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button
                  onClick={onClose}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
                  aria-label="Close logs"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-3 font-mono text-xs leading-relaxed">
              {loading && <p className="text-slate-500">Loading logs…</p>}
              {error && <p className="text-rose-300">Failed to load logs: {error}</p>}
              {!loading && !error && entries.length === 0 && (
                <p className="text-slate-500">
                  No log entries. Cloud Logging keeps job logs for 30 days, and runs that fail before the
                  container starts (e.g. image pull) only report the status message above.
                </p>
              )}
              {entries.map((e) => (
                <div key={e.id} className="flex gap-3 border-b border-white/[0.03] py-0.5">
                  <span className="shrink-0 text-slate-600">{e.timestamp.slice(11, 19)}</span>
                  <span className={`w-14 shrink-0 ${severityClass[e.severity] ?? 'text-slate-400'}`}>{e.severity}</span>
                  <span className={`whitespace-pre-wrap break-all ${severityClass[e.severity] ?? 'text-slate-300'}`}>
                    {e.message}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {execution.state === 'running' && (
              <footer className="border-t border-white/10 px-5 py-2">
                <LiveStatusIndicator isRefreshing={isRefreshing} lastUpdated={lastUpdated} intervalMs={POLL_MS} />
              </footer>
            )}
          </>
        )}
      </aside>
    </>
  );
}
