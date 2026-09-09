// Live strategy: LONG-ONLY VWAP outer-band + RSI-cross mean reversion.
//
// Runs on CLOSED 4H bars. Rolling-50-bar VWAP with ±2σ bands.
//   1. price tags the LOWER band  → arm
//   2. within `armBars`, RSI(14) crosses UP through 30, price still < VWAP → LONG
//   3. stop 1% below entry · TP1 = VWAP (BE trail) · TP2 = VWAP + 1.5σ
//
// The backtest that motivated this is in src/backtest/vwapBandRsi.ts +
// runVwapSweep.ts. Best params there: SL 1%, TP2 1.5σ, ~5–12x leverage.
// It is a bull-market edge on BTC/BNB; ETH is marginal. Paper-first.

import { randomUUID } from 'node:crypto';
import type { Candle, Signal } from '../types.js';
import type { MarketSnapshot } from './signal.js';
import { rsiSeries } from '../backtest/vwapBandRsi.js';
import { logger } from '../logger.js';

export interface VwapBandRsiLiveOptions {
  bandMult: number;
  rollingLen: number;
  rsiPeriod: number;
  rsiLong: number; // long when RSI crosses UP through this
  armBars: number;
  stopPct: number; // stop this % below entry
  tp2Sigma: number; // TP2 = VWAP + this many σ
  minBandWidthPct: number;
  marginPct: number; // commit this % of equity as margin per trade (0 = use runtime)
  leverage: number; // leverage for this strategy's trades (0 = use runtime)
}

export const DEFAULT_VBR: VwapBandRsiLiveOptions = {
  bandMult: 2,
  rollingLen: 50,
  rsiPeriod: 14,
  rsiLong: 30,
  armBars: 6,
  stopPct: 1,
  tp2Sigma: 1.5,
  minBandWidthPct: 0.8,
  marginPct: 95, // band-fade runs fixed-margin (the "new rule")
  leverage: 12,
};

function rollingVwap(bars: Candle[], len: number, mult: number) {
  const n = bars.length;
  const s = Math.max(0, n - len);
  let pv = 0;
  let v = 0;
  let p2v = 0;
  for (let i = s; i < n; i++) {
    const typ = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const vol = bars[i].volume || 1;
    pv += typ * vol;
    v += vol;
    p2v += typ * typ * vol;
  }
  const vwap = pv / v;
  const sd = Math.sqrt(Math.max(0, p2v / v - vwap * vwap));
  return { vwap, sd, upper: vwap + mult * sd, lower: vwap - mult * sd };
}

export class VwapBandRsiStrategy {
  private opts: VwapBandRsiLiveOptions;
  private armedAtBarTime: number | null = null;
  private lastBarTime = 0;

  constructor(opts: Partial<VwapBandRsiLiveOptions> = {}) {
    this.opts = { ...DEFAULT_VBR, ...opts };
  }

  get armed(): boolean {
    return this.armedAtBarTime !== null;
  }

  /** Evaluate on the latest CLOSED 4H bar. Returns a Signal only on a fresh
   *  long trigger; null otherwise (including while merely armed). */
  evaluate(snap: MarketSnapshot): Signal | null {
    const o = this.opts;
    const closed = snap.h4.slice(0, -1); // drop the forming bar
    if (closed.length < o.rollingLen + o.rsiPeriod + 4) return null;

    const bar = closed.at(-1)!;
    if (bar.time === this.lastBarTime) return null; // already handled this bar
    this.lastBarTime = bar.time;

    const band = rollingVwap(closed, o.rollingLen, o.bandMult);
    const widthPct = ((band.upper - band.lower) / band.vwap) * 100;
    if (band.sd === 0 || widthPct < o.minBandWidthPct) {
      this.armedAtBarTime = null;
      return null;
    }

    const rsi = rsiSeries(closed.map((c) => c.close), o.rsiPeriod);
    const r = rsi.at(-1);
    const rPrev = rsi.at(-2);
    if (r == null || rPrev == null) return null;

    // ---- not armed: look for a lower-band tag -------------------------------
    if (this.armedAtBarTime === null) {
      if (bar.low <= band.lower) {
        this.armedAtBarTime = bar.time;
        logger.info(`VBR armed: ${snap.symbol} 4H tagged lower band ${band.lower.toFixed(2)} (RSI ${r.toFixed(0)})`);
      }
      return null;
    }

    // ---- armed: wait for the RSI cross ------------------------------------
    const barsSinceArm = closed.filter((c) => c.time > this.armedAtBarTime!).length;
    const backToMean = bar.close > band.vwap;
    if (barsSinceArm > o.armBars || backToMean) {
      this.armedAtBarTime = null;
      return null;
    }

    const rsiCrossUp = rPrev <= o.rsiLong && r > o.rsiLong;
    if (!rsiCrossUp) return null;

    // ---- trigger: build the long signal ----------------------------------
    this.armedAtBarTime = null;
    const entry = snap.m1.at(-1)?.close ?? bar.close;
    const stopLoss = entry * (1 - o.stopPct / 100);
    const takeProfit = band.vwap + o.tp2Sigma * band.sd;
    if (takeProfit <= entry) return null; // no room (RSI crossed too late)
    const risk = entry - stopLoss;
    const reward = takeProfit - entry;

    logger.info(
      `VBR trigger: LONG ${snap.symbol} @ ${entry.toFixed(2)} — RSI crossed ${rPrev.toFixed(0)}→${r.toFixed(0)} up through ${o.rsiLong}, ` +
        `band ${band.lower.toFixed(2)}/${band.vwap.toFixed(2)}/${band.upper.toFixed(2)}`,
    );

    return {
      id: randomUUID(),
      time: Date.now(),
      symbol: snap.symbol,
      side: 'long',
      entry: round(entry, 2),
      stopLoss: round(stopLoss, 2),
      takeProfit: round(takeProfit, 2),
      riskReward: risk > 0 ? round(reward / risk, 2) : 0,
      confluence: 72,
      source: 'engine',
      reasons: [
        `VBR: 4H lower-band tag + RSI cross up through ${o.rsiLong}`,
        `stop ${o.stopPct}% · TP1 (BE) VWAP ${band.vwap.toFixed(2)} · TP2 ${takeProfit.toFixed(2)} (+${o.tp2Sigma}σ)`,
      ],
      nearTarget: round(band.vwap, 2), // TP1 — engine trails stop to BE when tagged
      drawTarget: round(takeProfit, 2),
      drawTimeframe: '4H',
      marginPctOverride: o.marginPct > 0 ? o.marginPct : undefined,
      leverageOverride: o.leverage > 0 ? o.leverage : undefined,
    };
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
