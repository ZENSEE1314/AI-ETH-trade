// Walk-forward backtester for the draw-on-liquidity strategy.
//
// It replays a 1m history minute by minute: at each step it rebuilds the
// higher-timeframe view (15M/1H/4H) from the 1m candles seen *so far* — no
// lookahead — asks generateSignal for a setup, and if one clears the confluence
// and R:R gates, simulates it forward on the 1m candles until the stop or the
// draw (take-profit) is hit. The headline it answers: how often do these
// 1M-timed entries actually reach the draw before the stop?

import type { Candle, Side } from '../types.js';
import { generateSignal, type SignalOptions } from '../strategy/signal.js';
import { generateFlipSignal, type FlipSignalOptions } from '../strategy/liquidityFlip.js';
import { generateChannelReversalSignal, type ChannelReversalSignalOptions } from '../strategy/channelReversal.js';
import { generateStructureTravelSignal, type StructureTravelOptions } from '../strategy/structureTravel.js';
import { generateChochReversalSignal, type ChochReversalOptions } from '../strategy/chochReversal.js';
import { generateHtfTravelSignal, type HtfTravelOptions } from '../strategy/htfTravel.js';
import { resample } from './resample.js';

export interface BacktestOptions {
  symbol?: string;
  minConfluence?: number;
  minRiskReward?: number;
  maxHoldBars?: number; // 1m bars to hold before timing out (default 240 = 4h)
  warmupBars?: number; // 1m bars to skip before trading (history to build HTFs)
  signal?: SignalOptions; // target/stop mode passed through to generateSignal
  partial?: boolean; // scale out at the near pool, move stop to breakeven, run to draw
  scaleFrac?: number; // fraction banked at the near pool (default 0.5)
  beAtR?: number; // move stop to breakeven once price is this many R in profit (0 = off)
  costBps?: number; // taker per-side cost (fee + slippage) in bps; 0 = frictionless
  cooldownBars?: number; // 1m bars to sit out after a trade closes before re-entering
  makerEntry?: boolean; // enter with a resting limit at the trigger level (may not fill)
  makerBps?: number; // maker per-side fee in bps (limit entry + limit take-profit legs)
  fillWindowBars?: number; // how many 1m bars a maker entry limit stays live before it's abandoned
  /** Use the trend-channel-flip + swept-EQH/EQL entry instead of the full 7-stage engine. */
  flip?: FlipSignalOptions | false;
  /** Use the channel-band reversal entry (LL at lower band + VWAP → HH, or mirror) instead. */
  reversal?: ChannelReversalSignalOptions | false;
  /** Use the 15M structure "green line → red line" travel entry (1H-gated) instead. */
  travel?: StructureTravelOptions | false;
  /** Use the SMC sweep→CHoCH→OB/FVG-retest reversal entry instead. */
  choch?: ChochReversalOptions | false;
  /** Use the HTF green→red travel entry (journal-matched: 4H/1D lines, tight structure stop). */
  htfTravel?: HtfTravelOptions | false;
}

interface SimResult {
  exitIdx: number;
  exit: number; // final exit price (last leg)
  rMultiple: number; // net R across all legs
  outcome: 'win' | 'loss' | 'timeout';
  mfeR: number; // max favorable excursion, in R (how far in profit it ever went)
  maeR: number; // max adverse excursion, in R (worst heat taken)
  reachedNear: boolean; // did price tag the near pool before exiting
}

/** Single-exit sim: stop or take-profit, whichever the bar hits first (stop wins ties).
 *  `beAtR` > 0 moves the stop to breakeven once price trades that many R in profit. */
function simulateSingle(
  sig: { side: Side; entry: number; stopLoss: number; takeProfit: number; nearTarget?: number },
  m1: Candle[],
  i: number,
  limit: number,
  beAtR = 0,
): SimResult {
  const { side, entry, stopLoss, takeProfit } = sig;
  const risk = Math.abs(entry - stopLoss) || 1e-9;
  const near = sig.nearTarget ?? takeProfit;
  let curStop = stopLoss;
  let mfe = 0;
  let mae = 0;
  let reachedNear = false;
  const done = (exitIdx: number, exit: number, rMultiple: number, outcome: SimResult['outcome']): SimResult => ({
    exitIdx, exit, rMultiple, outcome, mfeR: mfe / risk, maeR: mae / risk, reachedNear,
  });
  for (let j = i + 1; j < limit; j++) {
    const c = m1[j];
    const fav = side === 'long' ? c.high - entry : entry - c.low;
    const adv = side === 'long' ? entry - c.low : c.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    if (!reachedNear && (side === 'long' ? c.high >= near : c.low <= near)) reachedNear = true;
    if (side === 'long') {
      if (c.low <= curStop) return done(j, curStop, (curStop - entry) / risk, curStop >= entry ? 'timeout' : 'loss');
      if (c.high >= takeProfit) return done(j, takeProfit, (takeProfit - entry) / risk, 'win');
    } else {
      if (c.high >= curStop) return done(j, curStop, (entry - curStop) / risk, curStop <= entry ? 'timeout' : 'loss');
      if (c.low <= takeProfit) return done(j, takeProfit, (entry - takeProfit) / risk, 'win');
    }
    // Arm breakeven once we've seen beAtR of favorable excursion.
    if (beAtR > 0 && curStop !== entry && mfe >= beAtR * risk) curStop = entry;
  }
  const j = limit - 1;
  const exit = m1[j]?.close ?? entry;
  return done(j, exit, (side === 'long' ? exit - entry : entry - exit) / risk, 'timeout');
}

