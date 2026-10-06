// Read-only Polymarket client: market metadata (Gamma API) and order books
// (CLOB API). Both endpoints are public — no wallet, key or signature needed.

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

export interface PolyMarket {
  slug: string;
  question: string;
  endMs: number;
  closed: boolean;
  outcomes: string[]; // e.g. ["Up", "Down"]
  tokenIds: string[]; // same order as outcomes
  outcomePrices: number[]; // after resolution: [1, 0] or [0, 1]
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  bestAsk: BookLevel | null;
  bestBid: BookLevel | null;
}

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Gamma returns some arrays as JSON-encoded strings ("[\"Up\",\"Down\"]"). */
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseMarket(raw: Record<string, unknown>): PolyMarket | null {
  const tokenIds = arr(raw.clobTokenIds);
  const outcomes = arr(raw.outcomes);
  const endMs = Date.parse(String(raw.endDate ?? raw.end_date_iso ?? ''));
  if (tokenIds.length !== 2 || outcomes.length !== 2 || !Number.isFinite(endMs)) return null;
  return {
    slug: String(raw.slug ?? ''),
    question: String(raw.question ?? raw.slug ?? ''),
    endMs,
    closed: raw.closed === true,
    outcomes,
    tokenIds,
    outcomePrices: arr(raw.outcomePrices).map(Number),
  };
}

/** Look a market up by slug; falls back to the event endpoint (markets nested under the event). */
export async function fetchMarketBySlug(slug: string): Promise<PolyMarket | null> {
  const direct = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  if (Array.isArray(direct) && direct.length) {
    const m = parseMarket(direct[0] as Record<string, unknown>);
    if (m) return m;
  }
  const events = await getJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (Array.isArray(events) && events.length) {
    const markets = (events[0] as { markets?: unknown[] }).markets ?? [];
    for (const raw of markets) {
      const m = parseMarket(raw as Record<string, unknown>);
      if (m) return m;
    }
  }
  return null;
}

/** Best bid/ask from a raw CLOB book. Doesn't assume the levels are sorted. */
export function parseBook(raw: { bids?: unknown[]; asks?: unknown[] }): Book {
  const levels = (side: unknown[] | undefined): BookLevel[] =>
    (side ?? [])
      .map((l) => {
        const o = l as { price?: unknown; size?: unknown };
        return { price: Number(o.price), size: Number(o.size) };
      })
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
  const asks = levels(raw.asks);
  const bids = levels(raw.bids);
  const bestAsk = asks.length ? asks.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const bestBid = bids.length ? bids.reduce((a, b) => (b.price > a.price ? b : a)) : null;
  return { bestAsk, bestBid };
}

export async function fetchBook(tokenId: string): Promise<Book> {
  const raw = (await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`)) as {
    bids?: unknown[];
    asks?: unknown[];
  };
  return parseBook(raw);
}
