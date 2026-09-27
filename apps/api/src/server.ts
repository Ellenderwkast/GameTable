import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import http from 'node:http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' } });
const port = Number(process.env.API_PORT ?? 4000);

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gametable-api', timestamp: new Date().toISOString() }));

app.get('/api/tenants/:slug', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug }, include: { settings: true } });
  if (!tenant) return res.status(404).json({ error: 'RESTAURANT_NOT_FOUND' });
  return res.json({ id: tenant.id, name: tenant.settings?.displayName ?? tenant.name, slug: tenant.slug, plan: tenant.plan, settings: tenant.settings });
});

const matchInput = z.object({ tenantSlug: z.string().min(2), deviceId: z.string().optional(), gameKey: z.string().default('burger-rush') });
app.post('/api/matches', async (req, res) => {
  const parsed = matchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const tenant = await prisma.tenant.findUnique({ where: { slug: parsed.data.tenantSlug } });
  if (!tenant) return res.status(404).json({ error: 'RESTAURANT_NOT_FOUND' });
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  const match = await prisma.match.create({ data: { tenantId: tenant.id, deviceId: parsed.data.deviceId, gameKey: parsed.data.gameKey, code } });
  return res.status(201).json({ matchId: match.id, code: match.code, status: match.status, joinUrl: `/join/${match.code}` });
});

app.get('/api/matches/:code', async (req, res) => {
  const match = await prisma.match.findUnique({ where: { code: req.params.code }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
  if (!match) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
  return res.json({ id: match.id, code: match.code, status: match.status, players: match.players.map((participant) => ({ id: participant.playerId, nickname: participant.player.nickname, seat: participant.seat, score: participant.score })) });
});

const joinInput = z.object({ nickname: z.string().trim().min(2).max(18) });
app.post('/api/matches/:code/join', async (req, res) => {
  const parsed = joinInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_NICKNAME' });
  const match = await prisma.match.findUnique({ where: { code: req.params.code }, include: { players: true } });
  if (!match || match.status !== 'WAITING') return res.status(404).json({ error: 'MATCH_UNAVAILABLE' });
  if (match.players.length >= 8) return res.status(409).json({ error: 'MATCH_FULL' });
  const player = await prisma.player.create({ data: { tenantId: match.tenantId, nickname: parsed.data.nickname } });
  const participant = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id, seat: match.players.length + 1 }, include: { player: true } });
  io.to(`match:${match.id}`).emit('player:joined', { id: participant.playerId, nickname: player.nickname, seat: participant.seat });
  return res.status(201).json({ playerId: player.id, matchId: match.id, seat: participant.seat, nickname: player.nickname });
});

io.on('connection', (socket) => {
  socket.on('match:watch', async ({ matchId }: { matchId: string }) => {
    socket.join(`match:${matchId}`);
    const match = await prisma.match.findUnique({ where: { id: matchId }, include: { players: { include: { player: true }, orderBy: { seat: 'asc' } } } });
    if (match) socket.emit('match:snapshot', { id: match.id, code: match.code, status: match.status, players: match.players.map((p) => ({ id: p.playerId, nickname: p.player.nickname, seat: p.seat, score: p.score })) });
  });
  socket.on('player:input', (payload: { matchId: string; playerId: string; action: string }) => {
    if (!['LEFT', 'RIGHT', 'JUMP', 'ATTACK', 'READY'].includes(payload.action)) return;
    socket.to(`match:${payload.matchId}`).emit('game:input', { playerId: payload.playerId, action: payload.action });
  });
});

httpServer.listen(port, () => console.log(`GameTable API listening on http://localhost:${port}`));