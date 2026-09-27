import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { v2 as cloudinary } from 'cloudinary';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import helmet from 'helmet';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import Stripe from 'stripe';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { BurgerRushEngine, type GameAction } from './game/engine.js';

type AuthContext = { userId: string; tenantId: string; role: 'OWNER' | 'MANAGER' | 'OPERATOR' };
declare global { namespace Express { interface Request { auth?: AuthContext } } }

const prisma = new PrismaClient();
const app = express();
const httpServer = http.createServer(app);
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : undefined;
const jwtSecret = process.env.JWT_SECRET ?? 'local-only-secret-not-for-production';
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const allowedOrigins = new Set(webOrigin.split(',').map((origin) => origin.trim()).filter(Boolean));
const io = new Server(httpServer, { cors: { origin: [...allowedOrigins], credentials: true } });
const redisUrl = process.env.REDIS_URL;
const redisPub = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const redisSub = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const redisCoordinator = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const engines = new Map<string, BurgerRushEngine>();
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || jwtSecret.length < 32 || !redisUrl)) throw new Error('Production requires JWT_SECRET (32+ chars) and REDIS_URL');

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next);
const createRateLimitStore = () => redisCoordinator ? new RedisStore({ sendCommand: async (...args: string[]) => { const [command, ...commandArgs] = args; return await redisCoordinator.call(command ?? '', ...commandArgs) as number; } }) : undefined;
const tokenFor = (auth: AuthContext) => jwt.sign(auth, jwtSecret, { expiresIn: '12h', issuer: 'gametable-api' });
const publicMatch = (match: { id: string; code: string; status: string; players: Array<{ playerId: string; seat: number; tableNumber?: number | null; score: number; player: { nickname: string } }> }) => ({ id: match.id, code: match.code, status: match.status, players: match.players.map((participant) => ({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat, tableNumber: participant.tableNumber, score: participant.score })) });
const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');
const withMatchLock = async <T>(matchId: string, operation: () => Promise<T>): Promise<T> => {
  if (!redisCoordinator) return operation();
  const key = `gametable:match-lock:${matchId}`;
  const lockToken = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    acquired = (await redisCoordinator.set(key, lockToken, 'PX', 10_000, 'NX')) === 'OK';
    if (acquired) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!acquired) throw new ApiError(409, 'MATCH_BUSY_RETRY');
  try { return await operation(); }
  finally { await redisCoordinator.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, lockToken); }
};
const planLimit = (plan: string) => ({ FREE_TRIAL: Number.MAX_SAFE_INTEGER, STARTER_10: 10, GROWTH_25: 25, UNLIMITED: Number.MAX_SAFE_INTEGER, RESORTS: Number.MAX_SAFE_INTEGER }[plan] ?? 0);
const engineFor = (matchId: string, durationSeconds: number, state?: import('./game/engine.js').GameState | null) => {
  if (state) { const restored = new BurgerRushEngine(durationSeconds, Date.now, state); engines.set(matchId, restored); return restored; }
  let engine = engines.get(matchId);
  if (!engine) { engine = new BurgerRushEngine(durationSeconds); engines.set(matchId, engine); }
  return engine;
};
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  try {
    const payload = jwt.verify(header.slice(7), jwtSecret, { issuer: 'gametable-api' }) as AuthContext;
    if (!payload.userId || !payload.tenantId || !payload.role) return res.status(401).json({ error: 'INVALID_TOKEN' });
    req.auth = payload;
    return next();
  } catch { return res.status(401).json({ error: 'INVALID_TOKEN' }); }
};

