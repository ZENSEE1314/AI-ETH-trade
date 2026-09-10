// Stricter version of the NW-band + RSI fade — sweep filters to see if a
// selective rule set raises the win rate above the 38% the raw scan gives.
//
//   npx tsx src/backtest/runNwFilter.ts [--tf 1h,2h,4h] [--days 400]
//
// Filters tried (on top of: NW band tag + RSI(ohlc4,3) crosses its MA):
//   range   — ADX(14) < adxMax AND NW slope over 20 bars flat (< slopeMax%)
//   deep    — price pierced the band by ≥ deepPct% of price (not a mere touch)
//   rsiExt  — RSI(3) actually ≤ rsiLo (long) / ≥ rsiHi (short) at entry
//   trend   — only with the 200-EMA trend (long above / short below)
//   stop    — 0.5% / 1% / 1.5%
// Exit: TP1 = middle band (bank 50%, trail runner to +75% of TP1), TP2 = band.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const COST = 7 / 10_000;
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TFS = arg('tf', '1h,2h,4h').split(',');
const DAYS = Number(arg('days', '400'));
const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };

const H = 8, MULT = 3, MAE_LEN = 100, RSI_LEN = 3, RSI_MA = 14, ARM = 6, MAX_BARS = 48;

async function fetchK(sym: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - (DAYS + 30) * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${sym}&interval=${tf}&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
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
  for (let i = 0; i < cl.length; i++) { let num = 0, den = 0; for (let j = Math.max(0, i - span); j <= i; j++) { const w = Math.exp(-((i - j) ** 2) / (2 * H * H)); num += cl[j] * w; den += w; } out[i] = num / den; }
  return out;
}
function rsiS(v: number[], len: number): number[] {
  const out = new Array(v.length).fill(50);
  if (v.length < len + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len; out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (len - 1) + (d > 0 ? d : 0)) / len; l = (l * (len - 1) + (d < 0 ? -d : 0)) / len; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
function ema(v: number[], len: number) { const k = 2 / (len + 1); const o: number[] = []; let p = v[0]; for (let i = 0; i < v.length; i++) { p = i === 0 ? v[0] : v[i] * k + p * (1 - k); o.push(p); } return o; }
function adxS(c: Candle[], period = 14): number[] {
  const n = c.length; const adx = new Array(n).fill(0); if (n < period * 2) return adx;
  let tr = 0, pl = 0, mi = 0; const dx = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const u = c[i].high - c[i - 1].high, d = c[i - 1].low - c[i].low;
    const pdm = u > d && u > 0 ? u : 0, mdm = d > u && d > 0 ? d : 0;
    const t = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i <= period) { tr += t; pl += pdm; mi += mdm; } else { tr = tr - tr / period + t; pl = pl - pl / period + pdm; mi = mi - mi / period + mdm; }
    if (i >= period) { const pdi = 100 * pl / tr, mdi = 100 * mi / tr; dx[i] = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi); }
  }
  let a = 0; for (let i = period; i < period * 2 && i < n; i++) a += dx[i];
  adx[period * 2 - 1] = a / period;
  for (let i = period * 2; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return adx;
}
const ohlc4 = (c: Candle[]) => c.map((b) => (b.open + b.high + b.low + b.close) / 4);
const sma = (v: number[], i: number, len: number) => { const s = Math.max(0, i - len + 1); let a = 0; for (let j = s; j <= i; j++) a += v[j]; return a / (i - s + 1); };

interface F { name: string; range?: boolean; deep?: number; rsiExt?: boolean; trend?: 'with' | 'against'; stop: number; side?: 'long' | 'short'; }
const FILTERS: F[] = [
  { name: 'raw (0.5% stop)', stop: 0.5 },
  { name: 'stop 1%', stop: 1 },
  { name: 'stop 1.5%', stop: 1.5 },
  { name: 'range only', range: true, stop: 1 },
  { name: 'deep pierce 0.3%', deep: 0.3, stop: 1 },
  { name: 'RSI extreme', rsiExt: true, stop: 1 },
  { name: 'with-trend (EMA200)', trend: 'with', stop: 1 },
  { name: 'range + deep', range: true, deep: 0.3, stop: 1 },
  { name: 'range + RSI ext', range: true, rsiExt: true, stop: 1 },
  { name: 'range + deep + RSI ext', range: true, deep: 0.3, rsiExt: true, stop: 1 },
  { name: 'range+deep+RSIext LONG', range: true, deep: 0.3, rsiExt: true, stop: 1, side: 'long' },
  { name: 'range+deep+RSIext SHORT', range: true, deep: 0.3, rsiExt: true, stop: 1, side: 'short' },
  { name: 'all filters, stop 1.5%', range: true, deep: 0.3, rsiExt: true, stop: 1.5 },
];

