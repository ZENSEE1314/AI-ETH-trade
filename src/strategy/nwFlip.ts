// NW-band FLIP (breakout) — the tradable edge validated in backtest.
//
// Rule: on a CLOSED bar, a candle that closes fully OUTSIDE the causal
// Nadaraya-Watson envelope in its own direction is a momentum breakout —
//   green close ABOVE the upper (red) band  -> LONG
//   red   close BELOW the lower (blue) band  -> SHORT
// ridden with a trailing stop at the prior `trailLen`-bar extreme, capped by a
// hard `stopPct` from entry. This is the FLIP of the band-fade: the fade (buy
// blue → sell red) lost on 15m/1h/4h in backtest (PF < 1 everywhere); the flip
// is net-positive on 1h (+53%, PF 1.5) and 4h (+32%, PF 1.8). 15m loses either
// way, so it is intentionally not in the default timeframe set.
//
// The band math (h=8, mult=3, causal/non-repainting) matches nwBandRsi.ts.

import type { Candle, Side } from '../types.js';

const H = 8;
const MULT = 3;
const MAE_LEN = 100;

/** Endpoint (causal) Nadaraya-Watson estimate — bar i uses only bars <= i. */
function nwCausal(closes: number[]): number[] {
  const out = new Array(closes.length).fill(0);
  const span = Math.ceil(H * 3);
  for (let i = 0; i < closes.length; i++) {
    let num = 0;
    let den = 0;
    for (let j = Math.max(0, i - span); j <= i; j++) {
      const w = Math.exp(-((i - j) ** 2) / (2 * H * H));
      num += closes[j] * w;
      den += w;
    }
    out[i] = num / den;
  }
  return out;
}

export interface NwFlipConfig {
  trailLen: number; // bars in the trailing-stop lookback (default 10)
  stopPct: number; // hard max-loss % from entry (default 3)
}

export const DEFAULT_NWFLIP: NwFlipConfig = { trailLen: 10, stopPct: 3 };

export interface NwFlipSignal {
  side: Side;
  entry: number; // the breakout bar's close
  stopLoss: number; // initial stop = tighter of trail extreme / hard cap
  hardStop: number; // fixed stopPct-from-entry floor the trail never loosens past
  band: number; // the band edge that was broken (for the reason string)
  barTime: number; // the closed breakout bar's open time (for fresh-bar dedup)
}

/**
 * Detect a fresh NW-flip breakout on the LAST bar of `closedBars` (which must
 * already have the still-forming bar dropped by the caller). Returns null when
 * the last bar does not close outside the band in its own direction, or when
 * there is not enough history to form the band.
 */
export function detectNwFlip(closedBars: Candle[], cfg: NwFlipConfig = DEFAULT_NWFLIP): NwFlipSignal | null {
  if (closedBars.length < MAE_LEN + cfg.trailLen + 5) return null;
  const cl = closedBars.map((b) => b.close);
  const nw = nwCausal(cl);
  const i = closedBars.length - 1;
  const s = Math.max(0, i - MAE_LEN + 1);
  let mae = 0;
  for (let j = s; j <= i; j++) mae += Math.abs(cl[j] - nw[j]);
  mae /= i - s + 1;
  const upper = nw[i] + MULT * mae;
  const lower = nw[i] - MULT * mae;

  const bar = closedBars[i];
  const isGreen = bar.close > bar.open;
  const isRed = bar.close < bar.open;
  let side: Side | null = null;
  if (bar.close > upper && isGreen) side = 'long';
  else if (bar.close < lower && isRed) side = 'short';
  if (!side) return null;

  const entry = bar.close;
  const hardStop = side === 'long' ? entry * (1 - cfg.stopPct / 100) : entry * (1 + cfg.stopPct / 100);
  const trail = trailExtreme(closedBars, side, cfg.trailLen);
  const stopLoss = side === 'long' ? Math.max(trail, hardStop) : Math.min(trail, hardStop);
  return { side, entry, stopLoss, hardStop, band: side === 'long' ? upper : lower, barTime: bar.time };
}

/** Prior `trailLen`-bar extreme (low for a long, high for a short) — the trailing stop. */
export function trailExtreme(closedBars: Candle[], side: Side, trailLen: number): number {
  const i = closedBars.length - 1;
  if (side === 'long') {
    let m = Infinity;
    for (let j = i - trailLen; j < i; j++) m = Math.min(m, closedBars[j].low);
    return m;
  }
  let m = -Infinity;
  for (let j = i - trailLen; j < i; j++) m = Math.max(m, closedBars[j].high);
  return m;
}

/** Parse a comma-separated UTC-hour whitelist ("12,13,14,15,16"). Empty = all hours. */
export function parseHours(raw: string): number[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
    ),
  );
}

/** True when the breakout bar's UTC hour is in the whitelist (empty list = always allowed). */
export function nwHourAllowed(barTimeMs: number, allowedHours: number[]): boolean {
  if (!allowedHours.length) return true;
  return allowedHours.includes(new Date(barTimeMs).getUTCHours());
}
