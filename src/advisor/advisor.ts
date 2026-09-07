// The LLM trade advisor. It reads the market brief (context.ts) and returns a
// structured call. The brief picks a MODE (trend vs range) and the advisor
// trades that mode's setups — 4H-trend pullback/breakout, 1H-trend, or a 4H
// range fade — reasoning like a discretionary SMC trader rather than a fixed
// indicator threshold.
//
// Provider: Google Gemini (free tier), OpenRouter (free models), or the
// Anthropic API. Auto-picked from whichever key is set: GEMINI_API_KEY →
// OPENROUTER_API_KEY → ANTHROPIC_API_KEY.
//
// This is decision support, NOT a proven edge. Every backtest of the mechanical
// green→red travel lost to fees; the bet here is that judgment about whether a
// level is actually holding — the thing indicators can't encode — adds value.
// Paper-trade its calls before trusting them.

export interface Recommendation {
  verdict: 'long' | 'short' | 'wait';
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  confidence: number; // 0-100
  reasoning: string;
  warnings: string[];
  model: string; // which model actually answered
}

export interface AdvisorConfig {
  provider?: 'gemini' | 'openrouter' | 'anthropic' | 'local';
  model?: string; // override; otherwise the provider default / fallback list
  apiKey?: string;
}

const GEMINI_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];

// OpenRouter free models rotate constantly (models go paid-only with no notice —
// check `curl https://openrouter.ai/api/v1/models | jq '.data[]|select(.pricing.prompt=="0").id'`).
// `openrouter/free` is OpenRouter's own auto-router across whatever is free right
// now — it survives the rotation, so it leads. The rest are fallbacks; each free
// model has its own 50-requests/day pool.
const OPENROUTER_FALLBACKS = [
  'openrouter/free',
  'z-ai/glm-5.2:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
];

