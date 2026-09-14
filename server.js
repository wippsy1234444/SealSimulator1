const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 14;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ranks = [
  { name: 'Bronze', min: 0 }, { name: 'Silver', min: 100 }, { name: 'Gold', min: 300 },
  { name: 'Platinum', min: 650 }, { name: 'Diamond', min: 1200 }, { name: 'Master', min: 2200 }
];

const memory = {
  users: new Map(), sessions: new Map(), leaderboard: new Map(), players: new Map(),
  activeSockets: new Map(), queue: [], rooms: new Map()
};

let pool = null;
let dbReady = false;

function hasDb() { return !!process.env.DATABASE_URL && !!pool; }
function cookieSecure() { return process.env.NODE_ENV === 'production'; }
function setSessionCookie(res, token) {
  const parts = [`seal_session=${encodeURIComponent(token)}`, 'Path=/', `Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`, 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = ['seal_session=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function normalizeName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 18); }
function validName(name) { return /^[A-Za-z0-9 _-]{3,18}$/.test(name); }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase().slice(0, 160); }
function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }
function rankFor(elo) { return ranks.slice().reverse().find(r => elo >= r.min) || ranks[0]; }
function profileEntry(state) {
  const rank = rankFor(state.elo);
  return { id: state.id, name: state.name, elo: state.elo, rank: rank.name, clicks: state.totalClicks, online: true };
}
function defaultState(name) {
  return { flops: 0, totalClicks: 0, level: 1, runClicks: 0, combo: 0, bestCombo: 0, bestCps: 0,
    rankWins: 0, rankLosses: 0, elo: 0, name, prestige: 0, streak: 0, lastDaily: 0, missionClicks: 0,
    weeklyWins: 0, owned: ['none'], equipped: 'none', upgrades: { power:0, mult:0, crit:0, combo:0, lucky:0, bank:0 }, history: [] };
}
function cleanState(input, fallbackName) {
  const base = defaultState(fallbackName);
  const src = (input && typeof input === 'object') ? input : {};
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (key === 'name') continue;
    if (key === 'upgrades') out.upgrades = { ...base.upgrades, ...(src.upgrades || {}) };
    else if (key === 'owned') out.owned = Array.isArray(src.owned) ? [...new Set(src.owned.map(String).slice(0, 50))] : base.owned;
    else if (key === 'history') out.history = Array.isArray(src.history) ? src.history.slice(0, 20) : [];
    else if (typeof src[key] === 'number' && Number.isFinite(src[key])) out[key] = Math.max(0, Math.floor(src[key]));
    else if (typeof src[key] === 'string') out[key] = src[key].slice(0, 64);
    else if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  // Server identity fields are authoritative.
  out.name = fallbackName;
  out.elo = Math.min(out.elo, 1000000);
  out.prestige = Math.min(out.prestige, 1000);
  return out;
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Auth/progress will use temporary in-memory storage. Add a Render Postgres database for persistence.');
    return;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username VARCHAR(18) NOT NULL UNIQUE,
    username_key VARCHAR(18) NOT NULL UNIQUE,
    email VARCHAR(160),
    password_hash TEXT NOT NULL,
    game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)`);
  dbReady = true;
  console.log('Postgres database ready.');
}

async function getUserById(id) {
  if (!id) return null;
  if (!hasDb()) return memory.users.get(id) || null;
  const r = await pool.query('SELECT id, username, username_key, email, password_hash, game_state FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function getUserByNameKey(key) {
  if (!hasDb()) return memory.users.get(key) || null;
  const r = await pool.query('SELECT id, username, username_key, email, password_hash, game_state FROM users WHERE username_key=$1', [key]);
  return r.rows[0] || null;
}
async function insertUser({ username, usernameKey, email, passwordHash, gameState }) {
  if (!hasDb()) {
    const id = crypto.randomUUID();
    const user = { id, username, username_key: usernameKey, email, password_hash: passwordHash, game_state: gameState };
    memory.users.set(id, user); memory.users.set(usernameKey, user);
    return user;
  }
  const id = crypto.randomUUID();
  const r = await pool.query('INSERT INTO users(id, username, username_key, email, password_hash, game_state) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, username, username_key, email, password_hash, game_state', [id, username, usernameKey, email || null, passwordHash, JSON.stringify(gameState)]);
  return r.rows[0];
}
async function updateUserState(userId, state) {
  if (!hasDb()) {
    const user = memory.users.get(userId); if (user) user.game_state = state;
    return;
  }
  await pool.query('UPDATE users SET game_state=$2, updated_at=NOW() WHERE id=$1', [userId, JSON.stringify(state)]);
}
async function createSession(userId) {
  const raw = randomToken();
  const hash = tokenHash(raw);
  const expires = new Date(Date.now() + SESSION_MAX_AGE);
  if (!hasDb()) memory.sessions.set(hash, { userId, expiresAt: expires.getTime() });
  else await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash, userId, expires]);
  return raw;
}
async function deleteSession(raw) {
  const hash = tokenHash(raw);
  if (!hasDb()) memory.sessions.delete(hash); else await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash]);
}
async function getSessionUser(req) {
  const raw = getCookie(req, 'seal_session'); if (!raw) return null;
  const hash = tokenHash(raw);
  if (!hasDb()) {
    const s = memory.sessions.get(hash); if (!s || s.expiresAt < Date.now()) return null;
    return getUserById(s.userId);
  }
  const r = await pool.query('SELECT s.user_id, s.expires_at, u.id, u.username, u.username_key, u.email, u.password_hash, u.game_state FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [hash]);
  return r.rows[0] || null;
}
function publicUser(user) {
  const state = cleanState(user.game_state, user.username);
  return { id: user.id, username: user.username, email: user.email || '', state };
}
async function authRequired(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    req.user = user; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Authentication error.' }); }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = normalizeName(req.body?.username);
    const usernameKey = username.toLowerCase();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!validName(username)) return res.status(400).json({ error: 'Name must be 3–18 characters using letters, numbers, spaces, _ or -.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email or leave it blank.' });
    if (await getUserByNameKey(usernameKey)) return res.status(409).json({ error: 'That profile name is already registered.' });
    const imported = req.body?.legacyState && typeof req.body.legacyState === 'object' ? cleanState(req.body.legacyState, username) : defaultState(username);
    const user = await insertUser({ username, usernameKey, email: email || null, passwordHash: hashPassword(password), gameState: imported });
    const token = await createSession(user.id); setSessionCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create account.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const usernameKey = normalizeName(req.body?.username).toLowerCase();
    const password = String(req.body?.password || '');
    const user = await getUserByNameKey(usernameKey);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect name or password.' });
    const token = await createSession(user.id); setSessionCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not sign in.' }); }
});

app.post('/api/auth/logout', async (req, res) => { try { const raw = getCookie(req, 'seal_session'); if (raw) await deleteSession(raw); clearSessionCookie(res); res.json({ ok: true }); } catch { res.json({ ok: true }); } });
app.get('/api/me', authRequired, async (req, res) => res.json({ user: publicUser(req.user) }));
app.put('/api/state', authRequired, async (req, res) => {
  try {
    const user = req.user; const state = cleanState(req.body?.state, user.username);
    await updateUserState(user.id, state);
    res.json({ ok: true, state });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save progress.' }); }
});
app.get('/api/leaderboard', authRequired, async (_req, res) => {
  try {
    if (!hasDb()) {
      const list = [...memory.users.values()].filter(u => u && u.username_key).map(u => { const s = cleanState(u.game_state, u.username); return { id: u.id, name: u.username, elo: s.elo, rank: rankFor(s.elo).name, clicks: s.totalClicks }; }).sort((a,b)=>b.elo-a.elo).slice(0,50);
      return res.json({ players: list });
    }
    const r = await pool.query(`SELECT id, username, game_state FROM users ORDER BY ((game_state->>'elo')::int) DESC NULLS LAST LIMIT 50`);
    const players = r.rows.map(u => { const s = cleanState(u.game_state, u.username); return { id:u.id, name:u.username, elo:s.elo, rank:rankFor(s.elo).name, clicks:s.totalClicks }; });
    res.json({ players });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Leaderboard unavailable.' }); }
});

function makeCode() { const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code=''; do code=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); while(memory.rooms.has(code)); return code; }
function removeFromQueue(id){ const i=memory.queue.indexOf(id); if(i>=0) memory.queue.splice(i,1); }
function makeRoom(a,b,ranked){ const id=`r_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; const room={id,players:[a,b],ranked,started:false,clicks:{[a.id]:0,[b.id]:0},endsAt:0}; memory.rooms.set(id,room); a.socket.join(id); b.socket.join(id); return room; }
function pairRanked(){ while(memory.queue.length>=2){ const a=memory.players.get(memory.queue.shift()); const b=memory.players.get(memory.queue.shift()); if(!a||!b||a.socket.disconnected||b.socket.disconnected) continue; const room=makeRoom(a,b,true); a.socket.emit('match:found',{roomId:room.id,opponent:b.name,ranked:true}); b.socket.emit('match:found',{roomId:room.id,opponent:a.name,ranked:true}); setTimeout(()=>startRoom(room),1200); } }
function startRoom(room){ if(!memory.rooms.has(room.id)||room.started||room.players.length!==2)return; room.started=true; room.endsAt=Date.now()+30000; io.to(room.id).emit('battle:start',{duration:30,endsAt:room.endsAt}); setTimeout(()=>finishRoom(room.id),30050); }
async function savePlayer(player){ try { const state=cleanState(player.gameState, player.name); player.gameState=state; await updateUserState(player.userId,state); } catch(e){ console.error(e); } }
function finishRoom(id){ const room=memory.rooms.get(id); if(!room)return; const [a,b]=room.players; const as=room.clicks[a.id]||0, bs=room.clicks[b.id]||0; let result='draw'; if(as!==bs) result=as>bs?a.id:b.id; const payload={result,scores:{[a.id]:as,[b.id]:bs}}; if(room.ranked&&result!=='draw'){ const winner=memory.players.get(result), loser=memory.players.get(result===a.id?b.id:a.id); if(winner){winner.gameState.elo=Math.min(1000000,winner.gameState.elo+25);winner.gameState.rankWins++;savePlayer(winner);} if(loser){loser.gameState.elo=Math.max(0,loser.gameState.elo-15);loser.gameState.rankLosses++;savePlayer(loser);} payload.elo={}; if(winner)payload.elo[winner.id]=25; if(loser)payload.elo[loser.id]=-15; } io.to(room.id).emit('battle:end',payload); setTimeout(()=>memory.rooms.delete(id),5000); }

