// Winner/loser anatomy of the green→red travel — "capture only the wins".
//
// For every bullish 15M green-line→red-line attempt (a fresh HL under a standing
// swing high) it records a wide indicator panel at the decision bar, simulates
// the trade (SL = 25% of the range, TP = the red line, 5.5 bps/side), then:
//   1. tables win-rate + mean net-R for every indicator bucket,
//   2. greedy-searches the filter stack that maximises captured R,
//   3. applies that stack out-of-sample to a second file.
//
//   npx tsx src/backtest/studyStructure.ts data/eth-1m-90d.json data/eth-jan2026.json

import { loadCandles } from './loadCandles.js';
import { resample } from './resample.js';
import { findSwings, readStructure } from '../strategy/structure.js';
import { ema } from '../strategy/ema.js';
import { computeVwap } from '../strategy/vwap.js';
import type { Candle } from '../types.js';

const LB = 2;
const MAX_HOLD = 960; // 15M bars (~10 days) to resolve
const FEE = 0.11 / 100; // round-trip
const SL_RANGE = 0.25; // stop = 25% of the green→red range

interface Attempt {
  hitTravel: boolean; // tagged red before breaking green (the raw 47.5% base rate)
  outcome: 'win' | 'loss' | 'timeout';
  rNet: number;
  f: Record<string, number>; // indicator panel (numbers; booleans as 0/1)
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const trendNum = (t: string) => (t === 'bullish' ? 1 : t === 'bearish' ? -1 : 0);

function atrPct(c: Candle[], n = 14): number {
  if (c.length < n + 1) return NaN;
  let s = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    s += tr;
  }
  return (s / n / c.at(-1)!.close) * 100;
}