const requireRole = (...roles: AuthContext['role'][]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
  return next();
};
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
  connectSrc: ["'self'", ...allowedOrigins, ...(process.env.PUBLIC_API_URL ? [process.env.PUBLIC_API_URL] : []), 'https://api.cloudinary.com'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
} } }));
app.set('trust proxy', 1);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'BILLING_NOT_CONFIGURED' });
  const signature = req.header('stripe-signature');
  if (!signature) return res.status(400).json({ error: 'MISSING_SIGNATURE' });
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).json({ error: 'INVALID_SIGNATURE' }); }
  try {
    if (event.type === 'checkout.session.completed') {
      const checkout = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription?.id;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const metadata = { ...checkout.metadata, ...subscription.metadata };
        const tenantId = metadata.tenantId;
        const plan = metadata.plan as 'STARTER_10' | 'GROWTH_25' | 'UNLIMITED' | 'RESORTS' | undefined;
        if (tenantId && plan && ['STARTER_10', 'GROWTH_25', 'UNLIMITED', 'RESORTS'].includes(plan)) {
          const status = subscription.status === 'active' ? 'ACTIVE' : subscription.status === 'past_due' ? 'PAST_DUE' : subscription.status === 'canceled' ? 'CANCELLED' : 'TRIALING';
          const customerId = typeof checkout.customer === 'string' ? checkout.customer : checkout.customer?.id;
          await prisma.$transaction([
            prisma.tenant.update({ where: { id: tenantId }, data: { plan, ...(customerId ? { stripeCustomerId: customerId } : {}) } }),
            prisma.subscription.upsert({ where: { provider_externalId: { provider: 'STRIPE', externalId: subscription.id } }, create: { tenantId, provider: 'STRIPE', externalId: subscription.id, status, currentPeriodEnd: new Date(subscription.current_period_end * 1000) }, update: { tenantId, status, currentPeriodEnd: new Date(subscription.current_period_end * 1000) } })
          ]);
        }
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      const tenantId = subscription.metadata.tenantId;
      const plan = subscription.metadata.plan as 'STARTER_10' | 'GROWTH_25' | 'UNLIMITED' | 'RESORTS' | undefined;
      if (tenantId) {
        const status = event.type === 'customer.subscription.deleted' || subscription.status === 'canceled' ? 'CANCELLED' : subscription.status === 'active' ? 'ACTIVE' : subscription.status === 'past_due' ? 'PAST_DUE' : 'TRIALING';
        await prisma.subscription.upsert({ where: { provider_externalId: { provider: 'STRIPE', externalId: subscription.id } }, create: { tenantId, provider: 'STRIPE', externalId: subscription.id, status, currentPeriodEnd: new Date(subscription.current_period_end * 1000) }, update: { status, currentPeriodEnd: new Date(subscription.current_period_end * 1000) } });
        if (status === 'CANCELLED' || status === 'PAST_DUE') await prisma.tenant.update({ where: { id: tenantId }, data: { plan: 'FREE_TRIAL' } });
        else if (plan && ['STARTER_10', 'GROWTH_25', 'UNLIMITED', 'RESORTS'].includes(plan)) await prisma.tenant.update({ where: { id: tenantId }, data: { plan } });
      }
    }
    return res.json({ received: true });
  } catch (error) { console.error('Stripe webhook processing failed', error); return res.status(500).json({ error: 'WEBHOOK_PROCESSING_FAILED' }); }
});
app.use(express.json({ limit: '256kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, store: createRateLimitStore() }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false, store: createRateLimitStore() }));

app.get('/health/live', (_req, res) => res.json({ status: 'ok', service: 'gametable-api' }));
app.get('/health/ready', asyncRoute(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  if (redisCoordinator) await redisCoordinator.ping();
  res.json({ status: 'ready', service: 'gametable-api', timestamp: new Date().toISOString(), redis: Boolean(redisCoordinator) });
}));
app.get('/health', (_req, res) => res.redirect(307, '/health/ready'));

app.get('/api/public/stats', asyncRoute(async (_req, res) => {
  const [activeTenants, activePlayers, matches] = await Promise.all([
    prisma.tenant.count({ where: { status: 'ACTIVE' } }),
    prisma.matchPlayer.count({ where: { match: { status: { in: ['WAITING', 'RUNNING'] } } } }),
    prisma.match.count({ where: { status: 'FINISHED' } })
  ]);
  return res.json({ activeRestaurants: activeTenants, activePlayers, completedMatches: matches });
}));

app.get('/api/public/leaderboard', asyncRoute(async (_req, res) => {
  const leaders = await prisma.matchPlayer.findMany({ where: { match: { status: 'FINISHED' } }, orderBy: { score: 'desc' }, take: 20, include: { player: true, match: { include: { tenant: { select: { name: true, slug: true } } } } } });
  return res.json(leaders.map((entry, index) => ({ position: index + 1, nickname: entry.player.nickname, score: entry.score, restaurant: entry.match.tenant.name, restaurantSlug: entry.match.tenant.slug })));
}));
const registerInput = z.object({ restaurantName: z.string().trim().min(2).max(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,48}$/), name: z.string().trim().min(2).max(80), email: z.string().email().max(160), password: z.string().min(10).max(128) });
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const parsed = registerInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const trialEndsAt = new Date(); trialEndsAt.setFullYear(trialEndsAt.getFullYear() + 1);
  const tenant = await prisma.tenant.create({ data: { name: parsed.data.restaurantName, slug: parsed.data.slug, trialEndsAt, settings: { create: { displayName: parsed.data.restaurantName } }, users: { create: { name: parsed.data.name, email: parsed.data.email.toLowerCase(), passwordHash, role: 'OWNER' } } }, include: { users: true } });
  const user = tenant.users[0];
  if (!user) return res.status(500).json({ error: 'USER_CREATION_FAILED' });
  const auth: AuthContext = { userId: user.id, tenantId: tenant.id, role: user.role };
  return res.status(201).json({ token: tokenFor(auth), user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
}));

const loginInput = z.object({ tenantSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,48}$/), email: z.string().email(), password: z.string().min(1) });
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const user = await prisma.user.findFirst({ where: { email: parsed.data.email.toLowerCase(), tenant: { slug: parsed.data.tenantSlug, status: 'ACTIVE' } }, include: { tenant: true } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  const auth: AuthContext = { userId: user.id, tenantId: user.tenantId, role: user.role };
  return res.json({ token: tokenFor(auth), user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug } });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.auth!.userId, tenantId: req.auth!.tenantId }, include: { tenant: { include: { settings: true } } } });
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: user.tenant });
}));

