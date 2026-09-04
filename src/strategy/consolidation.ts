// Consolidation → breakout detector.
// The market coils (a tight, low-range box), then expands. This finds the box
// on a given timeframe and reports whether the latest bars are breaking out of
// it — with the volume expansion that separates a real break from a fake one.

import type { Candle } from '../types.js';

export interface Consolidation {
  isCoiled: boolean; // recent range is tight enough to call a box
  bars: number; // how many bars the box spans
  high: number; // box top
  low: number; // box bottom
  rangePct: number; // (high - low) / low * 100
  compression: number; // box range / prior-window range (<1 = tightening)
  breakout: 'up' | 'down' | null; // last close is outside the box
  volumeExpansion: number; // last bar volume / box average volume
  confirmed: boolean; // breakout + volume expansion + close beyond the edge
}

const WINDOW = 12; // bars that form the box (3h on 15M, 12h on 1H)
const TIGHT_RANGE_PCT = 1.6; // box range at/under this % of price = coiled
const VOL_EXPANSION_MIN = 1.5; // last bar must trade this × the box average

/**
 * Look at the last `window` closed bars (excluding the current forming bar) and
 * decide whether they form a coiled box, then test the latest bar against it.
 */
export function detectConsolidation(candles: Candle[], window = WINDOW): Consolidation | null {
  // Need the box window plus a prior window to measure compression, plus the
  // current bar we test against the box.
  if (candles.length < window * 2 + 1) return null;

  const current = candles.at(-1)!;
  const box = candles.slice(-1 - window, -1);
  const prior = candles.slice(-1 - window * 2, -1 - window);

  const high = Math.max(...box.map((c) => c.high));
  const low = Math.min(...box.map((c) => c.low));
  const rangePct = ((high - low) / low) * 100;

  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));
  const priorRange = priorHigh - priorLow || 1e-9;
  const compression = (high - low) / priorRange;

  const avgVol = box.reduce((s, c) => s + c.volume, 0) / box.length || 1e-9;
  const volumeExpansion = current.volume / avgVol;

  let breakout: Consolidation['breakout'] = null;
  if (current.close > high) breakout = 'up';
  else if (current.close < low) breakout = 'down';

  const isCoiled = rangePct <= TIGHT_RANGE_PCT;
  const confirmed = isCoiled && breakout != null && volumeExpansion >= VOL_EXPANSION_MIN;

  return {
    isCoiled,
    bars: window,
    high,
    low,
    rangePct: round(rangePct),
    compression: round(compression),
    breakout,
    volumeExpansion: round(volumeExpansion),
    confirmed,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
