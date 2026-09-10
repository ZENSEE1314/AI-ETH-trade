// List every NW-band + RSI-cross setup on recent 1h bars — entry, 0.5% stop,
// TP1 (middle band), TP2 (opposite band), and what actually happened. This is
// the "find me more trades like my 3" view: it shows the winners AND the
// losers, so the real hit-rate is visible, not just the highlight reel.
//
//   npx tsx src/backtest/runNwList.ts [--tf 1h] [--days 45] [--syms ETHUSDT,BTCUSDT,BNBUSDT]

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const COST = 7 / 10_000;

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TF = arg('tf', '1h');
const DAYS = Number(arg('days', '45'));
const SYMS = arg('syms', 'ETHUSDT,BTCUSDT,BNBUSDT').split(',');
const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };

// user's config: NW h8 mult3, RSI(ohlc4) len 3 crossing its SMA-14, 0.5% stop
const H = 8, MULT = 3, MAE_LEN = 100, RSI_LEN = 3, RSI_MA = 14, STOP_PCT = 0.5, ARM = 6, MAX_BARS = 48;

async function fetchK(sym: string): Promise<Candle[]> {
  const step = TF_MS[TF];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - (DAYS + 20) * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${sym}&interval=${TF}&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) byTime.set(Number(r[0]), { time: Number(r[0]), open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

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

async function main() {
  const since = Date.now() - DAYS * 86_400_000;
  console.log(`\nNW band + RSI(ohlc4,${RSI_LEN})×MA-${RSI_MA} setups · ${TF} · last ${DAYS}d · 0.5% stop · TP1 mid band · TP2 opposite band\n`);
  const rows: any[] = [];

  for (const sym of SYMS) {
    const c = await fetchK(sym);
    const cl = c.map((x) => x.close);
    const nw = nwCausal(cl);
    const rsi = rsiS(ohlc4(c), RSI_LEN);
    const rMa = rsi.map((_, i) => sma(rsi, i, RSI_MA));
    const mae = cl.map((_, i) => { const s = Math.max(0, i - MAE_LEN + 1); let a = 0; for (let j = s; j <= i; j++) a += Math.abs(cl[j] - nw[j]); return a / (i - s + 1); });
    const up = (i: number) => nw[i] + MULT * mae[i];
    const lo = (i: number) => nw[i] - MULT * mae[i];

    let arm: { side: 'long' | 'short'; bar: number } | null = null;
    for (let i = MAE_LEN + 5; i < c.length; i++) {
      const b = c[i];
      if (!arm) {
        // must CLOSE fully outside the band (not just wick-touch it)
        if (b.close > up(i)) arm = { side: 'short', bar: i };
        else if (b.close < lo(i)) arm = { side: 'long', bar: i };
        continue;
      }
      if (i - arm.bar > ARM) { arm = null; continue; }
      const cross = arm.side === 'long' ? rsi[i - 1] <= rMa[i - 1] && rsi[i] > rMa[i] : rsi[i - 1] >= rMa[i - 1] && rsi[i] < rMa[i];
      if (!cross) continue;
      const side = arm.side; arm = null;
      if (b.time < since) continue;
      const entry = b.close;
      const stop = side === 'long' ? entry * (1 - STOP_PCT / 100) : entry * (1 + STOP_PCT / 100);
      const tp1 = nw[i];
      const tp2 = side === 'long' ? up(i) : lo(i);
      const risk = Math.abs(entry - stop);
      // simulate forward
      let outcome = 'open', exit = entry, held = 0;
      for (let k = i + 1; k < Math.min(c.length, i + 1 + MAX_BARS); k++) {
        const x = c[k]; held = k - i;
        const hitStop = side === 'long' ? x.low <= stop : x.high >= stop;
        const hitTp1 = side === 'long' ? x.high >= tp1 : x.low <= tp1;
        const hitTp2 = side === 'long' ? x.high >= tp2 : x.low <= tp2;
        if (hitStop) { outcome = 'STOP'; exit = stop; break; }
        if (hitTp2) { outcome = 'TP2'; exit = tp2; break; }
        if (hitTp1) { outcome = 'TP1'; exit = tp1; break; }
        exit = x.close;
      }
      if (outcome === 'open') outcome = held >= MAX_BARS ? 'timeout' : 'open';
      const dir = side === 'long' ? 1 : -1;
      const rr = dir * (exit - entry) / risk - 2 * COST * (entry / risk);
      rows.push({ sym: sym.replace('USDT', ''), time: b.time, side, entry, stop, tp1, tp2, rr, outcome, held, rsi: rsi[i] });
    }
  }

  rows.sort((a, b) => a.time - b.time);
  console.log(`  date/time (UTC)    coin  side   entry     stop     TP1(mid)  TP2(band)  RSI   result   R`);
  let totR = 0, wins = 0;
  for (const r of rows) {
    totR += r.rr; if (r.rr > 0) wins++;
    const p = (n: number) => n.toFixed(n > 100 ? 0 : 2);
    console.log(
      `  ${new Date(r.time).toISOString().slice(0, 16).replace('T', ' ')}  ${r.sym.padEnd(4)} ${r.side.toUpperCase().padEnd(5)} ${p(r.entry).padStart(8)} ${p(r.stop).padStart(8)} ${p(r.tp1).padStart(9)} ${p(r.tp2).padStart(9)}  ${r.rsi.toFixed(0).padStart(3)}   ${r.outcome.padEnd(7)} ${(r.rr >= 0 ? '+' : '') + r.rr.toFixed(2)}`,
    );
  }
  console.log(`\n  ${rows.length} setups · ${wins} winners (${(wins / rows.length * 100).toFixed(0)}% WR) · net ${totR.toFixed(1)}R`);
  console.log(`  (your 3 screenshots were TP-hit trades; this shows the ones in between too)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
