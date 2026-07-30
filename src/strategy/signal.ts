// The Sniper Entry System: assembles a trade Signal by walking the core
// philosophy in order — Bias > Context > Liquidity > Market Structure >
// Timing > Execution. Each stage must agree or the setup is rejected.

import { randomUUID } from 'node:crypto';
import type { Candle, Signal, Side } from '../types.js';
import { buildBias } from './bias.js';
import { readStructure } from './structure.js';
import { buildLiquidity, detectSweep } from './liquidity.js';
import { latestUnmitigatedFVG, premiumDiscount } from './fvg.js';
import { readVwap } from './vwap.js';
import { analyzeCandle } from './candles.js';

/** Multi-timeframe input. Any series may be omitted; the engine degrades gracefully. */
export interface MarketSnapshot {
  symbol: string;
  h4: Candle[]; // bias
  h1: Candle[]; // confirmation / context
  m15: Candle[]; // setup
  m1: Candle[]; // entry / timing
}

const WEIGHTS = {
  bias: 25,
  context: 15,
  liquidity: 20,
  structure: 20,
  timing: 12,
  vwap: 8,
} as const;

export function generateSignal(snap: MarketSnapshot): Signal | null {
  const reasons: string[] = [];
  let confluence = 0;

  const setup = snap.m15.length ? snap.m15 : snap.h1;
  const entryTf = snap.m1.length ? snap.m1 : setup;
  if (setup.length < 10 || entryTf.length < 3) return null;

  // 1. BIAS (4H) --------------------------------------------------------------
  const bias = buildBias(snap.h4.length ? snap.h4 : snap.h1.length ? snap.h1 : setup);
  if (bias.direction === 'neutral') return null;
  const side: Side = bias.direction;
  confluence += WEIGHTS.bias;
  reasons.push(`BIAS: ${side.toUpperCase()} — ${bias.reasons.join('; ')}`);

  // 2. CONTEXT (1H) — confirmation must not oppose the bias --------------------
  const ctx = readStructure(snap.h1.length ? snap.h1 : setup);
  const ctxAligned =
    (side === 'long' && ctx.trend !== 'bearish') || (side === 'short' && ctx.trend !== 'bullish');
  if (!ctxAligned) {
    return null; // conflicting timeframes — stand aside
  }
  if ((side === 'long' && ctx.trend === 'bullish') || (side === 'short' && ctx.trend === 'bearish')) {
    confluence += WEIGHTS.context;
    reasons.push(`CONTEXT: 1H aligned (${ctx.label})`);
  } else {
    reasons.push('CONTEXT: 1H neutral, not opposing');
  }

  // 3. LIQUIDITY — require a sweep or key-level interaction in our favor -------
  const liq = buildLiquidity(setup);
  const sweep = detectSweep(setup, liq);
  const swept = sweep.swept;
  const favorableSweep =
    (side === 'long' && swept === 'sell-side') || (side === 'short' && swept === 'buy-side');
  if (favorableSweep) {
    confluence += WEIGHTS.liquidity;
    reasons.push(`LIQUIDITY: ${swept} swept @ ${sweep.level?.toFixed(2)} then rejected`);
  } else {
    const pd = premiumDiscount(setup);
    const atDiscountForLong = side === 'long' && pd.zone === 'discount';
    const atPremiumForShort = side === 'short' && pd.zone === 'premium';
    if (atDiscountForLong || atPremiumForShort) {
      confluence += WEIGHTS.liquidity * 0.5;
      reasons.push(`LIQUIDITY: entering from ${pd.zone} (no sweep yet)`);
    } else {
      reasons.push('LIQUIDITY: no favorable sweep / poor pricing');
    }
  }

  // 4. MARKET STRUCTURE — CHoCH/BOS shift in bias direction --------------------
  const struct = readStructure(setup);
  const structAligned =
    (side === 'long' && (struct.trend === 'bullish' || struct.choch)) ||
    (side === 'short' && (struct.trend === 'bearish' || struct.choch));
  if (structAligned) {
    confluence += WEIGHTS.structure;
    reasons.push(`STRUCTURE: ${struct.label}`);
  } else {
    reasons.push(`STRUCTURE: not confirmed (${struct.label})`);
  }

  // 5. TIMING — FVG entry window + candle confirmation ------------------------
  const fvg = latestUnmitigatedFVG(entryTf, side);
  const lastCandle = analyzeCandle(entryTf.at(-1)!);
  const candleConfirms =
    (side === 'long' && (lastCandle.bullish || lastCandle.rejection === 'bottom')) ||
    (side === 'short' && (lastCandle.bearish || lastCandle.rejection === 'top'));
  if (fvg) {
    confluence += WEIGHTS.timing;
    reasons.push(`TIMING: unmitigated ${side} FVG ${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)}`);
  }
  if (candleConfirms) {
    reasons.push(`TIMING: entry candle confirms (${lastCandle.strength})`);
  }

  // 6. VWAP confirmation ------------------------------------------------------
  const vwap = readVwap(entryTf);
  const vwapAgrees =
    (side === 'long' && vwap.signal.includes('long')) ||
    (side === 'short' && vwap.signal.includes('short'));
  if (vwapAgrees) {
    confluence += WEIGHTS.vwap;
    reasons.push(`VWAP: ${vwap.signal}`);
  }

  // 7. EXECUTION — price, stop, target ---------------------------------------
  const price = entryTf.at(-1)!.close;
  const entry = fvg ? (fvg.top + fvg.bottom) / 2 : price;

  const stopLoss = computeStop(side, entry, setup, sweep.level);
  const takeProfit = computeTarget(side, entry, liq, struct);
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;
  const riskReward = reward / risk;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol: snap.symbol,
    side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(riskReward, 2),
    confluence: Math.round(confluence),
    source: 'engine',
    reasons,
  };
}

function computeStop(side: Side, entry: number, setup: Candle[], sweptLevel: number | null): number {
  const window = setup.slice(-10);
  const swingLow = Math.min(...window.map((c) => c.low));
  const swingHigh = Math.max(...window.map((c) => c.high));
  const buffer = entry * 0.0015; // small buffer beyond the wick
  if (side === 'long') {
    const base = sweptLevel != null ? Math.min(sweptLevel, swingLow) : swingLow;
    return base - buffer;
  }
  const base = sweptLevel != null ? Math.max(sweptLevel, swingHigh) : swingHigh;
  return base + buffer;
}

function computeTarget(
  side: Side,
  entry: number,
  liq: ReturnType<typeof buildLiquidity>,
  struct: ReturnType<typeof readStructure>,
): number {
  if (side === 'long') {
    const targets = [liq.pdh, liq.pwh, struct.lastSwingHigh?.price, ...liq.equalHighs]
      .filter((v): v is number => v != null && v > entry)
      .sort((a, b) => a - b);
    return targets[0] ?? entry * 1.01;
  }
  const targets = [liq.pdl, liq.pwl, struct.lastSwingLow?.price, ...liq.equalLows]
    .filter((v): v is number => v != null && v < entry)
    .sort((a, b) => b - a);
  return targets[0] ?? entry * 0.99;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
