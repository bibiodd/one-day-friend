const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const messages = new Map();

const POOL_TTL = 24 * 3600 * 1000;
const PAIR_TTL = 24 * 3600 * 1000;
const MAX_SEQ  = 100; // 测试用，测完改回 500

const PRE = ['燃烧的','流浪的','发光的','失控的','做梦的','逃跑的','发疯的','自由的',
  '热烈的','不安的','脆弱的','耀眼的','迷路的','欢呼的','倔强的','荒唐的',
  '暗夜','血色','废墟','荆棘','黑曜','残响','深渊','灰烬','冷月','雾都'];
const CORE = ['摇滚','诗人','小丑','疯子','蝴蝶','乌鸦','玫瑰','猫','幽灵','骑士',
  '纵火犯','造梦师','守墓人','拾荒者','夜行者','殉道者','叛逆者','流浪汉',
  '游乐园','烟花','野火','风筝','流星','酒馆','钢琴','吸血鬼','女巫','天使'];
const ENFP_MOD = ['理想主义','三分钟热度','社交电池','泪点低','爱笑','话痨','冲动','共情',
  '浪漫','天真','好奇','热情','跳跃','敏感','赤诚','疯癫','温柔','爆裂'];
const SUF = ['','°','丶','〆','×','†','_','﹏','ヽ','ζ','の','·','﹌','┈','︶'];
const pick = a => a[Math.floor(Math.random() * a.length)];

function genCode(){
  const r = Math.random();
  let n = '';
  if (r < 0.22) n = pick(PRE) + '·' + pick(CORE);
  else if (r < 0.42) n = pick(ENFP_MOD) + '的' + pick(CORE);
  else if (r < 0.60) n = pick(SUF) + pick(ENFP_MOD) + pick(CORE) + pick(SUF);
  else if (r < 0.75) n = pick(PRE) + '_' + pick(CORE);
  else if (r < 0.88) n = pick(ENFP_MOD) + pick(CORE) + pick(SUF);
  else n = pick(SUF) + pick(PRE) + pick(SUF) + pick(CORE);
  if (Math.random() < 0.28) n += pick(['°','〆','×','丶','†']);
  return n;
}

function genUniqueCode(){
  for (let i = 0; i < 30; i++){
    const c = genCode();
    let dup = false;
    for (const u of users.values()){
      if (u.code === c && (u.status === 'pool' || u.status === 'paired')) { dup = true; break; }
    }
    if (!dup) return c;
  }
  return genCode() + '#' + Math.floor(Math.random() * 99);
}

function sweep(){
  const now = Date.now();
  for (const u of users.values()){
    if (u.status === 'pool' && now - u.createdAt > POOL_TTL) u.status = 'expired';
    if (u.status === 'paired' && now - u.pairStart > PAIR_TTL){
      if (u.pairId) messages.delete(u.pairId);
      if (u.partnerId){
        const p = users.get(u.partnerId);
        if (p){ p.status = 'closed'; p.pairId = null; p.partnerId = null; p.partnerCode = null; p.pairStart = null; }
      }
      u.status = 'closed'; u.pairId = null; u.partnerId = null; u.partnerCode = null; u.pairStart = null;
    }
  }
}

function findFreeSeq(){
  const cnt = new Map(); const now = Date.now();
  for (const u of users.values()){
    if (u.status === 'pool' && now - u.createdAt <= POOL_TTL) cnt.set(u.seq, (cnt.get(u.seq) || 0) + 1);
  }
  const free = [];
  for (let i = 1; i <= MAX_SEQ; i++){ if ((cnt.get(i) || 0) < 2) free.push(i); }
  return free.length ? pick(free) : null;
}

function matchFor(id){
  const me = users.get(id);
  if (!me || me.status !== 'pool') return null;
  const now = Date.now();
  for (const other of users.values()){
    if (other.id === me.id || other.status !== 'pool' || other.seq !== me.seq) continue;
    if (now - other.createdAt > POOL_TTL) continue;
    
    const pairId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    me.status = 'paired'; me.pairId = pairId; me.partnerId = other.id; me.partnerCode = other.code; me.pairStart = now;
    other.status = 'paired'; other.pairId = pairId; other.partnerId = me.id; other.partnerCode = me.code; other.pairStart = now;
    messages.set(pairId, []);
    return { pairId, me, other };
  }
  return null;
}