io.use(async (socket, next)=>{ try { const req=socket.request; const raw=getCookie(req,'seal_session'); if(!raw)return next(new Error('UNAUTHORIZED')); const hash=tokenHash(raw); let user=null; if(!hasDb()){ const s=memory.sessions.get(hash); if(!s||s.expiresAt<Date.now())return next(new Error('UNAUTHORIZED')); user=await getUserById(s.userId); } else { const r=await pool.query('SELECT u.id,u.username,u.game_state FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[hash]); user=r.rows[0]||null; } if(!user)return next(new Error('UNAUTHORIZED')); socket.user=user; next(); } catch(e){ next(new Error('AUTH_ERROR')); } });

io.on('connection', socket=>{
  const user=socket.user; const stateObj=cleanState(user.game_state,user.username); const player={id:socket.id,userId:user.id,socket,name:user.username,gameState:stateObj};
  const previous=memory.activeSockets.get(user.id); if(previous&&previous!==socket.id){ const old=memory.players.get(previous); if(old){ try{old.socket.emit('session:replaced');}catch{} old.socket.disconnect(true); memory.players.delete(previous); } }
  memory.activeSockets.set(user.id,socket.id); memory.players.set(socket.id,player);
  socket.emit('profile:accepted',{name:player.name,rank:rankFor(stateObj.elo).name,elo:stateObj.elo});

  socket.on('ranked:queue',()=>{ removeFromQueue(socket.id); memory.queue.push(socket.id); socket.emit('match:searching',{queued:true}); pairRanked(); });
  socket.on('ranked:cancel',()=>removeFromQueue(socket.id));
  socket.on('friend:create',()=>{ const code=makeCode(); memory.rooms.set(code,{id:code,players:[player],ranked:false,started:false,clicks:{[player.id]:0},endsAt:0}); socket.emit('friend:created',{code}); });
  socket.on('friend:join',raw=>{ const code=String(raw||'').trim().toUpperCase(); const room=memory.rooms.get(code); if(!room||room.players.length!==1)return socket.emit('friend:error','Room not available.'); room.players.push(player); const [a,b]=room.players; const battle=makeRoom(a,b,false); memory.rooms.delete(code); a.socket.emit('match:found',{roomId:battle.id,opponent:b.name,ranked:false}); b.socket.emit('match:found',{roomId:battle.id,opponent:a.name,ranked:false}); setTimeout(()=>startRoom(battle),1200); });
  socket.on('battle:click',roomId=>{ const room=memory.rooms.get(roomId); if(!room||!room.started||Date.now()>=room.endsAt||!room.players.some(p=>p.id===socket.id))return; room.clicks[socket.id]=(room.clicks[socket.id]||0)+1; io.to(roomId).emit('battle:score',{id:socket.id,score:room.clicks[socket.id]}); });
  socket.on('player:stats', async payload=>{ if(!payload||typeof payload!=='object')return; player.gameState=cleanState({...player.gameState,...payload},player.name); await savePlayer(player); });
  socket.on('disconnect',()=>{ removeFromQueue(socket.id); if(memory.activeSockets.get(user.id)===socket.id)memory.activeSockets.delete(user.id); memory.players.delete(socket.id); for(const [id,room] of memory.rooms.entries()){if(room.players?.some(p=>p.id===socket.id)){if(room.started)io.to(id).emit('battle:cancelled',{reason:'Player disconnected.'});memory.rooms.delete(id);}} });
});

app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>server.listen(PORT,()=>console.log(`SealSimulator running on port ${PORT}`))).catch(err=>{console.error('Database startup error',err);process.exit(1);});
