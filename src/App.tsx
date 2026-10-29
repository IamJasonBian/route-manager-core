import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Loader2, Plane } from 'lucide-react';

import HomePage from './pages/HomePage';
import SearchFlightsPage from './pages/SearchFlightsPage';
import PriceTrendsPage from './pages/PriceTrendsPage';
import PipelinesPage from './pages/PipelinesPage';

const PlanningPage = lazy(() => import('./pages/PlanningPage'));

function prefetchPlanningChunk() {
  void import('./pages/PlanningPage');
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'rounded-full px-3.5 py-2 text-sm font-medium transition-colors duration-200',
    isActive
      ? 'bg-white/10 text-white shadow-inner shadow-white/5'
      : 'text-slate-400 hover:bg-white/5 hover:text-white',
  ].join(' ');

function AppContent() {
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setIsLoading(false);
  }, []);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[hsl(var(--background))]">
        <div className="text-center">
          <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-cyan-400" aria-hidden />
          <p className="font-medium text-slate-300">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-transparent">
      <header className="sticky top-0 z-50 border-b border-white/5 bg-slate-950/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <NavLink to="/" className="group flex items-center gap-2.5 outline-none ring-cyan-400/50 focus-visible:ring-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400/20 to-amber-400/15 ring-1 ring-white/10 transition group-hover:from-cyan-400/30">
              <Plane className="h-5 w-5 text-cyan-300" aria-hidden />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight text-white">Apollo</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">Flight Trader</span>
            </span>
          </NavLink>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            <NavLink to="/" className={navLinkClass} end>
              Home
            </NavLink>
            <NavLink to="/plan" className={navLinkClass} onPointerEnter={prefetchPlanningChunk}>
              Plan
            </NavLink>
            <NavLink to="/search" className={navLinkClass}>
              Search
            </NavLink>
            <NavLink to="/trends" className={navLinkClass}>
              Trends
            </NavLink>
            <NavLink to="/pipelines" className={navLinkClass}>
              Pipelines
            </NavLink>
          </nav>
        </div>

        <div className="border-t border-white/5 px-4 py-2 md:hidden">
          <nav className="flex flex-wrap justify-center gap-1" aria-label="Primary mobile">
            <NavLink to="/" className={navLinkClass} end>
              Home
            </NavLink>
            <NavLink to="/plan" className={navLinkClass} onPointerEnter={prefetchPlanningChunk}>
              Plan
            </NavLink>
            <NavLink to="/search" className={navLinkClass}>
              Search
            </NavLink>
            <NavLink to="/trends" className={navLinkClass}>
              Trends
            </NavLink>
            <NavLink to="/pipelines" className={navLinkClass}>
              Pipelines
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="relative flex-1">
        <Routes>
          <Route
            path="/"
            element={
              <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
                <HomePage />
              </div>
            }
          />
          <Route path="/search" element={<SearchFlightsPage />} />
          <Route path="/trends" element={<PriceTrendsPage />} />
          <Route path="/pipelines" element={<PipelinesPage />} />
          <Route
            path="/plan"
            element={
              <Suspense
                fallback={
                  <div className="flex min-h-[50vh] items-center justify-center">
                    <Loader2 className="h-10 w-10 animate-spin text-cyan-400" aria-hidden />
                  </div>
                }
              >
                <PlanningPage />
              </Suspense>
            }
          />
        </Routes>
      </main>

      <footer className="mt-auto border-t border-white/5 py-6 text-center text-xs text-slate-500">
        Price signals for planning — not a booking engine.
      </footer>
    </div>
  );
}

export function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}