app.get('/api/billing', requireAuth, asyncRoute(async (req, res) => {
  const [tenant, subscription] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { plan: true, trialEndsAt: true } }),
    prisma.subscription.findFirst({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' } })
  ]);
  if (!tenant) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
  return res.json({ plan: tenant.plan, trialEndsAt: tenant.trialEndsAt, subscription });
}));

const checkoutInput = z.object({ plan: z.enum(['STARTER_10', 'GROWTH_25', 'UNLIMITED', 'RESORTS']) });
app.post('/api/billing/checkout', requireAuth, requireRole('OWNER'), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'BILLING_NOT_CONFIGURED' });
  const parsed = checkoutInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PLAN' });
  const priceId = process.env[`STRIPE_PRICE_${parsed.data.plan}`];
  if (!priceId) return res.status(503).json({ error: 'PLAN_PRICE_NOT_CONFIGURED' });
  const [tenant, user] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } }),
    prisma.user.findUnique({ where: { id: req.auth!.userId } })
  ]);
  if (!tenant || !user) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
  const activeSubscription = await prisma.subscription.findFirst({ where: { tenantId: tenant.id, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } } });
  if (activeSubscription) return res.status(409).json({ error: 'SUBSCRIPTION_EXISTS_USE_PORTAL' });
  const metadata = { tenantId: tenant.id, plan: parsed.data.plan };
  const customer = tenant.stripeCustomerId ?? (await stripe.customers.create({ email: user.email, name: tenant.name, metadata: { tenantId: tenant.id } })).id;
  if (!tenant.stripeCustomerId) await prisma.tenant.update({ where: { id: tenant.id }, data: { stripeCustomerId: customer } });
  const baseUrl = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0] ?? 'http://localhost:5173';
  const checkout = await stripe.checkout.sessions.create({ mode: 'subscription', customer, line_items: [{ price: priceId, quantity: 1 }], success_url: `${baseUrl}/?billing=success`, cancel_url: `${baseUrl}/?billing=cancelled`, metadata, subscription_data: { metadata } });
  return res.json({ url: checkout.url });
}));

app.post('/api/billing/portal', requireAuth, requireRole('OWNER'), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'BILLING_NOT_CONFIGURED' });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { stripeCustomerId: true } });
  if (!tenant?.stripeCustomerId) return res.status(404).json({ error: 'BILLING_CUSTOMER_NOT_FOUND' });
  const baseUrl = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0] ?? 'http://localhost:5173';
  const portal = await stripe.billingPortal.sessions.create({ customer: tenant.stripeCustomerId, return_url: `${baseUrl}/` });
  return res.json({ url: portal.url });
}));

app.get('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId: req.auth!.tenantId } });
  return res.json(settings);
}));

const settingsInput = z.object({ displayName: z.string().trim().min(2).max(80).optional(), primaryHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), logoUrl: z.string().url().nullable().optional() }).refine((value) => Object.keys(value).length > 0);
app.patch('/api/settings', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const settings = await prisma.tenantSettings.upsert({ where: { tenantId: req.auth!.tenantId }, create: { tenantId: req.auth!.tenantId, ...parsed.data }, update: parsed.data });
  return res.json(settings);
}));

app.get('/api/devices', requireAuth, asyncRoute(async (req, res) => {
  const devices = await prisma.device.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, lastSeenAt: true, createdAt: true } });
  return res.json(devices);
}));

app.post('/api/devices', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const deviceToken = randomBytes(32).toString('base64url');
  const device = await prisma.device.create({ data: { tenantId: req.auth!.tenantId, name: parsed.data.name, tokenHash: hashSession(deviceToken) }, select: { id: true, name: true, createdAt: true } });
  return res.status(201).json({ ...device, deviceToken });
}));

app.delete('/api/devices/:id', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const result = await prisma.device.deleteMany({ where: { id: String(req.params.id), tenantId: req.auth!.tenantId } });
  if (result.count === 0) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
  return res.status(204).end();
}));

app.post('/api/uploads/signature', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (_req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return res.status(503).json({ error: 'ASSET_STORAGE_NOT_CONFIGURED' });
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `gametable/${_req.auth!.tenantId}`;
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, apiSecret);
  return res.json({ cloudName, apiKey, timestamp, folder, signature });
}));

