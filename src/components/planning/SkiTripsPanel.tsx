import { useEffect, useMemo, useState } from 'react';
import { Bus, Plane } from 'lucide-react';
import { getSkiTrips, type SkiTrip, type SkiTripsResponse } from '../../services/api';

type HeroAccent = 'emerald' | 'sky' | 'indigo' | 'rose';

type TransportLeg = SkiTrip['transport']['outbound'];
type ReturnOption = SkiTrip['transport']['returnOptions'][number];

const ACCENT_BAR: Record<HeroAccent, string> = {
  emerald: 'bg-gradient-to-r from-emerald-400 to-emerald-600',
  sky: 'bg-gradient-to-r from-sky-400 to-sky-600',
  indigo: 'bg-gradient-to-r from-indigo-400 to-indigo-600',
  rose: 'bg-gradient-to-r from-rose-400 to-rose-600',
};

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function formatWeekdayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${weekday} ${time}`;
}

function LegSummary({ leg, kind }: { leg: TransportLeg | ReturnOption; kind: 'out' | 'ret' }) {
  const label = kind === 'out' ? 'Outbound' : 'Return';
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        {label}
      </p>
      <p className="text-sm font-medium text-[hsl(var(--foreground))] tabular-nums">
        {leg.from.code} → {leg.to.code} · {formatWeekdayTime(leg.depart)} · {formatDuration(leg.durationMin)}
      </p>
    </div>
  );
}

function ReturnOptionSelector({
  options,
  selectedId,
  onSelect,
  groupLabel,
}: {
  options: ReturnOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  groupLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={groupLabel} className="grid grid-cols-3 gap-1 rounded-lg bg-[hsl(var(--muted))/0.45] p-1">
      {options.map((opt) => {
        const active = opt.id === selectedId;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(opt.id)}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] ${
              active
                ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm ring-1 ring-[hsl(var(--border))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            }`}
          >
            <span className="block truncate">{opt.label}</span>
            <span className="block text-[10px] tabular-nums opacity-80">${opt.priceUsd}</span>
          </button>
        );
      })}
    </div>
  );
}

function SkiTripCard({ trip }: { trip: SkiTrip }) {
  const recommended = useMemo(
    () => trip.transport.returnOptions.find((o) => o.recommended) ?? trip.transport.returnOptions[0],
    [trip.transport.returnOptions]
  );
  const [selectedReturnId, setSelectedReturnId] = useState<string>(recommended?.id ?? '');

  const selectedReturn = useMemo(
    () => trip.transport.returnOptions.find((o) => o.id === selectedReturnId) ?? recommended,
    [trip.transport.returnOptions, selectedReturnId, recommended]
  );

  const totalPrice = (trip.transport.outbound.priceUsd ?? 0) + (selectedReturn?.priceUsd ?? 0);
  const accent = (trip.heroAccent as HeroAccent) in ACCENT_BAR ? (trip.heroAccent as HeroAccent) : 'emerald';
  const ModeIcon = trip.transport.mode === 'flight' ? Plane : Bus;

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm">
      <div className={`h-1.5 w-full ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold text-[hsl(var(--foreground))]">{trip.resort}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-md bg-[hsl(var(--muted))/0.7] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] ring-1 ring-[hsl(var(--border))]">
                {trip.state}
              </span>
              {trip.epicPass && (
                <span className="inline-flex items-center rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
                  Epic Pass
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 rounded-lg bg-[hsl(var(--muted))/0.5] p-2 text-[hsl(var(--foreground))]">
            <ModeIcon className="h-4 w-4" aria-label={trip.transport.mode === 'flight' ? 'Flight' : 'Bus'} />
          </div>
        </header>

        <LegSummary leg={trip.transport.outbound} kind="out" />

        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Pick return
          </p>
          <ReturnOptionSelector
            options={trip.transport.returnOptions}
            selectedId={selectedReturn?.id ?? ''}
            onSelect={setSelectedReturnId}
            groupLabel={`${trip.resort} return option`}
          />
          {selectedReturn && <LegSummary leg={selectedReturn} kind="ret" />}
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))/0.5] p-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              Round-trip
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-[hsl(var(--foreground))]">
              ${totalPrice}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              One-way transit
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-[hsl(var(--foreground))]">
              {formatDuration(trip.totals.transitTimeMinOneWay)}
            </p>
          </div>
        </div>

        {trip.transport.groundTransferMin > 0 && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            +{trip.transport.groundTransferMin}m ground transfer · {trip.transport.groundTransferNote}
          </p>
        )}

        <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] tabular-nums">
          {trip.mountainStats.verticalFt.toLocaleString()} ft vert · {trip.mountainStats.trails} trails · {trip.mountainStats.lifts} lifts
        </p>

        {trip.notes && (
          <p className="text-xs italic text-[hsl(var(--muted-foreground))] leading-relaxed">{trip.notes}</p>
        )}
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm">
      <div className="h-1.5 w-full bg-[hsl(var(--muted))]" />
      <div className="flex flex-col gap-3 p-5">
        <div className="h-5 w-2/3 animate-pulse rounded bg-[hsl(var(--muted))]" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-[hsl(var(--muted))]" />
        <div className="h-16 animate-pulse rounded-lg bg-[hsl(var(--muted))/0.7]" />
        <div className="h-10 animate-pulse rounded-lg bg-[hsl(var(--muted))/0.7]" />
        <div className="h-14 animate-pulse rounded-xl bg-[hsl(var(--muted))/0.5]" />
      </div>
    </div>
  );
}

type SkiTripsPanelProps = {
  onLoaded?: (meta: Pick<SkiTripsResponse, 'weekend' | 'seasonTarget' | 'origin'>) => void;
};

export function SkiTripsPanel({ onLoaded }: SkiTripsPanelProps = {}) {
  const [data, setData] = useState<SkiTripsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSkiTrips()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        onLoaded?.({ weekend: res.weekend, seasonTarget: res.seasonTarget, origin: res.origin });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load ski trips');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onLoaded]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 shadow-sm">
        <p className="text-sm text-[hsl(var(--foreground))]">
          Couldn&apos;t load ski trips: {error}.{' '}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="font-semibold text-[hsl(var(--primary))] underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (!data || !data.trips.length) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))]">No ski trips available.</p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {data.trips.map((trip) => (
        <SkiTripCard key={trip.id} trip={trip} />
      ))}
    </div>
  );
}

export default SkiTripsPanel;
