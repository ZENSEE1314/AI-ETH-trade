// Candlestick anatomy & pressure reading.
// "Candles tell the story of buyers and sellers."

import type { Candle } from '../types.js';

export interface CandleAnatomy {
  bullish: boolean;
  bearish: boolean;
  doji: boolean;
  bodyPct: number; // body size as % of full range
  upperWickPct: number;
  lowerWickPct: number;
  strength: 'strong' | 'moderate' | 'weak' | 'indecision';
  rejection: 'top' | 'bottom' | null; // long wick = rejection of that extreme
}

const DOJI_BODY_PCT = 10; // body < 10% of range => indecision
const STRONG_BODY_PCT = 70;
const REJECTION_WICK_PCT = 55;

export function analyzeCandle(c: Candle): CandleAnatomy {
  const range = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  const bodyPct = (body / range) * 100;
  const upperWickPct = (upperWick / range) * 100;
  const lowerWickPct = (lowerWick / range) * 100;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;
  const doji = bodyPct < DOJI_BODY_PCT;

  let strength: CandleAnatomy['strength'];
  if (doji) strength = 'indecision';
  else if (bodyPct >= STRONG_BODY_PCT) strength = 'strong';
  else if (bodyPct >= 40) strength = 'moderate';
  else strength = 'weak';

  let rejection: CandleAnatomy['rejection'] = null;
  if (upperWickPct >= REJECTION_WICK_PCT && upperWickPct > lowerWickPct) rejection = 'top';
  else if (lowerWickPct >= REJECTION_WICK_PCT && lowerWickPct > upperWickPct) rejection = 'bottom';

  return { bullish, bearish, doji, bodyPct, upperWickPct, lowerWickPct, strength, rejection };
}

/** Bullish engulfing: current green body fully engulfs prior red body. */
export function isBullishEngulfing(prev: Candle, cur: Candle): boolean {
  return (
    prev.close < prev.open &&
    cur.close > cur.open &&
    cur.close >= prev.open &&
    cur.open <= prev.close
  );
}

export function isBearishEngulfing(prev: Candle, cur: Candle): boolean {
  return (
    prev.close > prev.open &&
    cur.close < cur.open &&
    cur.open >= prev.close &&
    cur.close <= prev.open
  );
}

/**
 * The Power of 3 (AMD): accumulation -> manipulation -> distribution.
 * Heuristic over the last 3 candles: a sweep of one side's liquidity followed
 * by a strong displacement the other way signals the distribution leg.
 */
export function powerOfThree(candles: Candle[]): 'bullish-distribution' | 'bearish-distribution' | null {
  if (candles.length < 3) return null;
  const [a, b, c] = candles.slice(-3);
  const manipDown = b.low < Math.min(a.low, a.open);
  const manipUp = b.high > Math.max(a.high, a.open);
  const cBody = Math.abs(c.close - c.open);
  const cRange = Math.max(c.high - c.low, 1e-9);
  const displacement = cBody / cRange >= 0.6;

  if (manipDown && c.close > c.open && displacement) return 'bullish-distribution';
  if (manipUp && c.close < c.open && displacement) return 'bearish-distribution';
  return null;
}
