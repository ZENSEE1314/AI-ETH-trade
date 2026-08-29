// Load a 1m history from disk for backtesting / learning.
//
// Accepts what people actually have on hand:
//   • JSON — an array of {time,open,high,low,close,volume} objects, of
//     [time,open,high,low,close,volume] arrays, or {data|candles:[…]}.
//   • CSV  — including a TradingView chart export ("Export chart data…"): a
//     header row (time/open/high/low/close/Volume, extra indicator columns
//     ignored) then one bar per line. `time` may be a unix epoch (s or ms) or
//     an ISO-8601 datetime string.
//
// Times are normalised to epoch-ms and rows are sorted ascending.

import { readFile } from 'node:fs/promises';
import type { Candle } from '../types.js';

export async function loadCandles(path: string): Promise<Candle[]> {
  const text = await readFile(path, 'utf8');
  const head = text.trimStart()[0];
  const rows = head === '[' || head === '{' ? fromJson(text) : fromCsv(text);
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

function toMs(t: number): number {
  return t < 1e12 ? t * 1000 : t; // seconds → ms
}

/** Parse a time cell: epoch number (s/ms) or an ISO/date string. */
function parseTime(raw: string): number {
  const s = raw?.trim();
  if (!s) return NaN;
  const n = Number(s);
  if (Number.isFinite(n)) return toMs(n);
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : NaN;
}

function fromJson(text: string): Candle[] {
  const raw = JSON.parse(text);
  const rows: any[] = Array.isArray(raw) ? raw : raw.data ?? raw.candles ?? raw.bars ?? [];
  return rows
    .map((r): Candle | null => {
      const [time, open, high, low, close, volume] = Array.isArray(r)
        ? r
        : [r.time ?? r.t ?? r.ts, r.open ?? r.o, r.high ?? r.h, r.low ?? r.l, r.close ?? r.c, r.volume ?? r.v ?? 0];
      const t = typeof time === 'string' ? parseTime(time) : toMs(Number(time));
      const c = { time: t, open: +open, high: +high, low: +low, close: +close, volume: +volume || 0 };
      return [c.open, c.high, c.low, c.close, c.time].every(Number.isFinite) ? c : null;
    })
    .filter((c): c is Candle => c !== null);
}

function fromCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  // Column layout defaults to TradingView's order; a header row remaps by name.
  let col = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
  let start = 0;
  const firstCells = splitCsv(lines[0]);
  const isHeader = firstCells.some((c) => /[a-df-zA-DF-Z]/.test(c) && !isEpochish(c));
  if (isHeader) {
    start = 1;
    const h = firstCells.map((c) => c.trim().toLowerCase());
    const find = (...names: string[]) => {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    col = {
      time: find('time', 'date', 'datetime', 'timestamp', 'unix'),
      open: find('open', 'o'),
      high: find('high', 'h'),
      low: find('low', 'l'),
      close: find('close', 'c', 'price'),
      volume: find('volume', 'vol', 'v'),
    };
  }

  const out: Candle[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsv(lines[i]);
    const t = parseTime(cells[col.time]);
    const open = +cells[col.open];
    const high = +cells[col.high];
    const low = +cells[col.low];
    const close = +cells[col.close];
    const volume = col.volume >= 0 ? +cells[col.volume] || 0 : 0;
    if ([open, high, low, close, t].every(Number.isFinite)) {
      out.push({ time: t, open, high, low, close, volume });
    }
  }
  return out;
}

/** True if the cell reads like an epoch or ISO time (so it's not proof of a header). */
function isEpochish(c: string): boolean {
  const s = c.trim();
  return Number.isFinite(Number(s)) || /^\d{4}-\d{2}-\d{2}/.test(s);
}

/** Minimal CSV field split — handles simple double-quoted cells. */
function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
