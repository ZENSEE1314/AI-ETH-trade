// Channel-band reversal: buy the LL right where it taps the lower wall of the
// regression channel (the "green line" in the reference charts) while also
// sitting near the VWAP's lower band, target the most recent HH as price runs
// back up to the channel's upper wall. Mirror for a short at the HH/upper band.
//
// This is a band-to-band mean-reversion read, distinct from the trend-channel
// FILTER/TARGET modes in signal.ts (which trade WITH the slope) and from the
// liquidity-flip module (which trades a color flip). Here the entry is the
// swing extreme touching its own channel wall — no flip or sweep required,
// just price at the edge of its own regression envelope.

import type { Candle, Side, Signal } from '../types.js';
import { randomUUID } from 'node:crypto';
import { readTrendChannel, type TrendChannel } from './trendChannel.js';
import { findSwings } from './structure.js';
import { readVwap } from './vwap.js';
import { analyzeCandle } from './candles.js';

export interface ChannelReversal {
  side: Side; // 'long' off the LL at the lower band, 'short' off the HH at the upper band
  swingPrice: number; // the LL (long) / HH (short) price
  channel: TrendChannel;
}

export interface ChannelReversalOptions {
  length?: number; // regression channel window (bars)
  mult?: number; // channel wall width, residual-std multiples
  swingLookback?: number; // fractal width for the LL/HH swing
  bandTolerancePct?: number; // how close the swing must be to the channel wall, % of price
  requireVwapBand?: boolean; // also require price near/outside the VWAP band (default true)
  vwapTolerancePct?: number; // "near the VWAP band" tolerance, % of price
}

/**
 * Detect a fresh swing low tagging the lower channel wall (long) or a fresh
 * swing high tagging the upper wall (short), on the most recent candle only —
 * this is meant to fire right at the touch, not any time in the past.
 */
export function detectChannelReversal(candles: Candle[], opts: ChannelReversalOptions = {}): ChannelReversal | null {
  const length = opts.length ?? 50;
  const mult = opts.mult ?? 2;
  const swingLookback = opts.swingLookback ?? 2;
  const bandTolPct = opts.bandTolerancePct ?? 0.15;
  const requireVwap = opts.requireVwapBand ?? true;
  const vwapTolPct = opts.vwapTolerancePct ?? 0.15;

  if (candles.length < length + swingLookback * 2 + 2) return null;

  const chan = readTrendChannel(candles, length, mult);
  if (!chan) return null;

  const swings = findSwings(candles, swingLookback);
  const lastSwing = swings.at(-1);
  if (!lastSwing) return null;
  // Only fire while the swing is still fresh — within a few bars of the tip
  // (findSwings needs `swingLookback` bars of confirmation after the pivot).
  if (candles.length - 1 - lastSwing.index > swingLookback + 2) return null;

  const price = lastSwing.price;
  const near = (level: number) => Math.abs(price - level) / price * 100 <= bandTolPct;

  let side: Side | null = null;
  if (lastSwing.kind === 'low' && near(chan.lower)) side = 'long';
  else if (lastSwing.kind === 'high' && near(chan.upper)) side = 'short';
  if (!side) return null;

  if (requireVwap) {
    const v = readVwap(candles);
    const px = candles.at(-1)!.close;
    const nearBand = side === 'long'
      ? Math.abs(px - v.state.lower) / px * 100 <= vwapTolPct || px <= v.state.lower
      : Math.abs(px - v.state.upper) / px * 100 <= vwapTolPct || px >= v.state.upper;
    if (!nearBand) return null;
  }

  return { side, swingPrice: round(price), channel: chan };
}

export interface ChannelReversalSignalOptions extends ChannelReversalOptions {
  /** 'opposite-swing' targets the most recent opposing HH/LL (default); 'channel'
   *  targets the opposite channel wall directly. */
  targetMode?: 'opposite-swing' | 'channel';
}

/**
 * Turn a detected channel-band reversal into a full trade Signal: entry at the
 * touch bar's close, stop just past the swing extreme (tight — that's the
 * whole premise of trading the band touch), target the opposing swing high/low
 * or the opposite channel wall.
 */
export function generateChannelReversalSignal(
  candles: Candle[],
  symbol: string,
  opts: ChannelReversalSignalOptions = {},
): Signal | null {
  const rev = detectChannelReversal(candles, opts);
  if (!rev) return null;

  const entry = candles.at(-1)!.close;
  const buffer = entry * 0.0015;
  // Guard against a near-zero-risk stop: the swing extreme and the current
  // close can end up almost coincident in a tight consolidation, so anchor the
  // buffer off whichever of swingPrice/entry is more adverse — this guarantees
  // at least `buffer` of real risk regardless of how close the swing sits to
  // the current price (a near-zero risk denominator otherwise blows the R
  // multiple up to absurd values once trading costs are applied).
  const stopLoss = rev.side === 'long'
    ? Math.min(rev.swingPrice, entry) - buffer
    : Math.max(rev.swingPrice, entry) + buffer;

  const targetMode = opts.targetMode ?? 'opposite-swing';
  let takeProfit: number;
  if (targetMode === 'channel') {
    takeProfit = rev.side === 'long' ? rev.channel.upper : rev.channel.lower;
  } else {
    const swings = findSwings(candles, opts.swingLookback ?? 2);
    const wanted = rev.side === 'long' ? 'high' : 'low';
    const opposing = swings.filter((s) => s.kind === wanted).at(-1);
    takeProfit = opposing?.price ?? (rev.side === 'long' ? rev.channel.upper : rev.channel.lower);
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;

  const lastCandle = analyzeCandle(candles.at(-1)!);
  const confluence =
    50 +
    (rev.side === 'long' && (lastCandle.bullish || lastCandle.rejection === 'bottom') ? 10 : 0) +
    (rev.side === 'short' && (lastCandle.bearish || lastCandle.rejection === 'top') ? 10 : 0);

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol,
    side: rev.side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(reward / risk, 2),
    confluence: Math.round(confluence),
    source: 'engine',
    reasons: [
      `REVERSAL: ${rev.side === 'long' ? 'LL' : 'HH'} @ ${rev.swingPrice.toFixed(2)} tags ${rev.side === 'long' ? 'lower' : 'upper'} channel wall`,
      `TARGET: ${targetMode === 'channel' ? 'opposite channel wall' : 'opposing swing'} @ ${takeProfit.toFixed(2)}`,
    ],
    sweptLevel: round(rev.swingPrice),
    drawTarget: round(takeProfit),
    nearTarget: round(takeProfit),
    drawTimeframe: '15M',
  };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
