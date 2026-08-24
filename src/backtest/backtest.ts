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
}

interface SimResult {
  exitIdx: number;
  exit: number; // final exit price (last leg)
  rMultiple: number; // net R across all legs
  outcome: 'win' | 'loss' | 'timeout';
}

/** Single-exit sim: stop or take-profit, whichever the bar hits first (stop wins ties). */
function simulateSingle(
  sig: { side: Side; entry: number; stopLoss: number; takeProfit: number },
  m1: Candle[],
  i: number,
  limit: number,
): SimResult {
  const { side, entry, stopLoss, takeProfit } = sig;
  const risk = Math.abs(entry - stopLoss) || 1e-9;
  for (let j = i + 1; j < limit; j++) {
    const c = m1[j];
    if (side === 'long') {
      if (c.low <= stopLoss) return { exitIdx: j, exit: stopLoss, rMultiple: (stopLoss - entry) / risk, outcome: 'loss' };
      if (c.high >= takeProfit) return { exitIdx: j, exit: takeProfit, rMultiple: (takeProfit - entry) / risk, outcome: 'win' };
    } else {
      if (c.high >= stopLoss) return { exitIdx: j, exit: stopLoss, rMultiple: (entry - stopLoss) / risk, outcome: 'loss' };
      if (c.low <= takeProfit) return { exitIdx: j, exit: takeProfit, rMultiple: (entry - takeProfit) / risk, outcome: 'win' };
    }
  }
  const j = limit - 1;
  const exit = m1[j]?.close ?? entry;
  const r = (side === 'long' ? exit - entry : entry - exit) / risk;
  return { exitIdx: j, exit, rMultiple: r, outcome: 'timeout' };
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

  for (let j = i + 1; j < limit; j++) {
    const c = m1[j];
    const hitStop = side === 'long' ? c.low <= curStop : c.high >= curStop;
    if (hitStop) {
      const r = banked + remaining * rAt(curStop);
      return { exitIdx: j, exit: curStop, rMultiple: r, outcome: r > 1e-9 ? 'win' : 'loss' };
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
      if (hitDraw) {
        const r = banked + remaining * rAt(draw);
        return { exitIdx: j, exit: draw, rMultiple: r, outcome: 'win' };
      }
    }
  }
  const j = limit - 1;
  const exit = m1[j]?.close ?? entry;
  const r = banked + remaining * rAt(exit);
  return { exitIdx: j, exit, rMultiple: r, outcome: 'timeout' };
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
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number; // wins / trades
  hitDrawRate: number; // reached the draw (TP) / trades — the headline metric
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
      const hist = m1.slice(Math.max(0, i + 1 - 30_000), i + 1);
      m15 = resample(hist, 15);
      h1 = resample(hist, 60);
      h4 = resample(hist, 240);
      lastBucket15 = b15;
    }

    const snap = {
      symbol,
      h4: h4.slice(-120),
      h1: h1.slice(-200),
      m15: m15.slice(-200),
      m1: m1.slice(Math.max(0, i - 119), i + 1),
    };

    const sig = generateSignal(snap, opts.signal);
    if (!sig || sig.confluence < minConf || sig.riskReward < minRR) continue;

    const limit = Math.min(m1.length, i + 1 + maxHold);
    const res = opts.partial
      ? simulatePartial(sig, m1, i, limit, opts.scaleFrac ?? 0.5)
      : simulateSingle(sig, m1, i, limit);

    trades.push({
      side: sig.side,
      entryTime: t,
      entry: sig.entry,
      stopLoss: sig.stopLoss,
      takeProfit: sig.takeProfit,
      exit: res.exit,
      rMultiple: round(res.rMultiple, 2),
      outcome: res.outcome,
      confluence: sig.confluence,
      drawTimeframe: sig.drawTimeframe,
      barsHeld: res.exitIdx - i,
    });

    i = res.exitIdx; // one position at a time — no overlapping trades
  }

  return { stats: summarize(trades), trades };
}

function summarize(trades: BtTrade[]): BacktestStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
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
    winRate: n ? round(wins / n, 4) : 0,
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
