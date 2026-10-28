interface LiveStatusIndicatorProps {
  isRefreshing: boolean;
  lastUpdated: Date | null;
  intervalMs?: number;
  className?: string;
}

export default function LiveStatusIndicator({
  isRefreshing,
  lastUpdated,
  intervalMs = 5000,
  className = '',
}: LiveStatusIndicatorProps) {
  const seconds = Math.round(intervalMs / 1000);
  return (
    <div className={`flex items-center text-xs text-gray-500 ${className}`}>
      <span
        className={`mr-2 inline-block h-2 w-2 rounded-full ${
          isRefreshing ? 'bg-cyan-500 animate-pulse' : 'bg-emerald-500'
        }`}
        aria-hidden="true"
      />
      {isRefreshing
        ? 'Refreshing…'
        : `Live • auto-refreshes every ${seconds}s${
            lastUpdated ? ` • updated ${lastUpdated.toLocaleTimeString()}` : ''
          }`}
    </div>
  );
}
