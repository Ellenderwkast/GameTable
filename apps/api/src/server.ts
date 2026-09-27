import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

type AuthContext = { userId: string; tenantId: string; role: 'OWNER' | 'MANAGER' | 'OPERATOR' };
declare global { namespace Express { interface Request { auth?: AuthContext } } }

const prisma = new PrismaClient();
const app = express();
const httpServer = http.createServer(app);
const port = Number(process.env.API_PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? 'local-development-secret-change-me';
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const allowedOrigins = new Set(webOrigin.split(',').map((origin) => origin.trim()).filter(Boolean));
const io = new Server(httpServer, { cors: { origin: [...allowedOrigins], credentials: true } });
const redisUrl = process.env.REDIS_URL;
const redisPub = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const redisSub = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next);
const tokenFor = (auth: AuthContext) => jwt.sign(auth, jwtSecret, { expiresIn: '12h', issuer: 'gametable-api' });
const publicMatch = (match: { id: string; code: string; status: string; players: Array<{ playerId: string; seat: number; score: number; player: { nickname: string } }> }) => ({ id: match.id, code: match.code, status: match.status, players: match.players.map((participant) => ({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat, score: participant.score })) });
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
app.use(helmet());
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/health', asyncRoute(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: 'ok', service: 'gametable-api', timestamp: new Date().toISOString(), redis: Boolean(redisUrl) });
}));
const registerInput = z.object({ restaurantName: z.string().trim().min(2).max(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,48}$/), name: z.string().trim().min(2).max(80), email: z.string().email().max(160), password: z.string().min(10).max(128) });
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const parsed = registerInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const tenant = await prisma.tenant.create({ data: { name: parsed.data.restaurantName, slug: parsed.data.slug, settings: { create: { displayName: parsed.data.restaurantName } }, users: { create: { name: parsed.data.name, email: parsed.data.email.toLowerCase(), passwordHash, role: 'OWNER' } } }, include: { users: true } });
  const user = tenant.users[0];
  if (!user) return res.status(500).json({ error: 'USER_CREATION_FAILED' });
  const auth: AuthContext = { userId: user.id, tenantId: tenant.id, role: user.role };
  return res.status(201).json({ token: tokenFor(auth), user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
}));

const loginInput = z.object({ email: z.string().email(), password: z.string().min(1) });
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const user = await prisma.user.findFirst({ where: { email: parsed.data.email.toLowerCase(), tenant: { status: 'ACTIVE' } }, include: { tenant: true } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  const auth: AuthContext = { userId: user.id, tenantId: user.tenantId, role: user.role };
  return res.json({ token: tokenFor(auth), user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug } });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.auth!.userId, tenantId: req.auth!.tenantId }, include: { tenant: { include: { settings: true } } } });
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: user.tenant });
}));

app.get('/api/dashboard/summary', requireAuth, asyncRoute(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [matchesToday, activePlayers, topScores] = await Promise.all([
    prisma.match.count({ where: { tenantId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    prisma.matchPlayer.count({ where: { match: { tenantId, status: { in: ['WAITING', 'RUNNING'] } } } }),
    prisma.matchPlayer.findMany({ where: { match: { tenantId } }, orderBy: { score: 'desc' }, take: 5, include: { player: true, match: { select: { code: true } } } })
  ]);
  return res.json({ matchesToday, activePlayers, topScores: topScores.map((score) => ({ nickname: score.player.nickname, score: score.score, matchCode: score.match.code })) });
}));

const matchInput = z.object({ gameKey: z.string().trim().min(2).max(40).default('burger-rush'), deviceId: z.string().optional() });
app.post('/api/matches', requireAuth, requireRole('OWNER', 'MANAGER', 'OPERATOR'), asyncRoute(async (req, res) => {
  const parsed = matchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  if (parsed.data.deviceId) {
    const device = await prisma.device.findFirst({ where: { id: parsed.data.deviceId, tenantId: req.auth!.tenantId } });
    if (!device) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
  }
  let match;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = cryptoCode();
    try { match = await prisma.match.create({ data: { tenantId: req.auth!.tenantId, deviceId: parsed.data.deviceId, gameKey: parsed.data.gameKey, code } }); break; } catch (error) { if (attempt === 4) throw error; }
  }
  if (!match) return res.status(500).json({ error: 'MATCH_CREATION_FAILED' });
  const joinBase = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0];
  return res.status(201).json({ matchId: match.id, code: match.code, status: match.status, joinUrl: `${joinBase}/join/${match.code}`, qrUrl: `/api/matches/${match.code}/qr` });
}));