app.get('/api/dashboard/summary', requireAuth, asyncRoute(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [matchesToday, activePlayers, topScores] = await Promise.all([
    prisma.match.count({ where: { tenantId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    prisma.matchPlayer.count({ where: { match: { tenantId, status: { in: ['WAITING', 'RUNNING'] } } } }),
    prisma.matchPlayer.findMany({ where: { match: { tenantId, status: 'FINISHED' } }, orderBy: { score: 'desc' }, take: 5, include: { player: true, match: { select: { code: true } } } })
  ]);
  return res.json({ matchesToday, activePlayers, topScores: topScores.map((score) => ({ nickname: score.player.nickname, score: score.score, matchCode: score.match.code })) });
}));

const tournamentInput = z.object({ name: z.string().trim().min(2).max(100), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional() });
app.post('/api/tournaments', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const parsed = tournamentInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const tournament = await prisma.tournament.create({ data: { tenantId: req.auth!.tenantId, name: parsed.data.name, startsAt: parsed.data.startsAt, endsAt: parsed.data.endsAt } });
  return res.status(201).json(tournament);
}));

app.get('/api/tournaments', requireAuth, asyncRoute(async (req, res) => {
  const tournaments = await prisma.tournament.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { entries: true } } } });
  return res.json(tournaments);
}));

app.post('/api/tournaments/:id/open', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { id: String(req.params.id), tenantId: req.auth!.tenantId } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (tournament.status !== 'DRAFT') return res.status(409).json({ error: 'INVALID_TOURNAMENT_STATUS' });
  return res.json(await prisma.tournament.update({ where: { id: tournament.id }, data: { status: 'OPEN' } }));
}));

app.post('/api/tournaments/:id/start', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { id: String(req.params.id), tenantId: req.auth!.tenantId } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (tournament.status !== 'OPEN') return res.status(409).json({ error: 'INVALID_TOURNAMENT_STATUS' });
  return res.json(await prisma.tournament.update({ where: { id: tournament.id }, data: { status: 'RUNNING', startsAt: new Date() } }));
}));

app.post('/api/tournaments/:id/finish', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const tournament = await prisma.tournament.findFirst({ where: { id: String(req.params.id), tenantId: req.auth!.tenantId } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (tournament.status !== 'RUNNING') return res.status(409).json({ error: 'INVALID_TOURNAMENT_STATUS' });
  const finished = await prisma.tournament.update({ where: { id: tournament.id }, data: { status: 'FINISHED', endsAt: new Date() }, include: { entries: { orderBy: { score: 'desc' }, include: { player: true } } } });
  return res.json({ ...finished, entries: finished.entries.map((entry, index) => ({ position: index + 1, nickname: entry.player.nickname, score: entry.score })) });
}));

app.get('/api/tournaments/:id', asyncRoute(async (req, res) => {
  const tournament = await prisma.tournament.findUnique({ where: { id: String(req.params.id) }, include: { entries: { orderBy: { score: 'desc' }, include: { player: true } } } });
  if (!tournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  return res.json({ ...tournament, entries: tournament.entries.map((entry, index) => ({ position: index + 1, playerId: entry.playerId, nickname: entry.player.nickname, score: entry.score })) });
}));

const adInput = z.object({ title: z.string().trim().min(2).max(120), imageUrl: z.string().url().optional(), targetUrl: z.string().url().optional(), active: z.boolean().default(true), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional() });
app.post('/api/advertisements', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const parsed = adInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  return res.status(201).json(await prisma.advertisement.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId } }));
}));

app.get('/api/advertisements', requireAuth, asyncRoute(async (req, res) => {
  const ads = await prisma.advertisement.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' } });
  return res.json(ads);
}));

app.get('/api/tenants/:slug/advertisements', asyncRoute(async (req, res) => {
  const now = new Date();
  const ads = await prisma.advertisement.findMany({ where: { tenant: { slug: String(req.params.slug), status: 'ACTIVE' }, active: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] }, orderBy: { createdAt: 'desc' } });
  return res.json(ads);
}));

const questionnaireInput = z.object({ title: z.string().trim().min(2).max(120), active: z.boolean().default(false), questions: z.array(z.object({ prompt: z.string().trim().min(2).max(300), options: z.array(z.string().trim().min(1).max(120)).min(2).max(6), correctIndex: z.number().int().nonnegative() })).max(50) });
app.post('/api/questionnaires', requireAuth, requireRole('OWNER', 'MANAGER'), asyncRoute(async (req, res) => {
  const parsed = questionnaireInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  if (parsed.data.questions.some((question) => question.correctIndex >= question.options.length)) return res.status(400).json({ error: 'INVALID_CORRECT_OPTION' });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
  const trial = tenant.plan === 'FREE_TRIAL' && tenant.trialEndsAt >= new Date();
  if (!trial && !['UNLIMITED', 'RESORTS'].includes(tenant.plan)) return res.status(403).json({ error: 'PLAN_FEATURE_UNAVAILABLE' });
  const questionnaire = await prisma.questionnaire.create({ data: { tenantId: req.auth!.tenantId, title: parsed.data.title, active: parsed.data.active, questions: { create: parsed.data.questions.map((question) => ({ prompt: question.prompt, optionsJson: question.options, correctIndex: question.correctIndex })) } }, include: { questions: true } });
  return res.status(201).json(questionnaire);
}));

