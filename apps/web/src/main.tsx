import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Player = { id: string; nickname: string; seat: number; score?: number };

function App() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? (location.pathname.startsWith('/join') ? 'controller' : 'dashboard');
  const [players, setPlayers] = useState<Player[]>([]);
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [message, setMessage] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [matchId, setMatchId] = useState('');

  useEffect(() => {
    if (mode !== 'screen' || !code) return;
    let socket: ReturnType<typeof io> | undefined;
    let cancelled = false;
    fetch(`${API}/api/matches/${code}`).then((response) => response.json()).then((match) => {
      if (cancelled || !match.id) return;
      setMatchId(match.id);
      setPlayers(match.players ?? []);
      socket = io(API);
      socket.emit('match:watch', { matchId: match.id });
      socket.on('match:snapshot', (snapshot: { players: Player[] }) => setPlayers(snapshot.players));
      socket.on('player:joined', (player: Player) => setPlayers((current) => [...current, player]));
    }).catch(() => setMessage('No se pudo cargar la partida'));
    return () => { cancelled = true; socket?.disconnect(); };
  }, [mode, code]);

  const createMatch = async () => {
    const response = await fetch(`${API}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantSlug: 'demo-burger-house' }) });
    const data = await response.json();
    setCode(data.code); setMessage(`Partida ${data.code} creada`);
  };

  const join = async () => {
    const response = await fetch(`${API}/api/matches/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname }) });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'No se pudo unir');
    setPlayerId(data.playerId); setMatchId(data.matchId); setMessage(`Bienvenido, ${data.nickname}`);
  };

  const sendAction = (action: string) => {
    if (!matchId || !playerId) return setMessage('Entra a la partida primero');
    const socket = io(API); socket.emit('player:input', { matchId, playerId, action }); socket.disconnect(); setMessage(`${action} enviado`);
  };

  if (mode === 'controller') return <main className="controller"><span className="eyebrow">GAMETABLE / CONTROL</span><h1>Únete a la arena</h1><p className="muted">Código de partida: <strong>{code || 'sin código'}</strong></p><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Tu nickname" maxLength={18} /><button onClick={join}>Entrar a jugar</button><div className="pad"><button onClick={() => sendAction('JUMP')}>↑</button><button onClick={() => sendAction('ATTACK')}>⚡</button><button onClick={() => sendAction('LEFT')}>←</button><button onClick={() => sendAction('RIGHT')}>→</button></div><p className="status">{message}</p></main>;
  if (mode === 'screen') return <main className="screen"><span className="eyebrow">BURGER HOUSE / LIVE</span><h1>La arena está lista.</h1><div className="join-code">{code || 'A7K92'}</div><p>Escanea el QR y juega desde tu mesa</p><div className="players">{players.length ? players.map((player) => <div key={player.id}>{player.nickname}<small>MESA {player.seat}</small></div>) : <div className="empty">Esperando jugadores...</div>}</div></main>;
  return <main className="dashboard"><nav><strong>GAMETABLE</strong><span>Operaciones / Burger House</span></nav><section className="hero"><span className="eyebrow">PANEL DEL RESTAURANTE</span><h1>Convierte la espera en una partida.</h1><p>Administra tu arena, lanza una partida y mira cómo compite tu salón en tiempo real.</p><button onClick={createMatch}>Crear partida</button><p className="status">{message} {code && <a href={`/?mode=screen&code=${code}`}>Abrir pantalla</a>}</p></section><section className="metrics"><div><small>PARTIDAS HOY</small><strong>24</strong></div><div><small>JUGADORES ACTIVOS</small><strong>86</strong></div><div><small>RÉCORD DEL DÍA</small><strong>8.420</strong></div></section></main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);