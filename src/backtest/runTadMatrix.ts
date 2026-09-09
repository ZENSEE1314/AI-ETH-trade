// TAD system — full decision matrix.
//   3 coins (BTC/ETH/BNB) × {long-only, short-only, both} × 6 stop variants
//   × 8 leverages × {10% wallet fixed-margin, 95% fixed-margin}.
//
//   npx tsx src/backtest/runTadMatrix.ts [--tf 1d] [--start 1000]
//
// Isolated-margin model, compounding, one position at a time:
//   margin = equity * sizePct%
//   liquidation if worst adverse excursion in the trade ≥ ~100/leverage
//     → lose the committed margin (rest of the wallet survives), else
//   equity += margin * leverage * netPctReturn
//
// TAD entry: close > Donchian-20 high AND > BB(20,1.0) upper AND > EMA50 AND
//            volume > SMA(vol,20). Exit: trailing Donchian-10 (opposite band),
//            OR a fixed hard stop % from entry, whichever hits first.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TF = arg('tf', '1d');
const START = Number(arg('start', '1000'));
const COST = 7 / 10_000;

const DON_ENTRY = 20, DON_EXIT = 10, BB_LEN = 20, BB_SD = 1.0, EMA_LEN = 50, VOL_LEN = 20;
const DIRECTIONS = ['long', 'short', 'both'] as const;
const STOPS: { tag: string; hardPct: number }[] = [
  { tag: 'trail only', hardPct: 0 },
  { tag: 'hard 1%', hardPct: 1 },
  { tag: 'hard 2%', hardPct: 2 },
  { tag: 'hard 3%', hardPct: 3 },
  { tag: 'hard 5%', hardPct: 5 },
  { tag: 'hard 10%', hardPct: 10 },
];
const LEVS = [1, 2, 3, 5, 10, 20, 50, 100];
const MONEY: { tag: string; sizePct: number }[] = [
  { tag: '10% wallet margin', sizePct: 10 },
  { tag: '95% margin', sizePct: 95 },
];

const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000 };