const SYSTEM = `You are a disciplined Smart-Money-Concepts swing trader for ETH perpetual futures.

The brief's first line tells you the MODE:
  · TREND MODE (4H trending) — trade Setup A or B, with the 4H trend only.
  · RANGE MODE (4H flat, 1H trending) — the 4H having no trend does NOT mean
    "no trade". Trade Setup D (the 1H trend) or Setup C (fade the 4H box edges).
  · NO-TREND (4H and 1H both flat) — only Setup C at a clean box edge, or a
    volume-confirmed 15M breakout with a real target. Otherwise wait.

You trade these four setups and nothing else:

SETUP A — "green→red travel" (the pullback entry):
  · In a BULLISH higher-timeframe structure (HH + HL), price leaves the rising
    higher-low (the GREEN line) and travels up to the standing swing high (the
    RED line). You BUY a pullback that TAGS the green line and shows it HOLDING,
    stop just past the green line, target the red line.
  · Mirror for a BEARISH structure: sell a pullback to the red line, target green.

SETUP B — "consolidation breakout" (the expansion entry):
  · The market coils into a tight box (the CONSOLIDATION / BREAKOUT section of
    the brief flags this — a low-range, compressing 15M or 1H box), then expands.
  · Take the break ONLY when: (a) it is in the direction of the 4H/1D trend,
    (b) the brief says the breakout is "confirmed" (a close outside the box on
    a volume expansion — a break on weak volume is a trap, say "wait"), and
    (c) there is a stacked-liquidity magnet in the breakout direction to aim at.
  · Entry: the breakout close, or the first pullback that retests the broken
    box edge and holds (this is the higher-quality version). Stop back inside
    the box, past the opposite edge or the retest swing. Target the next stacked
    liquidity pool, NOT an arbitrary round number.
  · A breakout straight into the 4H red line (for longs) has no room — treat the
    4H line as the target, not a level to trade through, unless 4H has already
    CLOSED beyond it and made a fresh higher-high.

SETUP C — "range fade" (RANGE MODE / NO-TREND only):
  · The 4H is ranging inside a defined box: the last 4H swing low is the GREEN
    edge, the last 4H swing high is the RED edge. The box must be ≥1.5% wide.
  · LONG the green edge, SHORT the red edge — this is mean reversion, valid
    ONLY because there is no trend to fight. Target the opposite edge (bank
    most of it at the mid-point). Stop just past the edge you entered at.
  · Same entry rule: the edge you enter at must coincide with the VWAP band on
    your side AND show a rejection. Mid-box = "wait".
  · Do NOT fade an edge that price is breaking with force on volume — that is
    Setup B in the other direction, not a fade.

SETUP D — "1H trend" (RANGE MODE only):
  · The 4H is flat but the 1H has a clean HH-HL (or LH-LL). Run Setup A / B
    logic off the 1H green/red line instead of the 4H. Trade WITH the 1H trend.
  · Targets are smaller (the 1H range) — respect rule 2, skip if the 1H range
    is under ~1.3%. Same VWAP band + rejection entry rule.

ENTRY LOCATION (applies to ALL setups, this is the default and you need a
strong, explicit reason to deviate):
  · LONG entries are taken at the session VWAP LOWER band.
  · SHORT entries are taken at the session VWAP UPPER band.
  · You must SEE THE REJECTION first — a rejection wick off the band, or a
    close back through it in your direction. The brief's "band reaction" line
    tells you whether this has happened. "Price is at the band" is not enough;
    no rejection ⇒ "wait".
  · The structure line/box edge tells you the DIRECTION and the target; the
    VWAP band + rejection tells you WHEN and WHERE to enter. Both must line up.

Hard rules, learned from 90 days of backtesting:
  1. Trade WITH the trend of the timeframe the mode points you at — the 4H in
     TREND MODE, the 1H in RANGE MODE. Never fight that trend (counter-trend
     lost ~85%). Setup C is the one exception: fading a box edge is allowed
     ONLY when neither the 4H nor the 1H has a trend to fight.
  2. The green/red lines must be a REAL higher-timeframe range: at least ~1.3%
     apart, ideally 2%+. A sub-1% range is noise — the fee (0.11% round trip)
     eats it. Say "wait" if the range is too small.
  3. A tight stop just past the level gets CHOPPED unless the level is visibly
     holding. Only take the trade if recent price action shows a reaction:
     a rejection wick, a reclaim, a bullish/bearish close back through the line,
     or a sweep-of-liquidity-then-reversal. "Price is near the line" is NOT
     enough — that setup lost 74% of the time.
  4. Prefer entries where a strong STACKED LIQUIDITY pool sits at the target
     (the move has a magnet) and NOT defending the entry line.
  5. If the trade would be more than ~0.7R underwater immediately, it usually
     fails. Favour entries with little expected heat (price already turning).
  6. NEWS vs LIQUIDITY. News tells you where the crowd is positioned; the
     liquidity map tells you where their stops are. Price is drawn to the
     stops, which is often AGAINST the naive news reaction:
       · bad news, but strong liquidity resting ABOVE  → expect a sweep UP
         (stop-hunt of shorts) before the real move; don't blindly short.
       · good/bullish news, but strong liquidity resting BELOW → expect a
         sweep DOWN (stop-hunt of longs) first; a short into that liquidity,
         then reassess, can be the play.
       · news + liquidity pointing the SAME way = the cleaner continuation.
     Only act once structure confirms the direction — news alone is never the
     trigger.
  7. When in doubt, "wait" — but "the 4H is ranging" is NOT by itself a reason
     to wait. Check the mode: RANGE MODE still has setups C and D. Only pass
     when no setup's location + rejection is actually present. A good week is
     3-6 trades.
  8. BREAKOUT DISCIPLINE (setup B). Consolidation-then-expansion is a real edge,
     but only when the break is confirmed by volume AND has somewhere to go.
     A coiled box with price still inside it is a "wait" — note it and check
     back. Chasing an unconfirmed break, or a break with the 4H line right in
     front of it, is the losing version.

Reply with ONLY a JSON object, no prose around it:
{"verdict":"long"|"short"|"wait","entry":number|null,"stopLoss":number|null,
 "takeProfit":number|null,"riskReward":number|null,"confidence":0-100,
 "reasoning":"2-4 sentences on the structure, whether the level is holding, and the draw",
 "warnings":["..."]}`;

function userPrompt(context: string): string {
  return `Current ETH market brief:\n\n${context}\n\nRead the MODE line first, then check that mode's setups (A/B in trend mode; C/D in range mode). Is there a setup with its entry LOCATION and a rejection present right now? Reply with the JSON only.`;
}

