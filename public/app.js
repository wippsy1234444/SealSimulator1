const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const LEVEL_COSTS = [0, 200, 1500, 9000, 60000, 450000];
const upgrades = [
  { key:'power', name:'Click Power', desc:'More FLOPS from every seal click.', base:50, factor:1.85, max:10, effect:l=>1+l },
  { key:'mult', name:'Flop Multiplier', desc:'Increase the payout of every click.', base:400, factor:2.15, max:8, effect:l=>1+0.1*l },
  { key:'crit', name:'Critical Click', desc:'Chance to trigger a high-value click.', base:900, factor:2.25, max:7, effect:l=>0.02*l },
  { key:'combo', name:'Combo Bonus', desc:'Make sustained clicking more valuable.', base:1600, factor:2.4, max:7, effect:l=>0.05*l },
  { key:'lucky', name:'Lucky Flops', desc:'Rarely award a large bonus.', base:4500, factor:2.6, max:6, effect:l=>l },
  { key:'bank', name:'Deep Flop Bank', desc:'Raise your passive milestone rewards.', base:12000, factor:2.9, max:5, effect:l=>l }
];
const cosmetics = [
  {id:'none', name:'Natural', type:'Clean', cost:0},
  {id:'crown', name:'Mini Crown', type:'Hat', cost:8000},
  {id:'beanie', name:'Soft Beanie', type:'Hat', cost:12500},
  {id:'tophat', name:'Top Hat', type:'Hat', cost:25000},
  {id:'helmet', name:'Glass Helmet', type:'Hat', cost:50000},
  {id:'halo', name:'Light Ring', type:'Hat', cost:85000},
  {id:'sneaker', name:'Sneakers', type:'Shoes', cost:15000},
  {id:'boot', name:'Seal Boots', type:'Shoes', cost:35000},
  {id:'rocket', name:'Rocket Shoes', type:'Shoes', cost:95000},
  {id:'golden', name:'Silver Step', type:'Shoes', cost:160000}
];
const defaultState = {
  flops:0,totalClicks:0,level:1,runClicks:0,combo:0,bestCombo:0,bestCps:0,rankWins:0,elo:0,name:'Player',
  upgrades:Object.fromEntries(upgrades.map(u=>[u.key,0])), owned:['none'], equipped:'none'
};
let state = {...defaultState, ...(JSON.parse(localStorage.getItem('sealSimV3')||'{}')||{})};
state.upgrades = {...defaultState.upgrades,...(state.upgrades||{})};
state.owned = [...new Set(state.owned||['none'])];

function save(){localStorage.setItem('sealSimV3', JSON.stringify(state));}
function fmt(n){return Math.floor(n).toLocaleString();}
function levelRank(){return [...[{n:'Bronze',e:0},{n:'Silver',e:100},{n:'Gold',e:300},{n:'Platinum',e:650},{n:'Diamond',e:1200},{n:'Master',e:2200}]].reverse().find(x=>state.elo>=x.e)||{n:'Bronze',e:0};}
function upgradeCost(u){return Math.floor(u.base*Math.pow(u.factor,state.upgrades[u.key]||0));}
function clickPower(){const l=state.upgrades.power||0; const mult=1+(state.upgrades.mult||0)*0.1; const combo=1+(state.upgrades.combo||0)*0.05*Math.min(state.combo,20); return Math.max(1,Math.floor((1+l)*mult*combo));}

