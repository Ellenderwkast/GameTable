import { strict as assert } from 'node:assert';
import test from 'node:test';
import { BurgerRushEngine } from './engine.js';

test('starts only when every connected player is ready', () => {
  const engine = new BurgerRushEngine();
  engine.addPlayer({ id: 'p1', nickname: 'Ana', seat: 1 });
  engine.addPlayer({ id: 'p2', nickname: 'Luis', seat: 2 });
  assert.equal(engine.applyAction('p1', 'READY').status, 'WAITING');
  assert.equal(engine.applyAction('p2', 'READY').status, 'RUNNING');
});

test('scores valid actions and clamps movement', () => {
  let now = 1_000;
  const engine = new BurgerRushEngine(180, () => now);
  engine.addPlayer({ id: 'p1', nickname: 'Ana', seat: 5 });
  engine.addPlayer({ id: 'p2', nickname: 'Luis', seat: 1 });
  engine.start();
  const first = engine.applyAction('p1', 'LEFT');
  assert.equal(first.players[0]?.score, 100);
  now += 200;
  const moved = engine.applyAction('p1', 'RIGHT');
  assert.equal(moved.players[0]?.x, 500);
});

test('finishes at the configured duration and selects the winner', () => {
  let now = 0;
  const engine = new BurgerRushEngine(3, () => now);
  engine.addPlayer({ id: 'p1', nickname: 'Ana', seat: 1 });
  engine.addPlayer({ id: 'p2', nickname: 'Luis', seat: 2 });
  engine.start();
  now = 3_000;
  const result = engine.tick();
  assert.equal(result.status, 'FINISHED');
  assert.equal(result.winnerId, 'p1');
});

test('does not start with fewer than two players', () => {
  const engine = new BurgerRushEngine();
  engine.addPlayer({ id: 'p1', nickname: 'Ana', seat: 1 });
  assert.equal(engine.applyAction('p1', 'READY').status, 'WAITING');
});

test('restores a persisted state for reconnecting workers', () => {
  let now = 10_000;
  const original = new BurgerRushEngine(180, () => now);
  original.addPlayer({ id: 'p1', nickname: 'Ana', seat: 5 });
  original.addPlayer({ id: 'p2', nickname: 'Luis', seat: 2 });
  original.start();
  now += 100;
  original.applyAction('p1', 'LEFT');
  const restored = new BurgerRushEngine(180, () => now, original.snapshot());
  assert.equal(restored.snapshot().players[0]?.score, 100);
  assert.equal(restored.snapshot().status, 'RUNNING');
});

test('awards quiz points only during a running match', () => {
  const engine = new BurgerRushEngine();
  engine.addPlayer({ id: 'p1', nickname: 'Ana', seat: 1 });
  engine.addPlayer({ id: 'p2', nickname: 'Luis', seat: 2 });
  assert.throws(() => engine.awardPoints('p1', 100), /MATCH_NOT_RUNNING/);
  engine.start();
  assert.equal(engine.awardPoints('p1', 100).players[0]?.score, 100);
  assert.throws(() => engine.awardPoints('p1', 101), /INVALID_SCORE_EVENT/);
});