import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ChatMessage, connectSocket, ensureSession, Persona, request, Room, uuid } from './api';

type View = 'LOBBY' | 'PERSONAS' | 'CHAT';
type Mission = { publicId: string; text: string; status: string; type: 'CONFLICT' | 'COMEDY' | 'COOPERATIVE'; rewardPoints: number; isNew: boolean };
type Rule = { id: string; key: string; rule: string; endsAt: number };
type ScoreEntry = { memberId: number; nickname: string; score: number };
type ClaimResult = { verdict: 'YES' | 'NO'; reason: string; scoreGained?: number };

const emitAck = <T,>(socket: Socket, event: string, payload: unknown) => new Promise<T>((resolve, reject) => {
  socket.timeout(20_000).emit(event, payload, (error: Error | null, response: T & { ok?: boolean; message?: string }) => {
    if (error) reject(error); else if (response && response.ok === false) reject(new Error(response.message || '操作失败')); else resolve(response);
  });
});

export function App() {
  const [view, setView] = useState<View>('LOBBY');
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [personaId, setPersonaId] = useState(localStorage.getItem('lipu-persona') || '');
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memberId, setMemberId] = useState<number | null>(null);
  const memberIdRef = useRef<number | null>(null);
  memberIdRef.current = memberId;
  const [mission, setMission] = useState<Mission | null>(null);
  const [showMission, setShowMission] = useState(false);
  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);
  const [chaos, setChaos] = useState(0);
  const [rules, setRules] = useState<Rule[]>([]);
  const [now, setNow] = useState(Date.now());
  const [socket, setSocket] = useState<Socket | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const selectedPersona = useMemo(() => personas.find(item => item.publicId === personaId) || personas.find(item => item.enabled), [personas, personaId]);

  const refresh = useCallback(async () => {
    const [p, r] = await Promise.all([request<Persona[]>('/api/personas'), request<Room[]>('/api/rooms')]);
    setPersonas(p); setRooms(r);
    if (!personaId && p.some(item => item.enabled)) setPersonaId(p.find(item => item.enabled)!.publicId);
  }, [personaId]);

  useEffect(() => {
    ensureSession().then(async () => {
      await refresh();
      const next = connectSocket();
      setSocket(next);
      setLoading(false);
      return () => next.disconnect();
    }).catch(err => { setError(err.message); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (message: ChatMessage) => setMessages(old => old.some(item => item.publicId === message.publicId) ? old : [...old, message]);
    const onChaos = ({ value }: { value: number }) => setChaos(Math.min(100, value));
    const onRules = (next: Rule[]) => setRules((next || []).filter(item => item.endsAt > Date.now()));
    const onLeaderboard = (next: ScoreEntry[]) => setLeaderboard(next || []);
    const onMissionFailed = ({ memberId: failedId }: { memberId: number }) => {
      if (String(failedId) === String(memberIdRef.current)) setMission(current => current ? { ...current, status: 'FAILED' } : current);
    };
    socket.on('message:ready', onMessage).on('chaos:updated', onChaos).on('chaos:rules', onRules).on('score:leaderboard', onLeaderboard).on('mission:failed', onMissionFailed);
    return () => { socket.off('message:ready', onMessage).off('chaos:updated', onChaos).off('chaos:rules', onRules).off('score:leaderboard', onLeaderboard).off('mission:failed', onMissionFailed); };
  }, [socket]);

  useEffect(() => {
    if (!rules.length) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [rules.length]);

  async function enterRoom(target: Room) {
    if (!socket || !selectedPersona) return;
    setError('');
    try {
      const result = await emitAck<{ ok: boolean; room: Room; memberId: number; mission: Mission | null; chaos: { value: number; activeRules: Rule[] }; leaderboard: ScoreEntry[]; messages: ChatMessage[] }>(socket, 'room:join', { roomCode: target.code, personaId: selectedPersona.publicId });
      setRoom(result.room); setMemberId(result.memberId); setMessages(result.messages); setMission(result.mission); setShowMission(Boolean(result.mission?.isNew));
      setChaos(result.chaos.value); setRules(result.chaos.activeRules || []); setLeaderboard(result.leaderboard || []); setView('CHAT');
    } catch (err) { setError(err instanceof Error ? err.message : '加入失败'); }
  }

  async function switchPersona(nextId: string) {
    setPersonaId(nextId); localStorage.setItem('lipu-persona', nextId);
    if (view === 'CHAT' && socket) await emitAck(socket, 'persona:switch', { personaId: nextId });
  }

  async function claimMission(publicId: string): Promise<ClaimResult> {
    if (!socket) throw new Error('未连接');
    const result = await emitAck<{ verdict: 'YES' | 'NO'; reason: string; scoreGained?: number; leaderboard?: ScoreEntry[] }>(socket, 'mission:claim', { missionPublicId: publicId });
    if (result.verdict === 'YES') {
      setMission(current => current ? { ...current, status: 'COMPLETED' } : current);
      if (result.leaderboard) setLeaderboard(result.leaderboard);
    }
    return { verdict: result.verdict, reason: result.reason, scoreGained: result.scoreGained };
  }

  if (loading) return <div className="boot"><b>离谱聊天室</b><span>正在加载人格……</span></div>;

  return <>
    {error && <button className="error-toast" onClick={() => setError('')}>{error} ×</button>}
    {view === 'LOBBY' && <Lobby rooms={rooms} personas={personas.filter(p => p.enabled)} selected={selectedPersona} onSelect={switchPersona} onEnter={enterRoom} onCreate={async room => { await refresh(); await enterRoom(room); }} onManage={() => setView('PERSONAS')} />}
    {view === 'PERSONAS' && <PersonaManager personas={personas} onBack={() => { refresh(); setView('LOBBY'); }} onChanged={refresh} />}
    {view === 'CHAT' && room && selectedPersona && socket && <Chat room={room} persona={selectedPersona} personas={personas.filter(p => p.enabled)} messages={messages} memberId={memberId} socket={socket} chaos={chaos} mission={mission} rules={rules} now={now} leaderboard={leaderboard} onClaim={claimMission} onSwitch={switchPersona} onLeave={() => { setView('LOBBY'); setRoom(null); refresh(); }} onError={setError} />}
    {showMission && mission && <MissionOverlay mission={mission} onClose={() => setShowMission(false)} />}
  </>;
}

function Lobby({ rooms, personas, selected, onSelect, onEnter, onCreate, onManage }: { rooms: Room[]; personas: Persona[]; selected?: Persona; onSelect: (id: string) => void; onEnter: (room: Room) => void; onCreate: (room: Room) => void; onManage: () => void }) {
  const [code, setCode] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  async function search(event: FormEvent) {
    event.preventDefault();
    const room = await request<Room>(`/api/rooms/${code.trim().toUpperCase()}`);
    onEnter(room);
  }
  return <main className="page lobby">
    <header className="top"><div className="brand"><i>离</i>离谱聊天室</div><button className="link-btn" onClick={onManage}>人物管理 ↗</button></header>
    <section className="hero"><div><span className="sticker">REALTIME IDENTITY CHAOS</span><h1>换个人格<br/><em>再开口。</em></h1></div><form className="join-box" onSubmit={search}><b>输入房间 ID</b><div><input value={code} onChange={e => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8))} placeholder="8 位字母和数字" required minLength={8}/><button>加入</button></div><small>房间空置 5 分钟后会自动销毁</small></form></section>
    <section className="persona-strip"><div className="section-title"><h2>今天用谁说话？</h2><span>聊天室内也可以随时换</span></div><div className="persona-row">{personas.map(persona => <button key={persona.publicId} className={selected?.publicId === persona.publicId ? 'persona active' : 'persona'} style={{ '--c': persona.visual?.color || '#c7ff00' } as React.CSSProperties} onClick={() => onSelect(persona.publicId)}><i>{persona.visual?.symbol || persona.name[0]}</i><strong>{persona.name}</strong><span>{persona.shortDescription}</span></button>)}</div></section>
    <section className="rooms"><div className="section-title"><h2>正在发生</h2><button className="solid-btn" onClick={() => setShowCreate(true)}>＋ 创建聊天室</button></div><div className="room-grid">{rooms.map(item => <button className="room" key={item.code} onClick={() => onEnter(item)}><div><small>{item.type === 'THEME' ? '主题任务局' : '自由聊天'}</small><code>{item.code}</code></div><h3>{item.name}</h3><span>{item.status === 'EMPTY_GRACE' ? '销毁倒计时中 · 进去即可抢救' : '点击加入 →'}</span></button>)}{!rooms.length && <div className="empty">现在一个房间都没有。很好，你可以成为第一个发疯的人。</div>}</div></section>
    {showCreate && <CreateRoom onClose={() => setShowCreate(false)} onCreated={room => { setShowCreate(false); onCreate(room); }}/>} 
  </main>;
}

