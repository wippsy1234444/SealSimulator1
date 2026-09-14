const path=require('path');
const http=require('http');
const express=require('express');
const cookieParser=require('cookie-parser');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:true,credentials:true}});
app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));

const PORT=process.env.PORT||10000;
const JWT_SECRET=process.env.JWT_SECRET||'change-this-in-render';
if(!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set. Set it in Render Environment Variables.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const memoryMode=!process.env.DATABASE_URL;
const users=new Map(); const sessions=new Map(); const friends=new Map(); const messages=[]; const presence=new Map(); const queue=[]; const rooms=new Map();

async function q(text,params=[]){ if(memoryMode) return {rows:[]}; return pool.query(text,params); }
async function init(){
 if(memoryMode){console.log('DATABASE_URL missing: temporary memory mode'); return;}
 await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, username VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL, flops BIGINT DEFAULT 0, xp INT DEFAULT 0, level INT DEFAULT 1, rating INT DEFAULT 0, clicks BIGINT DEFAULT 0, prestige INT DEFAULT 0, cosmetics JSONB DEFAULT '{}'::jsonb, upgrades JSONB DEFAULT '{}'::jsonb, streak INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW());`);
 await q(`CREATE TABLE IF NOT EXISTS friendships(id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, friend_id INT REFERENCES users(id) ON DELETE CASCADE, status VARCHAR(12) NOT NULL, UNIQUE(user_id,friend_id));`);
 await q(`CREATE TABLE IF NOT EXISTS global_messages(id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`);
 await q(`CREATE TABLE IF NOT EXISTS private_messages(id BIGSERIAL PRIMARY KEY, sender_id INT REFERENCES users(id) ON DELETE CASCADE, receiver_id INT REFERENCES users(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`);
}
function tokenFor(u){return jwt.sign({id:u.id,username:u.username},JWT_SECRET,{expiresIn:'30d'});}
async function getUser(id){
 if(memoryMode) return users.get(Number(id));
 const r=await q('SELECT * FROM users WHERE id=$1',[id]); return r.rows[0];
}
async function auth(req,res,next){
 try{const t=req.cookies.ss_token;if(!t) return res.status(401).json({error:'auth'}); const p=jwt.verify(t,JWT_SECRET); const u=await getUser(p.id); if(!u) throw 0; req.user=u; next();}catch(e){res.status(401).json({error:'auth'});}
}
function rankName(r){ if(r<400)return 'Bronze'; if(r<800)return 'Silver'; if(r<1200)return 'Gold'; if(r<1700)return 'Platinum'; if(r<2300)return 'Diamond'; return 'Master'; }
function pubUser(u){return {id:u.id,username:u.username,rank:rankName(Number(u.rating||0)),rating:Number(u.rating||0),level:Number(u.level||1),flops:Number(u.flops||0),prestige:Number(u.prestige||0)};}
async function saveProgress(u,data){
 const allowed=['flops','xp','level','rating','clicks','prestige','cosmetics','upgrades','streak'];
 if(memoryMode){Object.assign(u,Object.fromEntries(allowed.filter(k=>data[k]!==undefined).map(k=>[k,data[k]]))); return pubUser(u);}
 const set=[]; const vals=[]; let i=1; for(const k of allowed){if(data[k]!==undefined){set.push(`${k}=$${i++}`); vals.push(data[k]);}} if(!set.length)return pubUser(u); vals.push(u.id); const r=await q(`UPDATE users SET ${set.join(',')}, last_seen=NOW() WHERE id=$${i} RETURNING *`,vals); return pubUser(r.rows[0]);
}

app.get('/api/me',auth,async(req,res)=>res.json({user:pubUser(req.user),rank:rankName(Number(req.user.rating||0))}));
app.post('/api/register',async(req,res)=>{const username=String(req.body.username||'').trim(); const password=String(req.body.password||''); if(!/^[A-Za-z0-9_]{3,20}$/.test(username)||password.length<6)return res.status(400).json({error:'Use 3-20 letters/numbers/_ and a password of 6+ characters.'}); const hash=await bcrypt.hash(password,12); try{ if(memoryMode){for(const u of users.values())if(u.username.toLowerCase()===username.toLowerCase())throw {code:'23505'}; const id=users.size+1; const u={id,username,password_hash:hash,flops:0,xp:0,level:1,rating:0,clicks:0,prestige:0,streak:0,cosmetics:{},upgrades:{}}; users.set(id,u); res.cookie('ss_token',tokenFor(u),{httpOnly:true,sameSite:'lax'}); return res.json({user:pubUser(u)});} const r=await q('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING *',[username,hash]); const u=r.rows[0]; res.cookie('ss_token',tokenFor(u),{httpOnly:true,sameSite:'lax'}); res.json({user:pubUser(u)});}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'That profile name is already taken.':'Registration failed.'});}});
app.post('/api/login',async(req,res)=>{const username=String(req.body.username||'').trim(); const password=String(req.body.password||''); let u;if(memoryMode){u=[...users.values()].find(x=>x.username.toLowerCase()===username.toLowerCase());}else{const r=await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)',[username]);u=r.rows[0];} if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Wrong username or password.'}); res.cookie('ss_token',tokenFor(u),{httpOnly:true,sameSite:'lax'}); res.json({user:pubUser(u)});});
app.post('/api/logout',auth,(req,res)=>{res.clearCookie('ss_token');res.json({ok:true});});
app.post('/api/progress',auth,async(req,res)=>res.json({user:await saveProgress(req.user,req.body||{})}));
app.get('/api/leaderboard',async(req,res)=>{if(memoryMode)return res.json({players:[...users.values()].sort((a,b)=>b.rating-a.rating).slice(0,50).map(pubUser)});const r=await q('SELECT * FROM users ORDER BY rating DESC, clicks DESC LIMIT 50');res.json({players:r.rows.map(pubUser)});});
app.get('/api/chat/global',async(req,res)=>{if(memoryMode)return res.json({messages:messages.slice(-100)});const r=await q(`SELECT g.id,g.message,g.created_at,u.username,u.rating,u.level FROM global_messages g JOIN users u ON u.id=g.user_id ORDER BY g.id DESC LIMIT 100`);res.json({messages:r.rows.reverse().map(x=>({id:x.id,username:x.username,rank:rankName(x.rating),level:x.level,message:x.message,createdAt:x.created_at,online:presence.has(String(x.username).toLowerCase())}))});});
app.get('/api/friends',auth,async(req,res)=>{if(memoryMode){const ids=[...(friends.get(req.user.id)||[])];return res.json({friends:ids.map(id=>pubUser(users.get(id))).filter(Boolean).map(x=>({...x,online:presence.has(x.username.toLowerCase())}))});} const r=await q(`SELECT u.* FROM friendships f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1 AND f.status='accepted' ORDER BY u.username`,[req.user.id]);res.json({friends:r.rows.map(x=>({...pubUser(x),online:presence.has(x.username.toLowerCase())}))});});
app.post('/api/friends/add',auth,async(req,res)=>{const code=String(req.body.username||'').trim(); let other;if(memoryMode)other=[...users.values()].find(x=>x.username.toLowerCase()===code.toLowerCase());else{const r=await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)',[code]);other=r.rows[0];} if(!other||other.id===req.user.id)return res.status(400).json({error:'Player not found.'}); if(memoryMode){let s=friends.get(req.user.id)||new Set();s.add(other.id);friends.set(req.user.id,s); return res.json({ok:true});} await q(`INSERT INTO friendships(user_id,friend_id,status) VALUES($1,$2,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted'`,[req.user.id,other.id]); await q(`INSERT INTO friendships(user_id,friend_id,status) VALUES($1,$2,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted'`,[other.id,req.user.id]);res.json({ok:true});});
app.get('/api/private/:username',auth,async(req,res)=>{const n=req.params.username;if(memoryMode)return res.json({messages:messages.filter(m=>(m.a===req.user.username&&m.b===n)||(m.b===req.user.username&&m.a===n)).slice(-100)});const r=await q(`SELECT p.id,p.message,p.created_at,s.username sender,r.username receiver,s.rating sender_rating,r.rating receiver_rating FROM private_messages p JOIN users s ON s.id=p.sender_id JOIN users r ON r.id=p.receiver_id WHERE (p.sender_id=$1 AND p.receiver_id=(SELECT id FROM users WHERE username=$2)) OR (p.receiver_id=$1 AND p.sender_id=(SELECT id FROM users WHERE username=$2)) ORDER BY p.id DESC LIMIT 100`,[req.user.id,n]);res.json({messages:r.rows.reverse().map(x=>({id:x.id,message:x.message,createdAt:x.created_at,sender:x.sender,senderRank:rankName(x.sender_rating)}))});});
app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const connected=new Map();
io.use((socket,next)=>{try{const t=socket.handshake.headers.cookie?.match(/ss_token=([^;]+)/)?.[1]; const p=t&&jwt.verify(decodeURIComponent(t),JWT_SECRET); if(!p)return next(new Error('auth')); socket.userId=p.id;socket.username=p.username;next();}catch(e){next(new Error('auth'));}});
io.on('connection',async(socket)=>{
 const key=socket.username.toLowerCase(); presence.set(key,socket.id); connected.set(socket.id,socket);
 io.emit('presence',{username:socket.username,online:true,count:presence.size});
 socket.on('global:send',async(raw)=>{const message=String(raw||'').trim().slice(0,300);if(!message)return;const u=await getUser(socket.userId);const out={id:Date.now()+Math.random(),username:u.username,rank:rankName(Number(u.rating||0)),level:Number(u.level||1),message,online:true}; if(memoryMode)messages.push(out); else {const r=await q('INSERT INTO global_messages(user_id,message) VALUES($1,$2) RETURNING id,created_at',[u.id,message]);out.id=r.rows[0].id;out.createdAt=r.rows[0].created_at;}io.emit('global:new',out);});
 socket.on('private:send',async({to,message})=>{message=String(message||'').trim().slice(0,300);to=String(to||'').trim();if(!message||!to)return;let receiver;if(memoryMode)receiver=[...users.values()].find(x=>x.username.toLowerCase()===to.toLowerCase());else{const r=await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)',[to]);receiver=r.rows[0];}if(!receiver)return;const u=await getUser(socket.userId);const out={id:Date.now()+Math.random(),from:u.username,to:receiver.username,message,rank:rankName(Number(u.rating||0)),online:true};if(memoryMode)messages.push({a:u.username,b:receiver.username,...out});else {const r=await q('INSERT INTO private_messages(sender_id,receiver_id,message) VALUES($1,$2,$3) RETURNING id,created_at',[u.id,receiver.id,message]);out.id=r.rows[0].id;out.createdAt=r.rows[0].created_at;} socket.emit('private:new',out); for(const s of connected.values())if(s.username.toLowerCase()===receiver.username.toLowerCase())s.emit('private:new',out);});
 socket.on('ranked:join',()=>{if(queue.find(x=>x.socketId===socket.id))return;const opponent=queue.shift();if(!opponent){queue.push({socketId:socket.id,userId:socket.userId,username:socket.username});socket.emit('ranked:searching');return;} const battleId='B'+Date.now()+Math.random().toString(36).slice(2,7); const room={id:battleId,players:[opponent.socketId,socket.id],scores:{[opponent.socketId]:0,[socket.id]:0},started:Date.now(),duration:30000};rooms.set(battleId,room);for(const sid of room.players)io.to(sid).emit('ranked:matched',{battleId,players:room.players.map(x=>({username:connected.get(x)?.username})) ,endsAt:room.started+room.duration}); setTimeout(()=>finishBattle(battleId),room.duration+500);});
 socket.on('ranked:click',({battleId})=>{const room=rooms.get(battleId);if(room&&room.players.includes(socket.id)&&Date.now()<room.started+room.duration){room.scores[socket.id]++;io.to(room.players[0]).to(room.players[1]).emit('ranked:score',{scores:room.scores});}});
 socket.on('friend:room',()=>{const code=Math.random().toString(36).slice(2,7).toUpperCase();rooms.set('F'+code,{id:'F'+code,owner:socket.id,players:[socket.id],friend:true});socket.emit('friend:code',code);});
 socket.on('friend:join',(code)=>{code=String(code||'').toUpperCase();const room=rooms.get('F'+code);if(!room)return socket.emit('friend:error','Room not found.');if(room.players.length>=2)return socket.emit('friend:error','Room is full.');room.players.push(socket.id);for(const sid of room.players)io.to(sid).emit('friend:matched',{roomId:room.id,players:room.players.map(x=>({username:connected.get(x)?.username}))});});
 socket.on('disconnect',()=>{if(presence.get(key)===socket.id)presence.delete(key);connected.delete(socket.id);for(let i=queue.length-1;i>=0;i--)if(queue[i].socketId===socket.id)queue.splice(i,1);io.emit('presence',{username:socket.username,online:false,count:presence.size});});
});
async function finishBattle(id){const r=rooms.get(id);if(!r||r.finished)return;r.finished=true;const a=r.players[0],b=r.players[1],sa=r.scores[a],sb=r.scores[b];let result='draw';if(sa>sb)result='a';else if(sb>sa)result='b'; for(const sid of r.players){const u=await getUser(connected.get(sid)?.userId);if(!u)continue;let delta=0;if(result==='draw')delta=0;else delta=sid===a?(result==='a'?25:-18):(result==='b'?25:-18);const updated=await saveProgress(u,{rating:Math.max(0,Number(u.rating||0)+delta),clicks:Number(u.clicks||0)+Number(r.scores[sid]||0),flops:Number(u.flops||0)+Math.max(0,Number(r.scores[sid]||0)*3)});io.to(sid).emit('ranked:finished',{result:result==='draw'?'draw':(result==='a'&&sid===a)||(result==='b'&&sid===b)?'win':'loss',myScore:r.scores[sid],opponentScore:r.scores[sid===a?b:a],delta,user:updated});}rooms.delete(id);}
init().then(()=>server.listen(PORT,()=>console.log('SealSimulator listening on '+PORT)));