app.get('/api/questionnaires', requireAuth, asyncRoute(async (req, res) => {
  const questionnaires = await prisma.questionnaire.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { questions: true } } } });
  return res.json(questionnaires);
}));

app.get('/api/tenants/:slug/questionnaires/active', asyncRoute(async (req, res) => {
  const questionnaire = await prisma.questionnaire.findFirst({ where: { tenant: { slug: String(req.params.slug), status: 'ACTIVE' }, active: true }, include: { questions: { select: { id: true, prompt: true, optionsJson: true } } } });
  if (!questionnaire) return res.status(404).json({ error: 'QUESTIONNAIRE_NOT_FOUND' });
  return res.json(questionnaire);
}));

app.post('/api/questionnaires/:id/answers', asyncRoute(async (req, res) => {
  const parsed = z.object({ questionId: z.string().min(1), playerId: z.string().min(1), sessionToken: z.string().min(20), selectedIndex: z.number().int().nonnegative() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const session = await prisma.playerSession.findFirst({ where: { playerId: parsed.data.playerId, tokenHash: hashSession(parsed.data.sessionToken), expiresAt: { gt: new Date() } }, include: { match: true } });
  if (!session) return res.status(401).json({ error: 'PLAYER_SESSION_INVALID' });
  if (session.match.status !== 'RUNNING') return res.status(409).json({ error: 'MATCH_NOT_RUNNING' });
  const tenant = await prisma.tenant.findUnique({ where: { id: session.match.tenantId } });
  if (!tenant || (tenant.plan === 'FREE_TRIAL' && tenant.trialEndsAt < new Date()) || (tenant.plan !== 'FREE_TRIAL' && !['UNLIMITED', 'RESORTS'].includes(tenant.plan))) return res.status(403).json({ error: 'PLAN_FEATURE_UNAVAILABLE' });
  const question = await prisma.question.findFirst({ where: { id: parsed.data.questionId, questionnaireId: String(req.params.id), questionnaire: { active: true, tenantId: session.match.tenantId } } });
  if (!question) return res.status(404).json({ error: 'QUESTION_NOT_FOUND' });
  const options = Array.isArray(question.optionsJson) ? question.optionsJson : [];
  if (parsed.data.selectedIndex >= options.length) return res.status(400).json({ error: 'INVALID_OPTION' });
  const correct = parsed.data.selectedIndex === question.correctIndex;
  const points = correct ? 100 : 0;
  try {
    await withMatchLock(session.matchId, async () => {
      const match = await prisma.match.findUnique({ where: { id: session.matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
      if (!match || match.status !== 'RUNNING') throw new ApiError(409, 'MATCH_NOT_RUNNING');
      if (points === 0) {
        await prisma.questionnaireAnswer.create({ data: { questionnaireId: question.questionnaireId, questionId: question.id, playerId: parsed.data.playerId, selectedIndex: parsed.data.selectedIndex, correct, points } });
        return;
      }
      const engine = new BurgerRushEngine(match.durationSeconds, Date.now, (match.stateJson as import('./game/engine.js').GameState | null) ?? undefined);
      for (const participant of match.players) engine.addPlayer({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat });
      const state = engine.awardPoints(parsed.data.playerId, points);
      await prisma.$transaction([
        prisma.questionnaireAnswer.create({ data: { questionnaireId: question.questionnaireId, questionId: question.id, playerId: parsed.data.playerId, selectedIndex: parsed.data.selectedIndex, correct, points } }),
        prisma.match.update({ where: { id: match.id }, data: { stateJson: JSON.parse(JSON.stringify(state)) } }),
        prisma.matchPlayer.update({ where: { matchId_playerId: { matchId: match.id, playerId: parsed.data.playerId } }, data: { score: state.players.find((player) => player.id === parsed.data.playerId)!.score } }),
        prisma.scoreEvent.create({ data: { tenantId: match.tenantId, matchId: match.id, playerId: parsed.data.playerId, points, reason: 'CUSTOM_QUESTIONNAIRE' } })
      ]);
      engines.set(match.id, engine);
      io.to(`match:${match.id}`).emit('game:state', state);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return res.status(409).json({ error: 'QUESTION_ALREADY_ANSWERED' });
    throw error;
  }
  return res.json({ correct, points });
}));

const matchInput = z.object({ gameKey: z.string().trim().min(2).max(40).default('burger-rush'), deviceId: z.string().optional() });
app.post('/api/matches', requireAuth, requireRole('OWNER', 'MANAGER', 'OPERATOR'), asyncRoute(async (req, res) => {
  const parsed = matchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant || tenant.status !== 'ACTIVE') return res.status(403).json({ error: 'TENANT_INACTIVE' });
  if (tenant.plan === 'FREE_TRIAL' && tenant.trialEndsAt < new Date()) return res.status(403).json({ error: 'TRIAL_EXPIRED' });
  if (parsed.data.deviceId) {
    const device = await prisma.device.findFirst({ where: { id: parsed.data.deviceId, tenantId: req.auth!.tenantId } });
    if (!device) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
  }
  let match;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = cryptoCode();
    try { match = await prisma.match.create({ data: { tenantId: req.auth!.tenantId, deviceId: parsed.data.deviceId, gameKey: parsed.data.gameKey, code, maxPlayers: Math.min(8, planLimit(tenant.plan)), durationSeconds: 180 } }); break; } catch (error) { if (attempt === 4) throw error; }
  }
  if (!match) return res.status(500).json({ error: 'MATCH_CREATION_FAILED' });
  const joinBase = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0];
  return res.status(201).json({ matchId: match.id, code: match.code, status: match.status, joinUrl: `${joinBase}/join/${match.code}`, qrUrl: `/api/matches/${match.code}/qr` });
}));

app.get('/api/matches/:code', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findUnique({ where: { code }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } }, tenant: { include: { settings: true } } } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  return res.json({ ...publicMatch(match), restaurant: { name: match.tenant.settings?.displayName ?? match.tenant.name, slug: match.tenant.slug, primaryHex: match.tenant.settings?.primaryHex ?? '#f4b942', logoUrl: match.tenant.settings?.logoUrl ?? null } });
}));

app.get('/api/matches/:code/qr', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findUnique({ where: { code }, select: { code: true } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  const joinBase = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0];
  const dataUrl = await QRCode.toDataURL(`${joinBase}/join/${match.code}`, { errorCorrectionLevel: 'M', margin: 2, width: 500 });
  return res.json({ dataUrl });
}));

