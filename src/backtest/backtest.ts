// Walk-forward backtester for the draw-on-liquidity strategy.
//
// It replays a 1m history minute by minute: at each step it rebuilds the
// higher-timeframe view (15M/1H/4H) from the 1m candles seen *so far* — no
// lookahead — asks generateSignal for a setup, and if one clears the confluence
// and R:R gates, simulates it forward on the 1m candles until the stop or the
// draw (take-profit) is hit. The headline it answers: how often do these
// 1M-timed entries actually reach the draw before the stop?

import type { Candle, Side } from '../types.js';
import { generateSignal } from '../strategy/signal.js';
import { resample } from './resample.js';

export interface BacktestOptions {
  symbol?: string;
  minConfluence?: number;
  minRiskReward?: number;
  maxHoldBars?: number; // 1m bars to hold before timing out (default 240 = 4h)
  warmupBars?: number; // 1m bars to skip before trading (history to build HTFs)
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
    const b15 = Math.floor(t / (15 * 60_000));
    if (b15 !== lastBucket15) {
      const hist = m1.slice(0, i + 1);
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

    const sig = generateSignal(snap);
    if (!sig || sig.confluence < minConf || sig.riskReward < minRR) continue;

    // Simulate forward. Stop is checked before target on the same bar (worst
    // case for us), so results never flatter the strategy.
    const { side, entry, stopLoss, takeProfit } = sig;
    let exitIdx = -1;
    let exit = 0;
    let outcome: BtTrade['outcome'] = 'timeout';
    const limit = Math.min(m1.length, i + 1 + maxHold);
    for (let j = i + 1; j < limit; j++) {
      const c = m1[j];
      if (side === 'long') {
        if (c.low <= stopLoss) { exit = stopLoss; outcome = 'loss'; exitIdx = j; break; }
        if (c.high >= takeProfit) { exit = takeProfit; outcome = 'win'; exitIdx = j; break; }
      } else {
        if (c.high >= stopLoss) { exit = stopLoss; outcome = 'loss'; exitIdx = j; break; }
        if (c.low <= takeProfit) { exit = takeProfit; outcome = 'win'; exitIdx = j; break; }
      }
    }
    if (exitIdx === -1) {
      exitIdx = limit - 1;
      exit = m1[exitIdx]?.close ?? entry;
    }

    const risk = Math.abs(entry - stopLoss) || 1e-9;
    const rMultiple = (side === 'long' ? exit - entry : entry - exit) / risk;
    trades.push({
      side,
      entryTime: t,
      entry,
      stopLoss,
      takeProfit,
      exit,
      rMultiple: round(rMultiple, 2),
      outcome,
      confluence: sig.confluence,
      drawTimeframe: sig.drawTimeframe,
      barsHeld: exitIdx - i,
    });

    i = exitIdx; // one position at a time — no overlapping trades
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