function CreateRoom({ onClose, onCreated }: { onClose: () => void; onCreated: (room: Room) => void }) {
  const [name, setName] = useState(''); const [type, setType] = useState<'NORMAL' | 'THEME'>('THEME');
  async function submit(event: FormEvent) { event.preventDefault(); onCreated(await request<Room>('/api/rooms', { method: 'POST', body: JSON.stringify({ name, type }) })); }
  return <div className="modal-bg"><form className="modal" onSubmit={submit}><button type="button" className="close" onClick={onClose}>×</button><span className="sticker">新建现场</span><h2>这局怎么疯？</h2><label>房间名称<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="例如：周一情绪急救中心"/></label><div className="type-pick"><button type="button" className={type === 'NORMAL' ? 'active' : ''} onClick={() => setType('NORMAL')}><b>普通房</b><span>自由发挥</span></button><button type="button" className={type === 'THEME' ? 'active' : ''} onClick={() => setType('THEME')}><b>主题任务局</b><span>暗线冲突 + 失控指数</span></button></div><button className="solid-btn wide">生成唯一房间 ID</button></form></div>;
}

function Chat({ room, persona, personas, messages, memberId, socket, chaos, mission, rules, now, leaderboard, onClaim, onSwitch, onLeave, onError }: { room: Room; persona: Persona; personas: Persona[]; messages: ChatMessage[]; memberId: number | null; socket: Socket; chaos: number; mission: Mission | null; rules: Rule[]; now: number; leaderboard: ScoreEntry[]; onClaim: (publicId: string) => Promise<ClaimResult>; onSwitch: (id: string) => void; onLeave: () => void; onError: (value: string) => void }) {
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false); const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  async function transform() {
    const originalText = input.trim(); if (!originalText || busy) return;
    setBusy(true);
    try {
      await emitAck(socket, 'message:transform', { originalText, clientMessageId: uuid() });
      setInput('');
    } catch (err) { onError(err instanceof Error ? err.message : '发送失败'); } finally { setBusy(false); }
  }
  async function claim() {
    if (!mission || claiming) return;
    setClaiming(true); setClaimResult(null);
    try { setClaimResult(await onClaim(mission.publicId)); }
    catch (err) { onError(err instanceof Error ? err.message : '任务判定失败'); }
    finally { setClaiming(false); }
  }
  return <main className="chat-layout">
    <aside className="chat-side"><button className="back" onClick={onLeave}>← 大厅</button><div className="room-id"><small>房间 ID</small><b>{room.code}</b></div><div className="mini-label">人物切换</div>{personas.map(item => <button key={item.publicId} className={item.publicId === persona.publicId ? 'side-persona active' : 'side-persona'} onClick={() => onSwitch(item.publicId)}><i style={{ background: item.visual?.color }}>{item.visual?.symbol || item.name[0]}</i>{item.name}</button>)}</aside>
    <section className="chat-main"><header className="chat-head"><button className="mobile-back" onClick={onLeave}>←</button><div><h2>{room.name}</h2><span>{room.type === 'THEME' ? '主题任务局 · 谁都别太相信' : '自由聊天室'}</span></div><div className="chaos"><label>失控指数 <b>{chaos}%</b></label><i><em style={{ width: `${chaos}%` }}/></i></div></header>
      <div className="message-list">{messages.map(message => <article key={message.publicId} className={String(message.sender.memberId) === String(memberId) ? 'msg mine' : 'msg'}><div className="msg-meta"><b>{message.sender.nickname}</b><span style={{ background: message.persona.visual?.color }}>{message.persona.name}</span></div><pre className={message.text.includes('\n') ? 'code' : ''}>{message.text}</pre></article>)}<div ref={bottomRef}/></div>
      <footer className="composer"><div className="current-persona" style={{ background: persona.visual?.color }}>{persona.visual?.symbol || persona.name[0]}<span>{persona.name}</span></div><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); transform(); } }} disabled={busy} placeholder="先输入人话，模型负责离谱……" maxLength={500}/><button className="send" onClick={transform} disabled={busy || !input.trim()}>{busy ? '转换中…' : '发送'}</button></footer>
    </section>
    <aside className="mission-side">{rules.length > 0 && <><span className="mini-label">失控规则 · {rules.length}</span>{rules.map(item => <div key={item.id} className="rule-panel__item"><span className="rule-panel__text">{item.rule}</span><span className="rule-panel__timer">{Math.max(0, Math.ceil((item.endsAt - now) / 1000))}s</span></div>)}</>}<span className="mini-label">我的秘密任务</span>{mission ? <div className="mission-card"><div className="mission-card__head"><span className={`mission-type ${mission.type.toLowerCase()}`}>{mission.type === 'CONFLICT' ? '对抗' : mission.type === 'COOPERATIVE' ? '合作' : '恶搞'} · {mission.rewardPoints}分</span>{mission.status === 'COMPLETED' && <span className="mission-done">已完成</span>}{mission.status === 'FAILED' && <span className="mission-failed">已失败</span>}</div><b>不要让别人看见</b><p>{mission.text}</p>{mission.status === 'ASSIGNED' && <button onClick={claim} disabled={claiming}>{claiming ? '判定中…' : '我觉得完成了'}</button>}{claimResult && <span className={`mission-claim-result ${claimResult.verdict === 'YES' ? 'ok' : 'no'}`}>{claimResult.verdict === 'YES' ? `判定通过 +${claimResult.scoreGained ?? 0}分` : `未通过：${claimResult.reason}`}</span>}</div> : <div className="no-mission">普通房间没有任务。可以放心胡说。</div>}{leaderboard.length > 0 && <><span className="mini-label">房间排行</span><ol className="leaderboard">{leaderboard.map(entry => <li key={entry.memberId} className={String(entry.memberId) === String(memberId) ? 'me' : ''}><span>{entry.nickname}</span><b>{entry.score}</b></li>)}</ol></>}<div className="chaos-help"><b>怎样让房间失控？</b><p>发言、切换人物、完成任务都会增加指数。满值后随机触发一条 30 秒规则，可叠加，AI 会自动遵守这些规则。</p></div></aside>
  </main>;
}

