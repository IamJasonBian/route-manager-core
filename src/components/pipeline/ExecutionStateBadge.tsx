import { ExecutionState } from '../../services/pipelineService';

const styles: Record<ExecutionState, string> = {
  running: 'bg-cyan-400/10 text-cyan-300 ring-cyan-400/30',
  succeeded: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
  failed: 'bg-rose-400/10 text-rose-300 ring-rose-400/30',
  finished: 'bg-slate-400/10 text-slate-300 ring-slate-400/30',
};

export function ExecutionStateBadge({ state }: { state: ExecutionState }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${styles[state]}`}>
      {state === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />}
      {state}
    </span>
  );
}
