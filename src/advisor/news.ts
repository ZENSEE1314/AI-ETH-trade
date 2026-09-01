// Recent crypto news headlines for the advisor. News drives retail positioning,
// which is where the liquidity pools sit — so the advisor reads the headlines
// AGAINST the liquidity map: bad news + liquidity resting above often means a
// sweep up (stop-hunt) before the real move; good news + liquidity below often
// means a sweep down. The model does that reasoning; this just supplies the feed.
//
// Free, no-key RSS. Best-effort — a failed feed is skipped, never fatal.

const FEEDS = [
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
];

export interface Headline {
  title: string;
  published: number; // ms epoch, 0 if unparseable
  source: string;
}

const clean = (s: string) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function parseItems(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const t = item.match(/<title>([\s\S]*?)<\/title>/i);
    const d = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (!t) continue;
    const title = clean(t[1]);
    if (!title) continue;
    const published = d ? Date.parse(clean(d[1])) || 0 : 0;
    out.push({ title, published, source });
  }
  return out;
}

/** Fetch the latest `limit` headlines across the feeds, newest first. */
export async function fetchHeadlines(limit = 12, timeoutMs = 6000): Promise<Headline[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async ({ source, url }) => {
      const ctrl = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { signal: ctrl, headers: { 'User-Agent': 'AI-ETH-trade/1.0' } });
      if (!res.ok) throw new Error(`${source} HTTP ${res.status}`);
      return parseItems(await res.text(), source);
    }),
  );

  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set<string>();
  return all
    .filter((h) => (seen.has(h.title) ? false : seen.add(h.title)))
    .sort((a, b) => b.published - a.published)
    .slice(0, limit);
}

/** A compact block for the advisor context. */
export function formatHeadlines(headlines: Headline[]): string {
  if (!headlines.length) return 'NEWS: (feed unavailable)';
  const ago = (t: number) => {
    if (!t) return '?';
    const m = Math.round((Date.now() - t) / 60_000);
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  return (
    'NEWS (newest first — read AGAINST the liquidity map):\n' +
    headlines.map((h) => `  [${ago(h.published)} · ${h.source}] ${h.title}`).join('\n')
  );
}
