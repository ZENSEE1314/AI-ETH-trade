// PAPER-ONLY observation watcher for the NW-band + RSI same-bar rule
// (Nadaraya-Watson envelope h=8/mult=3 + RSI(ohlc4,14) crossing its own
// SMA(3), long only, TP1=midline lock / TP2=opposite band), run across
// 15m/30m/1h/4h in parallel with whatever strategy the engine is actually
// trading. It never touches real capital, the risk manager, or the engine's
// own position/journal state — it keeps its own $1000-per-timeframe paper
// ledger (persisted via store.ts) purely so the rule can be watched live.
//
// Backtested edge is thin and mostly unproven — see
// project-ai-eth-trade-nwsetup.md (RETRACTED) in project memory. Only 1h
// showed a real edge in the 2y backtest; 15m/30m/4h run here for
// observation, not because they're expected to profit.

import type { Candle } from '../types.js';
import { logger } from '../logger.js';
import { readJson, writeJson } from '../store.js';
import { resample } from '../backtest/resample.js';

const H = 8, MULT = 3, MAE_LEN = 100, RSI_LEN = 14, RSI_MA = 3;
const COST = 7 / 10_000;

const TF_CONFIG: Record<string, { stopPct: number; leverage: number }> = {
  '15m': { stopPct: 2, leverage: 5 },
  '30m': { stopPct: 2.5, leverage: 5 },
  '1h': { stopPct: 5, leverage: 5 },
  '4h': { stopPct: 3, leverage: 5 },
};

interface PaperPosition {
  entry: number; stop: number; entryTime: number; tookTp1: boolean; legs: number; banked: number;
}
interface ClosedTrade {
  entryTime: number; exitTime: number; entry: number; exit: number; reason: string; pctRet: number;
}
interface TfState {
  equity: number; position: PaperPosition | null; trades: ClosedTrade[]; lastBarTime: number;
}
type WatchState = Record<string, TfState>;