// Audio — all generated locally, no external copyrighted audio.
let audioCtx=null, master=null, musicOn=true, soundOn=true, musicTimer=null;
function ensureAudio(){
  if(audioCtx) { if(audioCtx.state==='suspended') audioCtx.resume(); return; }
  audioCtx=new (window.AudioContext||window.webkitAudioContext)(); master=audioCtx.createGain(); master.gain.value=.18; master.connect(audioCtx.destination); startMusic();
}
function tone(freq,dur,type='sine',gain=.05,when=0){if(!audioCtx||!soundOn)return;const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=type;o.frequency.value=freq;g.gain.setValueAtTime(0,audioCtx.currentTime+when);g.gain.linearRampToValueAtTime(gain,audioCtx.currentTime+when+.008);g.gain.exponentialRampToValueAtTime(.0001,audioCtx.currentTime+when+dur);o.connect(g);g.connect(master);o.start(audioCtx.currentTime+when);o.stop(audioCtx.currentTime+when+dur+.02)}
function uiClick(){ensureAudio();tone(520,.04,'sine',.035);tone(240,.06,'triangle',.018,.01)}
function sealSound(){ensureAudio();if(!soundOn)return;const t=audioCtx.currentTime;const o=audioCtx.createOscillator(),g=audioCtx.createGain(),f=audioCtx.createBiquadFilter();o.type='sawtooth';o.frequency.setValueAtTime(320,t);o.frequency.exponentialRampToValueAtTime(105,t+.17);o.frequency.exponentialRampToValueAtTime(180,t+.28);f.type='lowpass';f.frequency.value=1200;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.12,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.3);o.connect(f);f.connect(g);g.connect(master);o.start(t);o.stop(t+.33);tone(82,.22,'sine',.05,.015)}
function startMusic(){if(!audioCtx||!musicOn||musicTimer)return;const notes=[220,277.18,329.63,246.94];let i=0;const tick=()=>{if(!musicOn)return;tone(notes[i%notes.length],1.8,'sine',.008);tone(notes[(i+2)%notes.length]/2,2.8,'sine',.006,.15);i++;musicTimer=setTimeout(tick,2100)};tick()}
function stopMusic(){clearTimeout(musicTimer);musicTimer=null}

function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800)}
function setTab(tab){uiClick();$$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('.view').forEach(v=>v.classList.toggle('active',v.id===tab+'View'));window.scrollTo({top:0,behavior:'smooth'});if(tab==='ranked')refreshLeaderboard();}
$$('[data-tab]').forEach(el=>el.addEventListener('click',()=>setTab(el.dataset.tab)));

function render(){
  $('#flops').textContent=fmt(state.flops); $('#flops2').textContent=fmt(state.flops);
  $('#runClicks').textContent=fmt(state.runClicks); $('#combo').textContent=state.combo; $('#bestCombo').textContent=state.bestCombo; $('#cps').textContent=calcCps().toFixed(1);
  $('#totalClicks').textContent=fmt(state.totalClicks); $('#bestCps').textContent=state.bestCps.toFixed(1); $('#rankWins').textContent=fmt(state.rankWins);
  $('#levelLabel').textContent=`LEVEL ${state.level} SEAL`; const next=LEVEL_COSTS[state.level]||null; $('#nextSeal').textContent=next?`Level ${state.level+1}`:'Maximum'; $('#evolveCost').textContent=next?fmt(next):'MAX';
  const prev=state.level===1?0:LEVEL_COSTS[state.level-1]; const pct=next?Math.min(100,Math.max(0,(state.flops-prev)/(next-prev)*100)):100; $('#levelProgress').style.width=pct+'%'; $('#progressText').textContent=next?`${fmt(Math.max(0,state.flops-prev))} / ${fmt(next-prev)} FLOPS`:'Fully evolved'; $('#evolveBtn').disabled=!next||state.flops<next;
  $('#rankName').textContent=levelRank().n;$('#rankElo').textContent=`${fmt(state.elo)} rating`;$('#rankBadge').textContent=levelRank().n.toUpperCase();$('#rankIcon').textContent=levelRank().n[0];
  $('#playerName').value=state.name;
  renderUpgrades();renderCosmetics();
}
let clickTimes=[];function calcCps(){const n=performance.now();clickTimes=clickTimes.filter(t=>n-t<1000);return clickTimes.length;}
function sealClick(){ensureAudio();const now=performance.now();clickTimes.push(now);state.runClicks++;state.totalClicks++;state.combo++;state.bestCombo=Math.max(state.bestCombo,state.combo);let reward=clickPower();const critChance=(state.upgrades.crit||0)*.02;if(Math.random()<critChance){reward*=5;toast('Critical seal click');}
  if(state.combo>1&&state.combo%10===0)reward+=Math.floor(reward*(state.upgrades.combo||0)*.05)+10*(state.upgrades.lucky||0); if(Math.random()<Math.min(.02*(state.upgrades.lucky||0),.25))reward+=100+50*(state.upgrades.lucky||0);
  state.flops+=reward;state.bestCps=Math.max(state.bestCps,calcCps());
  $('#sealButton').classList.remove('clicked');void $('#sealButton').offsetWidth;$('#sealButton').classList.add('clicked');sealSound();pop(`+${fmt(reward)}`);sendPlayerClick();save();render();
}
function pop(text){const el=$('#comboPop');el.textContent=text;el.classList.remove('show');void el.offsetWidth;el.classList.add('show')}
$('#sealButton').addEventListener('click',sealClick);
setInterval(()=>{if(state.combo>0 && performance.now()-clickTimes.at(-1)>1500){state.combo=0;render()}},300);