/**
 * Scale-out sim — how a discretionary trader banks a high win rate: take `frac`
 * off at the near pool, move the stop to breakeven, let the runner go to the
 * full draw. Anything that reaches the near pool books a win; the runner then
 * only ever costs the already-banked profit back to breakeven, never a full R.
 */
function simulatePartial(
  sig: { side: Side; entry: number; stopLoss: number; takeProfit: number; nearTarget?: number; drawTarget?: number },
  m1: Candle[],
  i: number,
  limit: number,
  frac: number,
): SimResult {
  const { side, entry, stopLoss } = sig;
  const risk = Math.abs(entry - stopLoss) || 1e-9;
  const near = sig.nearTarget ?? sig.takeProfit;
  const draw = sig.drawTarget ?? sig.takeProfit;
  const dir = side === 'long' ? 1 : -1;
  const rAt = (px: number) => (dir * (px - entry)) / risk;

  let banked = 0; // R already realized from the scaled-out portion
  let remaining = 1;
  let curStop = stopLoss;
  let scaled = false;
  let mfe = 0;
  let mae = 0;
  const fin = (exitIdx: number, exit: number, rMultiple: number, outcome: SimResult['outcome']): SimResult => ({
    exitIdx, exit, rMultiple, outcome, mfeR: mfe / risk, maeR: mae / risk, reachedNear: scaled,
  });

  for (let j = i + 1; j < limit; j++) {
    const c = m1[j];
    const fav = side === 'long' ? c.high - entry : entry - c.low;
    const adv = side === 'long' ? entry - c.low : c.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    const hitStop = side === 'long' ? c.low <= curStop : c.high >= curStop;
    if (hitStop) {
      const r = banked + remaining * rAt(curStop);
      return fin(j, curStop, r, r > 1e-9 ? 'win' : 'loss');
    }
    if (!scaled) {
      const hitNear = side === 'long' ? c.high >= near : c.low <= near;
      if (hitNear) {
        banked += frac * rAt(near);
        remaining -= frac;
        curStop = entry; // move the runner's stop to breakeven
        scaled = true;
        continue; // don't also test the BE stop on the tag bar
      }
    } else {
      const hitDraw = side === 'long' ? c.high >= draw : c.low <= draw;
      if (hitDraw) return fin(j, draw, banked + remaining * rAt(draw), 'win');
    }
  }
  const j = limit - 1;
  const exit = m1[j]?.close ?? entry;
  return fin(j, exit, banked + remaining * rAt(exit), 'timeout');
}

export interface BtTrade {
  side: Side;
  entryTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exit: number;
  rMultiple: number;
  outcome: 'win' | 'loss' | 'timeout'; // win = reached the draw
  confluence: number;
  drawTimeframe?: string;
  barsHeld: number;
  stopPct: number; // stop distance as % of entry (risk width)
  mfeR: number; // best favorable excursion in R
  maeR: number; // worst heat taken in R
  reachedNear: boolean; // did it tag the near pool before exit
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number; // profitable trades (net R > 0) / trades — the real win rate
  hitDrawRate: number; // reached the full draw (TP) / trades — a stricter metric
  avgR: number; // expectancy in R
  totalR: number;
  profitFactor: number; // gross win R / gross loss R
  maxDrawdownR: number; // worst peak-to-trough of the cumulative-R curve
  avgBarsHeld: number;
}

export interface BacktestResult {
  stats: BacktestStats;
  trades: BtTrade[];
}

