import { useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Item = { id: string; name?: string; title?: string; status?: string; active?: boolean; _count?: { entries?: number; questions?: number } };

export function Management({ token }: { token: string }) {
  const [tab, setTab] = useState('TORNEOS');
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState('');
  const [correctIndex, setCorrectIndex] = useState('0');
  const [notice, setNotice] = useState('');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const refresh = async () => {
    const endpoint = tab === 'TORNEOS' ? '/api/tournaments' : tab === 'ANUNCIOS' ? '/api/advertisements' : tab === 'CUESTIONARIOS' ? '/api/questionnaires' : '/api/devices';
    const response = await fetch(`${API}${endpoint}`, { headers });
    if (response.ok) setItems(await response.json());
  };
  useEffect(() => { void refresh(); }, [tab, token]);

  const submit = async () => {
    const endpoint = tab === 'TORNEOS' ? '/api/tournaments' : tab === 'ANUNCIOS' ? '/api/advertisements' : tab === 'CUESTIONARIOS' ? '/api/questionnaires' : '/api/devices';
    let body: Record<string, unknown>;
    if (tab === 'TORNEOS') body = { name };
    else if (tab === 'ANUNCIOS') body = { title: name, imageUrl: imageUrl || undefined, active: true };
    else if (tab === 'CUESTIONARIOS') {
      const parsedOptions = options.split(',').map((option) => option.trim()).filter(Boolean);
      body = { title: name, active: true, questions: [{ prompt, options: parsedOptions, correctIndex: Number(correctIndex) }] };
    } else body = { name };
    const response = await fetch(`${API}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error ?? 'No se pudo guardar');
    setName(''); setImageUrl(''); setPrompt(''); setOptions(''); setNotice(tab === 'DISPOSITIVOS' && data.deviceToken ? `Dispositivo creado. Token: ${data.deviceToken}` : 'Guardado');
    await refresh();
  };

  const transition = async (id: string, action: 'open' | 'start' | 'finish') => {
    const response = await fetch(`${API}/api/tournaments/${id}/${action}`, { method: 'POST', headers });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error ?? 'No se pudo actualizar el torneo');
    setNotice(action === 'finish' ? `Torneo finalizado. Ganador: ${data.entries?.[0]?.player?.nickname ?? 'sin resultados'}` : 'Estado actualizado');
    await refresh();
  };

  return <section className="management">
    <div className="management-head"><span className="eyebrow">OPERACIÓN</span><div className="management-tabs">{['TORNEOS', 'ANUNCIOS', 'CUESTIONARIOS', 'DISPOSITIVOS'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => { setTab(item); setNotice(''); }}>{item}</button>)}</div></div>
    <div className="management-form"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={tab === 'TORNEOS' ? 'Nombre del torneo' : tab === 'ANUNCIOS' ? 'Título de campaña' : tab === 'CUESTIONARIOS' ? 'Nombre del cuestionario' : 'Nombre de pantalla'} />{tab === 'ANUNCIOS' && <input value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="URL de imagen de Cloudinary" />}{tab === 'CUESTIONARIOS' && <><input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Pregunta" /><input value={options} onChange={(event) => setOptions(event.target.value)} placeholder="Opciones separadas por coma" /><label>Índice correcto (empieza en 0)<input type="number" min="0" value={correctIndex} onChange={(event) => setCorrectIndex(event.target.value)} /></label></>}<button onClick={submit}>Crear</button></div>
    <p className="status">{notice}</p>
    <div className="management-list">{items.map((item) => <div key={item.id}><strong>{item.name ?? item.title ?? 'Dispositivo'}</strong><span>{item.status ?? (item.active ? 'Activo' : 'Inactivo')} {item._count?.entries !== undefined ? `· ${item._count.entries} jugadores` : ''}{item._count?.questions !== undefined ? `· ${item._count.questions} preguntas` : ''}</span>{tab === 'TORNEOS' && <div className="management-actions">{item.status === 'DRAFT' && <button onClick={() => void transition(item.id, 'open')}>Abrir inscripciones</button>}{item.status === 'OPEN' && <button onClick={() => void transition(item.id, 'start')}>Iniciar</button>}{item.status === 'RUNNING' && <button onClick={() => void transition(item.id, 'finish')}>Finalizar</button>}</div>}</div>)}</div>
  </section>;
}