const hydrateEngine = async (matchId: string, durationSeconds: number) => {
  const match = await prisma.match.findUnique({ where: { id: matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
  if (!match) return undefined;
  const engine = engineFor(match.id, durationSeconds, match.stateJson as import('./game/engine.js').GameState | null);
  for (const participant of match.players) engine.addPlayer({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat });
  return { match, engine };
};

app.post('/api/matches/:code/start', requireAuth, requireRole('OWNER', 'MANAGER', 'OPERATOR'), asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findFirst({ where: { code, tenantId: req.auth!.tenantId } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  return withMatchLock(match.id, async () => {
    const hydrated = await hydrateEngine(match.id, match.durationSeconds);
    if (!hydrated) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
    if (hydrated.match.status !== 'WAITING') return res.status(409).json({ error: 'MATCH_NOT_WAITING' });
    if (hydrated.match.players.length < 2) return res.status(409).json({ error: 'NOT_ENOUGH_PLAYERS' });
    const state = hydrated.engine.start();
    await prisma.match.update({ where: { id: match.id }, data: { status: 'RUNNING', startedAt: new Date(state.startedAt ?? Date.now()), stateJson: JSON.parse(JSON.stringify(state)) } });
    engines.set(match.id, hydrated.engine);
    io.to(`match:${match.id}`).emit('game:state', state);
    return res.json(state);
  });
}));

app.post('/api/matches/:code/finish', requireAuth, requireRole('OWNER', 'MANAGER', 'OPERATOR'), asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findFirst({ where: { code, tenantId: req.auth!.tenantId } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  return withMatchLock(match.id, async () => {
    const hydrated = await hydrateEngine(match.id, match.durationSeconds);
    if (!hydrated) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
    if (hydrated.match.status === 'FINISHED') return res.status(409).json({ error: 'MATCH_ALREADY_FINISHED' });
    const state = hydrated.engine.finish();
    await prisma.$transaction([
      prisma.match.update({ where: { id: match.id }, data: { status: 'FINISHED', finishedAt: new Date(state.finishedAt ?? Date.now()), stateJson: JSON.parse(JSON.stringify(state)) } }),
      ...state.players.map((player) => prisma.matchPlayer.update({ where: { matchId_playerId: { matchId: match.id, playerId: player.id } }, data: { score: player.score } }))
    ]);
    await recordTournamentScores(match.tenantId, state.players.map((player) => ({ id: player.id, score: player.score })));
    engines.set(match.id, hydrated.engine);
    io.to(`match:${match.id}`).emit('game:state', state);
    return res.json({ ...state, winner: state.players.find((player) => player.id === state.winnerId) });
  });
}));

app.get('/api/matches/:code/results', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findUnique({ where: { code }, include: { players: { include: { player: true }, orderBy: { score: 'desc' } } } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  if (match.status !== 'FINISHED') return res.status(409).json({ error: 'MATCH_NOT_FINISHED' });
  return res.json({ code: match.code, finishedAt: match.finishedAt, results: match.players.map((participant, position) => ({ position: position + 1, playerId: participant.playerId, nickname: participant.player.nickname, score: participant.score })) });
}));

const joinInput = z.object({ nickname: z.string().trim().min(2).max(18), tableNumber: z.number().int().positive().max(1000) });
app.post('/api/matches/:code/join', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const parsed = joinInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_NICKNAME' });
  const requestedMatch = await prisma.match.findUnique({ where: { code }, select: { id: true } });
  if (!requestedMatch) return res.status(404).json({ error: 'MATCH_UNAVAILABLE' });
  const sessionToken = randomBytes(32).toString('base64url');
  const result = await withMatchLock(requestedMatch.id, () => prisma.$transaction(async (transaction) => {
    const match = await transaction.match.findUnique({ where: { code }, include: { players: true, tenant: { select: { slug: true } } } });
    if (!match || match.status !== 'WAITING') throw new ApiError(404, 'MATCH_UNAVAILABLE');
    if (match.players.length >= match.maxPlayers) throw new ApiError(409, 'MATCH_FULL');
    const tenant = await transaction.tenant.findUnique({ where: { id: match.tenantId } });
    if (!tenant || tenant.status !== 'ACTIVE') throw new ApiError(403, 'TENANT_INACTIVE');
    if (tenant.plan === 'FREE_TRIAL' && tenant.trialEndsAt < new Date()) throw new ApiError(403, 'TRIAL_EXPIRED');
    if (parsed.data.tableNumber > planLimit(tenant.plan)) throw new ApiError(403, 'TABLE_LIMIT_EXCEEDED');
    const player = await transaction.player.create({ data: { tenantId: match.tenantId, nickname: parsed.data.nickname } });
    const participant = await transaction.matchPlayer.create({ data: { matchId: match.id, playerId: player.id, seat: match.players.length + 1, tableNumber: parsed.data.tableNumber }, include: { player: true } });
    await transaction.playerSession.create({ data: { matchId: match.id, playerId: player.id, tokenHash: hashSession(sessionToken), expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) } });
    const allParticipants = await transaction.matchPlayer.findMany({ where: { matchId: match.id }, include: { player: true }, orderBy: { seat: 'asc' } });
    const engine = new BurgerRushEngine(match.durationSeconds, Date.now, (match.stateJson as import('./game/engine.js').GameState | null) ?? undefined);
    for (const entry of allParticipants) engine.addPlayer({ id: entry.playerId, nickname: entry.player.nickname, seat: entry.seat });
    await transaction.match.update({ where: { id: match.id }, data: { stateJson: JSON.parse(JSON.stringify(engine.snapshot())) } });
    return { participant, matchId: match.id, tenantSlug: match.tenant.slug, durationSeconds: match.durationSeconds, gameState: engine.snapshot() };
  }));
  engines.set(result.matchId, new BurgerRushEngine(result.durationSeconds, Date.now, result.gameState));
  io.to(`match:${result.matchId}`).emit('player:joined', { id: result.participant.playerId, nickname: result.participant.player.nickname, seat: result.participant.seat });
  return res.status(201).json({ playerId: result.participant.playerId, matchId: result.matchId, seat: result.participant.seat, tableNumber: result.participant.tableNumber, nickname: result.participant.player.nickname, tenantSlug: result.tenantSlug, sessionToken });
}));

