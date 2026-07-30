// HTTP server: auth, dashboard, JSON API, settings, TradingView webhook, SSE.

import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { canTradeLive, loadSettings, updateSettings, publicSettings } from './runtime.js';
import { APP_SECRET_IS_EPHEMERAL } from './auth/crypto.js';
import { register, authenticate, AuthError, userCount } from './auth/users.js';
import { requireAuth, currentUser, setSessionCookie, clearSessionCookie } from './auth/middleware.js';
import { logger } from './logger.js';
import { engine } from './engine/tradeEngine.js';
import { parseTradingViewAlert, WebhookError } from './webhooks/tradingview.js';
import { CURRICULUM, PHILOSOPHY } from './knowledge/curriculum.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.text({ type: ['text/plain', 'text/*'] }));

// --- Health ---------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, live: canTradeLive() }));

// --- Auth -----------------------------------------------------------------
app.post('/auth/register', (req, res) => {
  try {
    const { username, password, code } = req.body ?? {};
    const user = register(username, password, code);
    setSessionCookie(res, user.id);
    logger.info(`Registered user "${user.username}".`);
    res.json({ ok: true, user });
  } catch (err) {
    const status = err instanceof AuthError ? 400 : 500;
    res.status(status).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    const user = authenticate(username, password);
    setSessionCookie(res, user.id);
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    const status = err instanceof AuthError ? 401 : 500;
    res.status(status).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user, needsBootstrap: userCount() === 0 });
});

// --- JSON API (session-protected) -----------------------------------------
app.get('/api/state', requireAuth, (_req, res) => res.json(engine.state()));
app.get('/api/journal', requireAuth, (_req, res) => res.json(engine.getJournal()));
app.get('/api/logs', requireAuth, (_req, res) => res.json(logger.recent()));
app.get('/api/curriculum', requireAuth, (_req, res) =>
  res.json({ philosophy: PHILOSOPHY, modules: CURRICULUM }),
);

app.get('/api/settings', requireAuth, (_req, res) => res.json(publicSettings()));
app.post('/api/settings', requireAuth, (req, res) => {
  updateSettings(req.body ?? {});
  res.json({ ok: true, settings: publicSettings() });
});

app.post('/api/close/:id', requireAuth, (req, res) => {
  const ok = engine.closePositionManually(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// --- SSE stream -----------------------------------------------------------
app.get('/api/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('update', engine.state());

  const onUpdate = (s: unknown) => send('update', s);
  const onSignal = (s: unknown) => send('signal', s);
  const onTrade = (t: unknown) => send('trade', t);
  engine.on('update', onUpdate);
  engine.on('signal', onSignal);
  engine.on('trade', onTrade);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    engine.off('update', onUpdate);
    engine.off('signal', onSignal);
    engine.off('trade', onTrade);
  });
});

// --- TradingView webhook (its own shared secret, no session) --------------
app.post('/webhook/tradingview', (req, res) => {
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const signal = parseTradingViewAlert(raw);
    logger.info(`Webhook signal received: ${signal.side} ${signal.symbol} @ ${signal.entry}`);
    engine.processSignal(signal);
    res.json({ ok: true, id: signal.id });
  } catch (err) {
    const status = err instanceof WebhookError ? 400 : 500;
    logger.warn(`Webhook rejected: ${(err as Error).message}`);
    res.status(status).json({ ok: false, error: (err as Error).message });
  }
});

// --- Static assets + gated dashboard --------------------------------------
// Public assets (login page, css, js) are fine to serve to anyone; the API
// behind them still requires a session.
app.use(express.static(publicDir, { index: false }));

const dashboard = (_req: Request, res: Response) => res.sendFile(join(publicDir, 'index.html'));
app.get(['/', '/index.html'], (req, res) => {
  if (!currentUser(req)) return res.redirect('/login.html');
  return dashboard(req, res);
});

app.listen(config.port, () => {
  loadSettings();
  logger.info(`AI-ETH-trade listening on :${config.port} (${engine.state().mode} mode)`);
  if (APP_SECRET_IS_EPHEMERAL) {
    logger.warn('APP_SECRET is not set — sessions and stored API secrets will NOT survive a restart. Set APP_SECRET.');
  }
  if (config.dataDir === 'data') {
    logger.warn('DATA_DIR is the ephemeral default. On Railway, mount a volume and set RAILWAY_VOLUME_MOUNT_PATH to persist users/settings.');
  }
  engine.start();
});