function collect(m1: Candle[]): Attempt[] {
  const m15 = resample(m1, 15);
  const h1 = resample(m1, 60);
  const h4 = resample(m1, 240);
  const d1 = resample(m1, 1440);
  const tfAt = (tf: Candle[], t: number) => {
    let k = 0;
    for (let i = 0; i < tf.length; i++) if (tf[i].time <= t) k = i; else break;
    return tf.slice(0, k + 1);
  };

  const swings = findSwings(m15, LB);
  const out: Attempt[] = [];

  for (let si = 1; si < swings.length; si++) {
    const sw = swings[si];
    if (sw.kind !== 'low') continue;
    const at = sw.index + LB;
    if (at >= m15.length - 5) continue;
    const hist = m15.slice(0, at + 1);
    const st = readStructure(hist, LB);
    if (st.trend !== 'bullish' || !st.lastSwingHigh) continue;

    const green = sw.price;
    const red = st.lastSwingHigh.price;
    if (red <= green) continue;
    const range = red - green;
    const px = m15[at].close;
    if (px <= green || px >= red) continue;

    // ---- simulate: SL 25% of range, TP = red line ----
    const stop = px - range * SL_RANGE;
    const risk = px - stop;
    if (risk <= 0) continue;
    let outcome: Attempt['outcome'] = 'timeout';
    let exit = m15[Math.min(at + MAX_HOLD, m15.length - 1)].close;
    let hitTravel = false;
    for (let j = at + 1; j < Math.min(at + MAX_HOLD, m15.length); j++) {
      if (!hitTravel && m15[j].low < green) { /* travel failed later checks */ }
      if (m15[j].low <= stop) { outcome = 'loss'; exit = stop; break; }
      if (m15[j].high >= red) { outcome = 'win'; exit = red; hitTravel = true; break; }
    }
    for (let j = at + 1; j < Math.min(at + MAX_HOLD, m15.length); j++) {
      if (m15[j].low < green) break;
      if (m15[j].high >= red) { hitTravel = true; break; }
    }
    const rGross = (exit - px) / risk;
    const rNet = rGross - FEE * (px / risk) * 2;

    // ---- indicator panel at the decision bar ----
    const h1h = tfAt(h1, m15[at].time);
    const h4h = tfAt(h4, m15[at].time);
    const d1h = tfAt(d1, m15[at].time);
    const closes15 = hist.map((c) => c.close);
    const closes1h = h1h.map((c) => c.close);
    const e200_1h = ema(closes1h, 200);
    const e200_1h_prev = ema(closes1h.slice(0, -5), 200);
    const e50_15 = ema(closes15, 50);
    const day = Math.floor(m15[at].time / 86_400_000);
    const vw = computeVwap(hist.filter((c) => Math.floor(c.time / 86_400_000) === day));

    const sinceGreen = hist.slice(sw.index);
    const priorTouches = sinceGreen.filter((c) => Math.abs(c.low - green) / green <= 0.002).length;
    const lowerLows = swings.filter((s) => s.kind === 'low' && s.index < sw.index).map((s) => s.price);
    const nearestLower = lowerLows.length ? Math.max(...lowerLows.filter((p) => p < green)) : NaN;
    const sweptLower = Number.isFinite(nearestLower)
      ? sinceGreen.slice(0, 20).some((c) => c.low <= nearestLower) && px > nearestLower
      : false;

    const f: Record<string, number> = {
      rangePct: (range / green) * 100,
      entryDepthPct: ((px - green) / range) * 100,
      dist2greenPct: ((px - green) / px) * 100,
      h1: trendNum(readStructure(h1h, LB).trend),
      h4: trendNum(readStructure(h4h, LB).trend),
      d1: trendNum(readStructure(d1h, LB).trend),
      alignUp: 0, // filled below
      ema200_1h: e200_1h != null ? (h1h.at(-1)!.close > e200_1h ? 1 : -1) : 0,
      ema200_1h_up: e200_1h != null && e200_1h_prev != null ? (e200_1h > e200_1h_prev ? 1 : 0) : 0,
      ema50_15: e50_15 != null ? (px > e50_15 ? 1 : -1) : 0,
      vwapAbove: vw.vwap > 0 ? (px > vw.vwap ? 1 : 0) : 0,
      hourUtc: new Date(m15[at].time).getUTCHours(),
      dow: new Date(m15[at].time).getUTCDay(),
      volRatio: m15[at].volume / (mean(m15.slice(at - 20, at).map((c) => c.volume)) || 1),
      atrPct: atrPct(hist),
      greenAgeBars: at - sw.index,
      priorTouches,
      sweptLower: sweptLower ? 1 : 0,
      bodyPct: (Math.abs(m15[at].close - m15[at].open) / Math.max(m15[at].high - m15[at].low, 1e-9)) * 100,
    };
    f.alignUp = [f.h1, f.h4, f.d1].filter((x) => x > 0).length;
    out.push({ hitTravel, outcome, rNet, f });
  }
  return out;
}

// ---- reporting ----------------------------------------------------------
const wr = (g: Attempt[]) => (g.length ? (100 * g.filter((a) => a.rNet > 0).length / g.length).toFixed(0) + '%' : '-');
const exp = (g: Attempt[]) => (g.length ? mean(g.map((a) => a.rNet)).toFixed(3) : '-');
const tot = (g: Attempt[]) => g.reduce((s, a) => s + a.rNet, 0).toFixed(1);
const line = (label: string, g: Attempt[]) =>
  console.log(`   ${label.padEnd(30)} n=${String(g.length).padStart(4)}  wr=${wr(g).padStart(4)}  exp=${exp(g).padStart(7)}  totR=${tot(g).padStart(6)}`);

interface Filt { name: string; test: (a: Attempt) => boolean }

