import { Link } from 'react-router-dom';
import { Bitcoin, ChevronRight, Cpu, Hexagon, Moon, Sun } from 'lucide-react';
import { useTheme, FontMode } from '../contexts/ThemeContext';

const FONT_LABELS: Record<FontMode, string> = {
  clean: 'Aa',
  serif: 'Ff',
  hacker: '</>',
};

const ASSETS = [
  {
    id: 'BTC',
    name: 'Bitcoin',
    detail: 'BTC / USD',
    icon: Bitcoin,
    to: '/dashboard',
  },
  {
    id: 'MU',
    name: 'Micron',
    detail: 'MU · 4% trail',
    icon: Cpu,
    to: '/strategies?tab=volatility-puts&symbol=MU',
  },
  {
    id: 'NBIS',
    name: 'Nebius',
    detail: 'NBIS · 6% trail',
    icon: Hexagon,
    to: '/strategies?tab=volatility-puts&symbol=NBIS',
  },
] as const;

export default function LandingPage() {
  const { isDark, toggle, font, cycleFont } = useTheme();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black flex flex-col">
      <div className="flex justify-end gap-1 p-4">
        <button
          onClick={cycleFont}
          className="px-2 py-1 rounded text-xs font-medium text-gray-400 dark:text-zinc-600 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-950 transition-colors"
          title={`Font: ${font}`}
        >
          {FONT_LABELS[font]}
        </button>
        <button
          onClick={toggle}
          className="p-1.5 rounded text-gray-400 dark:text-zinc-600 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-950 transition-colors"
          aria-label="Toggle dark mode"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <p className="text-sm text-gray-400 dark:text-zinc-600 mb-6 tracking-wide uppercase">
          Select asset
        </p>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          {ASSETS.map((asset) => {
            const Icon = asset.icon;
            return (
              <Link
                key={asset.id}
                to={asset.to}
                className="flex items-center gap-4 px-5 py-4 border border-gray-200 dark:border-zinc-900 rounded-lg hover:border-gray-400 dark:hover:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-950 transition-all text-left group"
              >
                <div className="p-2 rounded-lg bg-gray-100 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-900 group-hover:border-gray-300 dark:group-hover:border-zinc-700 transition-colors">
                  <Icon className="w-5 h-5 text-gray-700 dark:text-white" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900 dark:text-white">{asset.name}</p>
                  <p className="text-xs text-gray-400 dark:text-zinc-600 mt-0.5">{asset.detail}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 dark:text-zinc-800 group-hover:text-gray-500 dark:group-hover:text-zinc-500 transition-colors" />
              </Link>
            );
          })}
        </div>
      </div>

      <div className="py-6 text-center">
        <p className="text-xs text-gray-300 dark:text-zinc-800">
          MU and NBIS open the live stop desk
        </p>
      </div>
    </div>
  );
}
