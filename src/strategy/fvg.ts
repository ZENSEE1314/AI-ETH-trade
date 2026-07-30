// Fair Value Gaps (imbalance) + premium/discount pricing.

import type { Candle, FVG, Side } from '../types.js';

/**
 * A 3-candle FVG. Bullish gap: candle1.high < candle3.low (price jumped up,
 * leaving an unfilled window). Bearish gap: candle1.low > candle3.high.
 * A gap is "mitigated" once later price trades back into it.
 */
export function findFVGs(candles: Candle[]): FVG[] {
  const gaps: FVG[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    if (c1.high < c3.low) {
      const g: FVG = { side: 'long', top: c3.low, bottom: c1.high, time: c3.time, mitigated: false };
      g.mitigated = candles.slice(i + 1).some((c) => c.low <= g.bottom);
      gaps.push(g);
    } else if (c1.low > c3.high) {
      const g: FVG = { side: 'short', top: c1.low, bottom: c3.high, time: c3.time, mitigated: false };
      g.mitigated = candles.slice(i + 1).some((c) => c.high >= g.top);
      gaps.push(g);
    }
  }
  return gaps;
}

/** Most recent unmitigated FVG on the given side, if any. */
export function latestUnmitigatedFVG(candles: Candle[], side: Side): FVG | null {
  const gaps = findFVGs(candles).filter((g) => g.side === side && !g.mitigated);
  return gaps.at(-1) ?? null;
}

/**
 * Premium / discount relative to the dealing range (recent swing high↔low).
 * Below equilibrium = discount (favor longs); above = premium (favor shorts).
 */
export function premiumDiscount(
  candles: Candle[],
  lookback = 50,
): { zone: 'premium' | 'discount' | 'equilibrium'; equilibrium: number } {
  const window = candles.slice(-lookback);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const eq = (high + low) / 2;
  const price = candles.at(-1)!.close;
  const band = (high - low) * 0.05; // 5% neutral zone around equilibrium
  let zone: 'premium' | 'discount' | 'equilibrium' = 'equilibrium';
  if (price > eq + band) zone = 'premium';
  else if (price < eq - band) zone = 'discount';
  return { zone, equilibrium: eq };
}
