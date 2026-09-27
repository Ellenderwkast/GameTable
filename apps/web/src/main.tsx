import { StrictMode, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { Management } from './Management';
import { GameCanvas } from './game/GameCanvas';
import './styles.css';
import './game-controls.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Player = { id: string; nickname: string; seat: number; tableNumber?: number; score?: number };
type GameSnapshot = { status: string; startedAt?: number; durationSeconds: number; ingredientX: number; players: Array<Player & { x: number; y: number }>; winnerId?: string };
type Advertisement = { id: string; title: string; imageUrl: string | null; targetUrl: string | null };
type ActiveQuestionnaire = { id: string; title: string; questions: Array<{ id: string; prompt: string; optionsJson: string[] }> };
type Match = { id: string; code: string; status: string; players: Player[]; game?: GameSnapshot; restaurant?: { name: string; slug: string; primaryHex: string; logoUrl: string | null } };

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
  const [tenantSlug, setTenantSlug] = useState('demo-burger-house');
  const [restaurantName, setRestaurantName] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState({ matchesToday: 0, activePlayers: 0, topScores: [] as Array<{ nickname: string; score: number }> });
  const [code, setCode] = useState('');
  const [matchStarted, setMatchStarted] = useState(false);
  const [billingPlan, setBillingPlan] = useState('STARTER_10');
  const [brandName, setBrandName] = useState('');
  const [brandColor, setBrandColor] = useState('#f4b942');

  useEffect(() => { if (!token) return; const headers = { Authorization: `Bearer ${token}` }; fetch(`${API}/api/dashboard/summary`, { headers }).then((response) => response.ok ? response.json() : Promise.reject()).then(setSummary).catch(() => { localStorage.removeItem('gametable_token'); setToken(''); }); fetch(`${API}/api/settings`, { headers }).then((response) => response.ok ? response.json() : null).then((settings) => { if (settings) { setBrandName(settings.displayName ?? ''); setBrandColor(settings.primaryHex ?? '#f4b942'); } }).catch(() => undefined); }, [token]);

  const authenticate = async () => {
    const endpoint = registering ? '/api/auth/register' : '/api/auth/login';
    const body = registering ? { restaurantName, slug, name, email, password } : { tenantSlug, email, password };
    const response = await fetch(`${API}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'No se pudo autenticar');
    localStorage.setItem('gametable_token', data.token); setToken(data.token); setMessage('Sesión iniciada');
  };

  const createMatch = async () => {
    const response = await fetch(`${API}/api/matches`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gameKey: 'burger-rush' }) });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'No se pudo crear la partida');
    setCode(data.code); setMatchStarted(false); setMessage(`Partida ${data.code} lista para compartir`);
  };

  const startMatch = async () => {
    const response = await fetch(`${API}/api/matches/${code}/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? 'Se requieren al menos dos jugadores listos');
    setMatchStarted(true); setMessage('Partida iniciada');
  };

  const openCheckout = async () => {
    const response = await fetch(`${API}/api/billing/checkout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: billingPlan }) });
    const data = await response.json();
    if (!response.ok || !data.url) return setMessage(data.error ?? 'No se pudo iniciar el pago');
    location.assign(data.url);
  };

  const openBillingPortal = async () => {
    const response = await fetch(`${API}/api/billing/portal`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok || !data.url) return setMessage(data.error ?? 'No hay una suscripción para administrar');
    location.assign(data.url);
  };

  const saveBrand = async (logoUrl?: string) => {
    const response = await fetch(`${API}/api/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: brandName || undefined, primaryHex: brandColor, ...(logoUrl ? { logoUrl } : {}) }) });
    const data = await response.json();
    setMessage(response.ok ? 'Marca guardada' : data.error ?? 'No se pudo guardar la marca');
  };

  const uploadLogo = async (file?: File) => {
    if (!file) return;
    const signedResponse = await fetch(`${API}/api/uploads/signature`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const signature = await signedResponse.json();
    if (!signedResponse.ok) return setMessage(signature.error ?? 'Almacenamiento de imágenes no configurado');
    const form = new FormData(); form.append('file', file); form.append('api_key', signature.apiKey); form.append('timestamp', String(signature.timestamp)); form.append('folder', signature.folder); form.append('signature', signature.signature);
    const uploadResponse = await fetch(`https://api.cloudinary.com/v1_1/${signature.cloudName}/image/upload`, { method: 'POST', body: form });
    const uploaded = await uploadResponse.json();
    if (!uploadResponse.ok) return setMessage('No se pudo subir la imagen');
    await saveBrand(uploaded.secure_url);
  };

  if (!token) return <main className="auth"><span className="eyebrow">GAMETABLE / OPERACIONES</span><h1>Tu restaurante, convertido en arena.</h1><p>Administra partidas rápidas, jugadores y ranking desde un solo lugar.</p><div className="auth-form">{registering && <><input value={restaurantName} onChange={(event) => setRestaurantName(event.target.value)} placeholder="Nombre del restaurante" /><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="slug-del-restaurante" /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tu nombre" /></>}{!registering && <input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} placeholder="slug-del-restaurante" />}<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Correo electrónico" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Contraseña (10 caracteres mínimo)" /><button onClick={authenticate}>{registering ? 'Crear cuenta' : 'Entrar al panel'}</button><button className="quiet" onClick={() => setRegistering((current) => !current)}>{registering ? 'Ya tengo una cuenta' : 'Crear restaurante'}</button><p className="status">{message}</p></div></main>;
  return <main className="dashboard">
    <nav><strong>GAMETABLE</strong><span>Operaciones / restaurante</span><button className="quiet" onClick={() => { localStorage.removeItem('gametable_token'); setToken(''); }}>Salir</button></nav>
    <section className="hero"><span className="eyebrow">PANEL DEL RESTAURANTE</span><h1>Convierte la espera en una partida.</h1><p>Lanza Burger Rush y deja que cada mesa compita desde su propio celular.</p><button onClick={createMatch}>Crear partida</button>{code && !matchStarted && <button className="secondary" onClick={startMatch}>Iniciar partida</button>}<p className="status">{message} {code && <a href={`/?mode=screen&code=${code}`}>Abrir pantalla</a>}</p></section>
    <section className="metrics"><div><small>PARTIDAS HOY</small><strong>{summary.matchesToday}</strong></div><div><small>JUGADORES ACTIVOS</small><strong>{summary.activePlayers}</strong></div><div><small>RANKING</small><strong>{summary.topScores[0]?.score ?? 0}</strong></div></section>
    <section className="brand-settings"><span className="eyebrow">MARCA DEL RESTAURANTE</span><input value={brandName} onChange={(event) => setBrandName(event.target.value)} placeholder="Nombre público" /><label>Color principal <input type="color" value={brandColor} onChange={(event) => setBrandColor(event.target.value)} /></label><label>Logo <input type="file" accept="image/*" onChange={(event) => void uploadLogo(event.target.files?.[0])} /></label><button onClick={() => void saveBrand()}>Guardar marca</button></section>
    <section className="billing"><span className="eyebrow">PLAN DEL RESTAURANTE</span><label htmlFor="billing-plan">Selecciona un plan</label><select id="billing-plan" value={billingPlan} onChange={(event) => setBillingPlan(event.target.value)}><option value="STARTER_10">Hasta 10 mesas · $59.000 COP/mes</option><option value="GROWTH_25">Hasta 25 mesas · $99.000 COP/mes</option><option value="UNLIMITED">Mesas ilimitadas · $150.000 COP/mes</option><option value="RESORTS">Parques y resorts · $249.000 COP/mes</option></select><button onClick={openCheckout}>Administrar suscripción</button><button className="quiet" onClick={openBillingPortal}>Portal de facturación</button></section>
    <Management token={token} />
    {summary.topScores.length > 0 && <section className="ranking"><span className="eyebrow">TOP DEL RESTAURANTE</span>{summary.topScores.map((score, index) => <div key={`${score.nickname}-${index}`}><strong>0{index + 1}</strong><span>{score.nickname}</span><b>{score.score.toLocaleString('es-CO')}</b></div>)}</section>}
  </main>;
}

function Screen({ initialCode }: { initialCode: string }) {
  const [match, setMatch] = useState<Match>(); const [qr, setQr] = useState(''); const [socket, setSocket] = useState<Socket>(); const [now, setNow] = useState(Date.now()); const [advertisement, setAdvertisement] = useState<Advertisement>();
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!initialCode) return; let active = true; fetch(`${API}/api/matches/${initialCode}`).then((response) => response.json()).then((data: Match) => { if (!active || !data.id) return; setMatch(data); return fetch(`${API}/api/matches/${initialCode}/qr`); }).then((response) => response?.json()).then((data) => { if (data?.dataUrl) setQr(data.dataUrl); }).catch(() => undefined); return () => { active = false; }; }, [initialCode]);
  useEffect(() => { if (!match) return; const current = io(API); current.emit('match:watch', { matchId: match.id }); current.on('match:snapshot', (snapshot: Match) => setMatch(snapshot)); current.on('player:joined', (player: Player) => setMatch((previous) => previous ? { ...previous, players: [...previous.players, player] } : previous)); current.on('game:state', (game: NonNullable<Match['game']>) => setMatch((previous) => previous ? { ...previous, status: game.status, game, players: previous.players.map((player) => ({ ...player, score: game.players.find((candidate) => candidate.id === player.id)?.score ?? player.score })) } : previous)); setSocket(current); return () => { current.disconnect(); setSocket(undefined); }; }, [match?.id]);
  useEffect(() => { const slug = match?.restaurant?.slug; if (!slug) return; fetch(`${API}/api/tenants/${slug}/advertisements`).then((response) => response.ok ? response.json() : []).then((ads: Advertisement[]) => { if (ads.length) setAdvertisement(ads[0]); }).catch(() => undefined); }, [match?.restaurant?.slug]);
  if (!match) return <main className="screen"><span className="eyebrow">GAMETABLE / LIVE</span><h1>Preparando la arena...</h1><p>Espera un momento mientras conectamos la pantalla.</p></main>;
  const remaining = match.game?.startedAt ? Math.max(0, match.game.durationSeconds - Math.floor((now - match.game.startedAt) / 1000)) : 180;
  return <main className="screen" style={{ '--tenant-color': match.restaurant?.primaryHex ?? '#f4b942' } as CSSProperties}>
    <div className="screen-head">{match.restaurant?.logoUrl && <img className="restaurant-logo" src={match.restaurant.logoUrl} alt={match.restaurant.name} />}<span className="eyebrow">{match.restaurant?.name ?? 'GAMETABLE'} / LIVE</span><span className="live-dot">{match.status === 'RUNNING' ? 'EN JUEGO' : match.status === 'FINISHED' ? 'FINALIZADA' : 'ESPERANDO'}</span></div>
    <h1>{match.status === 'FINISHED' ? '¡Partida terminada!' : match.status === 'RUNNING' ? 'Burger Rush' : 'Escanea y entra.'}</h1>
    <div className="screen-layout"><div>{match.status !== 'FINISHED' && <><div className="join-code">{match.code}</div><p>{match.status === 'RUNNING' ? `Tiempo restante: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Abre el enlace en tu celular y juega desde tu mesa.'}</p></>}{advertisement?.imageUrl && <img className="ad-banner" src={advertisement.imageUrl} alt={advertisement.title} />}<GameCanvas socket={socket} players={match.players} gameState={match.game} /></div>
      <aside>{match.status !== 'RUNNING' && match.status !== 'FINISHED' && qr && <img className="qr" src={qr} alt={`Código QR para unirse a la partida ${match.code}`} />}<strong>{match.players.length}/8 jugadores</strong><div className="players">{[...match.players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((player, index) => <div key={player.id}><b>{match.status === 'FINISHED' ? `${index + 1}. ` : ''}{player.nickname}</b><small>MESA {player.tableNumber ?? player.seat} · {player.score ?? 0} PTS</small></div>)}</div></aside>
    </div>
  </main>;
}

function Controller({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode.toUpperCase()); const [nickname, setNickname] = useState(''); const [tableNumber, setTableNumber] = useState(''); const [playerId, setPlayerId] = useState(''); const [matchId, setMatchId] = useState(''); const [sessionToken, setSessionToken] = useState(''); const [message, setMessage] = useState(''); const [questionnaire, setQuestionnaire] = useState<ActiveQuestionnaire>(); const [answered, setAnswered] = useState<string[]>([]); const socket = useRef<Socket | undefined>(undefined);
  useEffect(() => () => { socket.current?.disconnect(); }, []);
  useEffect(() => {
    if (!code || playerId) return;
    try {
      const saved = sessionStorage.getItem(`gametable-player:${code}`);
      if (!saved) return;
      const session = JSON.parse(saved) as { playerId: string; matchId: string; nickname: string; tableNumber: number; sessionToken: string; tenantSlug: string };
      setPlayerId(session.playerId); setMatchId(session.matchId); setNickname(session.nickname); setTableNumber(String(session.tableNumber)); setSessionToken(session.sessionToken);
      const connection = io(API); connection.on('game:error', (error: { error: string }) => setMessage(error.error)); socket.current = connection;
      void fetch(`${API}/api/tenants/${session.tenantSlug}/questionnaires/active`).then((response) => response.ok ? response.json() : undefined).then((quiz) => { if (quiz) setQuestionnaire(quiz); });
    } catch { sessionStorage.removeItem(`gametable-player:${code}`); }
  }, [code, playerId]);
  const join = async () => { const response = await fetch(`${API}/api/matches/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname, tableNumber: Number(tableNumber) }) }); const data = await response.json(); if (!response.ok) return setMessage(data.error ?? 'No se pudo unir'); const session = { playerId: data.playerId, matchId: data.matchId, nickname: data.nickname, tableNumber: data.tableNumber, sessionToken: data.sessionToken, tenantSlug: data.tenantSlug }; sessionStorage.setItem(`gametable-player:${code}`, JSON.stringify(session)); setPlayerId(data.playerId); setMatchId(data.matchId); setSessionToken(data.sessionToken); socket.current = io(API); socket.current.on('game:error', (error: { error: string }) => setMessage(error.error)); setMessage(`Listo, ${data.nickname}`); };
  const sendAction = (action: string) => { if (!playerId || !matchId || !sessionToken || !socket.current) return setMessage('Primero entra a la partida'); socket.current.emit('player:input', { matchId, playerId, sessionToken, action }); setMessage(`${action} enviado`); };
  const answerQuestion = async (questionId: string, selectedIndex: number) => { const response = await fetch(`${API}/api/questionnaires/${questionnaire?.id}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId, playerId, sessionToken, selectedIndex }) }); const result = await response.json(); if (!response.ok) return setMessage(result.error ?? 'No se pudo enviar la respuesta'); setAnswered((current) => [...current, questionId]); setMessage(result.correct ? `¡Correcto! +${result.points} puntos` : 'Respuesta registrada'); };
  return <main className="controller"><span className="eyebrow">GAMETABLE / CONTROL</span><h1>Únete a la arena.</h1><p className="muted">Escribe el código que aparece en la pantalla.</p><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="A7K92" maxLength={5} disabled={Boolean(playerId)} /><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Tu nickname" maxLength={18} disabled={Boolean(playerId)} /><input type="number" min="1" max="1000" value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} placeholder="Número de mesa" required disabled={Boolean(playerId)} /><button onClick={join} disabled={Boolean(playerId)}>Entrar a jugar</button>{playerId && <><p className="status">Conectado como {nickname}</p><button className="secondary" onClick={() => sendAction('READY')}>Estoy listo</button><div className="pad"><button onClick={() => sendAction('JUMP')}>↑</button><button onClick={() => sendAction('ATTACK')}>⚡</button><button onClick={() => sendAction('LEFT')}>←</button><button onClick={() => sendAction('RIGHT')}>→</button></div>{questionnaire && <section className="controller-quiz"><span className="eyebrow">{questionnaire.title}</span>{questionnaire.questions.map((question) => <div key={question.id}><p>{question.prompt}</p>{question.optionsJson.map((option, index) => <button key={`${question.id}-${index}`} disabled={answered.includes(question.id)} onClick={() => answerQuestion(question.id, index)}>{option}</button>)}</div>)}</section>}</>}<p className="status">{message}</p></main>;
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