const actionInput = z.object({ matchId: z.string().min(1), playerId: z.string().min(1), sessionToken: z.string().min(20), action: z.enum(['LEFT', 'RIGHT', 'JUMP', 'ATTACK', 'READY']) });
io.on('connection', (socket) => {
  socket.on('match:watch', async (payload: unknown) => {
    const parsed = z.object({ matchId: z.string().min(1) }).safeParse(payload);
    if (!parsed.success) return socket.emit('game:error', { error: 'INVALID_MATCH' });
    const match = await prisma.match.findUnique({ where: { id: parsed.data.matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } }, tenant: { include: { settings: true } } } });
    if (!match) return socket.emit('game:error', { error: 'MATCH_NOT_FOUND' });
    socket.join(`match:${match.id}`);
    const engine = engineFor(match.id, match.durationSeconds, match.stateJson as import('./game/engine.js').GameState | null);
    for (const participant of match.players) engine.addPlayer({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat });
    return socket.emit('match:snapshot', { ...publicMatch(match), game: engine.snapshot(), restaurant: { name: match.tenant.settings?.displayName ?? match.tenant.name, slug: match.tenant.slug, primaryHex: match.tenant.settings?.primaryHex ?? '#f4b942', logoUrl: match.tenant.settings?.logoUrl ?? null } });
  });
  socket.on('player:input', async (payload: unknown) => {
    const parsed = actionInput.safeParse(payload);
    if (!parsed.success) return socket.emit('game:error', { error: 'INVALID_ACTION' });
    try {
      await withMatchLock(parsed.data.matchId, async () => {
        const session = await prisma.playerSession.findFirst({ where: { matchId: parsed.data.matchId, playerId: parsed.data.playerId, tokenHash: hashSession(parsed.data.sessionToken), expiresAt: { gt: new Date() } } });
        const match = await prisma.match.findUnique({ where: { id: parsed.data.matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
        if (!session || !match || ['FINISHED', 'CANCELLED'].includes(match.status)) throw new ApiError(403, 'PLAYER_NOT_IN_MATCH');
        const participant = match.players.find((entry) => entry.playerId === parsed.data.playerId);
        if (!participant) throw new ApiError(403, 'PLAYER_NOT_IN_MATCH');
        const engine = new BurgerRushEngine(match.durationSeconds, Date.now, (match.stateJson as import('./game/engine.js').GameState | null) ?? undefined);
        for (const entry of match.players) engine.addPlayer({ id: entry.playerId, nickname: entry.player.nickname, seat: entry.seat });
        const before = engine.snapshot().players.find((player) => player.id === participant.playerId)?.score ?? 0;
        const state = engine.applyAction(parsed.data.playerId, parsed.data.action as GameAction);
        const after = state.players.find((player) => player.id === participant.playerId)?.score ?? before;
        await prisma.$transaction([
          prisma.match.update({ where: { id: parsed.data.matchId }, data: { status: state.status, startedAt: state.startedAt ? new Date(state.startedAt) : undefined, finishedAt: state.finishedAt ? new Date(state.finishedAt) : undefined, stateJson: JSON.parse(JSON.stringify(state)) } }),
          ...(after > before ? [prisma.scoreEvent.create({ data: { tenantId: match.tenantId, matchId: parsed.data.matchId, playerId: parsed.data.playerId, points: after - before, reason: parsed.data.action } })] : []),
          ...(state.status === 'FINISHED' ? state.players.map((player) => prisma.matchPlayer.update({ where: { matchId_playerId: { matchId: parsed.data.matchId, playerId: player.id } }, data: { score: player.score } })) : [])
        ]);
        if (state.status === 'FINISHED') await recordTournamentScores(match.tenantId, state.players.map((player) => ({ id: player.id, score: player.score })));
        engines.set(match.id, engine);
        io.to(`match:${parsed.data.matchId}`).emit('game:state', state);
        socket.to(`match:${parsed.data.matchId}`).emit('game:input', { playerId: parsed.data.playerId, action: parsed.data.action, at: Date.now() });
      });
    } catch (error) { socket.emit('game:error', { error: error instanceof Error ? error.message : 'INVALID_ACTION' }); }
  });
});

class ApiError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
function cryptoCode() { return randomInt(0, 36 ** 5).toString(36).padStart(5, '0').toUpperCase(); }

const recordTournamentScores = async (tenantId: string, players: Array<{ id: string; score: number }>) => {
  const tournaments = await prisma.tournament.findMany({ where: { tenantId, status: 'RUNNING' }, select: { id: true } });
  if (tournaments.length === 0) return;
  await prisma.$transaction(tournaments.flatMap((tournament) => players.map((player) => prisma.tournamentEntry.upsert({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: player.id } },
    create: { tournamentId: tournament.id, playerId: player.id, score: player.score },
    update: { score: { increment: player.score } }
  }))));
};

