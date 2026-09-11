import { io } from 'socket.io-client';

const base = process.env.API_URL || 'http://localhost:3000';

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

function ack(socket, event, body) {
  return new Promise((resolve, reject) => socket.timeout(20_000).emit(event, body, (error, response) => error ? reject(error) : resolve(response)));
}

const session = await api('/api/session', { method: 'POST', body: JSON.stringify({ nickname: '端到端测试员' }) });
const auth = { Authorization: `Bearer ${session.token}` };
const personas = await api('/api/personas?enabled=true');
if (!personas.length) throw new Error('没有已启用人物');
const room = await api('/api/rooms', { method: 'POST', headers: auth, body: JSON.stringify({ name: '自动化失控实验室', type: 'THEME' }) });

const socket = io(base, { transports: ['websocket'], auth: { token: session.token } });
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
const joined = await ack(socket, 'room:join', { roomCode: room.code, personaId: personas[0].publicId });
if (!joined.ok || !joined.mission?.publicId) throw new Error(`加入/任务分配失败: ${JSON.stringify(joined)}`);

const readyPromise = new Promise(resolve => socket.once('message:ready', resolve));
const transformed = await ack(socket, 'message:transform', { originalText: '我吃了3个鸡蛋', clientMessageId: crypto.randomUUID() });
if (!transformed.ok || !transformed.transformedText || transformed.autoSendAfterMs !== 3000) throw new Error(`转换失败: ${JSON.stringify(transformed)}`);
const committed = await ack(socket, 'message:commit', { draftId: transformed.draftId, editedText: transformed.transformedText });
const broadcast = await readyPromise;
if (!committed.ok || !broadcast.publicId) throw new Error('提交或广播失败');

const rulePromise = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('失控指数未触发临时规则')), 20_000);
  socket.once('chaos:rule_triggered', value => { clearTimeout(timeout); resolve(value); });
});
for (let index = 0; index < 8; index++) {
  const preview = await ack(socket, 'message:transform', { originalText: `第${index + 2}次让房间继续失控`, clientMessageId: crypto.randomUUID() });
  await ack(socket, 'message:commit', { draftId: preview.draftId, editedText: preview.transformedText });
}
const chaosRule = await rulePromise;

console.log(JSON.stringify({
  ok: true,
  roomCode: room.code,
  mission: joined.mission.text,
  transformedText: transformed.transformedText,
  messageSequence: broadcast.sequenceNo,
  chaos: joined.chaos,
  triggeredRule: chaosRule,
}, null, 2));
socket.disconnect();
