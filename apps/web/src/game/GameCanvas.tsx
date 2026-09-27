import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { createBurgerRushGame, type GameAction } from './BurgerRushGame';

type Player = { id: string; nickname: string; seat: number };
type Props = { socket: Socket | undefined; players: Player[] };

export function GameCanvas({ socket, players }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const game = useRef<ReturnType<typeof createBurgerRushGame> | undefined>(undefined);
  useEffect(() => {
    if (!container.current) return;
    game.current = createBurgerRushGame(container.current, () => undefined);
    return () => { game.current?.game.destroy(true); game.current = undefined; };
  }, []);
  useEffect(() => {
    for (const player of players) game.current?.scene().addPlayer(player.id, player.seat, player.nickname);
  }, [players]);
  useEffect(() => {
    const handleInput = (payload: { playerId: string; action: GameAction }) => game.current?.scene().applyInput(payload.playerId, payload.action);
    socket?.on('game:input', handleInput);
    return () => { socket?.off('game:input', handleInput); };
  }, [socket]);
  return <div ref={container} className="game-canvas" aria-label="Arena Burger Rush" />;
}