function publicMe(u){
  const now = Date.now();
  let remainPoolMs = 0, remainPairMs = 0;
  if (u.status === 'pool') remainPoolMs = Math.max(0, u.createdAt + POOL_TTL - now);
  if (u.status === 'paired' && u.pairStart) remainPairMs = Math.max(0, u.pairStart + PAIR_TTL - now);
  return { id: u.id, code: u.code, seq: u.seq, status: u.status, pairId: u.pairId || null, partnerCode: u.partnerCode || null, remainPoolMs, remainPairMs };
}

function emitMatched(m){
  io.to(m.me.id).emit('matched', { pairId: m.pairId, partnerCode: m.other.code, pairStart: m.me.pairStart });
  io.to(m.other.id).emit('matched', { pairId: m.pairId, partnerCode: m.me.code, pairStart: m.other.pairStart });
}

function ensureUser(id){
  let u = users.get(id); const now = Date.now();
  if (!u){
    const seq = findFreeSeq(); if (seq === null) return null;
    u = { id, code: genUniqueCode(), seq, status: 'pool', createdAt: now, lastReroll: 0, pairId: null, partnerId: null, partnerCode: null, pairStart: null };
    users.set(id, u);
  }
  if (u.status === 'closed' || u.status === 'expired' || u.status === 'left'){
    const seq = findFreeSeq(); if (seq === null) return null;
    u.code = genUniqueCode(); u.seq = seq; u.status = 'pool'; u.createdAt = now; u.pairId = null; u.partnerId = null; u.partnerCode = null; u.pairStart = null;
  }
  return u;
}

app.post('/api/join', (req, res) => {
  sweep();
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const u = ensureUser(id);
  if (!u) return res.status(503).json({ error: 'pool full' });
  const m = matchFor(id);
  if (m) emitMatched(m);
  res.json(publicMe(users.get(id)));
});

app.post('/api/reroll', (req, res) => {
  sweep();
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const u = users.get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status === 'paired') return res.status(400).json({ error: 'already paired' });
  const seq = findFreeSeq();
  if (seq === null) return res.status(503).json({ error: 'pool full' });
  u.code = genUniqueCode(); u.seq = seq; u.status = 'pool'; u.lastReroll = Date.now();
  const m = matchFor(id);
  if (m) emitMatched(m);
  res.json(publicMe(users.get(id)));
});

app.post('/api/leave', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const u = users.get(id);
  if (u && u.status === 'pool') u.status = 'left';
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  sweep();
  const u = users.get(req.query.id);
  if (!u) return res.json({ status: 'none' });
  res.json(publicMe(u));
});

app.get('/api/messages', (req, res) => {
  const { id, pairId } = req.query;
  const u = users.get(id);
  if (!u || u.pairId !== pairId) return res.json({ messages: [] });
  const arr = messages.get(pairId) || [];
  res.json({ messages: arr.map(m => ({ sender_code: m.senderCode, text: m.text, created_at: m.at })) });
});

// 管理员强制解散接口
app.post('/api/admin/force-close', (req, res) => {
  const { pairId, code, adminKey } = req.body || {};
  if (adminKey !== 'admin_secret_2026') return res.status(403).json({ error: '无权限' });
  
  let targetPairId = pairId;
  if (!targetPairId && code) {
    for (const u of users.values()) {
      if (u.code === code && u.status === 'paired') { targetPairId = u.pairId; break; }
    }
  }
  if (!targetPairId) return res.status(400).json({ error: '未找到有效的配对' });
  
  let found = false;
  for (const u of users.values()) {
    if (u.pairId === targetPairId) {
      u.status = 'closed'; u.pairId = null; u.partnerId = null; u.partnerCode = null; u.pairStart = null;
      found = true;
    }
  }
  if (found) messages.delete(targetPairId);
  io.to(targetPairId).emit('match_closed', { reason: '管理员强制解散' });
  res.json({ ok: true });
});

io.on('connection', socket => {
  socket.on('join', ({ id }) => {
    if (!id) return;
    socket.join(id);
    const u = users.get(id);
    if (u && u.pairId) socket.join(u.pairId);
  });
  socket.on('chat', ({ id, text }) => {
    if (!id || !text) return;
    const u = users.get(id);
    if (!u || u.status !== 'paired' || !u.pairId) return;
    if (u.pairStart + PAIR_TTL < Date.now()) return;
    const msg = { senderCode: u.code, text: String(text).slice(0, 500), at: Date.now() };
    const arr = messages.get(u.pairId) || [];
    arr.push(msg); messages.set(u.pairId, arr);
    io.to(u.pairId).emit('message', { sender_code: msg.senderCode, text: msg.text, created_at: msg.at });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('▶ 一日好友 running on ' + PORT);
});
