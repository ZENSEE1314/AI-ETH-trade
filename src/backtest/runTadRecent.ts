// TAD live-config backtest over a short recent window (default 30 days).
// Mirrors the deployed setup: 2h + 1h, BTC L+S / ETH L+S / BNB long-only,
// trailing Donchian-10 + hard 5% stop, 10% margin @ 10x, one position per coin.
// Shows every trade, with and without the UTC entry-hour whitelist.
//
//   npx tsx src/backtest/runTadRecent.ts [--days 30]

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
const DAYS = Number(arg('days', '30'));
// warmup bars so Donchian-20 / EMA-50 are valid at the window start
const WARMUP_MS = 60 * 24 * 3_600_000;

const COINS: { sym: string; long: boolean; short: boolean }[] = [
  { sym: 'BTCUSDT', long: true, short: true },
  { sym: 'ETHUSDT', long: true, short: true },
  { sym: 'BNBUSDT', long: true, short: false },
];

async function fetchTf(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - DAYS * 86_400_000 - WARMUP_MS;
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

interface T { sym: string; tf: string; side: 'long' | 'short'; entryTime: number; entry: number; exit: number; hour: number; rMultiple: number; pctReturn: number; bars: number; reason: string; }

function backtest(c: Candle[], sym: string, tf: string, allowLong: boolean, allowShort: boolean, windowStart: number): T[] {
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
        out.push({ sym, tf, side: pos.side, entryTime: c[pos.i].time, entry: pos.entry, exit: eff, hour: new Date(c[pos.i].time).getUTCHours(), rMultiple: net / risk, pctReturn: net, bars: i - pos.i, reason: eff === hf ? 'hard5%' : 'trail' });
        pos = null;
      } else continue;
    }
    if (pos || Number.isNaN(sma(vo, i, VOL_LEN)) || vo[i] <= sma(vo, i, VOL_LEN)) continue;
    let side: 'long' | 'short' | null = null;
    if (allowLong && lb(i) && !lb(i - 1)) side = 'long';
    else if (allowShort && sb(i) && !sb(i - 1)) side = 'short';
    if (!side) continue;
    if (c[i].time < windowStart) continue; // warmup only — no entries before the window
    const init = side === 'long' ? ll(c, i - DON_EXIT + 1, i) : hh(c, i - DON_EXIT + 1, i);
    const hf = side === 'long' ? c[i].close * (1 - HARD / 100) : c[i].close * (1 + HARD / 100);
    pos = { side, entry: c[i].close, i, stop: init, init: side === 'long' ? Math.max(init, hf) : Math.min(init, hf) };
  }
  return out;
}

function summarise(label: string, trades: T[]) {
  if (!trades.length) { console.log(`  ${label.padEnd(26)} 0 trades`); return; }
  const w = trades.filter((t) => t.pctReturn > 0).length;
  const totR = trades.reduce((s, t) => s + t.rMultiple, 0);
  let eq = 1000;
  for (const t of trades.slice().sort((a, b) => a.entryTime - b.entryTime)) eq += eq * 0.1 * 10 * t.pctReturn;
  console.log(`  ${label.padEnd(26)} ${String(trades.length).padStart(2)} trades · WR ${(w / trades.length * 100).toFixed(0)}% · totalR ${totR.toFixed(1)} · $1000→$${eq.toFixed(0)}`);
}

async function main() {
  const from = Date.now() - DAYS * 86_400_000;
  console.log(`\nTAD live config — last ${DAYS} days (${new Date(from).toISOString().slice(0, 10)} → today)`);
  console.log(`2h+1h · BTC L/S · ETH L/S · BNB long · trail Donchian-10 + hard 5% · 10% margin 10x\n`);

  const every: T[] = [];
  for (const co of COINS) {
    for (const tf of ['2h', '1h']) {
      const bars = await fetchTf(co.sym, tf);
      const tr = backtest(bars, co.sym, tf, co.long, co.short, from);
      every.push(...tr);
      for (const t of tr) {
        const inWl = WL[tf].includes(t.hour);
        console.log(
          `  ${new Date(t.entryTime).toISOString().slice(5, 16).replace('T', ' ')}  ${co.sym.replace('USDT', '').padEnd(3)} ${tf.padEnd(2)} ${t.side.toUpperCase().padEnd(5)} @${t.entry.toFixed(t.entry > 100 ? 0 : 2).padStart(8)}  ${String(t.hour).padStart(2)}h${inWl ? '✓' : ' '}  → ${t.reason.padEnd(6)} ${(t.pctReturn * 100 >= 0 ? '+' : '') + (t.pctReturn * 100).toFixed(2)}%  ${(t.rMultiple >= 0 ? '+' : '') + t.rMultiple.toFixed(2)}R  ${t.bars}b`,
        );
      }
    }
  }
  if (!every.length) console.log('  (no trades in the window)');

  console.log(`\n── summary ──`);
  summarise('ALL signals (no filter)', every);
  summarise('WHITELIST hours only', every.filter((t) => WL[t.tf].includes(t.hour)));
  summarise('  └ long only', every.filter((t) => t.side === 'long' && WL[t.tf].includes(t.hour)));
  console.log(`\n  by coin (whitelist):`);
  for (const co of COINS) summarise(`   ${co.sym}`, every.filter((t) => t.sym === co.sym && WL[t.tf].includes(t.hour)));
  console.log(`  by timeframe (whitelist):`);
  for (const tf of ['2h', '1h']) summarise(`   ${tf}`, every.filter((t) => t.tf === tf && WL[t.tf].includes(t.hour)));
  console.log(`\nNote: 1 month is a tiny sample — treat as a spot check, not evidence.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
