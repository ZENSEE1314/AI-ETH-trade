// HTF green→red travel — the code version of tradingview/GreenRedTravel_strategy.pine
// v2, built to match the user's manual trade journal:
//   · green/red = last confirmed swing low/high on a HIGHER timeframe (4H or 1D)
//     — so the range is 2%+ wide, not 15M noise
//   · enter within `entryTolPct` of the line, in the structure direction
//   · optional reaction candle at the line (close back through, and vs prior close)
//   · stop `stopPastPct` past the line (tight — if it breaks, you're wrong)
//   · target the OPPOSITE line
//   · a context timeframe must not oppose (or must agree, if strict)

import { randomUUID } from 'node:crypto';
import type { Candle, Side, Signal } from '../types.js';
import { readStructure } from './structure.js';

export type Tf = '15m' | '1h' | '4h' | '1d';

export interface HtfTravelSnapshot {
  m1: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

export interface HtfTravelOptions {
  lineTf?: Tf; // which timeframe's structure sets the green/red lines (default '4h')
  ctxTf?: Tf | 'off'; // context timeframe that must not oppose (default '1d')
  ctxStrict?: boolean; // context must AGREE, not just "not oppose"
  swingLookback?: number; // fractal width
  entryTolPct?: number; // how close price must sit to the line, % of price
  stopPastPct?: number; // stop this far past the line, % of the line price
  minRangePct?: number; // skip if (red-green)/green*100 is below this
  maxRangePct?: number; // …or above this (structure gone stale)
  reactionCandle?: boolean; // require a reaction candle on the 1m entry bar
}

function series(snap: HtfTravelSnapshot, tf: Tf): Candle[] {
  return tf === '1d' ? snap.d1 : tf === '4h' ? snap.h4 : tf === '1h' ? snap.h1 : snap.m15;
}

export function generateHtfTravelSignal(
  snap: HtfTravelSnapshot,
  symbol: string,
  opts: HtfTravelOptions = {},
): Signal | null {
  const lookback = opts.swingLookback ?? 2;
  const entryTol = opts.entryTolPct ?? 0.5;
  const stopPast = opts.stopPastPct ?? 0.5;
  const minRange = opts.minRangePct ?? 1.2;
  const maxRange = opts.maxRangePct ?? 12;
  const ctxTf = opts.ctxTf ?? '1d';

  const structTf = series(snap, opts.lineTf ?? '4h');
  if (structTf.length < lookback * 2 + 4) return null;

  const s = readStructure(structTf, lookback);
  if (!s.lastSwingHigh || !s.lastSwingLow) return null;
  const green = s.lastSwingLow.price;
  const red = s.lastSwingHigh.price;
  if (red <= green) return null;

  const rangePct = ((red - green) / green) * 100;
  if (rangePct < minRange || rangePct > maxRange) return null;

  const bull = s.trend === 'bullish';
  const bear = s.trend === 'bearish';
  const px = snap.m1.at(-1)!.close;

  const ctxTrend =
    ctxTf === 'off' ? 'ranging' : readStructure(series(snap, ctxTf), lookback).trend;
  const ctxOkLong = ctxTf === 'off' || (opts.ctxStrict ? ctxTrend === 'bullish' : ctxTrend !== 'bearish');
  const ctxOkShort = ctxTf === 'off' || (opts.ctxStrict ? ctxTrend === 'bearish' : ctxTrend !== 'bullish');

  let side: Side | null = null;
  if (bull && px >= green && ((px - green) / px) * 100 <= entryTol && ctxOkLong) side = 'long';
  else if (bear && px <= red && ((red - px) / px) * 100 <= entryTol && ctxOkShort) side = 'short';
  if (!side) return null;

  if (opts.reactionCandle) {
    const c = snap.m1.at(-1)!;
    const p = snap.m1.at(-2);
    const react =
      side === 'long'
        ? c.close > c.open && (!p || c.close > p.close)
        : c.close < c.open && (!p || c.close < p.close);
    if (!react) return null;
  }

  const stopLoss = side === 'long' ? green * (1 - stopPast / 100) : red * (1 + stopPast / 100);
  const takeProfit = side === 'long' ? red : green;
  const risk = Math.abs(px - stopLoss);
  const reward = Math.abs(takeProfit - px);
  if (risk <= 0 || reward <= 0) return null;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol,
    side,
    entry: round(px),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(reward / risk, 2),
    confluence: 70 + (opts.reactionCandle ? 10 : 0) + (opts.ctxStrict ? 10 : 0),
    source: 'engine',
    reasons: [
      `HTF-TRAVEL: ${opts.lineTf ?? '4h'} ${side === 'long' ? 'green line (HL)' : 'red line (LH)'} @ ${(side === 'long' ? green : red).toFixed(2)} (range ${rangePct.toFixed(1)}%)`,
      `TARGET: opposite line @ ${takeProfit.toFixed(2)}`,
    ],
    sweptLevel: round(side === 'long' ? green : red),
    nearTarget: round(takeProfit),
    drawTarget: round(takeProfit),
    drawTimeframe: '15M',
  };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
