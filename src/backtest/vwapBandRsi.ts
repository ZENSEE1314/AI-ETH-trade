// Backtest: "VWAP outer-band + RSI-cross" mean reversion.
//
// Rules (from the user's manual style):
//   · Only trade at the OUTER VWAP band (session VWAP ± k·σ, k=2).
//   · Price tags the band → arm. Then WAIT for RSI to cross:
//       upper band  + RSI crosses DOWN through the level → SHORT
//       lower band  + RSI crosses UP   through the level → LONG
//   · TP1 = middle band (VWAP) — bank `scaleFrac`, move stop to breakeven.
//   · TP2 = the opposite outer band — the runner.
//   · Targets track the LIVE session VWAP/bands (no lookahead — each bar is
//     tested against that bar's VWAP state).
//
// Session VWAP resets at 00:00 UTC. An open trade is force-closed at the
// session boundary or after `maxBars`.

import type { Candle, Side } from '../types.js';

export interface VwapBandRsiOptions {
  bandMult?: number; // σ multiplier for the outer band (default 2)
  rsiPeriod?: number; // Wilder RSI length (default 14)
  rsiShort?: number; // short when RSI crosses DOWN through this (default 70)
  rsiLong?: number; // long when RSI crosses UP through this (default 30)
  trigger?: 'rsi' | 'reclaim'; // RSI cross, or just a close back inside the band (default 'rsi')
  armBars?: number; // bars the arm stays live waiting for the trigger (default 8)
  stopMode?: 'band' | 'entryPct'; // stop past the band, or a fixed % from entry (default 'band')
  stopBandFrac?: number; // stopMode 'band': extra σ past the band (default 0.75)
  stopPct?: number; // stopMode 'entryPct': stop this far from entry, % (default 0.5)
  scaleFrac?: number; // fraction banked at TP1 / VWAP (default 0.5)
  maxBars?: number; // hard time stop in bars (default 48)
  costBps?: number; // per-side cost, fee + slippage, in bps (default 7)
  minBandWidthPct?: number; // skip if (upper-lower)/vwap*100 below this (default 0.8)
  flatOnly?: number; // only fade when the 50-bar trend slope is under this (% over the window); 0 = off
  anchor?: 'daily' | 'weekly' | 'rolling'; // VWAP anchor (default 'daily')
  rollingLen?: number; // bars for anchor 'rolling' (default 30)
  longOnly?: boolean; // never take the short (upper-band) side
  shortOnly?: boolean; // never take the long (lower-band) side
  tp1LockFrac?: number; // after TP1, trail the runner stop to entry + frac*(TP1-entry). 0 = breakeven (default 0)
  tp2Sigma?: number; // TP2 = VWAP ± this many σ (default = bandMult, i.e. the opposite outer band)
}

export interface VbrTrade {
  side: Side;
  entryTime: number;
  entry: number;
  stopLoss: number;
  exit: number;
  rMultiple: number; // net R after costs, across both legs
  outcome: 'win' | 'loss' | 'timeout'; // win = booked positive R
  reachedTp1: boolean;
  reachedTp2: boolean;
  barsHeld: number;
  rsiAtEntry: number;
  pctReturn: number; // net return on the notional position (rMultiple × stop-distance%)
  maePct: number; // worst adverse excursion before exit, % of entry (for liquidation modelling)
}

export interface VbrStats {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRatePct: number;
  tp1RatePct: number; // reached the middle band
  tp2RatePct: number; // reached the opposite band
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  avgBarsHeld: number;
  longs: number;
  shorts: number;
}

export interface VbrResult {
  stats: VbrStats;
  trades: VbrTrade[];
}

/** Wilder RSI for every index (null until it has `period` deltas). */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

interface VwapBar {
  vwap: number;
  sd: number;
  upper: number;
  lower: number;
}

/** Per-bar VWAP + σ bands. No lookahead: bar i reflects only bars up to i.
 *  'daily'/'weekly' reset at the UTC period boundary; 'rolling' uses a fixed
 *  trailing window (better fit for higher timeframes where a day is few bars). */
