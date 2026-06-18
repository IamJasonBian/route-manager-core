# PR #62 — Visual redesign proposal

The "Hugo Coder" direction (content-forward, monospace data, CSS variables) is good. What's landing in the PR feels 70% there but still reads flat: uniform borders on a uniform card color, status badges that break the theme, dates/prices that look like raw data rows, and a noticeable dark/light flash on first paint. Seven concrete changes below, each with before/after code. They're additive — no routing or data changes, and they layer on top of the PR.

## 1. Design tokens — add elevation, shadow, spacing, motion

The current token set only has colors + one radius. That forces every card/button to reinvent its hover/focus/elevation, which is why the UI feels flat. Extend the tokens first; everything else follows.

**`src/index.css` — replace `:root` and `.dark` blocks:**

```css
@layer base {
  :root {
    /* Surfaces */
    --bg:            #f8f8f7;
    --surface-1:     #ffffff;
    --surface-2:     #f2f2f0;
    --surface-3:     #e9e9e6;
    --foreground:    #18181b;
    --muted:         #71717a;
    --muted-bg:      #f4f4f5;
    --border:        #e4e4e7;
    --border-strong: #d4d4d8;

    /* Brand / state */
    --accent:              #2563eb;
    --accent-hover:        #1d4ed8;
    --accent-soft:         #dbeafe;
    --accent-soft-fg:      #1e40af;
    --accent-foreground:   #ffffff;
    --link:                #2563eb;
    --success:             #166534;
    --success-soft:        #dcfce7;
    --warning:             #854d0e;
    --warning-soft:        #fef3c7;
    --destructive:         #b91c1c;
    --destructive-soft:    #fee2e2;
    --ring:                #2563eb;

    /* Shape / shadow / motion */
    --radius-sm:  0.375rem;
    --radius:     0.5rem;
    --radius-lg:  0.75rem;
    --shadow-xs:  0 1px 0 0 rgb(24 24 27 / 0.04);
    --shadow-sm:  0 1px 2px 0 rgb(24 24 27 / 0.06), 0 1px 1px 0 rgb(24 24 27 / 0.04);
    --shadow-md:  0 4px 12px -2px rgb(24 24 27 / 0.08), 0 2px 4px -1px rgb(24 24 27 / 0.05);
    --transition: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .dark {
    --bg:            #0b0d10;
    --surface-1:     #121418;
    --surface-2:     #181b20;
    --surface-3:     #20242b;
    --foreground:    #e5e7eb;
    --muted:         #9ca3af;
    --muted-bg:      #1a1d22;
    --border:        #2a2f36;
    --border-strong: #3a4049;

    --accent:              #60a5fa;
    --accent-hover:        #93c5fd;
    --accent-soft:         #1e3a8a33;
    --accent-soft-fg:      #bfdbfe;
    --accent-foreground:   #0b0d10;
    --link:                #60a5fa;
    --success:             #86efac;
    --success-soft:        #14532d4d;
    --warning:             #fcd34d;
    --warning-soft:        #713f1240;
    --destructive:         #fca5a5;
    --destructive-soft:    #7f1d1d4d;
    --ring:                #60a5fa;

    --shadow-xs:  0 1px 0 0 rgb(0 0 0 / 0.3);
    --shadow-sm:  0 1px 2px 0 rgb(0 0 0 / 0.5), 0 1px 1px 0 rgb(0 0 0 / 0.3);
    --shadow-md:  0 4px 12px -2px rgb(0 0 0 / 0.6), 0 2px 4px -1px rgb(0 0 0 / 0.4);
  }

  body {
    background: var(--bg);
    color: var(--foreground);
  }

  *:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}
```

Key changes: (a) three surface levels so cards can sit above the page, (b) per-state soft backgrounds for badges so we stop hardcoding `bg-blue-100`, (c) shadow tokens for hover lift, (d) global `:focus-visible` replaces the inconsistent `focus:ring-1` usages.

Rename `--background`/`--card` → `--bg`/`--surface-1` in the components (trivial find-replace); keeps semantic intent clear.

## 2. Kill the theme flash — inline bootstrap in `index.html`

Today: page paints in light, then `useTheme` effect kicks in, page flickers to dark. Fix before React mounts.

