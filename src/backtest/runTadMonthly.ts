// TAD live config — month-by-month for the last N months.
// 2h + 1h · BTC L/S · ETH L/S · BNB long · trail Donchian-10 + hard 5% ·
// UTC entry-hour whitelist · 10% margin @ 10x. One continuous backtest per
// (coin, timeframe); trades are bucketed by the calendar month of entry.
//
//   npx tsx src/backtest/runTadMonthly.ts [--months 12] [--nofilter]

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const COST = 7 / 10_000;
const DON_ENTRY = 20, DON_EXIT = 10, BB_LEN = 20, BB_SD = 1.0, EMA_LEN = 50, VOL_LEN = 20;
const HARD = 5;
const WL: Record<string, number[]> = { '1h': [3, 10, 12, 13, 15, 16], '2h': [2, 6, 12, 16, 18] };
const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000 };

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const MONTHS = Number(arg('months', '12'));
const NOFILTER = process.argv.includes('--nofilter');
const WARMUP_MS = 60 * 24 * 3_600_000;

const COINS = [
  { sym: 'BTCUSDT', long: true, short: true },
  { sym: 'ETHUSDT', long: true, short: true },
  { sym: 'BNBUSDT', long: true, short: false },
];

async function fetchTf(symbol: string, tf: string, sinceMs: number): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  let cursor = sinceMs - WARMUP_MS;
  const end = Date.now();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${tf}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r[0]);
      byTime.set(t, { time: t, open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    }
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ema(v: number[], len: number) {
  const k = 2 / (len + 1);
  const o: number[] = [];
  let p = v[0];
  for (let i = 0; i < v.length; i++) { p = i === 0 ? v[0] : v[i] * k + p * (1 - k); o.push(p); }
  return o;
}
const sma = (v: number[], i: number, l: number) => { if (i < l - 1) return NaN; let s = 0; for (let j = i - l + 1; j <= i; j++) s += v[j]; return s / l; };
const sd = (v: number[], i: number, l: number, m: number) => { let s = 0; for (let j = i - l + 1; j <= i; j++) s += (v[j] - m) ** 2; return Math.sqrt(s / l); };
const hh = (c: Candle[], a: number, b: number) => { let m = -Infinity; for (let j = a; j <= b; j++) m = Math.max(m, c[j].high); return m; };
const ll = (c: Candle[], a: number, b: number) => { let m = Infinity; for (let j = a; j <= b; j++) m = Math.min(m, c[j].low); return m; };

interface T { tf: string; side: 'long' | 'short'; entryTime: number; hour: number; rMultiple: number; pctReturn: number; }

function backtest(c: Candle[], tf: string, allowLong: boolean, allowShort: boolean, windowStart: number): T[] {
  const cl = c.map((x) => x.close);
  const vo = c.map((x) => x.volume);
  const e = ema(cl, EMA_LEN);
  const out: T[] = [];
  let pos: null | { side: 'long' | 'short'; entry: number; i: number; stop: number; init: number } = null;
  const lb = (i: number) => { const dh = hh(c, i - DON_ENTRY, i - 1); const m = sma(cl, i, BB_LEN); return cl[i] > dh && cl[i] > m + BB_SD * sd(cl, i, BB_LEN, m) && cl[i] > e[i]; };
  const sb = (i: number) => { const dl = ll(c, i - DON_ENTRY, i - 1); const m = sma(cl, i, BB_LEN); return cl[i] < dl && cl[i] < m - BB_SD * sd(cl, i, BB_LEN, m) && cl[i] < e[i]; };

  for (let i = Math.max(DON_ENTRY, EMA_LEN, BB_LEN, VOL_LEN) + 2; i < c.length; i++) {
    const bar = c[i];
    if (pos) {
      const tr = pos.side === 'long' ? ll(c, i - DON_EXIT, i - 1) : hh(c, i - DON_EXIT, i - 1);
      pos.stop = pos.side === 'long' ? Math.max(pos.stop, tr) : Math.min(pos.stop, tr);
      const hf = pos.side === 'long' ? pos.entry * (1 - HARD / 100) : pos.entry * (1 + HARD / 100);
      const eff = pos.side === 'long' ? Math.max(pos.stop, hf) : Math.min(pos.stop, hf);
      const hit = pos.side === 'long' ? bar.low <= eff : bar.high >= eff;
      if (hit) {
        const d = pos.side === 'long' ? 1 : -1;
        const net = d * (eff - pos.entry) / pos.entry - 2 * COST;
        const risk = Math.abs(pos.entry - pos.init) / pos.entry || 0.02;
        out.push({ tf, side: pos.side, entryTime: c[pos.i].time, hour: new Date(c[pos.i].time).getUTCHours(), rMultiple: net / risk, pctReturn: net });
        pos = null;
      } else continue;
    }
    if (pos || Number.isNaN(sma(vo, i, VOL_LEN)) || vo[i] <= sma(vo, i, VOL_LEN)) continue;
    let side: 'long' | 'short' | null = null;
    if (allowLong && lb(i) && !lb(i - 1)) side = 'long';
    else if (allowShort && sb(i) && !sb(i - 1)) side = 'short';
    if (!side || c[i].time < windowStart) continue;
    const init = side === 'long' ? ll(c, i - DON_EXIT + 1, i) : hh(c, i - DON_EXIT + 1, i);
    const hf = side === 'long' ? c[i].close * (1 - HARD / 100) : c[i].close * (1 + HARD / 100);
    pos = { side, entry: c[i].close, i, stop: init, init: side === 'long' ? Math.max(init, hf) : Math.min(init, hf) };
  }
  return out;
}

const ym = (ms: number) => new Date(ms).toISOString().slice(0, 7);

async function main() {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - (MONTHS - 1));
  const since = start.getTime();

  console.log(`\nTAD live config — monthly, last ${MONTHS} months from ${ym(since)}`);
  console.log(`2h+1h · BTC L/S · ETH L/S · BNB long · trail Donchian-10 + hard 5% · ${NOFILTER ? 'NO hour filter' : 'entry-hour whitelist'} · 10% margin 10x\n`);

  const all: T[] = [];
  for (const co of COINS) {
    for (const tf of ['2h', '1h']) {
      process.stdout.write(`  ${co.sym} ${tf} …`);
      const bars = await fetchTf(co.sym, tf, since);
      const tr = backtest(bars, tf, co.long, co.short, since);
      const kept = NOFILTER ? tr : tr.filter((t) => WL[tf].includes(t.hour));
      all.push(...kept);
      console.log(` ${bars.length} bars, ${tr.length} raw → ${kept.length} kept`);
    }
  }
  all.sort((a, b) => a.entryTime - b.entryTime);

  // month buckets
  const months: string[] = [];
  for (let m = 0; m < MONTHS; m++) {
    const d = new Date(since);
    d.setUTCMonth(d.getUTCMonth() + m);
    months.push(ym(d.getTime()));
  }

  console.log(`\n  month     trades  WR%   totalR   avgR    stand-alone $1000→   compounding equity`);
  console.log(`  ` + '─'.repeat(78));
  let eq = 1000;
  let totTrades = 0, totWins = 0, totR = 0;
  for (const mo of months) {
    const g = all.filter((t) => ym(t.entryTime) === mo);
    const w = g.filter((t) => t.pctReturn > 0).length;
    const r = g.reduce((s, t) => s + t.rMultiple, 0);
    let solo = 1000;
    for (const t of g) solo += solo * 0.1 * 10 * t.pctReturn;
    for (const t of g) eq += eq * 0.1 * 10 * t.pctReturn;
    totTrades += g.length; totWins += w; totR += r;
    const soloStr = g.length ? `$${solo.toFixed(0)}` : '—';
    console.log(
      `  ${mo}   ${String(g.length).padStart(4)}   ${g.length ? (w / g.length * 100).toFixed(0).padStart(3) : ' - '}  ${r.toFixed(1).padStart(7)}  ${g.length ? (r / g.length).toFixed(2).padStart(6) : '     -'}   ${soloStr.padStart(10)}          $${eq.toFixed(0)}`,
    );
  }
  console.log(`  ` + '─'.repeat(78));
  console.log(
    `  TOTAL    ${String(totTrades).padStart(4)}   ${(totWins / totTrades * 100).toFixed(0).padStart(3)}  ${totR.toFixed(1).padStart(7)}  ${(totR / totTrades).toFixed(2).padStart(6)}   ` +
    `                     $${eq.toFixed(0)}  (${((eq / 1000 - 1) * 100).toFixed(0)}% over ${MONTHS}mo)`,
  );
  const winMonths = months.filter((mo) => {
    const g = all.filter((t) => ym(t.entryTime) === mo);
    return g.length && g.reduce((s, t) => s + t.rMultiple, 0) > 0;
  }).length;
  const tradedMonths = months.filter((mo) => all.some((t) => ym(t.entryTime) === mo)).length;
  console.log(`\n  green months: ${winMonths}/${tradedMonths}   ·   compounding assumes every overlapping signal taken (live = 1/coin, so fewer)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
