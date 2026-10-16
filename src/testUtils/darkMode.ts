// Shared by the page dark-mode regression tests (TradePage, TickerPnLPage).

/** Patterns that are "light only" and need a dark: counterpart.
 *  Negative lookbehind excludes hover:/focus: prefixed variants. */
export const LIGHT_PATTERNS = [
  /(?<!hover:|focus:)\bbg-white\b/,
  /(?<!hover:|focus:)\bbg-gray-\d+\b/,
  /(?<!hover:|focus:)\btext-gray-[1-9]\d*\b/,    // text-gray-100 through text-gray-900
  /(?<!hover:|focus:)\bborder-gray-\d+\b/,
  /(?<!hover:|focus:)\bdivide-gray-\d+\b/,
];


/**
 * Walk every element in the container. For each className string,
 * check that every light-mode class has a `dark:` counterpart somewhere
 * in the same className string.
 *
 * Returns a list of violations: { element tag, className, offending class }.
 */
export function findDarkModeViolations(container: HTMLElement) {
  const violations: { tag: string; className: string; lightClass: string }[] = [];
  const allElements = container.querySelectorAll('*');

  for (const el of allElements) {
    const raw = el.className;
    // SVG elements return an SVGAnimatedString — extract baseVal
    const cn = typeof raw === 'string' ? raw : (raw as SVGAnimatedString)?.baseVal;
    if (typeof cn !== 'string' || !cn) continue;

    // Skip skeleton/loading placeholders (animate-pulse)
    if (cn.includes('animate-pulse')) continue;

    for (const pattern of LIGHT_PATTERNS) {
      const matches = cn.match(new RegExp(pattern.source, 'g'));
      if (!matches) continue;

      for (const match of matches) {
        // Already-dark classes don't need a dark: variant
        if (/bg-gray-[89]\d{2}|bg-gray-900|bg-gray-800/.test(match)) continue;
        if (/hover:bg-gray-800/.test(match)) continue;
        // Light/mid text (gray-300/400/500) is already visible on dark backgrounds
        if (/text-gray-[345]00/.test(match)) continue;

        // Extract the utility name (e.g. "bg-gray-50" or "bg-white")
        const prefix = match.startsWith('bg-') ? 'dark:bg-' :
                       match.startsWith('text-') ? 'dark:text-' :
                       match.startsWith('border-') ? 'dark:border-' :
                       match.startsWith('divide-') ? 'dark:divide-' : 'dark:';

        // Check if there's a corresponding dark: class in the same className
        if (!cn.includes(prefix)) {
          violations.push({ tag: el.tagName, className: cn, lightClass: match });
        }
      }
    }
  }

  return violations;
}

/** Human-readable summary of the first violations, for a failing assertion. */
export function describeViolations(violations: ReturnType<typeof findDarkModeViolations>): string {
  return violations
    .slice(0, 20)
    .map((v) => `  <${v.tag}> has "${v.lightClass}" without dark: pair\n    className="${v.className.slice(0, 120)}"`)
    .join('\n');
}