interface T { side: 'long' | 'short'; rr: number; pctRet: number; }
function run(c: Candle[], f: F): T[] {
  const cl = c.map((x) => x.close);
  const nw = nwCausal(cl);
  const rsi = rsiS(ohlc4(c), RSI_LEN);
  const rMa = rsi.map((_, i) => sma(rsi, i, RSI_MA));
  const mae = cl.map((_, i) => { const s = Math.max(0, i - MAE_LEN + 1); let a = 0; for (let j = s; j <= i; j++) a += Math.abs(cl[j] - nw[j]); return a / (i - s + 1); });
  const adx = adxS(c);
  const e200 = ema(cl, 200);
  const up = (i: number) => nw[i] + MULT * mae[i];
  const lo = (i: number) => nw[i] - MULT * mae[i];
  const out: T[] = [];
  let arm: { side: 'long' | 'short'; bar: number } | null = null;

  for (let i = Math.max(MAE_LEN, 210) + 5; i < c.length; i++) {
    const b = c[i];
    if (!arm) {
      if (b.high >= up(i)) arm = { side: 'short', bar: i };
      else if (b.low <= lo(i)) arm = { side: 'long', bar: i };
      continue;
    }
    if (i - arm.bar > ARM) { arm = null; continue; }
    const cross = arm.side === 'long' ? rsi[i - 1] <= rMa[i - 1] && rsi[i] > rMa[i] : rsi[i - 1] >= rMa[i - 1] && rsi[i] < rMa[i];
    if (!cross) continue;
    const side = arm.side; arm = null;
    if (f.side && side !== f.side) continue;

    // filters
    if (f.range) {
      const slope = Math.abs(nw[i] - nw[i - 20]) / cl[i] * 100;
      if (adx[i] >= 25 || slope > 1.2) continue;
    }
    if (f.deep) {
      const pierce = side === 'long' ? (lo(i) - b.low) / cl[i] * 100 : (b.high - up(i)) / cl[i] * 100;
      if (pierce < f.deep) continue;
    }
    if (f.rsiExt) {
      if (side === 'long' && rsi[i] > 20) continue;
      if (side === 'short' && rsi[i] < 80) continue;
    }
    if (f.trend === 'with') {
      if (side === 'long' && cl[i] < e200[i]) continue;
      if (side === 'short' && cl[i] > e200[i]) continue;
    }

    const entry = b.close;
    const stop = side === 'long' ? entry * (1 - f.stop / 100) : entry * (1 + f.stop / 100);
    const risk = Math.abs(entry - stop);
    const dir = side === 'long' ? 1 : -1;
    let banked = 0, remaining = 1, curStop = stop, tookTp1 = false, exitPx = entry, legs = 1;
    for (let k = i + 1; k < Math.min(c.length, i + 1 + MAX_BARS); k++) {
      const x = c[k];
      const hitStop = side === 'long' ? x.low <= curStop : x.high >= curStop;
      if (hitStop) { banked += remaining * dir * (curStop - entry) / entry; remaining = 0; exitPx = curStop; break; }
      if (!tookTp1) {
        const mid = nw[k];
        const hitMid = side === 'long' ? x.high >= mid : x.low <= mid;
        if (hitMid) { banked += 0.5 * dir * (mid - entry) / entry; remaining -= 0.5; curStop = entry + dir * 0.75 * Math.abs(mid - entry); tookTp1 = true; legs++; continue; }
      } else {
        const band = side === 'long' ? up(k) : lo(k);
        const hitBand = side === 'long' ? x.high >= band : x.low <= band;
        if (hitBand) { banked += remaining * dir * (band - entry) / entry; remaining = 0; exitPx = band; legs++; break; }
      }
      exitPx = x.close;
    }
    if (remaining > 0) { banked += remaining * dir * (exitPx - entry) / entry; }
    const net = banked - legs * COST;
    out.push({ side, rr: net / (risk / entry), pctRet: net });
  }
  return out;
}

function summary(ts: T[]) {
  const n = ts.length;
  const w = ts.filter((t) => t.pctRet > 0).length;
  const gW = ts.filter((t) => t.rr > 0).reduce((s, t) => s + t.rr, 0);
  const gL = -ts.filter((t) => t.rr < 0).reduce((s, t) => s + t.rr, 0);
  let eq = 1000;
  for (const t of ts) { eq += eq * 0.1 * 10 * t.pctRet; if (eq < 0) eq = 0; }
  return { n, wr: n ? w / n * 100 : 0, pf: gL > 0 ? gW / gL : n ? 99 : 0, totR: ts.reduce((s, t) => s + t.rr, 0), eq };
}

async function main() {
  console.log(`\nNW band + RSI(ohlc4,3) fade — FILTER SWEEP · BTC+ETH+BNB · ${DAYS}d · TP1 mid / TP2 band · 10% margin @10x\n`);
  for (const tf of TFS) {
    console.log(`═══ ${tf} ═══`);
    const data: Record<string, Candle[]> = {};
    for (const s of SYMS) data[s] = await fetchK(s, tf);
    const months = DAYS / 30.44;
    console.log(`  ${'filter'.padEnd(26)} ${'n'.padStart(4)}  ${'WR%'.padStart(4)}  ${'PF'.padStart(5)}  ${'totR'.padStart(6)}   $1k→(10x)   $/mo`);
    for (const f of FILTERS) {
      const all: T[] = [];
      for (const s of SYMS) all.push(...run(data[s], f));
      const st = summary(all);
      const perMo = (st.eq - 1000) / months;
      const mk = st.pf >= 1 && st.n >= 15 ? ' ★' : '';
      console.log(`  ${f.name.padEnd(26)} ${String(st.n).padStart(4)}  ${st.wr.toFixed(0).padStart(4)}  ${st.pf.toFixed(2).padStart(5)}  ${st.totR.toFixed(0).padStart(6)}   $${st.eq.toFixed(0).padStart(7)}   ${perMo >= 0 ? '+' : ''}$${perMo.toFixed(0)}${mk}`);
    }
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
