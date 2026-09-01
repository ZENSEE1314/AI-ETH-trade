// Liquidity flip: the trend-channel envelope changes color (red→green = down→up,
// green→red = up→down) right at a swept equal-high/equal-low pool — the exact
// read in the reference screenshot (Zeiierman trend channel + EQH/EQL liquidity
// on the 1m, HH/LH/CHoCH structure on the 1H). A flip on its own is noise; a
// flip that lands on freshly-swept resting liquidity is the high-probability
// version — the sweep trapped the crowd on the wrong side just as the channel
// turned.

import { randomUUID } from 'node:crypto';
import type { Candle, Side, Signal } from '../types.js';
import { readTrendChannel, type TrendChannel } from './trendChannel.js';
import { equalLevels } from './liquidity.js';
import { buildLiquidityMap } from './liquidityMap.js';

export interface LiquidityFlip {
  side: Side; // 'long' on a down→up (red→green) flip, 'short' on up→down (green→red)
  sweptLevel: number; // the EQL (long) / EQH (short) pool swept into the flip
  channel: TrendChannel; // the channel state at the flip bar
}

export interface LiquidityFlipOptions {
  length?: number; // regression channel window (bars)
  mult?: number; // channel wall width, residual-std multiples
  lookback?: number; // how many recent bars count as "just flipped"
  sweepTolerancePct?: number; // how close a wick must come to the pool to count as swept
}

/**
 * Walk the channel direction backward bar-by-bar over `lookback` bars to find
 * a genuine flip (down→up or up→down, ignoring 'flat' noise in between), then
 * require the flip side's opposing equal-level pool to have been swept in that
 * same window. Returns null when there's no flip or no confirming sweep.
 */
export function detectLiquidityFlip(candles: Candle[], opts: LiquidityFlipOptions = {}): LiquidityFlip | null {
  const length = opts.length ?? 50;
  const mult = opts.mult ?? 2;
  // The channel direction passes through several 'flat' bars while it turns
  // (confirmed: ~5-25 bars on real data), so the walk-back window has to span
  // that whole transition zone, not just the last couple of bars.
  const lookback = opts.lookback ?? 40;
  const tolPct = opts.sweepTolerancePct ?? 0.15;

  if (candles.length < length + lookback + 2) return null;

  const cur = readTrendChannel(candles, length, mult);
  if (!cur || cur.direction === 'flat') return null;

  // Direction at each prior bar, walking back from just before the current one,
  // stopping as soon as we find a non-flat direction different from `cur` (the
  // flip origin) or the same as `cur` (no flip within the window — bail).
  let from: TrendChannel['direction'] | null = null;
  for (let k = 1; k <= lookback; k++) {
    const end = candles.length - k;
    if (end < length) break;
    const chan = readTrendChannel(candles.slice(0, end), length, mult);
    if (!chan || chan.direction === 'flat') continue;
    from = chan.direction;
    break;
  }
  if (!from || from === cur.direction) return null;

  const side: Side | null = from === 'down' && cur.direction === 'up' ? 'long'
    : from === 'up' && cur.direction === 'down' ? 'short'
    : null;
  if (!side) return null;

  // Confirming sweep: the opposing equal-level pool (EQL for a long, EQH for a
  // short) must have been pierced within the flip window.
  const { highs, lows } = equalLevels(candles.slice(-Math.max(length * 2, 100)), 0.1);
  const pools = side === 'long' ? lows : highs;
  if (pools.length === 0) return null;

  const window = candles.slice(-(lookback + 2));
  let sweptLevel: number | null = null;
  for (const level of pools) {
    const swept = window.some((c) =>
      side === 'long' ? c.low <= level * (1 + tolPct / 100) : c.high >= level * (1 - tolPct / 100),
    );
    if (swept) {
      // nearest-to-price pool wins when more than one pool was swept
      if (sweptLevel == null || Math.abs(level - cur.price) < Math.abs(sweptLevel - cur.price)) {
        sweptLevel = level;
      }
    }
  }
  if (sweptLevel == null) return null;

  return { side, sweptLevel: round(sweptLevel), channel: cur };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface FlipSignalOptions extends LiquidityFlipOptions {
  /** 'near' targets the nearest opposing 1H pool; 'draw' targets the furthest. Default 'near'. */
  targetMode?: 'near' | 'draw';
}

/**
 * Turn a detected liquidity flip into a full trade Signal: entry at the flip
 * bar's close, stop just past the swept pool (the sweep extreme — noise below
 * a real reclaim shouldn't stop it out), target the nearest (or furthest)
 * opposing hourly liquidity pool, mirroring the engine's other draw-based
 * signals so it can run through the same backtester.
 */
export function generateFlipSignal(
  entryTf: Candle[],
  h1: Candle[],
  symbol: string,
  opts: FlipSignalOptions = {},
): Signal | null {
  const flip = detectLiquidityFlip(entryTf, opts);
  if (!flip) return null;

  const entry = entryTf.at(-1)!.close;
  const buffer = entry * 0.0015;
  const stopLoss = flip.side === 'long' ? flip.sweptLevel - buffer : flip.sweptLevel + buffer;

  const map = buildLiquidityMap(h1.length ? h1 : entryTf);
  const pools = flip.side === 'long' ? map.buySide : map.sellSide;
  const targetMode = opts.targetMode ?? 'near';
  const pool = targetMode === 'near' ? pools[0] : pools.at(-1);
  const takeProfit = pool?.price ?? (flip.side === 'long' ? entry * 1.01 : entry * 0.99);

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol,
    side: flip.side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(reward / risk, 2),
    confluence: Math.round(50 + Math.min(flip.channel.width, 50)), // flip + confirmed sweep = fixed base confidence
    source: 'engine',
    reasons: [
      `FLIP: channel turned ${flip.channel.direction} (slope ${flip.channel.slopePct.toFixed(3)}%/bar)`,
      `FLIP: swept ${flip.side === 'long' ? 'EQL' : 'EQH'} @ ${flip.sweptLevel.toFixed(2)}`,
    ],
    sweepSide: flip.side === 'long' ? 'sell-side' : 'buy-side',
    sweptLevel: round(flip.sweptLevel),
    drawTarget: pools.at(-1)?.price != null ? round(pools.at(-1)!.price) : undefined,
    nearTarget: pools[0]?.price != null ? round(pools[0]!.price) : undefined,
    drawTimeframe: '15M',
  };
}
