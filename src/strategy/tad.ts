// TAD system — Turtle + Atom + Duck (Fred Tam / 10percentaday), reconstructed
// from public descriptions and validated in src/backtest/runTadMatrix.ts.
//
//   TURTLE  Donchian: close breaks the prior 20-bar high (long) / low (short).
//   ATOM    Bollinger Bands (20, 1.0σ): close beyond the band in the break dir.
//   DUCK    EMA 50: long only above it, short only below it.
//   VOLUME  the breakout bar's volume > SMA(volume, 20).
//
// Exit is managed by the engine: the stop trails the opposite 10-bar Donchian
// channel, never past a hard 5% from entry (whichever is hit first).
//
// Backtest verdict (9y BTC/ETH daily, long-only, ~1x account exposure):
// $1000 → ~$18-24k, ~40% CAGR, 35-50% drawdowns. Shorting is weak — only
// BTC/ETH get it; BNB is long-only. Edge collapses below 4h; 1h is marginal.

import type { Candle, Side } from '../types.js';

export interface TadOptions {
  donEntry: number; // Turtle breakout lookback
  donExit: number; // trailing-stop channel lookback
  bbLen: number;
  bbSd: number;
  emaLen: number;
  volLen: number;
  hardStopPct: number; // max loss from entry, % (the 5% cap)
  marginPct: number; // % of equity committed as margin per trade
  leverage: number;
}

export const DEFAULT_TAD: TadOptions = {
  donEntry: 20,
  donExit: 10,
  bbLen: 20,
  bbSd: 1.0,
  emaLen: 50,
  volLen: 20,
  hardStopPct: 5,
  marginPct: 10,
  leverage: 10,
};

/** Priority order — the first timeframe with a fresh signal takes the trade. */
export const TAD_TIMEFRAMES = ['1d', '4h', '2h', '1h'] as const;
export type TadTimeframe = (typeof TAD_TIMEFRAMES)[number];

export interface TadSignal {
  side: Side;
  entry: number;
  stopLoss: number; // engine-ready: closer of (10-bar Donchian, hard 5%)
  donTrail: number; // the raw 10-bar Donchian stop (for the engine's trail)
  hardStop: number; // the fixed 5%-from-entry floor/ceil
}

function emaSeries(vals: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
const meanOf = (v: number[], a: number, b: number) => {
  let s = 0;
  for (let j = a; j <= b; j++) s += v[j];
  return s / (b - a + 1);
};
const stdevOf = (v: number[], a: number, b: number, m: number) => {
  let s = 0;
  for (let j = a; j <= b; j++) s += (v[j] - m) ** 2;
  return Math.sqrt(s / (b - a + 1));
};
const highestHigh = (c: Candle[], a: number, b: number) => {
  let m = -Infinity;
  for (let j = a; j <= b; j++) m = Math.max(m, c[j].high);
  return m;
};
const lowestLow = (c: Candle[], a: number, b: number) => {
  let m = Infinity;
  for (let j = a; j <= b; j++) m = Math.min(m, c[j].low);
  return m;
};

/** The 10-bar Donchian trailing stop for an open position, given fresh closed bars. */
export function tadTrailStop(closed: Candle[], side: Side, donExit = DEFAULT_TAD.donExit): number {
  const i = closed.length - 1;
  if (i < donExit) return side === 'long' ? -Infinity : Infinity;
  return side === 'long' ? lowestLow(closed, i - donExit + 1, i) : highestHigh(closed, i - donExit + 1, i);
}

/**
 * Evaluate the last CLOSED bar for a fresh TAD entry. `closed` must exclude the
 * in-progress bar. Returns null unless every component aligns AND the prior bar
 * did NOT (so this is a breakout event, not a "still extended" state).
 */
export function detectTadSignal(
  closed: Candle[],
  opts: { allowLong: boolean; allowShort: boolean },
  cfg: TadOptions = DEFAULT_TAD,
): TadSignal | null {
  const need = Math.max(cfg.donEntry, cfg.emaLen, cfg.bbLen, cfg.volLen) + 2;
  if (closed.length < need) return null;

  const i = closed.length - 1;
  const closes = closed.map((c) => c.close);
  const vols = closed.map((c) => c.volume || 0);
  const ema = emaSeries(closes, cfg.emaLen);

  const breakoutLong = (idx: number): boolean => {
    const donHi = highestHigh(closed, idx - cfg.donEntry, idx - 1);
    const mid = meanOf(closes, idx - cfg.bbLen + 1, idx);
    const bbUp = mid + cfg.bbSd * stdevOf(closes, idx - cfg.bbLen + 1, idx, mid);
    return closes[idx] > donHi && closes[idx] > bbUp && closes[idx] > ema[idx];
  };
  const breakoutShort = (idx: number): boolean => {
    const donLo = lowestLow(closed, idx - cfg.donEntry, idx - 1);
    const mid = meanOf(closes, idx - cfg.bbLen + 1, idx);
    const bbDn = mid - cfg.bbSd * stdevOf(closes, idx - cfg.bbLen + 1, idx, mid);
    return closes[idx] < donLo && closes[idx] < bbDn && closes[idx] < ema[idx];
  };

  const volOk = vols[i] > meanOf(vols, i - cfg.volLen + 1, i);
  if (!volOk) return null;

  let side: Side | null = null;
  if (opts.allowLong && breakoutLong(i) && !breakoutLong(i - 1)) side = 'long';
  else if (opts.allowShort && breakoutShort(i) && !breakoutShort(i - 1)) side = 'short';
  if (!side) return null;

  const entry = closes[i];
  const donTrail =
    side === 'long' ? lowestLow(closed, i - cfg.donExit + 1, i) : highestHigh(closed, i - cfg.donExit + 1, i);
  const hardStop = side === 'long' ? entry * (1 - cfg.hardStopPct / 100) : entry * (1 + cfg.hardStopPct / 100);
  // engine stop = whichever is hit FIRST = the one closer to entry
  const stopLoss = side === 'long' ? Math.max(donTrail, hardStop) : Math.min(donTrail, hardStop);

  return { side, entry, stopLoss, donTrail, hardStop };
}

/** Parse `TAD_SYMBOLS=BTCUSDT:ls,ETHUSDT:ls,BNBUSDT:l` → direction map. */
export function parseTadSymbols(raw: string): { symbol: string; allowLong: boolean; allowShort: boolean }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [symRaw, dirRaw = 'l'] = entry.split(':');
      const dir = dirRaw.toLowerCase();
      return {
        symbol: symRaw.trim().toUpperCase(),
        allowLong: dir.includes('l'),
        allowShort: dir.includes('s'),
      };
    })
    .filter((s) => s.symbol && (s.allowLong || s.allowShort));
}
