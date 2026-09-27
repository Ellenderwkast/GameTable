import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

type Player = { id: string; nickname: string; seat: number };
type GameSnapshot = { ingredientX: number; players: Array<{ id: string; x: number; y: number }> };
type Props = { socket: Socket | undefined; players: Player[]; gameState?: GameSnapshot };
type GameInstance = ReturnType<typeof import('./BurgerRushGame').createBurgerRushGame>;

export function GameCanvas({ socket, players, gameState }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const game = useRef<GameInstance | undefined>(undefined);
  const latestPlayers = useRef(players);
  const latestState = useRef(gameState);
  useEffect(() => {
    if (!container.current) return;
    let mounted = true;
    void import('./BurgerRushGame').then(({ createBurgerRushGame }) => {
      if (!mounted || !container.current) return;
      game.current = createBurgerRushGame(container.current);
      for (const player of latestPlayers.current) game.current.scene().addPlayer(player.id, player.seat, player.nickname);
      if (latestState.current) {
        game.current.scene().syncPlayers(latestState.current.players);
        game.current.scene().setIngredientPosition(latestState.current.ingredientX);
      }
    });
    return () => { mounted = false; game.current?.game.destroy(true); game.current = undefined; };
  }, []);
  useEffect(() => {
    latestPlayers.current = players;
    for (const player of players) game.current?.scene().addPlayer(player.id, player.seat, player.nickname);
  }, [players]);
  useEffect(() => {
    latestState.current = gameState;
    if (!gameState) return;
    game.current?.scene().syncPlayers(gameState.players);
    game.current?.scene().setIngredientPosition(gameState.ingredientX);
  }, [gameState]);
  useEffect(() => {
    const handleInput = (payload: { playerId: string; action: 'LEFT' | 'RIGHT' | 'JUMP' | 'ATTACK' }) => game.current?.scene().applyInput(payload.playerId, payload.action);
    const handleState = (state: GameSnapshot) => { game.current?.scene().syncPlayers(state.players); game.current?.scene().setIngredientPosition(state.ingredientX); };
    socket?.on('game:input', handleInput);
    socket?.on('game:state', handleState);
    return () => { socket?.off('game:input', handleInput); socket?.off('game:state', handleState); };
  }, [socket]);
  return <div ref={container} className="game-canvas" aria-label="Arena Burger Rush" />;
}