function renderUpgrades(){
  $('#upgradeGrid').innerHTML=upgrades.map(u=>{const lvl=state.upgrades[u.key]||0,cost=upgradeCost(u);return `<div class="card upgrade"><div class="upgrade-top"><div><div class="eyebrow">UPGRADE</div><h3>${u.name}</h3><p>${u.desc}</p></div><div class="level">LEVEL ${lvl}/${u.max}</div></div><div class="upgrade-bottom">${lvl>=u.max?'<span class="cost">MAXED</span>':`<span class="cost">${fmt(cost)} FLOPS</span><button class="primary-btn buy-upgrade" data-key="${u.key}" ${state.flops<cost?'disabled':''}>Upgrade</button>`}</div></div>`}).join('');
  $$('.buy-upgrade').forEach(b=>b.addEventListener('click',()=>buyUpgrade(b.dataset.key)));
}
function buyUpgrade(key){uiClick();const u=upgrades.find(x=>x.key===key),lvl=state.upgrades[key]||0,cost=upgradeCost(u);if(!u||lvl>=u.max||state.flops<cost)return;state.flops-=cost;state.upgrades[key]=lvl+1;save();render();toast(`${u.name} upgraded`)}
$('#evolveBtn').addEventListener('click',()=>{uiClick();const cost=LEVEL_COSTS[state.level];if(!cost||state.flops<cost)return;state.flops-=cost;state.level++;save();render();toast(`Seal evolved to Level ${state.level}`)});

function renderCosmetics(){
  const layer=cosmeticMarkup(state.equipped);$('#cosmeticLayer').innerHTML=layer;$('#previewCosmeticLayer').innerHTML=layer;
  $('#cosmeticList').innerHTML=cosmetics.map(c=>{const owned=state.owned.includes(c.id), equipped=state.equipped===c.id;return `<div class="card cosmetic-item"><div class="cosmetic-info"><strong>${c.name}</strong><span>${c.type}</span></div><div>${equipped?'<button class="ghost-btn" disabled>Equipped</button>':owned?`<button class="secondary-btn equip" data-id="${c.id}">Equip</button>`:`<button class="primary-btn buy-cosmetic" data-id="${c.id}" ${state.flops<c.cost?'disabled':''}>${fmt(c.cost)} FLOPS</button>`}</div></div>`}).join('');
  $$('.equip').forEach(b=>b.addEventListener('click',()=>equipCosmetic(b.dataset.id)));$$('.buy-cosmetic').forEach(b=>b.addEventListener('click',()=>buyCosmetic(b.dataset.id)));
}
function cosmeticMarkup(id){if(id==='none')return ''; if(['crown','beanie','tophat','helmet','halo'].includes(id))return `<div class="hat ${id}"></div>`;return `<div class="shoes"><div class="shoe ${id}"></div><div class="shoe ${id}"></div></div>`}
function buyCosmetic(id){uiClick();const c=cosmetics.find(x=>x.id===id);if(!c||state.owned.includes(id)||state.flops<c.cost)return;state.flops-=c.cost;state.owned.push(id);state.equipped=id;save();render();toast(`${c.name} unlocked`)}
function equipCosmetic(id){uiClick();if(!state.owned.includes(id))return;state.equipped=id;save();render();toast('Cosmetic equipped')}

