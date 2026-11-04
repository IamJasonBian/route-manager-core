import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarRange,
  Compass,
  Gauge,
  Snowflake,
  Sparkles,
  TrendingDown,
} from 'lucide-react';
import { getFlightPrices, type FlightPrice, type SkiTripsResponse } from '../services/api';
import { SkiTripsPanel } from '../components/planning/SkiTripsPanel';

const SEGMENTS = [
  { id: 'out', label: 'Outbound', from: 'JFK', to: 'LAX', stops: 'Nonstop' },
  { id: 'rt', label: 'Return', from: 'LAX', to: 'JFK', stops: '1 stop · ORD 2h' },
] as const;

function heatLabel(price: number, min: number, max: number): { text: string; className: string } {
  if (max <= min) return { text: 'Fair', className: 'bg-slate-600/35 text-slate-200 ring-1 ring-white/10' };
  const t = (price - min) / (max - min);
  if (t < 0.33) return { text: 'Low', className: 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/25' };
  if (t < 0.66) return { text: 'Med', className: 'bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/25' };
  return { text: 'High', className: 'bg-rose-500/15 text-rose-100 ring-1 ring-rose-400/25' };
}

export default function PlanningPage() {
  const [activeSeg, setActiveSeg] = useState<(typeof SEGMENTS)[number]['id']>('out');
  const [prices, setPrices] = useState<FlightPrice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const [skiMeta, setSkiMeta] = useState<Pick<SkiTripsResponse, 'weekend' | 'seasonTarget' | 'origin'> | null>(
    null
  );

  const handleSkiLoaded = useCallback(
    (meta: Pick<SkiTripsResponse, 'weekend' | 'seasonTarget' | 'origin'>) => setSkiMeta(meta),
    []
  );

  const origin = 'JFK';
  const dest = 'LAX';

  const loadPrices = useCallback(async () => {
    setLoading(true);
    const t0 = performance.now();
    try {
      const p = await getFlightPrices(origin, dest, new Date().toISOString().slice(0, 10));
      setPrices(p);
      setMs(Math.round(performance.now() - t0));
    } finally {
      setLoading(false);
    }
  }, [origin, dest]);

  const { minP, maxP } = useMemo(() => {
    if (!prices?.length) return { minP: 0, maxP: 1 };
    const vals = prices.map((x) => x.price);
    return { minP: Math.min(...vals), maxP: Math.max(...vals) };
  }, [prices]);

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      <div className="relative overflow-hidden border-b border-[hsl(var(--border))]">
        <div
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            background:
              'linear-gradient(135deg, hsl(var(--primary) / 0.12) 0%, transparent 45%), linear-gradient(215deg, hsl(280 60% 96%) 0%, transparent 40%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8">
            <div>
              <p className="inline-flex items-center gap-2 text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">
                <Sparkles className="h-4 w-4 text-[hsl(var(--primary))]" aria-hidden />
                Trip canvas
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-[hsl(var(--foreground))]">
                {origin} → {dest}
              </h1>
              <p className="mt-3 text-lg text-[hsl(var(--muted-foreground))] max-w-xl">
                Scan windows, compare pressure, and move from watching to booking without losing context.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/search"
                className="inline-flex items-center justify-center rounded-lg bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-semibold text-[hsl(var(--primary-foreground))] shadow-sm ring-offset-2 transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              >
                Search this route
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </Link>
              <Link
                to="/trends"
                className="inline-flex items-center justify-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]/80 px-5 py-2.5 text-sm font-semibold text-[hsl(var(--foreground))] backdrop-blur-md transition hover:bg-[hsl(var(--card))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              >
                Open trends
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
        {/* Route timeline */}
        <section aria-labelledby="timeline-heading" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id="timeline-heading" className="text-xl font-semibold text-[hsl(var(--foreground))]">
              Route timeline
            </h2>
            <span className="text-sm text-[hsl(var(--muted-foreground))]">Tap a leg to focus price context</span>
          </div>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            role="tablist"
            aria-label="Flight legs"
          >
            {SEGMENTS.map((s) => {
              const active = activeSeg === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveSeg(s.id)}
                  className={`text-left rounded-xl border p-4 transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] focus:ring-offset-2 ${
                    active
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--card))] shadow-md shadow-[hsl(var(--primary)/0.12)]'
                      : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]/60 hover:border-[hsl(var(--primary)/0.35)]'
                  }`}
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                    {s.label}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-[hsl(var(--foreground))]">
                    {s.from} → {s.to}
                  </p>
                  <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{s.stops}</p>
                </button>
              );
            })}
          </div>
        </section>

        {/* Price window heat ribbon */}
        <section aria-labelledby="ribbon-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="ribbon-heading" className="text-xl font-semibold text-[hsl(var(--foreground))] flex items-center gap-2">
              <CalendarRange className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
              Price window
            </h2>
            <button
              type="button"
              onClick={loadPrices}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--secondary))] px-4 py-2 text-sm font-medium text-[hsl(var(--secondary-foreground))] transition hover:bg-[hsl(var(--muted))] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            >
              {loading ? 'Loading…' : 'Refresh sample curve'}
            </button>
          </div>

          <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]/80 backdrop-blur-md p-4 md:p-6 shadow-sm">
            {!prices && !loading && (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                Load a quick price curve for this corridor (uses your configured API mode: Netlify, mock, or remote).
              </p>
            )}
            {loading && (
              <div className="h-16 flex items-center justify-center text-[hsl(var(--muted-foreground))] text-sm">
                Fetching…
              </div>
            )}
            {prices && prices.length > 0 && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2" role="list">
                  {prices.slice(0, 7).map((p, i) => {
                    const d = p.date instanceof Date ? p.date : new Date(p.date);
                    const { text, className } = heatLabel(p.price, minP, maxP);
                    return (
                      <div
                        key={i}
                        role="listitem"
                        className={`flex min-w-[4.5rem] flex-col items-center rounded-lg px-2 py-2 text-center ${className}`}
                      >
                        <span className="text-[10px] font-medium uppercase text-[hsl(var(--muted-foreground))]">
                          {d.toLocaleDateString(undefined, { weekday: 'short' })}
                        </span>
                        <span className="text-xs tabular-nums font-semibold">${p.price}</span>
                        <span className="text-[10px] font-medium mt-0.5">{text}</span>
                      </div>
                    );
                  })}
                </div>
                {ms != null && (
                  <p className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums" aria-live="polite">
                    Last request round-trip (client): {ms}ms
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Commit vs watch + meter */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="lg:col-span-2 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-[hsl(var(--foreground))] mb-4 flex items-center gap-2">
              <Compass className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
              Commit vs watch
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-dashed border-[hsl(var(--border))] p-4 bg-[hsl(var(--muted))/0.35]">
                <p className="text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Committed</p>
                <p className="mt-2 text-sm text-[hsl(var(--foreground))]">Lock dates when the ribbon shows two consecutive “Low” days.</p>
              </div>
              <div className="rounded-xl border border-[hsl(var(--border))] p-4">
                <p className="text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Watching</p>
                <p className="mt-2 text-sm text-[hsl(var(--foreground))]">Flex ±3 days; we’ll nudge when the curve dips vs your baseline.</p>
              </div>
            </div>
          </section>
          <section className="rounded-2xl border border-[hsl(var(--border))] bg-gradient-to-br from-[hsl(var(--card))] to-[hsl(var(--muted))/0.4] p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-[hsl(var(--foreground))] mb-4 flex items-center gap-2">
              <Gauge className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
              Booking pressure
            </h2>
            <div className="space-y-3">
              <div className="h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[hsl(var(--primary))] transition-all duration-500 ease-out"
                  style={{ width: `${prices ? 62 : 35}%` }}
                />
              </div>
              <p className="text-sm text-[hsl(var(--muted-foreground))] flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-emerald-600" aria-hidden />
                Favor booking soon if the next week trends “Med” or higher across the ribbon.
              </p>
            </div>
          </section>
        </div>

        {/* Weekend ski trips */}
        <section aria-labelledby="ski-trips-heading" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="ski-trips-heading"
                className="text-xl font-semibold text-[hsl(var(--foreground))] flex items-center gap-2"
              >
                <Snowflake className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
                Weekend ski trips · Epic Pass · East Coast
              </h2>
              {skiMeta?.weekend?.label && (
                <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{skiMeta.weekend.label}</p>
              )}
            </div>
          </div>
          <SkiTripsPanel onLoaded={handleSkiLoaded} />
        </section>
      </div>
    </div>
  );
}