app.get('/api/matches/:code', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findUnique({ where: { code }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  return res.json(publicMatch(match));
}));

app.get('/api/matches/:code/qr', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const match = await prisma.match.findUnique({ where: { code }, select: { code: true } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  const joinBase = process.env.PUBLIC_WEB_URL ?? webOrigin.split(',')[0];
  const dataUrl = await QRCode.toDataURL(`${joinBase}/join/${match.code}`, { errorCorrectionLevel: 'M', margin: 2, width: 500 });
  return res.json({ dataUrl });
}));

const joinInput = z.object({ nickname: z.string().trim().min(2).max(18) });
app.post('/api/matches/:code/join', asyncRoute(async (req, res) => {
  const code = String(req.params.code);
  const parsed = joinInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_NICKNAME' });
  const result = await prisma.$transaction(async (transaction) => {
    const match = await transaction.match.findUnique({ where: { code }, include: { players: true } });
    if (!match || match.status !== 'WAITING') throw new ApiError(404, 'MATCH_UNAVAILABLE');
    if (match.players.length >= 8) throw new ApiError(409, 'MATCH_FULL');
    const player = await transaction.player.create({ data: { tenantId: match.tenantId, nickname: parsed.data.nickname } });
    return transaction.matchPlayer.create({ data: { matchId: match.id, playerId: player.id, seat: match.players.length + 1 }, include: { player: true } });
  });
  io.to(`match:${result.matchId}`).emit('player:joined', { id: result.playerId, nickname: result.player.nickname, seat: result.seat });
  return res.status(201).json({ playerId: result.playerId, matchId: result.matchId, seat: result.seat, nickname: result.player.nickname });
}));

const actionInput = z.object({ matchId: z.string().min(1), playerId: z.string().min(1), action: z.enum(['LEFT', 'RIGHT', 'JUMP', 'ATTACK', 'READY']) });
io.on('connection', (socket) => {
  socket.on('match:watch', async (payload: unknown) => {
    const parsed = z.object({ matchId: z.string().min(1) }).safeParse(payload);
    if (!parsed.success) return socket.emit('game:error', { error: 'INVALID_MATCH' });
    const match = await prisma.match.findUnique({ where: { id: parsed.data.matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
    if (!match) return socket.emit('game:error', { error: 'MATCH_NOT_FOUND' });
    socket.join(`match:${match.id}`);
    return socket.emit('match:snapshot', publicMatch(match));
  });
  socket.on('player:input', async (payload: unknown) => {
    const parsed = actionInput.safeParse(payload);
    if (!parsed.success) return socket.emit('game:error', { error: 'INVALID_ACTION' });
    const participant = await prisma.matchPlayer.findUnique({ where: { matchId_playerId: { matchId: parsed.data.matchId, playerId: parsed.data.playerId } }, include: { match: true } });
    if (!participant || ['FINISHED', 'CANCELLED'].includes(participant.match.status)) return socket.emit('game:error', { error: 'PLAYER_NOT_IN_MATCH' });
    if (parsed.data.action === 'READY' && participant.match.status === 'WAITING') await prisma.match.update({ where: { id: participant.matchId }, data: { status: 'RUNNING', startedAt: new Date() } });
    socket.to(`match:${parsed.data.matchId}`).emit('game:input', { playerId: parsed.data.playerId, action: parsed.data.action, at: Date.now() });
  });
});

class ApiError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
function cryptoCode() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }

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
  io.close();
  httpServer.close(async () => { await redisPub?.quit(); await redisSub?.quit(); await prisma.$disconnect(); process.exit(0); });
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
start().catch(async (error) => { console.error('Unable to start API', error); await prisma.$disconnect(); process.exit(1); });
