import { lazy, Suspense, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Bitcoin, LayoutDashboard, GitCompare, TrendingUp, FlaskConical, Moon, Sun, Menu, X, Settings, Layers, PieChart, Newspaper, Target } from 'lucide-react';
import { ThemeProvider, useTheme, FontMode } from './contexts/ThemeContext';

import LandingPage from './pages/LandingPage';

// Route-level code splitting: each page (and its recharts / 3D surface /
// static financials payload) loads on first visit instead of in the entry bundle.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const TradePage = lazy(() => import('./pages/TradePage'));
const PnLAllocationPage = lazy(() => import('./pages/PnLAllocationPage'));
const StrategiesPage = lazy(() => import('./pages/StrategiesPage'));
const ConfigurePage = lazy(() => import('./pages/ConfigurePage'));
const MarketDepthPage = lazy(() => import('./pages/MarketDepthPage'));
const NewsPage = lazy(() => import('./pages/NewsPage'));
const TickerPnLPage = lazy(() => import('./pages/TickerPnLPage'));

function PageFallback() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="animate-pulse h-8 w-48 rounded bg-gray-200 dark:bg-zinc-800" />
    </div>
  );
}

const FONT_LABELS: Record<FontMode, string> = {
  clean: 'Aa',
  serif: 'Ff',
  hacker: '</>',
};

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/compare', icon: GitCompare, label: 'Compare' },
  { to: '/trade', icon: TrendingUp, label: 'Trade' },
  { to: '/depth', icon: Layers, label: 'Depth' },
  { to: '/news', icon: Newspaper, label: 'News' },
  { to: '/pnl-allocation', icon: PieChart, label: 'P&L & Allocation' },
  { to: '/ticker/NBIS', icon: Target, label: 'Ticker P&L' },
  { to: '/strategies', icon: FlaskConical, label: 'Strategies' },
  { to: '/configure', icon: Settings, label: 'Configure' },
];

/** Exact match, except /ticker/* which stays active whichever ticker is open. */
function isNavActive(pathname: string, to: string): boolean {
  if (to.startsWith('/ticker/')) return pathname.startsWith('/ticker');
  return pathname === to;
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  const isActive = isNavActive(location.pathname, to);

  return (
    <Link
      to={to}
      className={`text-sm font-medium transition-colors pb-0.5 ${
        isActive
          ? 'text-gray-900 dark:text-white border-b border-gray-900 dark:border-white'
          : 'text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'
      }`}
    >
      {children}
    </Link>
  );
}

function AppShell() {
  const { isDark, toggle, font, cycleFont } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black flex flex-col">
      <header className="sticky top-0 z-50 bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-zinc-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="flex items-center group">
              <Bitcoin className="h-6 w-6 text-gray-900 dark:text-white" />
              <h1 className="ml-3 text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Systemmatic BTC</h1>
            </Link>

            {/* Desktop nav */}
            <nav className="hidden md:flex items-center flex-1 ml-8">
              <div className="flex items-center space-x-2">
                <button
                  onClick={cycleFont}
                  className="px-2 py-1 rounded text-xs font-medium text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                  aria-label="Cycle font"
                  title={`Font: ${font}`}
                >
                  {FONT_LABELS[font]}
                </button>
                <button
                  onClick={toggle}
                  className="p-1.5 rounded text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                  aria-label="Toggle dark mode"
                >
                  {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
              </div>
              <div className="flex items-center space-x-8 ml-auto">
                {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
                  <NavLink key={to} to={to}>
                    <span className="flex items-center gap-2">
                      <Icon className="w-4 h-4" />
                      {label}
                    </span>
                  </NavLink>
                ))}
              </div>
            </nav>

            {/* Mobile: controls + hamburger */}
            <div className="flex items-center gap-1 md:hidden">
              <button
                onClick={cycleFont}
                className="px-2 py-1 rounded text-xs font-medium text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                aria-label="Cycle font"
              >
                {FONT_LABELS[font]}
              </button>
              <button
                onClick={toggle}
                className="p-1.5 rounded text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                aria-label="Toggle dark mode"
              >
                {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setMobileOpen((o) => !o)}
                className="p-1.5 rounded text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                aria-label="Toggle menu"
              >
                {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile dropdown nav */}
        {mobileOpen && (
          <div className="md:hidden border-t border-gray-100 dark:border-zinc-900 bg-white dark:bg-zinc-950">
            {NAV_ITEMS.map(({ to, icon: Icon, label }) => {
              const isActive = isNavActive(location.pathname, to);
              return (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-gray-900 dark:text-white bg-gray-50 dark:bg-zinc-900'
                      : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-zinc-900'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </header>

      <main className="flex-1">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/trade" element={<TradePage />} />
            <Route path="/depth" element={<MarketDepthPage />} />
            <Route path="/news" element={<NewsPage />} />
            <Route path="/pnl-allocation" element={<PnLAllocationPage />} />
            <Route path="/ticker" element={<TickerPnLPage />} />
            <Route path="/ticker/:symbol" element={<TickerPnLPage />} />
            <Route path="/configure" element={<ConfigurePage />} />
            <Route path="/strategies" element={<StrategiesPage />} />
          </Routes>
        </Suspense>
      </main>

      <footer className="bg-white dark:bg-zinc-950 border-t border-gray-100 dark:border-zinc-900 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-xs text-gray-400 dark:text-zinc-500">
            Data provided by{' '}
            <a
              href="https://twelvedata.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 dark:text-zinc-400 hover:underline"
            >
              Twelve Data
            </a>
            {', '}
            <a
              href="https://polygon.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 dark:text-zinc-400 hover:underline"
            >
              Polygon.io
            </a>
            {' & '}
            <a
              href="https://www.coindesk.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 dark:text-zinc-400 hover:underline"
            >
              CoinDesk
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <Router>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/*" element={<AppShell />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}