export function backtest(m1: Candle[], opts: BacktestOptions = {}): BacktestResult {
  const symbol = opts.symbol ?? 'ETHUSDT';
  const minConf = opts.minConfluence ?? 0;
  const minRR = opts.minRiskReward ?? 0;
  const maxHold = opts.maxHoldBars ?? 240;
  // Enough 1m to give the strategy some structure; capped to the data we have.
  const warmup = Math.min(opts.warmupBars ?? 600, Math.max(0, m1.length - 10));

  const trades: BtTrade[] = [];
  let m15: Candle[] = [];
  let h1: Candle[] = [];
  let h4: Candle[] = [];
  let d1: Candle[] = [];
  let lastBucket15 = -1;

  for (let i = warmup; i < m1.length; i++) {
    const t = m1[i].time;

    // Rebuild the higher-timeframe view only when a new 15m bar opens — cheap,
    // and it never leaks a forming bar's future into the current decision.
    // Buckets are UTC-aligned, so a bounded tail yields the same recent HTF
    // candles the strategy uses (120×4H = 28,800 1m) while keeping this O(1) in
    // history length — the difference between seconds and minutes on 90d of 1m.
    const b15 = Math.floor(t / (15 * 60_000));
    if (b15 !== lastBucket15) {
      const hist = m1.slice(Math.max(0, i + 1 - 60_000), i + 1);
      m15 = resample(hist, 15);
      h1 = resample(hist, 60);
      h4 = resample(hist, 240);
      d1 = resample(hist, 1440);
      lastBucket15 = b15;
    }

    const snap = {
      symbol,
      d1: d1.slice(-60),
      h4: h4.slice(-180),
      h1: h1.slice(-200),
      m15: m15.slice(-200),
      m1: m1.slice(Math.max(0, i - 119), i + 1),
    };

    const sig = opts.flip
      ? generateFlipSignal(snap.m1, snap.h1, symbol, opts.flip)
      : opts.reversal
      ? generateChannelReversalSignal(snap.m15, symbol, opts.reversal)
      : opts.travel
      ? generateStructureTravelSignal(
          { m1: snap.m1, m15: snap.m15, h1: snap.h1, h4: snap.h4, d1: snap.d1 },
          symbol,
          opts.travel,
        )
      : opts.choch
      ? generateChochReversalSignal(
          { m1: snap.m1, m15: snap.m15, h1: snap.h1, h4: snap.h4, d1: snap.d1 },
          symbol,
          opts.choch,
        )
      : opts.htfTravel
      ? generateHtfTravelSignal(
          { m1: snap.m1, m15: snap.m15, h1: snap.h1, h4: snap.h4, d1: snap.d1 },
          symbol,
          opts.htfTravel,
        )
      : generateSignal(snap, opts.signal);
    if (!sig || sig.confluence < minConf || sig.riskReward < minRR) continue;

    // Maker entry: a resting limit at the trigger level. It only fills if a later
    // bar trades through it inside the fill window — that's the cost of the
    // cheaper fee (many runners never come back to the limit and are missed).
    let entryIdx = i;
    let fillSig = sig;
    if (opts.makerEntry) {
      const limitPx = sig.sweptLevel ?? sig.entry;
      const window = Math.min(m1.length, i + 1 + (opts.fillWindowBars ?? 10));
      let hit = -1;
      for (let j = i + 1; j < window; j++) {
        if (sig.side === 'long' ? m1[j].low <= limitPx : m1[j].high >= limitPx) { hit = j; break; }
      }
      if (hit < 0) continue; // limit never filled — no trade
      entryIdx = hit;
      fillSig = { ...sig, entry: limitPx };
    }

    const limit = Math.min(m1.length, entryIdx + 1 + maxHold);
    const res = opts.partial
      ? simulatePartial(fillSig, m1, entryIdx, limit, opts.scaleFrac ?? 0.5)
      : simulateSingle(fillSig, m1, entryIdx, limit, opts.beAtR ?? 0);

    // Trading cost in R. Stop distance is 1R, so a leg costs (bps/1e4)·entry/risk.
    // Taker legs: the entry (unless maker) and any stop/timeout market exit.
    // Maker legs: a maker limit entry, and a take-profit that rests as a limit.
    const risk = Math.abs(fillSig.entry - fillSig.stopLoss) || 1e-9;
    const taker = (opts.costBps ?? 0) / 10_000;
    const maker = (opts.makerBps ?? opts.costBps ?? 0) / 10_000;
    const perLeg = fillSig.entry / risk;
    const entryFee = (opts.makerEntry ? maker : taker) * perLeg;
    const exitFee = (res.outcome === 'win' ? maker : taker) * perLeg;
    const scaleFee = opts.partial ? maker * perLeg : 0; // scale-out tags a limit
    const feeR = entryFee + exitFee + scaleFee;
    const netR = res.rMultiple - feeR;

    trades.push({
      side: fillSig.side,
      entryTime: m1[entryIdx].time,
      entry: fillSig.entry,
      stopLoss: fillSig.stopLoss,
      takeProfit: fillSig.takeProfit,
      exit: res.exit,
      rMultiple: round(netR, 2),
      outcome: res.outcome,
      confluence: fillSig.confluence,
      drawTimeframe: fillSig.drawTimeframe,
      barsHeld: res.exitIdx - entryIdx,
      stopPct: round((Math.abs(fillSig.entry - fillSig.stopLoss) / fillSig.entry) * 100, 3),
      mfeR: round(res.mfeR, 2),
      maeR: round(res.maeR, 2),
      reachedNear: res.reachedNear,
    });

    i = res.exitIdx + (opts.cooldownBars ?? 0); // one position at a time, then sit out the cooldown
  }

  return { stats: summarize(trades), trades };
}

function summarize(trades: BtTrade[]): BacktestStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const timeouts = trades.filter((t) => t.outcome === 'timeout').length;
  const profitable = trades.filter((t) => t.rMultiple > 0).length; // real wins by P&L
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
    winRate: n ? round(profitable / n, 4) : 0,
    hitDrawRate: n ? round(wins / n, 4) : 0,
    avgR: n ? round(totalR / n, 3) : 0,
    totalR: round(totalR, 2),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: round(maxDd, 2),
    avgBarsHeld: n ? Math.round(trades.reduce((s, t) => s + t.barsHeld, 0) / n) : 0,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
