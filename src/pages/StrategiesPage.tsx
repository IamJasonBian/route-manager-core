import { useSearchParams } from 'react-router-dom';
import WeekendMomentum from '../components/WeekendMomentum';
import WeekendGap from '../components/WeekendGap';
import NewsStraddle from '../components/NewsStraddle';
import MarketDepth from '../components/MarketDepth';
import UnderlyingsMomentum from '../components/UnderlyingsMomentum';
import VolatilityPuts from '../components/VolatilityPuts';

const TABS = [
  { id: 'underlyings', label: 'Underlyings' },
  { id: 'market-depth', label: 'Market Depth' },
  { id: 'volatility-puts', label: 'Volatility Puts' },
  { id: 'weekend-momentum', label: 'Weekend Momentum' },
  { id: 'weekend-gap', label: 'Weekend Gap' },
  { id: 'news-straddle', label: 'News Straddle' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export default function StrategiesPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const activeTab: TabId = isTabId(requested) ? requested : 'underlyings';
  const focusSymbol = params.get('symbol') || undefined;

  const setActiveTab = (id: TabId) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    if (id !== 'volatility-puts') next.delete('symbol');
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Strategies</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">Quantitative strategy analysis and ideas. Backtesting coming soon.</p>
      </div>

      <div className="border-b border-gray-200 dark:border-zinc-800 mb-8">
        <nav className="flex gap-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-gray-900 dark:border-gray-100 text-gray-900 dark:text-white'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'underlyings' && <UnderlyingsMomentum />}
      {activeTab === 'market-depth' && <MarketDepth />}
      {activeTab === 'volatility-puts' && <VolatilityPuts focusSymbol={focusSymbol} />}
      {activeTab === 'weekend-momentum' && <WeekendMomentum />}
      {activeTab === 'weekend-gap' && <WeekendGap />}
      {activeTab === 'news-straddle' && <NewsStraddle />}
    </div>
  );
}
