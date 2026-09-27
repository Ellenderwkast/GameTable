export type GameAction = 'LEFT' | 'RIGHT' | 'JUMP' | 'ATTACK' | 'READY';
export type GameStatus = 'WAITING' | 'RUNNING' | 'FINISHED';

export type GamePlayer = {
  id: string;
  nickname: string;
  seat: number;
  x: number;
  y: number;
  score: number;
  ready: boolean;
  lastActionAt: number;
};

export type GameState = {
  status: GameStatus;
  startedAt?: number;
  finishedAt?: number;
  durationSeconds: number;
  players: GamePlayer[];
  winnerId?: string;
  ingredientX: number;
};

export class BurgerRushEngine {
  private readonly players = new Map<string, GamePlayer>();
  private status: GameStatus = 'WAITING';
  private startedAt?: number;
  private finishedAt?: number;
  private winnerId?: string;
  private ingredientX = 500;

  constructor(private readonly durationSeconds = 180, private readonly now: () => number = Date.now, initialState?: GameState) {
    if (!initialState) return;
    this.status = initialState.status;
    this.startedAt = initialState.startedAt;
    this.finishedAt = initialState.finishedAt;
    this.winnerId = initialState.winnerId;
    this.ingredientX = initialState.ingredientX ?? 500;
    for (const player of initialState.players) this.players.set(player.id, { ...player });
  }

  addPlayer(player: Pick<GamePlayer, 'id' | 'nickname' | 'seat'>) {
    if (this.players.has(player.id)) return this.players.get(player.id)!;
    if (this.status !== 'WAITING') throw new Error('MATCH_ALREADY_STARTED');
    if (this.players.size >= 8) throw new Error('MATCH_FULL');
    const created: GamePlayer = { ...player, x: 100 + (player.seat - 1) * 100, y: 220, score: 0, ready: false, lastActionAt: 0 };
    this.players.set(player.id, created);
    return created;
  }

  applyAction(playerId: string, action: GameAction) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (action === 'READY') { player.ready = true; const players = [...this.players.values()]; if (players.length >= 2 && players.every((item) => item.ready)) this.start(); return this.snapshot(); }
    if (this.status !== 'RUNNING') throw new Error('MATCH_NOT_RUNNING');
    const now = this.now();
    if (now - player.lastActionAt < 180) return this.snapshot();
    player.lastActionAt = now;
    if (action === 'LEFT') player.x = Math.max(40, player.x - 24);
    if (action === 'RIGHT') player.x = Math.min(860, player.x + 24);
    if (action === 'JUMP') player.y = 140;
    if ((action === 'LEFT' || action === 'RIGHT') && Math.abs(player.x - this.ingredientX) <= 30) {
      player.score += 100;
      this.ingredientX = 80 + ((this.ingredientX * 17 + 113) % 740);
    }
    if (action === 'ATTACK') {
      for (const rival of this.players.values()) {
        if (rival.id !== player.id && Math.abs(rival.x - player.x) <= 70) {
          rival.x = Math.min(860, rival.x + (rival.x >= player.x ? 48 : -48));
          player.score += 25;
        }
      }
    }
    this.tick();
    return this.snapshot();
  }

  start() {
    if (this.status === 'WAITING') {
      if (this.players.size < 2) throw new Error('NOT_ENOUGH_PLAYERS');
      this.status = 'RUNNING'; this.startedAt = this.now();
    }
    return this.snapshot();
  }

  finish() { if (this.status !== 'FINISHED') { this.status = 'FINISHED'; this.finishedAt = this.now(); this.winnerId = [...this.players.values()].sort((left, right) => right.score - left.score)[0]?.id; } return this.snapshot(); }

  awardPoints(playerId: string, points: number) {
    if (this.status !== 'RUNNING') throw new Error('MATCH_NOT_RUNNING');
    const player = this.players.get(playerId);
    if (!player || !Number.isInteger(points) || points < 0 || points > 100) throw new Error('INVALID_SCORE_EVENT');
    player.score += points;
    return this.snapshot();
  }

  tick() {
    if (this.status === 'RUNNING' && this.startedAt !== undefined && this.now() - this.startedAt >= this.durationSeconds * 1000) {
      this.status = 'FINISHED'; this.finishedAt = this.now(); this.winnerId = [...this.players.values()].sort((left, right) => right.score - left.score)[0]?.id;
    }
    for (const player of this.players.values()) if (player.y !== 220) player.y = 220;
    return this.snapshot();
  }

  snapshot(): GameState { return { status: this.status, startedAt: this.startedAt, finishedAt: this.finishedAt, durationSeconds: this.durationSeconds, winnerId: this.winnerId, ingredientX: this.ingredientX, players: [...this.players.values()].map((player) => ({ ...player })) }; }
}