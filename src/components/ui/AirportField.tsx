import type { ChangeEvent, RefObject } from 'react';

export interface Airport {
  iataCode: string;
  name: string;
  cityName: string;
  countryName: string;
  type: string;
}

// IATA input with an autocomplete menu; the parent owns lookup and click-outside.
export default function AirportField({
  id,
  label,
  placeholder,
  containerRef,
  value,
  onChange,
  onFocus,
  suggestions,
  onSelect,
}: {
  id: string;
  label: string;
  placeholder: string;
  containerRef: RefObject<HTMLDivElement>;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  suggestions: Airport[];
  onSelect: (airport: Airport) => void;
}) {
  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        type="text"
        id={id}
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        placeholder={placeholder}
        autoComplete="off"
        className="input font-mono uppercase tracking-wide"
      />
      {suggestions.length > 0 && (
        <div className="menu">
          {suggestions.map((airport) => (
            <div key={airport.iataCode} className="menu-item" onClick={() => onSelect(airport)}>
              <span className="font-mono text-sm text-white">{airport.iataCode}</span>
              <span className="ml-2 text-xs text-slate-500">
                {[airport.name, airport.cityName, airport.countryName].filter(Boolean).join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
