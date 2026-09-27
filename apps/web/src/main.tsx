import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { GameCanvas } from './game/GameCanvas';
import './styles.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Player = { id: string; nickname: string; seat: number; score?: number };
type Match = { id: string; code: string; status: string; players: Player[] };

function App() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? (location.pathname.startsWith('/join') ? 'controller' : 'dashboard');
  if (mode === 'controller') return <Controller initialCode={params.get('code') ?? location.pathname.split('/').pop() ?? ''} />;
  if (mode === 'screen') return <Screen initialCode={params.get('code') ?? ''} />;
  return <Dashboard />;
}

function Dashboard() {
  const [token, setToken] = useState(() => localStorage.getItem('gametable_token') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [restaurantName, setRestaurantName] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState({ matchesToday: 0, activePlayers: 0, topScores: [] as Array<{ nickname: string; score: number }> });
  const [code, setCode] = useState('');

  useEffect(() => { if (!token) return; fetch(`${API}/api/dashboard/summary`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : Promise.reject()).then(setSummary).catch(() => { localStorage.removeItem('gametable_token'); setToken(''); }); }, [token]);

  const authenticate = async () => {
    const endpoint = registering ? '/api/auth/register' : '/api/auth/login';
    const body = registering ? { restaurantName, slug, name, email, password } : { email, password };
    const response = await fetch(`${API}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'No se pudo autenticar');
    localStorage.setItem('gametable_token', data.token); setToken(data.token); setMessage('Sesión iniciada');
  };

  const createMatch = async () => {
    const response = await fetch(`${API}/api/matches`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gameKey: 'burger-rush' }) });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'No se pudo crear la partida');
    setCode(data.code); setMessage(`Partida ${data.code} lista para compartir`);
  };

  if (!token) return <main className="auth"><span className="eyebrow">GAMETABLE / OPERACIONES</span><h1>Tu restaurante, convertido en arena.</h1><p>Administra partidas rápidas, jugadores y ranking desde un solo lugar.</p><div className="auth-form">{registering && <><input value={restaurantName} onChange={(event) => setRestaurantName(event.target.value)} placeholder="Nombre del restaurante" /><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="slug-del-restaurante" /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tu nombre" /></>}<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Correo electrónico" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Contraseña (10 caracteres mínimo)" /><button onClick={authenticate}>{registering ? 'Crear cuenta' : 'Entrar al panel'}</button><button className="quiet" onClick={() => setRegistering((current) => !current)}>{registering ? 'Ya tengo una cuenta' : 'Crear restaurante'}</button><p className="status">{message}</p></div></main>;
  return <main className="dashboard"><nav><strong>GAMETABLE</strong><span>Operaciones / restaurante</span><button className="quiet" onClick={() => { localStorage.removeItem('gametable_token'); setToken(''); }}>Salir</button></nav><section className="hero"><span className="eyebrow">PANEL DEL RESTAURANTE</span><h1>Convierte la espera en una partida.</h1><p>Lanza Burger Rush y deja que cada mesa compita desde su propio celular.</p><button onClick={createMatch}>Crear partida</button><p className="status">{message} {code && <a href={`/?mode=screen&code=${code}`}>Abrir pantalla</a>}</p></section><section className="metrics"><div><small>PARTIDAS HOY</small><strong>{summary.matchesToday}</strong></div><div><small>JUGADORES ACTIVOS</small><strong>{summary.activePlayers}</strong></div><div><small>RANKING</small><strong>{summary.topScores[0]?.score ?? 0}</strong></div></section>{summary.topScores.length > 0 && <section className="ranking"><span className="eyebrow">TOP DEL RESTAURANTE</span>{summary.topScores.map((score, index) => <div key={`${score.nickname}-${index}`}><strong>0{index + 1}</strong><span>{score.nickname}</span><b>{score.score.toLocaleString('es-CO')}</b></div>)}</section>}</main>;
}

function Screen({ initialCode }: { initialCode: string }) {
  const [match, setMatch] = useState<Match>(); const [qr, setQr] = useState(''); const [socket, setSocket] = useState<Socket>();
  useEffect(() => { if (!initialCode) return; let active = true; fetch(`${API}/api/matches/${initialCode}`).then((response) => response.json()).then((data: Match) => { if (!active || !data.id) return; setMatch(data); return fetch(`${API}/api/matches/${initialCode}/qr`); }).then((response) => response?.json()).then((data) => { if (data?.dataUrl) setQr(data.dataUrl); }).catch(() => undefined); return () => { active = false; }; }, [initialCode]);
  useEffect(() => { if (!match) return; const current = io(API); current.emit('match:watch', { matchId: match.id }); current.on('match:snapshot', (snapshot: Match) => setMatch(snapshot)); current.on('player:joined', (player: Player) => setMatch((previous) => previous ? { ...previous, players: [...previous.players, player] } : previous)); setSocket(current); return () => { current.disconnect(); setSocket(undefined); }; }, [match?.id]);
  if (!match) return <main className="screen"><span className="eyebrow">GAMETABLE / LIVE</span><h1>Preparando la arena...</h1><p>Espera un momento mientras conectamos la pantalla.</p></main>;
  return <main className="screen"><div className="screen-head"><span className="eyebrow">BURGER HOUSE / LIVE</span><span className="live-dot">EN VIVO</span></div><h1>Escanea y entra.</h1><div className="screen-layout"><div><div className="join-code">{match.code}</div><p>Abre el enlace en tu celular y juega desde tu mesa.</p><GameCanvas socket={socket} players={match.players} /></div><aside>{qr && <img className="qr" src={qr} alt={`Código QR para unirse a la partida ${match.code}`} />}<strong>{match.players.length}/8 jugadores</strong><div className="players">{match.players.length ? match.players.map((player) => <div key={player.id}><b>{player.nickname}</b><small>MESA {player.seat}</small></div>) : <div className="empty">Esperando jugadores...</div>}</div></aside></div></main>;
}

function Controller({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode.toUpperCase()); const [nickname, setNickname] = useState(''); const [playerId, setPlayerId] = useState(''); const [matchId, setMatchId] = useState(''); const [message, setMessage] = useState(''); const socket = useRef<Socket | undefined>(undefined);
  useEffect(() => () => { socket.current?.disconnect(); }, []);
  const join = async () => { const response = await fetch(`${API}/api/matches/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname }) }); const data = await response.json(); if (!response.ok) return setMessage(data.error ?? 'No se pudo unir'); setPlayerId(data.playerId); setMatchId(data.matchId); socket.current = io(API); setMessage(`Listo, ${data.nickname}`); };
  const sendAction = (action: string) => { if (!playerId || !matchId || !socket.current) return setMessage('Primero entra a la partida'); socket.current.emit('player:input', { matchId, playerId, action }); setMessage(`${action} enviado`); };
  return <main className="controller"><span className="eyebrow">GAMETABLE / CONTROL</span><h1>Únete a la arena.</h1><p className="muted">Escribe el código que aparece en la pantalla.</p><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="A7K92" maxLength={5} /><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Tu nickname" maxLength={18} /><button onClick={join}>Entrar a jugar</button><div className="pad"><button onClick={() => sendAction('JUMP')}>↑</button><button onClick={() => sendAction('ATTACK')}>⚡</button><button onClick={() => sendAction('LEFT')}>←</button><button onClick={() => sendAction('RIGHT')}>→</button></div><p className="status">{message}</p></main>;
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
