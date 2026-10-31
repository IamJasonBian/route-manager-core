import { useRef, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
  type ChartOptions,
  type ChartData
} from 'chart.js';
import 'chartjs-adapter-date-fns';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler
);

export type ChartType = 'line' | 'burn-down' | 'draw-down';

export interface FlightDetails {
  carrier?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
  duration?: string;
  stops?: number;
  bookingClass?: string;
}

export interface PricePoint {
  price: number;
  recorded_at: string;
  flightDetails?: FlightDetails;
}

export interface PriceHistoryChartProps {
  prices: PricePoint[];
  loading?: boolean;
  className?: string;
  chartType?: ChartType;
  title?: string;
}

const calculateBurnDownData = (prices: PricePoint[]): number[] => {
  if (prices.length === 0) return [];
  
  const maxPrice = Math.max(...prices.map(p => p.price));
  return prices.map(p => maxPrice - p.price);
};

const calculateDrawDownData = (prices: PricePoint[]): number[] => {
  if (prices.length === 0) return [];
  
  let peak = prices[0].price;
  return prices.map(point => {
    if (point.price > peak) {
      peak = point.price;
    }
    return ((peak - point.price) / peak) * 100; // Return as percentage
  });
};

const PriceHistoryChart: React.FC<PriceHistoryChartProps> = ({
  prices,
  loading = false,
  className = '',
  chartType = 'line',
  title = 'Price History'
}) => {
  const chartRef = useRef<ChartJS<'line'>>(null);

  const chartData = useMemo<ChartData<'line'>>(() => {
    const labels = prices.map(p => p.recorded_at);
    let data: number[] = [];
    let label = 'Price ($)';
    let borderColor = 'rgb(34, 211, 238)';
    let backgroundColor = 'rgba(34, 211, 238, 0.08)';

    switch (chartType) {
      case 'burn-down':
        data = calculateBurnDownData(prices);
        label = 'Price Drop ($)';
        borderColor = 'rgb(52, 211, 153)';
        backgroundColor = 'rgba(52, 211, 153, 0.08)';
        break;
      case 'draw-down':
        data = calculateDrawDownData(prices);
        label = 'Draw Down (%)';
        borderColor = 'rgb(251, 113, 133)';
        backgroundColor = 'rgba(251, 113, 133, 0.08)';
        break;
      default: // 'line'
        data = prices.map(p => p.price);
        break;
    }

    return {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor,
          backgroundColor,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          borderWidth: 2,
        }
      ]
    };
  }, [prices, chartType]);

  const chartOptions = useMemo<ChartOptions<'line'>>(() => {
    const baseOptions: ChartOptions<'line'> = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: false,
          text: title,
          font: {
            size: 16,
            weight: 'bold',
          },
          padding: { bottom: 20 }
        },
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.parsed.y;
              const pricePoint = prices[context.dataIndex];
              const labels: string[] = [];

              // Add price label
              if (chartType === 'draw-down') {
                labels.push(`${value.toFixed(2)}%`);
              } else if (chartType === 'burn-down') {
                labels.push(`$${value.toFixed(2)} below peak`);
              } else {
                labels.push(`Price: $${value.toFixed(2)}`);
              }

              // Add flight details if available
              if (pricePoint?.flightDetails) {
                const fd = pricePoint.flightDetails;
                if (fd.flightNumber) {
                  labels.push(`Flight: ${fd.flightNumber}`);
                }
                if (fd.stops !== undefined) {
                  labels.push(`Stops: ${fd.stops === 0 ? 'Nonstop' : fd.stops}`);
                }
                if (fd.duration) {
                  // Convert PT8H30M to 8h 30m
                  const duration = fd.duration.replace('PT', '').replace('H', 'h ').replace('M', 'm');
                  labels.push(`Duration: ${duration}`);
                }
                if (fd.bookingClass) {
                  labels.push(`Class: ${fd.bookingClass}`);
                }
              }

              return labels;
            },
            title: (context) => {
              const pricePoint = prices[context[0].dataIndex];
              if (pricePoint?.flightDetails?.departureTime) {
                const date = new Date(pricePoint.flightDetails.departureTime);
                return date.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                });
              }
              return context[0].label;
            }
          }
        }
      },
      elements: {
        line: {
          borderWidth: 2
        },
        point: {
          radius: 3,
          hoverRadius: 5,
          hoverBorderWidth: 2
        }
      },
      animation: {
        duration: 1000
      },
      interaction: {
        intersect: false,
        mode: 'index' as const,
      },
    };

    // Add time scale configuration
    const timeScale = {
      type: 'time' as const,
      time: {
        unit: 'day' as const,
        tooltipFormat: 'PP',
        displayFormats: {
          day: 'MMM d',
          week: 'PP',
          month: 'MMM yyyy',
        }
      },
      title: {
        display: true,
        text: 'Date',
        color: '#64748b'
      },
      grid: {
        display: false
      },
      ticks: {
        color: '#64748b'
      }
    };

    // Add y-axis configuration
    const yAxis = {
      beginAtZero: chartType === 'burn-down',
      title: {
        display: true,
        text: chartType === 'draw-down' ? 'Draw Down (%)' : 
              chartType === 'burn-down' ? 'Price Drop ($)' : 'Price ($)',
        color: '#64748b'
      },
      ticks: {
        callback: (value: string | number) => {
          if (chartType === 'draw-down') {
            return `${value}%`;
          }
          return `$${value}`;
        },
        color: '#64748b'
      },
      grid: {
        color: 'rgba(255, 255, 255, 0.05)'
      }
    };

    // Return the final options with proper typing
    return {
      ...baseOptions,
      scales: {
        x: timeScale as any, // Type assertion needed due to Chart.js type definitions
        y: yAxis as any
      }
    };
  }, [chartType, title]);

  return (
    <div className={`relative h-full ${className}`}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-cyan-400"></div>
        </div>
      ) : prices.length === 0 ? (
        <div className="flex items-center justify-center h-64 text-slate-500">
          No price data available
        </div>
      ) : (
        <Line 
          ref={chartRef}
          data={chartData} 
          options={chartOptions}
          className="h-full w-full"
        />
      )}
    </div>
  );
};

export default PriceHistoryChart;