const tickGames = async () => {
  for (const matchId of engines.keys()) {
    await withMatchLock(matchId, async () => {
      const match = await prisma.match.findUnique({ where: { id: matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
      if (!match || match.status !== 'RUNNING') { engines.delete(matchId); return; }
      const engine = new BurgerRushEngine(match.durationSeconds, Date.now, (match.stateJson as import('./game/engine.js').GameState | null) ?? undefined);
      const state = engine.tick();
      if (state.status !== 'FINISHED') { engines.set(matchId, engine); return; }
      await prisma.$transaction([
        prisma.match.update({ where: { id: matchId }, data: { status: 'FINISHED', finishedAt: new Date(state.finishedAt ?? Date.now()), stateJson: JSON.parse(JSON.stringify(state)) } }),
        ...state.players.map((player) => prisma.matchPlayer.update({ where: { matchId_playerId: { matchId, playerId: player.id } }, data: { score: player.score } }))
      ]);
      await recordTournamentScores(match.tenantId, state.players.map((player) => ({ id: player.id, score: player.score })));
      engines.set(matchId, engine);
      io.to(`match:${matchId}`).emit('game:state', state);
    });
  }
};
const gameTicker = setInterval(() => void tickGames().catch((error) => console.error('Game ticker failed', error)), 1000);
gameTicker.unref();
const sessionCleaner = setInterval(() => void prisma.playerSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch((error) => console.error('Session cleanup failed', error)), 5 * 60 * 1000);
sessionCleaner.unref();

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ApiError) return res.status(error.statusCode).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});

const start = async () => {
  await prisma.$connect();
  if (redisPub && redisSub) io.adapter(createAdapter(redisPub, redisSub));
  httpServer.listen(port, () => console.log(`GameTable API listening on http://localhost:${port}`));
};

const shutdown = async (signal: string) => {
  console.log(`${signal}: shutting down`);
  clearInterval(gameTicker);
  clearInterval(sessionCleaner);
  io.close();
  httpServer.close(async () => { await redisPub?.quit(); await redisSub?.quit(); await redisCoordinator?.quit(); await prisma.$disconnect(); process.exit(0); });
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
start().catch(async (error) => { console.error('Unable to start API', error); await prisma.$disconnect(); process.exit(1); });
