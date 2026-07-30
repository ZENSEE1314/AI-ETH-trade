// Liquidity: PDH/PDL/OP/PWH/PWL, equal highs/lows, sweeps & stop hunts.

import type { Candle, LiquidityLevels } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Group candles into UTC day buckets and return prior-day H/L + today's open. */
export function dailyLevels(candles: Candle[]): { pdh: number | null; pdl: number | null; op: number | null } {
  if (candles.length === 0) return { pdh: null, pdl: null, op: null };
  const byDay = new Map<number, Candle[]>();
  for (const c of candles) {
    const day = Math.floor(c.time / DAY_MS);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(c);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length === 0) return { pdh: null, pdl: null, op: null };

  const today = byDay.get(days.at(-1)!)!;
  const op = today[0]?.open ?? null;

  if (days.length < 2) return { pdh: null, pdl: null, op };
  const prev = byDay.get(days.at(-2)!)!;
  const pdh = Math.max(...prev.map((c) => c.high));
  const pdl = Math.min(...prev.map((c) => c.low));
  return { pdh, pdl, op };
}

/** Prior-week high/low using 7-day buckets. */
export function weeklyLevels(candles: Candle[]): { pwh: number | null; pwl: number | null } {
  if (candles.length === 0) return { pwh: null, pwl: null };
  const byWeek = new Map<number, Candle[]>();
  for (const c of candles) {
    const week = Math.floor(c.time / (7 * DAY_MS));
    (byWeek.get(week) ?? byWeek.set(week, []).get(week)!).push(c);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  if (weeks.length < 2) return { pwh: null, pwl: null };
  const prev = byWeek.get(weeks.at(-2)!)!;
  return {
    pwh: Math.max(...prev.map((c) => c.high)),
    pwl: Math.min(...prev.map((c) => c.low)),
  };
}

/** Find clusters of near-equal swing highs/lows (resting liquidity pools). */
export function equalLevels(candles: Candle[], tolerancePct = 0.05): { highs: number[]; lows: number[] } {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  return { highs: cluster(highs, tolerancePct), lows: cluster(lows, tolerancePct) };
}

function cluster(values: number[], tolerancePct: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && (sorted[j] - sorted[i]) / sorted[i] * 100 <= tolerancePct) j++;
    if (j - i >= 2) out.push((sorted[i] + sorted[j - 1]) / 2); // >=2 touches = equal level
    i = j;
  }
  return out;
}

export function buildLiquidity(candles: Candle[]): LiquidityLevels {
  const { pdh, pdl, op } = dailyLevels(candles);
  const { pwh, pwl } = weeklyLevels(candles);
  const { highs, lows } = equalLevels(candles);
  return { pdh, pdl, op, pwh, pwl, equalHighs: highs, equalLows: lows };
}

/**
 * A liquidity sweep / stop hunt: the most recent candle wicks BEYOND a key
 * level but closes back inside — trapping breakout traders. Returns the swept
 * side, if any.
 */
export function detectSweep(
  candles: Candle[],
  levels: LiquidityLevels,
): { swept: 'buy-side' | 'sell-side' | null; level: number | null } {
  const last = candles.at(-1);
  if (!last) return { swept: null, level: null };

  const buySide = [levels.pdh, levels.pwh, ...levels.equalHighs].filter((v): v is number => v != null);
  const sellSide = [levels.pdl, levels.pwl, ...levels.equalLows].filter((v): v is number => v != null);

  for (const lvl of buySide) {
    if (last.high > lvl && last.close < lvl) return { swept: 'buy-side', level: lvl };
  }
  for (const lvl of sellSide) {
    if (last.low < lvl && last.close > lvl) return { swept: 'sell-side', level: lvl };
  }
  return { swept: null, level: null };
}