**`index.html`:**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Search flights, track prices, and plan trip proposals." />
    <meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#f8f8f7" media="(prefers-color-scheme: light)" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Simple Trip Proposals</title>
    <script>
      (function () {
        try {
          var t = localStorage.getItem('theme');
          if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          if (t === 'dark') document.documentElement.classList.add('dark');
        } catch (e) {}
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
```

`useTheme` can stop writing the class on initial render since it's already set — just keep the effect for toggle transitions. Also ship a 1-color SVG favicon (paper-airplane glyph) to replace `vite.svg`.

## 3. Status badges — dot + label, theme-driven

Currently `ProposalCard` uses hardcoded `bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200` for two of the four statuses, which bypasses the theme and won't match the new palette. Unify them with the `*-soft` tokens from §1 and add a small colored dot — instantly reads as "status" rather than "chip".

**`src/components/ProposalCard.tsx` — replace `statusColors` and badge markup:**

```tsx
const STATUS_STYLE: Record<TripProposal['status'], { bg: string; fg: string; dot: string; label: string }> = {
  draft:    { bg: 'var(--muted-bg)',         fg: 'var(--muted)',          dot: 'var(--muted)',       label: 'Draft' },
  proposed: { bg: 'var(--accent-soft)',      fg: 'var(--accent-soft-fg)', dot: 'var(--accent)',      label: 'Proposed' },
  accepted: { bg: 'var(--success-soft)',     fg: 'var(--success)',        dot: 'var(--success)',     label: 'Accepted' },
  rejected: { bg: 'var(--destructive-soft)', fg: 'var(--destructive)',    dot: 'var(--destructive)', label: 'Rejected' },
};

function StatusBadge({ status }: { status: TripProposal['status'] }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}
```

Renders the label capitalized ("Proposed" not "proposed") — consistent headline casing across the UI.

## 4. Card elevation + hover lift

Flat borders everywhere make scanning a long proposals grid tiring. A subtle elevation gives each card a "pickable" affordance; the transform on hover is what sells "this is clickable".

**`ProposalCard` — outer wrapper:**

```tsx
<div
  className="group relative rounded-lg p-5 bg-[var(--surface-1)] border border-[var(--border)]
             shadow-[var(--shadow-xs)] transition-all duration-150
             hover:shadow-[var(--shadow-md)] hover:border-[var(--border-strong)] hover:-translate-y-0.5"
>
```

Apply the same to the three "Quick action" tiles on `HomePage` and the route cards. Use `shadow-xs` at rest, `shadow-md` on hover. `-translate-y-0.5` (2px) is the sweet spot — any more feels noisy.

## 5. Humanize prices and dates

Right now a proposal reads:

> `Depart: 2026-05-15  Return: 2026-05-22  $299 USD`

Dates look like API payloads and "$299 USD" is redundant. Add a tiny `formatters.ts`:

```ts
// src/utils/formatters.ts
const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DATE_FMT_LONG = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function formatDate(iso?: string, opts?: { long?: boolean }) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (opts?.long ? DATE_FMT_LONG : DATE_FMT).format(d);
}

export function formatPrice(amount?: number, currency = 'USD') {
  if (amount == null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(amount);
}
```

In `ProposalCard`'s detail row:

```tsx
<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
  {proposal.departureDate && (
    <span className="inline-flex items-center gap-1">
      <CalendarIcon className="h-3.5 w-3.5" />
      {formatDate(proposal.departureDate)}
      {proposal.returnDate && <> → {formatDate(proposal.returnDate)}</>}
    </span>
  )}
  {proposal.estimatedPrice != null && (
    <span className="font-semibold text-[var(--foreground)] tabular-nums">
      {formatPrice(proposal.estimatedPrice, proposal.currency)}
    </span>
  )}
</div>
```

`tabular-nums` keeps prices vertically aligned in the grid — small thing, big quality signal. The single calendar pill collapses "Depart X / Return Y" into one readable glance.

## 6. Header mark + typography refinement

The wordmark "SIMPLE TRIP PROPOSALS" in 0.1em-tracked uppercase is shouty at 20px. Quiet it down and add a small visual anchor.

**`src/App.tsx` — replace the `<Link to="/">` content:**

```tsx
<Link to="/" className="flex items-center gap-2 group">
  <span
    aria-hidden
    className="h-6 w-6 rounded-md flex items-center justify-center text-[11px] font-bold
               bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white"
  >
    ✈
  </span>
  <span className="text-base font-semibold tracking-tight text-[var(--foreground)]">
    Simple Trip Proposals
  </span>
</Link>
```

Also tighten nav sizing (`text-sm` not `text-base`) so the wordmark can breathe. Pin the header with `sticky top-0 z-30 backdrop-blur bg-[var(--surface-1)]/80` for a modern app-shell feel.

## 7. Skeleton loaders instead of "Loading..."

Both `HomePage` and `ProposalsPage` render literal `"Loading..."` text while data fetches. Easy win — a shimmer-shaped skeleton matching the real card layout makes the page feel 2× faster even if it isn't.

**Add `src/components/Skeleton.tsx`:**

```tsx
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse bg-[var(--surface-2)] rounded ${className}`}
      aria-hidden
    />
  );
}

export function ProposalCardSkeleton() {
  return (
    <div className="rounded-lg p-5 bg-[var(--surface-1)] border border-[var(--border)] shadow-[var(--shadow-xs)]">
      <div className="flex justify-between gap-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-1/3 mt-3" />
      <Skeleton className="h-3 w-1/2 mt-4" />
      <Skeleton className="h-3 w-3/4 mt-2" />
    </div>
  );
}
```

And in `ProposalsPage`:

```tsx
{loading ? (
  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
    {Array.from({ length: 6 }).map((_, i) => <ProposalCardSkeleton key={i} />)}
  </div>
) : ...}
```

## 8. Bonus — empty state with tinted icon well

`ProposalsPage`'s "No proposals yet" is a center-aligned text blob. Give it a visual anchor:

```tsx
<div className="text-center py-20 border border-dashed border-[var(--border)] rounded-lg bg-[var(--surface-1)]">
  <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-[var(--accent-soft)] flex items-center justify-center">
    <SendIcon className="h-5 w-5 text-[var(--accent)]" />
  </div>
  <p className="text-base font-medium text-[var(--foreground)]">No proposals yet</p>
  <p className="text-sm text-[var(--muted)] mt-1 mb-4">Create one or search for a flight to get started.</p>
  <ProposeTripModal trigger={<button className="...">New Proposal</button>} onCreated={loadProposals} />
</div>
```

## Implementation cost

| Change | Files touched | Est. LOC | Risk |
|--------|---------------|----------|------|
| 1. Tokens | `src/index.css` | ~60 | Low — purely additive, existing `--background`/`--card` vars aliased |
| 2. Theme flash | `index.html`, `useTheme.ts` | ~10 | Low |
| 3. Status badges | `ProposalCard.tsx` | ~25 | None |
| 4. Elevation | `ProposalCard.tsx`, `HomePage.tsx`, `RouteCard.tsx` | ~10 | None |
| 5. Formatters | `utils/formatters.ts` (new), 2 consumers | ~40 | Low |
| 6. Header | `App.tsx` | ~15 | None |
| 7. Skeletons | `Skeleton.tsx` (new), 2 consumers | ~30 | None |
| 8. Empty state | `ProposalsPage.tsx` | ~12 | None |

Total: ~200 LOC across 7 files, no data-layer changes, ships independently of the Drizzle/migration work. Good candidate for PR C in the four-way split suggested in the main review.

## Before / after — summary

| | Before | After |
|---|--------|-------|
| Card rest state | Flat 1px border on white | Border + `--shadow-xs`, slight tint separation from `--bg` |
| Card hover | No change | `-translate-y-0.5` + `--shadow-md` + stronger border |
| Status badge | Mixed Tailwind hex + var classes, lowercase label | Unified `*-soft` tokens, dot + label, capitalized |
| Price | `$299 USD` | `$299` in tabular-nums, currency only if non-USD |
| Date | `2026-05-15` | `May 15 → May 22` in one pill |
| Loading | "Loading..." text | 6-card shimmer grid |
| Empty | Text only | Tinted icon well + CTA |
| Header mark | Uppercase tracked wordmark | Gradient glyph + tight wordmark, sticky blur |
| Theme flash | Visible on every load | Inline bootstrap in `<head>` |
| Focus ring | Inconsistent `focus:ring-1` | Global `:focus-visible` using `--ring` |

## How to test visually

1. Apply changes on the PR branch and run `npm run dev:clean`.
2. Flip system to dark and hard-refresh three times; confirm no light flash.
3. Load `/proposals` with the network tab throttled to Slow 3G; confirm skeleton grid then fade-in.
4. Seed 20 proposals, scan the grid — prices should align vertically; status dots should be the first thing your eye catches.
5. Tab through the page; every interactive element should show the `--ring` outline.
6. Screenshot the home page and one card in both themes — commit to `docs/reviews/screenshots/` so future redesigns have a baseline.