let socket=null,currentRoom=null, battleTimer=null, socketReady=false;
function connect(){try{socket=io();socket.on('connect',()=>{socketReady=true;socket.emit('profile:set',state.name);toast('Online');});socket.on('disconnect',()=>{socketReady=false;$('#searchState').textContent='Offline. Ranked requires real connected players.';});socket.on('match:searching',()=>{toggleSearch(true);});socket.on('match:found',data=>{currentRoom=data.roomId;openBattle(data.opponent,data.ranked);});socket.on('battle:start',data=>startBattleClock(data.endsAt));socket.on('battle:score',data=>{if(data.id===socket.id)$('#youScore').textContent=data.score;else $('#enemyScore').textContent=data.score});socket.on('battle:end',data=>finishBattle(data));socket.on('battle:cancelled',d=>{closeBattle();toast(d.reason||'Battle cancelled');});socket.on('friend:created',d=>{$('#createdCode').hidden=false;$('#createdCode').textContent=d.code;toast('Room created');});socket.on('friend:error',m=>toast(m));}catch(e){socketReady=false}}
function sendPlayerClick(){if(socketReady)socket.emit('player:click')}
function toggleSearch(searching){$('#rankQueueBtn').hidden=searching;$('#rankCancelBtn').hidden=!searching;$('#searchState').textContent=searching?'Searching for a real player… no bots.':''}
$('#rankQueueBtn').addEventListener('click',()=>{uiClick();if(!socketReady){toast('Server is offline.');return}socket.emit('ranked:queue');toggleSearch(true)});$('#rankCancelBtn').addEventListener('click',()=>{uiClick();socket?.emit('ranked:cancel');toggleSearch(false)});
$('#createRoomBtn').addEventListener('click',()=>{uiClick();if(!socketReady){toast('Server is offline.');return}socket.emit('friend:create')});$('#joinRoomBtn').addEventListener('click',()=>{uiClick();if(!socketReady){toast('Server is offline.');return}socket.emit('friend:join',$('#roomCode').value)});
$('#saveNameBtn').addEventListener('click',()=>{uiClick();state.name=$('#playerName').value.trim().slice(0,18)||'Player';save();socket?.emit('profile:set',state.name);toast('Profile saved')});

function openBattle(opponent,ranked){$('#battleMode').textContent=ranked?'RANKED BATTLE':'FRIEND BATTLE';$('#opponentName').textContent=opponent;$('#enemyName').textContent=opponent;$('#youName').textContent=state.name;$('#youScore').textContent='0';$('#enemyScore').textContent='0';$('#battleModal').hidden=false;toggleSearch(false)}
function startBattleClock(endsAt){clearInterval(battleTimer);const tick=()=>{const left=Math.max(0,(endsAt-Date.now())/1000);$('#battleTimer').textContent=left.toFixed(1);if(left<=0)clearInterval(battleTimer)};tick();battleTimer=setInterval(tick,50)}
$('#battleSeal').addEventListener('click',()=>{if(!socketReady||!currentRoom)return;socket.emit('battle:click',currentRoom);ensureAudio();sealSound();$('#battleSeal').classList.remove('hit');void $('#battleSeal').offsetWidth;$('#battleSeal').classList.add('hit')});
function finishBattle(data){clearInterval(battleTimer);const you=data.scores[socket.id]||0,enemy=Object.values(data.scores).find((_,i)=>Object.keys(data.scores)[i]!==socket.id)||0;setTimeout(()=>{closeBattle();if(data.result===socket.id){state.rankWins++;state.elo+=25;toast('Victory +25 rating');}else if(data.result!=='draw'){state.elo=Math.max(0,state.elo-15);toast('Defeat -15 rating')}else toast('Draw');save();render();refreshLeaderboard()},500)}
function closeBattle(){$('#battleModal').hidden=true;currentRoom=null}

async function refreshLeaderboard(){try{const res=await fetch('/api/leaderboard');const data=await res.json();const rows=(data.players||[]).map((p,i)=>`<div class="leader-row"><div class="place">${i+1}</div><div><div class="player">${escapeHtml(p.name)}</div><div class="rank">${escapeHtml(p.rank||'Bronze')}</div></div><div class="rank">${fmt(p.clicks||0)} clicks</div><div class="elo">${fmt(p.elo||0)}</div></div>`).join('');$('#leaderboardRows').innerHTML=rows||'<div class="empty">No connected players yet.</div>'}catch{ $('#leaderboardRows').innerHTML='<div class="empty">Leaderboard unavailable until the server is online.</div>'}}
$('#refreshLeaderboard').addEventListener('click',()=>{uiClick();refreshLeaderboard()});
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

$('#soundToggle').addEventListener('click',()=>{soundOn=!soundOn;uiClick();$('#soundToggle').textContent=soundOn?'Sound':'Muted'});$('#musicToggle').addEventListener('click',()=>{musicOn=!musicOn;uiClick();if(musicOn){ensureAudio();startMusic()}else stopMusic();$('#musicToggle').textContent=musicOn?'Music':'Music off'});
window.addEventListener('pointerdown',ensureAudio,{once:true});
connect();render();