function candidateFilters(all: Attempt[]): Filt[] {
  const med = (k: string) => median(all.map((a) => a.f[k]).filter(Number.isFinite));
  const mkC = (k: string, op: '<=' | '>=', v: number, lbl?: string): Filt => ({
    name: lbl ?? `${k} ${op} ${v.toFixed(2)}`,
    test: (a) => (op === '<=' ? a.f[k] <= v : a.f[k] >= v),
  });
  return [
    mkC('entryDepthPct', '<=', 40), mkC('entryDepthPct', '<=', 55), mkC('entryDepthPct', '>=', 45),
    mkC('rangePct', '>=', 0.6), mkC('rangePct', '>=', 0.8), mkC('rangePct', '<=', 1.5),
    { name: 'h1 bullish', test: (a) => a.f.h1 > 0 },
    { name: 'h4 not bearish', test: (a) => a.f.h4 >= 0 },
    { name: 'd1 not bearish', test: (a) => a.f.d1 >= 0 },
    { name: 'align >= 2', test: (a) => a.f.alignUp >= 2 },
    { name: 'align == 3', test: (a) => a.f.alignUp === 3 },
    { name: 'price > 1H EMA200', test: (a) => a.f.ema200_1h > 0 },
    { name: '1H EMA200 rising', test: (a) => a.f.ema200_1h_up > 0 },
    { name: 'price > 15M EMA50', test: (a) => a.f.ema50_15 > 0 },
    { name: 'price > VWAP', test: (a) => a.f.vwapAbove > 0 },
    { name: 'hour 00-17 UTC', test: (a) => a.f.hourUtc < 17 },
    { name: 'hour 07-16 UTC', test: (a) => a.f.hourUtc >= 7 && a.f.hourUtc < 16 },
    mkC('volRatio', '>=', 1.0, 'vol >= 1.0x avg'), mkC('volRatio', '<=', 1.6, 'vol <= 1.6x avg'),
    mkC('atrPct', '<=', med('atrPct'), 'ATR <= median (calm)'),
    mkC('atrPct', '>=', med('atrPct'), 'ATR >= median (active)'),
    { name: 'green age <= 20 bars', test: (a) => a.f.greenAgeBars <= 20 },
    { name: 'prior touches <= 1', test: (a) => a.f.priorTouches <= 1 },
    { name: 'swept a lower low first', test: (a) => a.f.sweptLower > 0 },
    mkC('bodyPct', '>=', 45, 'entry body >= 45%'),
    { name: 'not Fri/Sat/Sun', test: (a) => a.f.dow >= 1 && a.f.dow <= 4 },
  ];
}

function greedy(all: Attempt[], cands: Filt[], maxFilters = 6): Filt[] {
  let cur = all;
  const chosen: Filt[] = [];
  for (let step = 0; step < maxFilters; step++) {
    let best: { f: Filt; g: Attempt[]; score: number } | null = null;
    const floor = Math.max(20, Math.round(all.length * 0.15));
    for (const f of cands) {
      if (chosen.includes(f)) continue;
      const g = cur.filter(f.test);
      if (g.length < floor) continue;
      const score = g.reduce((s, a) => s + a.rNet, 0);
      if (!best || score > best.score) best = { f, g, score };
    }
    const curTot = cur.reduce((s, a) => s + a.rNet, 0);
    if (!best || best.score <= curTot + 0.5) break;
    chosen.push(best.f);
    cur = best.g;
  }
  return chosen;
}

async function main() {
  const [pathA, pathB] = [process.argv[2] ?? 'data/eth-1m-90d.json', process.argv[3]];
  const A = collect(await loadCandles(pathA));

  console.log(`\n=== ${pathA} — ${A.length} bullish green→red attempts ===`);
  line('ALL', A);
  console.log(`   raw travel-completion (green→red tag): ${(100 * A.filter((a) => a.hitTravel).length / A.length).toFixed(1)}%\n`);

  console.log('  BY INDICATOR BUCKET (net R, 5.5bps):');
  for (const f of candidateFilters(A)) line(f.name, A.filter(f.test));

  const stack = greedy(A, candidateFilters(A));
  console.log('\n  GREEDY WINNERS-ONLY STACK:');
  let g = A;
  for (const f of stack) {
    g = g.filter(f.test);
    line('+ ' + f.name, g);
  }
  console.log(`\n  RESULT: from ${A.length} trades (exp ${exp(A)}) → ${g.length} trades (exp ${exp(g)}, totR ${tot(g)}, wr ${wr(g)})`);

  if (pathB) {
    const B = collect(await loadCandles(pathB));
    let gb = B;
    for (const f of stack) gb = gb.filter(f.test);
    console.log(`\n  OUT-OF-SAMPLE ${pathB}: all ${B.length} (exp ${exp(B)}) → filtered ${gb.length} (exp ${exp(gb)}, totR ${tot(gb)}, wr ${wr(gb)})`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('study failed:', (e as Error).message);
  process.exit(1);
});
