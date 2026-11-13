// Pure money, time and pricing rules. No I/O, no clock, no model calls: every
// function here is an equation or a lookup so it can be unit-tested exactly.
// All USD amounts are integer cents. KHR amounts are integer riel.

/** Smallest riel note in everyday use; cash amounts are rounded to this. */
export const KHR_STEP = 100;

/** Riel a customer owes for a USD amount. Rounded UP so the sale is never short. */
export function khrDue(cents: number, rate: number): number {
  return Math.ceil((cents * rate) / 100 / KHR_STEP) * KHR_STEP;
}

/** USD-cent value of riel handed over. Rounded DOWN (house never over-credits). */
export function khrToCents(khr: number, rate: number): number {
  return Math.floor((khr * 100) / rate);
}

/**
 * Change for a cash tender, the way Phnom Penh tills actually give it:
 * whole dollars in USD notes, the sub-dollar remainder in riel (rounded down
 * to the nearest 100, since US coins do not circulate).
 */
export function cashChange(changeCents: number, rate: number) {
  const usd = Math.floor(changeCents / 100) * 100;
  const khr = Math.floor(((changeCents - usd) * rate) / 100 / KHR_STEP) * KHR_STEP;
  return { change_usd_cents: usd, change_khr: khr };
}

/** Apply a discount in basis points (2000 = 20%). */
export function discounted(cents: number, bp: number): number {
  return Math.round((cents * (10000 - bp)) / 10000);
}

export function pct(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10000);
}

/** VAT contained in a VAT-inclusive total. */
export function vatIncluded(totalCents: number, vatBp: number): number {
  return vatBp > 0 ? Math.round((totalCents * vatBp) / (10000 + vatBp)) : 0;
}

/** Local wall-clock parts for a UTC timestamp and a fixed offset (Cambodia: +420, no DST). */
export function localParts(tsMs: number, tzOffsetMin: number) {
  const d = new Date(tsMs + tzOffsetMin * 60000);
  return {
    date: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/**
 * The trading day a moment belongs to. A bar's night runs past midnight, so
 * anything before the cutoff hour (default 06:00) counts as the previous day.
 */
export function businessDate(tsMs: number, tzOffsetMin: number, cutoffHour: number): string {
  return localParts(tsMs - cutoffHour * 3600000, tzOffsetMin).date;
}

function hhmm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

export interface HappyHourRule {
  enabled: boolean;
  start: string; // "17:00"
  end: string; // "19:00"; may be earlier than start to wrap past midnight
  days: number[]; // 0 = Sunday
  discount_bp: number;
}

/** True when the moment falls inside the happy-hour window. Start inclusive, end exclusive. */
export function isHappyHour(tsMs: number, tzOffsetMin: number, r: HappyHourRule): boolean {
  if (!r.enabled || r.discount_bp <= 0) return false;
  const s = hhmm(r.start), e = hhmm(r.end);
  if (s < 0 || e < 0 || s === e) return false;
  const p = localParts(tsMs, tzOffsetMin);
  if (s < e) return r.days.includes(p.day) && p.minutes >= s && p.minutes < e;
  // Window wraps midnight: the late part belongs to the day it started on.
  if (p.minutes >= s) return r.days.includes(p.day);
  if (p.minutes < e) return r.days.includes((p.day + 6) % 7);
  return false;
}

/**
 * Cost-plus price suggestion: the price at which the drink's ingredient cost
 * equals the target pour cost, rounded up to the next price step.
 */
export function suggestPrice(costCents: number, targetPourCostBp: number, stepCents = 25): number {
  if (costCents <= 0 || targetPourCostBp <= 0) return 0;
  return Math.ceil((costCents * 10000) / targetPourCostBp / stepCents) * stepCents;
}

export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
