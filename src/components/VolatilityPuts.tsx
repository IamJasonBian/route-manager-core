import { useEffect, useRef, useState } from 'react';
import { Activity, FileText, Download, Radio } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useStopEventStream, type PriceTicks } from '../hooks/useStopEventStream';
import {
  DESIGNATED_SYMBOLS,
  eventTs,
  inDateRange,
  type CoverageName,
  type StopRiskEvent,
  type StopRiskSnapshot,
} from '../services/stopEventStream';
import EventPriceChart from './EventPriceChart';

const WHITEPAPER_URL =
  'https://raw.githubusercontent.com/IamJasonBian/allocation-gym/IamJasonBian/audit-redis-proto/docs/7/iwn_vol_analysis.pdf';

function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const normalized = !iso.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(iso) ? `${iso}Z` : iso;
  return new Date(normalized).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

function NameCard({ name, focused }: { name: CoverageName; focused: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const whole = Math.floor(name.quantity);
  const uncovered = name.uncovered_qty >= 1;
  const badge = whole < 1
    ? (name.quantity > 0 ? 'fractional' : 'no lot')
    : uncovered
      ? 'partial cover'
      : 'covered';

  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  return (
    <div
      ref={cardRef}
      id={`coverage-${name.symbol}`}
      data-testid={`coverage-${name.symbol}`}
      className={`rounded-lg border p-5 ${
        focused
          ? 'border-gray-900 dark:border-white'
          : 'border-gray-200 dark:border-zinc-800'
      } bg-white dark:bg-zinc-950`}
    >
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-zinc-500">
            {name.coded_trail_percent}% coded trail
          </p>
          <h3 className="text-2xl font-semibold text-gray-900 dark:text-white mt-1">{name.symbol}</h3>
        </div>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded ${
            uncovered || badge === 'fractional'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {badge}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-gray-400 dark:text-zinc-500">Mark</dt>
          <dd className="font-medium text-gray-900 dark:text-white">{money(name.mark)}</dd>
        </div>
        <div>
          <dt className="text-gray-400 dark:text-zinc-500">Stop</dt>
          <dd className="font-medium text-gray-900 dark:text-white">{money(name.stop_price)}</dd>
        </div>
        <div>
          <dt className="text-gray-400 dark:text-zinc-500">Covered</dt>
          <dd className="font-medium text-gray-900 dark:text-white">
            {name.covered_qty} / {name.quantity}
          </dd>
        </div>
        <div>
          <dt className="text-gray-400 dark:text-zinc-500">Uncovered</dt>
          <dd className={`font-medium ${uncovered ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
            {name.uncovered_qty.toFixed(3)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function EventRow({ event }: { event: StopRiskEvent }) {
  const tone = 'text-gray-700 dark:text-gray-200';
  return (
    <div className="px-5 py-3 flex items-start gap-3" data-testid="live-event">
      <Activity className="w-4 h-4 mt-0.5 text-gray-400 dark:text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {event.symbol && (
            <span className="text-xs font-semibold text-gray-900 dark:text-white">{event.symbol}</span>
          )}
          <span className={`text-xs uppercase tracking-wide ${tone}`}>
            {event.code || event.event_type || event.type}
          </span>
          {event.side && (
            <span
              className={`text-xs font-medium ${
                event.side === 'SELL' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {event.side}
            </span>
          )}
          {event.status && (
            <span className="text-xs text-gray-400 dark:text-zinc-500">{event.status}</span>
          )}
          <span className="text-xs text-gray-400 dark:text-zinc-600 ml-auto">{fmtTime(event.ts || event.created_at)}</span>
        </div>
        {event.message && (
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{event.message}</p>
        )}
      </div>
    </div>
  );
}

export default function VolatilityPuts({
  snapshot: snapshotProp,
  ticks: ticksProp,
  connected: connectedProp,
  focusSymbol,
}: {
  snapshot?: StopRiskSnapshot;
  ticks?: PriceTicks;
  connected?: boolean;
  focusSymbol?: string;
}) {
  const live = useStopEventStream();
  const snapshot = snapshotProp ?? live.snapshot;
  const ticks = ticksProp ?? live.ticks;
  const connected = connectedProp ?? live.connected;
  const focus = (focusSymbol || '').toUpperCase();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const datedEvents = inDateRange(snapshot.events, from, to);

  const names = [...snapshot.names].sort((a, b) => {
    if (focus && a.symbol === focus) return -1;
    if (focus && b.symbol === focus) return 1;
    return 0;
  });

  const chartData = names.map((n) => ({
    symbol: n.symbol,
    covered: n.covered_qty,
    uncovered: n.uncovered_qty,
    mark: n.mark,
    stop: n.stop_price || 0,
  }));

  const sortedEvents = [...datedEvents]
    .filter((e) => !focus || !e.symbol || e.symbol.toUpperCase() === focus)
    .sort((a, b) => eventTs(b) - eventTs(a));

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-lg p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-gray-100 dark:bg-zinc-800 rounded-lg">
            <FileText className="w-6 h-6 text-gray-700 dark:text-gray-300" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Grayscale BTC Mini-Trust &amp; IWM Put Hedging
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
              Technical Report &middot; March 4, 2026
            </p>
            <p className="text-gray-600 dark:text-gray-300 mt-3 text-sm leading-relaxed">
              Intra-week volatility trading with a long-term macro viewpoint. Live desk below
              streams MU (4%) and NBIS (6%) trailing-stop coverage from the auth-service book.
            </p>
            <a
              href={WHITEPAPER_URL}
              download="iwn_vol_analysis.pdf"
              className="inline-flex items-center gap-2 mt-4 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-zinc-800 text-sm"
            >
              <Download className="w-4 h-4" />
              Download Whitepaper
            </a>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Live stop desk</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            SSE from the designated trailing-stop book
          </p>
        </div>
        <span
          data-testid="sse-status"
          className={`inline-flex items-center gap-1.5 text-xs ${
            connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-zinc-500'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          {connected ? 'live' : 'connecting'}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {names.map((name) => (
          <NameCard key={name.symbol} name={name} focused={focus === name.symbol} />
        ))}
      </div>

      <div className="flex items-end gap-3 flex-wrap" role="group" aria-label="Date filter">
        <label className="text-xs text-gray-500 dark:text-gray-400">
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="block mt-1 px-2 py-1 text-sm rounded border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-gray-900 dark:text-white"
          />
        </label>
        <label className="text-xs text-gray-500 dark:text-gray-400">
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="block mt-1 px-2 py-1 text-sm rounded border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-gray-900 dark:text-white"
          />
        </label>
        {(from || to) && (
          <button
            onClick={() => {
              setFrom('');
              setTo('');
            }}
            className="text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400 hover:border-gray-400"
          >
            Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-w-0">
          <EventPriceChart
            events={datedEvents}
            ticks={ticks}
            names={snapshot.names}
            designated={[...DESIGNATED_SYMBOLS]}
            focusSymbol={focus || undefined}
          />
        </div>

        <div className="bg-white dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 flex flex-col min-w-0">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-900">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Event feed</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" data-testid="feed-count">
              {from || to
                ? `${sortedEvents.length} engine order events in range`
                : 'Last 120 engine order events'}
            </p>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-zinc-900 max-h-[440px] overflow-y-auto">
            {sortedEvents.length === 0 ? (
              <p className="px-5 py-8 text-sm text-gray-400 dark:text-zinc-600 text-center">
                {from || to ? 'No events in this date range' : 'Waiting for the first SSE snapshot'}
              </p>
            ) : (
              sortedEvents.map((event, i) => (
                <EventRow key={event.id || `${event.code}-${event.symbol}-${i}`} event={event} />
              ))
            )}
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 p-5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Coverage</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="symbol" stroke="#a1a1aa" fontSize={12} />
              <YAxis stroke="#a1a1aa" fontSize={12} />
              <Tooltip />
              <Bar dataKey="covered" stackId="q" fill="#10b981" name="Covered" />
              <Bar dataKey="uncovered" stackId="q" fill="#ef4444" name="Uncovered" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