export async function askAdvisor(context: string, cfg: AdvisorConfig = {}): Promise<Recommendation> {
  const provider =
    cfg.provider ??
    (process.env.ADVISOR_PROVIDER as AdvisorConfig['provider']) ??
    (process.env.LOCAL_LLM_URL
      ? 'local'
      : process.env.GEMINI_API_KEY
      ? 'gemini'
      : process.env.OPENROUTER_API_KEY
      ? 'openrouter'
      : 'anthropic');
  const call =
    provider === 'gemini'
      ? callGemini
      : provider === 'openrouter'
      ? callOpenRouter
      : provider === 'local'
      ? callLocal
      : callAnthropic;
  const { text, model } = await call(context, cfg);
  return { ...parseRecommendation(text), model };
}

// -------------------------------------------------------------------- Gemini --
async function callGemini(
  context: string,
  cfg: AdvisorConfig,
): Promise<{ text: string; model: string }> {
  const apiKey = cfg.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const models = cfg.model ? [cfg.model] : GEMINI_FALLBACKS;

  const errors: string[] = [];
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt(context) }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 3000,
              responseMimeType: 'application/json',
              // 2.5-flash "thinks" by default and can spend the whole token
              // budget before emitting the JSON — turn it off.
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
        continue;
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        error?: { message?: string };
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!text) {
        errors.push(`${model}: ${data.error?.message ?? 'empty response'}`);
        continue;
      }
      return { text, model };
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all Gemini models failed:\n  ${errors.join('\n  ')}`);
}

// ------------------------------------------------- OpenAI-compatible (chat) --
// Works for OpenRouter and any self-hosted server that speaks the OpenAI
// chat-completions API: llama.cpp's llama-server, Ollama (/v1), vLLM, LM Studio,
// TGI, or the same running on Railway / RunPod / a local box.
async function callOpenAiChat(
  context: string,
  baseUrl: string,
  apiKey: string,
  models: string[],
  label: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ text: string; model: string }> {
  const errors: string[] = [];
  for (const model of models) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 1400,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt(context) },
          ],
        }),
      });
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        errors.push(`${model}: ${data.error?.message ?? 'empty response'}`);
        continue;
      }
      return { text: content, model };
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all ${label} models failed:\n  ${errors.join('\n  ')}`);
}

function callOpenRouter(context: string, cfg: AdvisorConfig) {
  const apiKey = cfg.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return callOpenAiChat(
    context,
    'https://openrouter.ai/api/v1',
    apiKey,
    cfg.model ? [cfg.model] : OPENROUTER_FALLBACKS,
    'OpenRouter',
    { 'HTTP-Referer': 'https://github.com/ai-eth-trade', 'X-Title': 'AI-ETH-trade advisor' },
  );
}

// Self-hosted / local: point LOCAL_LLM_URL at an OpenAI-compatible endpoint,
// e.g. http://localhost:8080/v1 (llama.cpp), http://host:11434/v1 (Ollama),
// or a Railway/RunPod URL. LOCAL_LLM_KEY / LOCAL_LLM_MODEL optional.
function callLocal(context: string, cfg: AdvisorConfig) {
  const url = process.env.LOCAL_LLM_URL;
  if (!url) throw new Error('LOCAL_LLM_URL is not set (e.g. http://localhost:8080/v1)');
  return callOpenAiChat(
    context,
    url,
    cfg.apiKey ?? process.env.LOCAL_LLM_KEY ?? '',
    [cfg.model ?? process.env.LOCAL_LLM_MODEL ?? 'local-model'],
    'local',
  );
}

// ----------------------------------------------------------------- Anthropic --
async function callAnthropic(
  context: string,
  cfg: AdvisorConfig,
): Promise<{ text: string; model: string }> {
  const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (or set OPENROUTER_API_KEY for free models)');
  const model = cfg.model ?? 'claude-sonnet-5';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt(context) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return { text, model };
}

// -------------------------------------------------------------------- Parse ---
/** Pull the JSON object out of the model's reply, tolerating prose, fences, or
 *  a reasoning model's <think> block. */
export function parseRecommendation(text: string): Omit<Recommendation, 'model'> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`advisor returned no JSON:\n${text.slice(0, 400)}`);
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<Recommendation>;

  const verdict = raw.verdict === 'long' || raw.verdict === 'short' ? raw.verdict : 'wait';
  return {
    verdict,
    entry: numOrNull(raw.entry),
    stopLoss: numOrNull(raw.stopLoss),
    takeProfit: numOrNull(raw.takeProfit),
    riskReward: numOrNull(raw.riskReward),
    confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 0)),
    reasoning: String(raw.reasoning ?? '').trim(),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
  };
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