async function fetchAll(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const capDays = tf === '1h' ? 1460 : 0;
  const byTime = new Map<number, Candle>();
  let cursor = capDays ? Date.now() - capDays * 86_400_000 : Date.parse('2017-07-01');
  const end = Date.now();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${tf}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
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

function ema(vals: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
const sma = (v: number[], i: number, len: number) => { if (i < len - 1) return NaN; let s = 0; for (let j = i - len + 1; j <= i; j++) s += v[j]; return s / len; };
const stdev = (v: number[], i: number, len: number, m: number) => { let s = 0; for (let j = i - len + 1; j <= i; j++) s += (v[j] - m) ** 2; return Math.sqrt(s / len); };
const hh = (c: Candle[], i: number, len: number) => { let m = -Infinity; for (let j = i - len + 1; j <= i; j++) m = Math.max(m, c[j].high); return m; };
const ll = (c: Candle[], i: number, len: number) => { let m = Infinity; for (let j = i - len + 1; j <= i; j++) m = Math.min(m, c[j].low); return m; };

interface Trade { side: 'long' | 'short'; pctReturn: number; maePct: number; win: boolean; }

function backtest(c: Candle[], dir: (typeof DIRECTIONS)[number], hardPct: number): Trade[] {
  const closes = c.map((x) => x.close);
  const vols = c.map((x) => x.volume);
  const ema50 = ema(closes, EMA_LEN);
  const allowLong = dir === 'long' || dir === 'both';
  const allowShort = dir === 'short' || dir === 'both';
  const trades: Trade[] = [];
  let pos: null | { side: 'long' | 'short'; entry: number; entryIdx: number; stop: number; hard: number; worstAdv: number } = null;

  for (let i = Math.max(DON_ENTRY, EMA_LEN, BB_LEN, VOL_LEN) + 1; i < c.length; i++) {
    const bar = c[i];
    const mid = sma(closes, i, BB_LEN);
    const sd = stdev(closes, i, BB_LEN, mid);
    const bbUp = mid + BB_SD * sd, bbDn = mid - BB_SD * sd;
    const donHi = hh(c, i - 1, DON_ENTRY), donLo = ll(c, i - 1, DON_ENTRY);
    const volAvg = sma(vols, i, VOL_LEN);

    if (pos) {
      const advPx = pos.side === 'long' ? bar.low : bar.high;
      const adv = pos.side === 'long' ? (pos.entry - advPx) / pos.entry * 100 : (advPx - pos.entry) / pos.entry * 100;
      if (adv > pos.worstAdv) pos.worstAdv = adv;

      const trail = pos.side === 'long' ? ll(c, i - 1, DON_EXIT) : hh(c, i - 1, DON_EXIT);
      pos.stop = pos.side === 'long' ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
      const effStop = pos.hard > 0
        ? (pos.side === 'long' ? Math.max(pos.stop, pos.hard) : Math.min(pos.stop, pos.hard))
        : pos.stop;
      const hit = pos.side === 'long' ? bar.low <= effStop : bar.high >= effStop;
      if (hit) {
        const dirMul = pos.side === 'long' ? 1 : -1;
        const net = dirMul * (effStop - pos.entry) / pos.entry - 2 * COST;
        trades.push({ side: pos.side, pctReturn: net, maePct: pos.worstAdv, win: net > 0 });
        pos = null;
      } else continue;
    }
    if (pos || Number.isNaN(volAvg) || sd === 0) continue;

    const volOk = bar.volume > volAvg;
    const longSig = allowLong && bar.close > donHi && bar.close > bbUp && bar.close > ema50[i] && volOk;
    const shortSig = allowShort && bar.close < donLo && bar.close < bbDn && bar.close < ema50[i] && volOk;
    if (longSig) {
      pos = { side: 'long', entry: bar.close, entryIdx: i, stop: ll(c, i, DON_EXIT), hard: hardPct > 0 ? bar.close * (1 - hardPct / 100) : 0, worstAdv: 0 };
    } else if (shortSig) {
      pos = { side: 'short', entry: bar.close, entryIdx: i, stop: hh(c, i, DON_EXIT), hard: hardPct > 0 ? bar.close * (1 + hardPct / 100) : 0, worstAdv: 0 };
    }
  }
  if (pos) {
    const bar = c[c.length - 1];
    const dirMul = pos.side === 'long' ? 1 : -1;
    const net = dirMul * (bar.close - pos.entry) / pos.entry - 2 * COST;
    trades.push({ side: pos.side, pctReturn: net, maePct: pos.worstAdv, win: net > 0 });
  }
  return trades;
}

function sim(trades: Trade[], sizePct: number, lev: number) {
  let eq = START, peak = START, maxDdPct = 0, wins = 0, liq = 0;
  const liqThresh = 100 / lev - (lev >= 50 ? 0.5 : lev >= 10 ? 0.3 : 0.1);
  for (const t of trades) {
    const margin = eq * (sizePct / 100);
    if (lev > 1 && t.maePct >= liqThresh) { eq -= margin; liq++; }
    else { eq += margin * lev * t.pctReturn; if (t.pctReturn > 0) wins++; }
    if (eq < 0) eq = 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (peak - eq) / peak * 100);
    if (eq === 0) break;
  }
  return { eq, wins, n: trades.length, maxDdPct, liq };
}

function fmt(n: number) {
  if (n <= 0) return 'DEAD';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

async function main() {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`TAD SYSTEM DECISION MATRIX — ${TF} bars · $${START} start · 7bps/side · compounding`);
  console.log(`entry: Donchian-20 break + BB(20,1.0) + EMA50 + volume · exit: Donchian-10 trail (+ hard stop)`);
  console.log(`${'='.repeat(78)}`);

  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    process.stdout.write(`fetching ${s} ${TF} …`);
    data[s] = await fetchAll(s, TF);
    const y = (data[s].at(-1)!.time - data[s][0].time) / (365.25 * 86_400_000);
    console.log(` ${data[s].length} bars, ~${y.toFixed(1)}y, buy&hold ${(data[s].at(-1)!.close / data[s][0].close).toFixed(0)}x`);
  }

  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const years = (data[sym].at(-1)!.time - data[sym][0].time) / (365.25 * 86_400_000);
    for (const dir of DIRECTIONS) {
      console.log(`\n\n█ ${coin}  ·  ${dir.toUpperCase()}${dir === 'both' ? ' (long+short)' : dir === 'long' ? ' (long-only)' : ' (short-only)'}  ·  ~${years.toFixed(1)} years`);
      // per-stop trade stats (independent of leverage/money)
      const perStop: Record<string, Trade[]> = {};
      console.log(`  ${'stop'.padEnd(11)} ${'trades'.padStart(6)} ${'WR%'.padStart(6)} ${'avgWin%'.padStart(8)} ${'avgLoss%'.padStart(9)} ${'totRet%'.padStart(8)}`);
      for (const st of STOPS) {
        const tr = backtest(data[sym], dir, st.hardPct);
        perStop[st.tag] = tr;
        const w = tr.filter((t) => t.pctReturn > 0);
        const l = tr.filter((t) => t.pctReturn <= 0);
        const aw = w.reduce((s, t) => s + t.pctReturn, 0) / (w.length || 1) * 100;
        const al = l.reduce((s, t) => s + t.pctReturn, 0) / (l.length || 1) * 100;
        const tot = tr.reduce((s, t) => s + t.pctReturn, 0) * 100;
        console.log(`  ${st.tag.padEnd(11)} ${String(tr.length).padStart(6)} ${(tr.length ? (w.length / tr.length * 100).toFixed(0) : '0').padStart(6)} ${('+' + aw.toFixed(1)).padStart(8)} ${al.toFixed(1).padStart(9)} ${(tot >= 0 ? '+' : '') + tot.toFixed(0).padStart(7)}`);
      }
      // money × leverage grid, per money model: rows = stop, cols = leverage → final equity
      for (const m of MONEY) {
        console.log(`\n  ── ${m.tag} · $${START} → final equity (│ = liquidations, DEAD = wiped) ──`);
        console.log(`  ${'stop'.padEnd(11)} ` + LEVS.map((L) => `${L}x`.padStart(8)).join(''));
        for (const st of STOPS) {
          const cells = LEVS.map((L) => {
            const r = sim(perStop[st.tag], m.sizePct, L);
            const tag = fmt(r.eq) + (r.liq > 0 && r.eq > 0 ? `│${r.liq}` : '');
            return tag.padStart(8);
          });
          console.log(`  ${st.tag.padEnd(11)} ` + cells.join(''));
        }
        // matching max-drawdown row-set for the best-ish leverages
        console.log(`  ${'(maxDD%)'.padEnd(11)} ` + LEVS.map((L) => {
          const r = sim(perStop[STOPS[1].tag], m.sizePct, L); // use hard-1% as the DD reference
          return `${r.maxDdPct.toFixed(0)}%`.padStart(8);
        }).join('') + '   ← for hard-1%');
      }
    }
  }
  console.log(`\n\nNote: CAGR from any final F over ~${'~'}years = (F/1000)^(1/years) - 1. Short-only and high`);
  console.log(`leverage rows are shown for completeness — read WR + maxDD + liquidations, not just final $.`);
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