function nwCausal(cl: number[]): number[] {
  const out = new Array(cl.length).fill(0);
  const span = Math.ceil(H * 3);
  for (let i = 0; i < cl.length; i++) {
    let num = 0, den = 0;
    for (let j = Math.max(0, i - span); j <= i; j++) { const w = Math.exp(-((i - j) ** 2) / (2 * H * H)); num += cl[j] * w; den += w; }
    out[i] = num / den;
  }
  return out;
}
function rsiS(v: number[], len: number): number[] {
  const out = new Array(v.length).fill(50);
  if (v.length < len + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (len - 1) + (d > 0 ? d : 0)) / len; l = (l * (len - 1) + (d < 0 ? -d : 0)) / len; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
const ohlc4 = (c: Candle[]) => c.map((b) => (b.open + b.high + b.low + b.close) / 4);
const sma = (v: number[], i: number, len: number) => { const s = Math.max(0, i - len + 1); let a = 0; for (let j = s; j <= i; j++) a += v[j]; return a / (i - s + 1); };

export class NwBandRsiWatcher {
  private state: WatchState;

  constructor() {
    this.state = readJson<WatchState>('nwWatchState', {});
  }

  /** Feed the current multi-timeframe snapshot; evaluates all 4 timeframes. */
  evaluate(snap: { m15: Candle[]; h1: Candle[]; h4: Candle[]; m1: Candle[] }): void {
    this.evalOne('15m', snap.m15);
    this.evalOne('30m', resample(snap.m1, 30));
    this.evalOne('1h', snap.h1);
    this.evalOne('4h', snap.h4);
    writeJson('nwWatchState', this.state);
  }

  private tf(tf: string): TfState {
    let st = this.state[tf];
    if (!st) { st = { equity: 1000, position: null, trades: [], lastBarTime: 0 }; this.state[tf] = st; }
    return st;
  }

  private evalOne(tf: string, bars: Candle[]): void {
    const cfg = TF_CONFIG[tf];
    const closed = bars.slice(0, -1); // drop the still-forming bar
    if (closed.length < MAE_LEN + 10) return;
    const st = this.tf(tf);
    const cl = closed.map((x) => x.close);
    const nw = nwCausal(cl);
    const rsi = rsiS(ohlc4(closed), RSI_LEN);
    const rMa = rsi.map((_, i) => sma(rsi, i, RSI_MA));
    const mae = cl.map((_, i) => { const s = Math.max(0, i - MAE_LEN + 1); let a = 0; for (let j = s; j <= i; j++) a += Math.abs(cl[j] - nw[j]); return a / (i - s + 1); });
    const up = (i: number) => nw[i] + MULT * mae[i];
    const lo = (i: number) => nw[i] - MULT * mae[i];
    const iLast = closed.length - 1;
    const bar = closed[iLast];
    if (bar.time <= st.lastBarTime) return; // already evaluated this closed bar
    st.lastBarTime = bar.time;

    if (st.position) {
      const pos = st.position;
      const adv = (pos.entry - bar.low) / pos.entry * 100;
      const liqAt = 100 / cfg.leverage - 0.1;
      if (cfg.leverage > 1 && adv >= liqAt) {
        st.equity -= st.equity * 0.1;
        st.trades.push({ entryTime: pos.entryTime, exitTime: bar.time, entry: pos.entry, exit: bar.low, reason: 'liquidation', pctRet: -1 });
        st.position = null;
        logger.info(`NW-watch ${tf}: LIQUIDATED @ ~${bar.low.toFixed(2)} — equity $${st.equity.toFixed(2)}`);
        return;
      }
      if (bar.low <= pos.stop) {
        const ret = pos.banked + (1 - (pos.tookTp1 ? 0.5 : 0)) * (pos.stop - pos.entry) / pos.entry - pos.legs * COST;
        st.equity += st.equity * 0.1 * cfg.leverage * ret;
        st.trades.push({ entryTime: pos.entryTime, exitTime: bar.time, entry: pos.entry, exit: pos.stop, reason: pos.tookTp1 ? 'be(tp1-lock)' : 'stop', pctRet: ret });
        st.position = null;
        logger.info(`NW-watch ${tf}: closed ${pos.tookTp1 ? 'be(tp1-lock)' : 'STOP'} @ ${pos.stop.toFixed(2)} (${(ret * 100).toFixed(2)}%) — equity $${st.equity.toFixed(2)}`);
        return;
      }
      if (!pos.tookTp1) {
        const mid = nw[iLast];
        if (bar.high >= mid) {
          pos.banked += 0.5 * (mid - pos.entry) / pos.entry;
          pos.stop = mid; pos.tookTp1 = true; pos.legs++;
          logger.info(`NW-watch ${tf}: TP1 hit @ ${mid.toFixed(2)} — banked 50%, stop moved to TP1`);
        }
        return;
      }
      const band = up(iLast);
      if (bar.high >= band) {
        const ret = pos.banked + 0.5 * (band - pos.entry) / pos.entry - (pos.legs + 1) * COST;
        st.equity += st.equity * 0.1 * cfg.leverage * ret;
        st.trades.push({ entryTime: pos.entryTime, exitTime: bar.time, entry: pos.entry, exit: band, reason: 'tp2', pctRet: ret });
        st.position = null;
        logger.info(`NW-watch ${tf}: closed TP2 @ ${band.toFixed(2)} (+${(ret * 100).toFixed(2)}%) — equity $${st.equity.toFixed(2)}`);
      }
      return;
    }

    // no position: look for a same-bar touch + RSI cross entry
    const touchLong = bar.low <= lo(iLast);
    const crossUp = rsi[iLast - 1] <= rMa[iLast - 1] && rsi[iLast] > rMa[iLast];
    if (touchLong && crossUp) {
      const entry = bar.close;
      const stop = entry * (1 - cfg.stopPct / 100);
      st.position = { entry, stop, entryTime: bar.time, tookTp1: false, legs: 1, banked: 0 };
      logger.info(`NW-watch ${tf}: ENTRY long @ ${entry.toFixed(2)}, stop ${stop.toFixed(2)} (band ${lo(iLast).toFixed(2)}, RSI crossed MA)`);
    }
  }

  /** One-line-per-timeframe status, for the SCAN heartbeat log. */
  summary(): string {
    const parts = Object.keys(TF_CONFIG).map((tf) => {
      const st = this.state[tf];
      if (!st) return `${tf}:-`;
      return `${tf}:$${st.equity.toFixed(0)}${st.position ? (st.position.tookTp1 ? '(runner)' : '(open)') : ''}`;
    });
    return `NW ${parts.join(' ')}`;
  }
}