function MissionOverlay({ mission, onClose }: { mission: Mission; onClose: () => void }) {
  return <div className="mission-overlay"><small>只给你看一次</small><span className={`mission-type ${mission.type.toLowerCase()}`}>{mission.type === 'CONFLICT' ? '对抗任务' : mission.type === 'COOPERATIVE' ? '合作任务' : '恶搞任务'}</span><h1>你的暗线<br/>任务来了</h1><p>{mission.text}</p><button onClick={onClose}>记住了，开始表演</button></div>;
}

function PersonaManager({ personas, onBack, onChanged }: { personas: Persona[]; onBack: () => void; onChanged: () => void }) {
  const empty = { name: '', shortDescription: '', identityBackground: '', speakingHabits: '', attitudeStyle: '', transformRules: '', color: '#c7ff00', symbol: '角' };
  const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { await request('/api/personas', { method: 'POST', body: JSON.stringify({ name: form.name, shortDescription: form.shortDescription, identityBackground: form.identityBackground, speakingHabits: form.speakingHabits.split('\n').filter(Boolean), attitudeStyle: form.attitudeStyle.split('\n').filter(Boolean), transformRules: form.transformRules.split('\n').filter(Boolean), examples: [], color: form.color, symbol: form.symbol, visibility: 'PUBLIC' }) }); setForm(empty); await onChanged(); } finally { setSaving(false); } }
  async function toggle(item: Persona) { await request(`/api/personas/${item.publicId}/${item.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); await onChanged(); }
  async function remove(item: Persona) { if (!confirm(`确认删除人物“${item.name}”？历史消息不会改变。`)) return; await request(`/api/personas/${item.publicId}`, { method: 'DELETE' }); await onChanged(); }
  return <main className="page manager"><header className="top"><button className="link-btn" onClick={onBack}>← 返回大厅</button><div className="brand"><i>人</i>人物管理台</div></header><div className="manager-grid"><section><span className="sticker">CRUD / VERSIONED</span><h1>把人设<br/><em>说清楚。</em></h1><form className="persona-form" onSubmit={submit}><label>人物名称<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label><label>一句话介绍<input required value={form.shortDescription} onChange={e => setForm({ ...form, shortDescription: e.target.value })}/></label><label>身份介绍<textarea required value={form.identityBackground} onChange={e => setForm({ ...form, identityBackground: e.target.value })}/></label><div className="form-cols"><label>发言习惯（每行一条）<textarea required value={form.speakingHabits} onChange={e => setForm({ ...form, speakingHabits: e.target.value })}/></label><label>态度风格（每行一条）<textarea required value={form.attitudeStyle} onChange={e => setForm({ ...form, attitudeStyle: e.target.value })}/></label></div><label>转换规则（每行一条）<textarea required value={form.transformRules} onChange={e => setForm({ ...form, transformRules: e.target.value })}/></label><div className="form-cols"><label>代表符号<input maxLength={3} value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })}/></label><label>人物颜色<input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })}/></label></div><button className="solid-btn wide" disabled={saving}>{saving ? '正在保存…' : '创建并启用人物'}</button></form></section><section className="persona-admin-list"><h2>人物库 · {personas.length}</h2>{personas.map(item => <article key={item.publicId} style={{ '--c': item.visual?.color || '#ddd' } as React.CSSProperties}><i>{item.visual?.symbol || item.name[0]}</i><div><h3>{item.name} <small>v{item.version}</small></h3><p>{item.shortDescription}</p><span>{item.enabled ? '已启用' : '已停用'}</span></div><div className="admin-actions"><button onClick={() => toggle(item)}>{item.enabled ? '停用' : '启用'}</button><button onClick={() => remove(item)}>删除</button></div></article>)}</section></div></main>;
}