function anchoredVwapSeries(
  candles: Candle[],
  mult: number,
  anchor: 'daily' | 'weekly' | 'rolling',
  rollingLen: number,
): VwapBar[] {
  const out: VwapBar[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  const period = anchor === 'weekly' ? 7 * DAY : DAY;

  if (anchor === 'rolling') {
    const typ = candles.map((c) => (c.high + c.low + c.close) / 3);
    const vol = candles.map((c) => c.volume || 1);
    for (let i = 0; i < candles.length; i++) {
      const s = Math.max(0, i - rollingLen + 1);
      let pv = 0;
      let v = 0;
      let p2v = 0;
      for (let j = s; j <= i; j++) {
        pv += typ[j] * vol[j];
        v += vol[j];
        p2v += typ[j] * typ[j] * vol[j];
      }
      const vwap = pv / v;
      const sd = Math.sqrt(Math.max(0, p2v / v - vwap * vwap));
      out.push({ vwap, sd, upper: vwap + mult * sd, lower: vwap - mult * sd });
    }
    return out;
  }

  let bucket = -1;
  let cumPV = 0;
  let cumV = 0;
  let cumP2V = 0;
  for (const c of candles) {
    const b = Math.floor((anchor === 'weekly' ? c.time - 3 * DAY : c.time) / period); // week anchored to Monday
    if (b !== bucket) {
      bucket = b;
      cumPV = 0;
      cumV = 0;
      cumP2V = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 1;
    cumPV += typical * v;
    cumV += v;
    cumP2V += typical * typical * v;
    const vwap = cumPV / cumV;
    const sd = Math.sqrt(Math.max(0, cumP2V / cumV - vwap * vwap));
    out.push({ vwap, sd, upper: vwap + mult * sd, lower: vwap - mult * sd });
  }
  return out;
}

const DAY_MS = 86_400_000;
const sameBucket = (a: number, b: number, ms: number) =>
  Math.floor(a / ms) === Math.floor(b / ms);

export function backtestVwapBandRsi(candles: Candle[], opts: VwapBandRsiOptions = {}): VbrResult {
  const bandMult = opts.bandMult ?? 2;
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const rsiShort = opts.rsiShort ?? 70;
  const rsiLong = opts.rsiLong ?? 30;
  const trigger = opts.trigger ?? 'rsi';
  const armBars = opts.armBars ?? 8;
  const stopMode = opts.stopMode ?? 'band';
  const stopBandFrac = opts.stopBandFrac ?? 0.75;
  const stopPct = opts.stopPct ?? 0.5;
  const scaleFrac = opts.scaleFrac ?? 0.5;
  const maxBars = opts.maxBars ?? 48;
  const cost = (opts.costBps ?? 7) / 10_000;
  const minWidth = opts.minBandWidthPct ?? 0.8;
  const flatOnly = opts.flatOnly ?? 0;
  const anchor = opts.anchor ?? 'daily';
  const rollingLen = opts.rollingLen ?? 30;
  const longOnly = opts.longOnly ?? false;
  const shortOnly = opts.shortOnly ?? false;
  const tp1LockFrac = opts.tp1LockFrac ?? 0;
  const tp2Sigma = opts.tp2Sigma ?? bandMult;
  // Session-boundary check for the time stop. 'rolling' has no reset, so make
  // the bucket huge (effectively "never resets", maxBars governs).
  const bucketMs = anchor === 'weekly' ? 7 * DAY_MS : anchor === 'rolling' ? 1e15 : DAY_MS;

  const closes = candles.map((c) => c.close);
  const rsi = rsiSeries(closes, rsiPeriod);
  // |price now vs price 50 bars ago| as % — a cheap trend-strength proxy.
  const trendPct = (i: number): number =>
    i < 50 ? 0 : Math.abs((closes[i] - closes[i - 50]) / closes[i - 50]) * 100;
  const vw = anchoredVwapSeries(candles, bandMult, anchor, rollingLen);

  const trades: VbrTrade[] = [];

  type Arm = { side: Side; bar: number };
  let arm: Arm | null = null;

  let i = rsiPeriod + 2;
  while (i < candles.length) {
    const c = candles[i];
    const b = vw[i];
    const r = rsi[i];
    const rPrev = rsi[i - 1];
    if (r == null || rPrev == null || b.sd === 0) {
      i++;
      continue;
    }

    const widthPct = ((b.upper - b.lower) / b.vwap) * 100;

    // ---- arm on an outer-band tag -------------------------------------------
    if (!arm && widthPct >= minWidth && (flatOnly === 0 || trendPct(i) <= flatOnly)) {
      if (c.high >= b.upper && !longOnly) arm = { side: 'short', bar: i };
      else if (c.low <= b.lower && !shortOnly) arm = { side: 'long', bar: i };
    } else if (arm) {
      const stale =
        i - arm.bar > armBars || !sameBucket(candles[arm.bar].time, c.time, bucketMs);
      const backToMean = arm.side === 'short' ? c.close < b.vwap : c.close > b.vwap;
      const rsiCross =
        arm.side === 'short'
          ? rPrev >= rsiShort && r < rsiShort
          : rPrev <= rsiLong && r > rsiLong;
      // 'reclaim': the bar closes back inside the band it tagged.
      const reclaim =
        arm.side === 'short'
          ? candles[i - 1].close >= vw[i - 1].upper && c.close < b.upper
          : candles[i - 1].close <= vw[i - 1].lower && c.close > b.lower;
      const triggered = trigger === 'rsi' ? rsiCross : reclaim;

      if (triggered && !backToMean) {
        // ---- enter -----------------------------------------------------------
        const side = arm.side;
        const entry = c.close;
        const stop =
          stopMode === 'entryPct'
            ? side === 'short'
              ? entry * (1 + stopPct / 100)
              : entry * (1 - stopPct / 100)
            : side === 'short'
            ? b.upper + stopBandFrac * b.sd
            : b.lower - stopBandFrac * b.sd;
        const risk = Math.abs(entry - stop) || 1e-9;
        const dir = side === 'long' ? 1 : -1;
        const rAt = (px: number) => (dir * (px - entry)) / risk;

        let banked = 0;
        let remaining = 1;
        let curStop = stop;
        let tookTp1 = false;
        let reachedTp2 = false;
        let exitPx = entry;
        let exitIdx = i;
        let worstAdverse = 0; // max adverse price move from entry, absolute

        for (let j = i + 1; j < Math.min(candles.length, i + 1 + maxBars); j++) {
          const cj = candles[j];
          const bj = vw[j];
          exitIdx = j;
          const adv = side === 'long' ? entry - cj.low : cj.high - entry;
          if (adv > worstAdverse) worstAdverse = adv;
          const hitStop = side === 'long' ? cj.low <= curStop : cj.high >= curStop;
          if (hitStop) {
            exitPx = curStop;
            banked += remaining * rAt(curStop);
            remaining = 0;
            break;
          }
          if (!tookTp1) {
            const hitTp1 = side === 'long' ? cj.high >= bj.vwap : cj.low <= bj.vwap;
            if (hitTp1) {
              banked += scaleFrac * rAt(bj.vwap);
              remaining -= scaleFrac;
              // trail the runner stop: entry (BE) + a fraction of the TP1 gain
              curStop = entry + tp1LockFrac * (bj.vwap - entry);
              tookTp1 = true;
              continue;
            }
          } else {
            const oppBand = side === 'long' ? bj.vwap + tp2Sigma * bj.sd : bj.vwap - tp2Sigma * bj.sd;
            const hitTp2 = side === 'long' ? cj.high >= oppBand : cj.low <= oppBand;
            if (hitTp2) {
              exitPx = oppBand;
              banked += remaining * rAt(oppBand);
              remaining = 0;
              reachedTp2 = true;
              break;
            }
          }
          // session reset → flat at this bar's close
          if (!sameBucket(c.time, cj.time, bucketMs)) {
            exitPx = cj.close;
            banked += remaining * rAt(cj.close);
            remaining = 0;
            break;
          }
        }
        if (remaining > 0) {
          const cj = candles[exitIdx];
          exitPx = cj.close;
          banked += remaining * rAt(cj.close);
        }

        // costs: entry leg + one exit leg (+ a scale leg if TP1 filled)
        const perLeg = entry / risk;
        const feeR = cost * perLeg * (tookTp1 ? 3 : 2);
        const netR = banked - feeR;
        const stopDistPct = (risk / entry) * 100;

        trades.push({
          side,
          entryTime: c.time,
          entry,
          stopLoss: stop,
          exit: exitPx,
          rMultiple: round(netR, 3),
          outcome: netR > 0 ? 'win' : exitIdx - i >= maxBars ? 'timeout' : 'loss',
          reachedTp1: tookTp1,
          reachedTp2,
          barsHeld: exitIdx - i,
          rsiAtEntry: round(r, 1),
          pctReturn: round(netR * (stopDistPct / 100), 5),
          maePct: round((worstAdverse / entry) * 100, 3),
        });

        arm = null;
        i = exitIdx + 1;
        continue;
      }

      if (stale || backToMean) arm = null;
    }
    i++;
  }

  return { stats: summarize(trades), trades };
}

export function summarize(trades: VbrTrade[]): VbrStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = trades.filter((t) => t.rMultiple <= 0 && t.outcome !== 'timeout').length;
  const timeouts = trades.filter((t) => t.outcome === 'timeout').length;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = -trades.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.rMultiple;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  return {
    trades: n,
    wins,
    losses,
    timeouts,
    winRatePct: n ? round((wins / n) * 100, 1) : 0,
    tp1RatePct: n ? round((trades.filter((t) => t.reachedTp1).length / n) * 100, 1) : 0,
    tp2RatePct: n ? round((trades.filter((t) => t.reachedTp2).length / n) * 100, 1) : 0,
    avgR: n ? round(totalR / n, 3) : 0,
    totalR: round(totalR, 2),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: round(maxDd, 2),
    avgBarsHeld: n ? Math.round(trades.reduce((s, t) => s + t.barsHeld, 0) / n) : 0,
    longs: trades.filter((t) => t.side === 'long').length,
    shorts: trades.filter((t) => t.side === 'short').length,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
