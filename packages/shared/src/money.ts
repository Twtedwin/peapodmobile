/**
 * MODULE: @peapod/shared/money
 *
 * PURPOSE
 *   Every monetary helper in Peapod. Money is represented as an INTEGER count
 *   of the currency's minor unit and nothing else.
 *
 * INPUTS  : integer minor units + an ISO 4217 currency code
 * OUTPUTS : integer minor units, or a display string (formatting only)
 *
 * CONSUMED BY
 *   - apps/mobile   : rendering every amount on the Wallet and Trip screens
 *   - services/api  : wallet ledger writes and bill splitting
 *
 * WHY MINOR UNITS, NOT FLOATS
 *   Binary floating point cannot represent 0.1 exactly. Adding 0.1 ten times
 *   gives 0.9999999999999999, and splitting a $10.00 bill three ways gives
 *   three shares that do not add back to $10.00. In a shared wallet that drift
 *   is not a rounding curiosity -- it is money appearing or vanishing between
 *   two people who can both see the balance. Integers make every operation
 *   exact, and the only place a decimal point exists is the final render.
 *
 * WHY NOT A DECIMAL LIBRARY
 *   A Decimal type would also be exact, but it would have to cross four
 *   language boundaries (TypeScript, Rust, Python, JSON) and there is no shared
 *   wire representation for one. Integers survive JSON untouched.
 */

/**
 * How many minor units make one major unit, per currency.
 *
 * Most currencies are 100 (cents to the dollar), but several have no minor unit
 * at all. Getting this wrong by a factor of 100 is the classic currency bug, so
 * the exceptions are listed explicitly rather than assumed.
 */
const MINOR_UNITS_PER_MAJOR: Record<string, number> = {
  // Zero-decimal currencies: the minor unit IS the major unit.
  JPY: 1, // Japanese yen
  KRW: 1, // South Korean won
  VND: 1, // Vietnamese dong
  IDR: 1, // Indonesian rupiah -- technically has sen, but they are not in circulation
  CLP: 1, // Chilean peso
  ISK: 1, // Icelandic krona
};

/** The multiplier for currencies not listed above: cents, pence, and friends. */
const DEFAULT_MINOR_UNITS_PER_MAJOR = 100;

/**
 * Symbols used for display. Falls back to the currency code itself, which is
 * always correct if not always pretty.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  SGD: 'S$',
  USD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
  AUD: 'A$',
  MYR: 'RM',
  THB: '฿',
  KRW: '₩',
  VND: '₫',
  TWD: 'NT$',
  HKD: 'HK$',
  IDR: 'Rp',
  CNY: '¥',
};

/**
 * Minor units per major unit for a currency code.
 *
 * @param currency ISO 4217 code, case-insensitive.
 * @returns 1 for zero-decimal currencies, otherwise 100.
 */
export function minorUnitsPerMajor(currency: string): number {
  return MINOR_UNITS_PER_MAJOR[currency.toUpperCase()] ?? DEFAULT_MINOR_UNITS_PER_MAJOR;
}

/**
 * Formats minor units for display.
 *
 * This is the ONLY function permitted to produce a decimal point from a money
 * value. Everything upstream stays integral.
 *
 * @param amountMinor Integer minor units. Negative values are rendered with a leading minus.
 * @param currency    ISO 4217 code. Decides both the symbol and the decimal places.
 * @param options.showSymbol   Prefix the currency symbol. Default true.
 * @param options.alwaysSigned Force a leading `+` on positive values, for ledger rows.
 * @returns e.g. `S$14.98`, `¥13000`, `-S$82.40`, `+S$120.00`.
 *
 * EDGE CASES
 *   - A non-integer input is rounded, because a fractional minor unit is always
 *     a bug upstream and silently truncating would hide it. Round, do not throw:
 *     a malformed amount must not blank out a whole screen.
 *   - Zero-decimal currencies render with no decimal separator at all.
 */
export function formatMinor(
  amountMinor: number,
  currency = 'SGD',
  options: { showSymbol?: boolean; alwaysSigned?: boolean } = {},
): string {
  const { showSymbol = true, alwaysSigned = false } = options;

  const code = currency.toUpperCase();
  const divisor = minorUnitsPerMajor(code);
  const decimals = divisor === 1 ? 0 : 2;

  const rounded = Math.round(amountMinor);
  const negative = rounded < 0;
  const magnitude = Math.abs(rounded);

  // Integer division keeps the whole part exact; the remainder becomes the
  // fractional part. Doing this with division and toFixed would reintroduce
  // float error on the very value we are trying to protect.
  const whole = Math.floor(magnitude / divisor);
  const fraction = magnitude % divisor;

  const groupedWhole = whole.toLocaleString('en-US');
  const body = decimals === 0 ? groupedWhole : `${groupedWhole}.${String(fraction).padStart(decimals, '0')}`;

  const symbol = showSymbol ? (CURRENCY_SYMBOLS[code] ?? `${code} `) : '';
  const sign = negative ? '-' : alwaysSigned ? '+' : '';

  return `${sign}${symbol}${body}`;
}

/**
 * Parses user input in major units into integer minor units.
 *
 * @param input    What the user typed, e.g. `"14.98"`, `"1,200"`, `"S$40"`.
 * @param currency ISO 4217 code, which decides the multiplier.
 * @returns Integer minor units, or `null` when the input is not a number.
 *
 * EDGE CASES
 *   - Strips currency symbols, spaces, and thousands separators first, so
 *     pasting a formatted amount back in works.
 *   - More decimal places than the currency supports are rounded, not rejected:
 *     typing `10.999` into a cents field means 11.00, which is what a person
 *     would expect.
 *   - An empty or non-numeric string returns null so the caller can show a
 *     validation message rather than silently recording zero.
 */
export function parseMajorToMinor(input: string, currency = 'SGD'): number | null {
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  return Math.round(value * minorUnitsPerMajor(currency.toUpperCase()));
}

/**
 * Sums a list of minor-unit amounts.
 *
 * Trivial, but worth having by name: it documents at every call site that the
 * values being added are already integers, and it keeps the reduce boilerplate
 * out of the screens.
 *
 * @param amounts Integer minor units.
 * @returns Integer minor units.
 */
export function sumMinor(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) total += amount;
  return total;
}

/**
 * Merges cost lines that share a label, summing their amounts.
 *
 * The itinerary generator emits one line per activity, so a ten-day trip
 * produces thirty "Activities" lines. The breakdown UI wants one row per label
 * with a single total.
 *
 * @param lines Cost lines in any order.
 * @returns One line per distinct label, in first-seen order so the display
 *          ordering stays stable across renders.
 */
export function mergeCostLines<T extends { label: string; amount_minor: number }>(lines: readonly T[]): T[] {
  const byLabel = new Map<string, T>();

  for (const line of lines) {
    const existing = byLabel.get(line.label);
    if (existing) {
      // Mutating a copy rather than the caller's object: these lines often come
      // straight from a React Query cache, which must not be written through.
      byLabel.set(line.label, { ...existing, amount_minor: existing.amount_minor + line.amount_minor });
    } else {
      byLabel.set(line.label, { ...line });
    }
  }

  return [...byLabel.values()];
}
