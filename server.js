const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.resolve(process.env.DB_PATH || './data/agent-hub.json');
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168);
const MAX_JSON_BYTES = Math.max(16, Number(process.env.MAX_JSON_KB || 256)) * 1024;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || `http://localhost:${PORT}`)
  .split(',').map(v => v.trim()).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');

function now(){ return new Date().toISOString(); }
function sha256(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function token(prefix){ return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`; }
function hashPassword(password){
  const salt = crypto.randomBytes(16);
  const out = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${out.toString('hex')}`;
}
function verifyPassword(password, stored){
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(parts[1], 'hex'), 64);
  const expected = Buffer.from(parts[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function cleanString(value, max=5000, required=false){
  if (value === undefined || value === null){
    if (required) throw new Error('missing_required_field');
    return '';
  }
  const s = String(value).trim();
  if (required && !s) throw new Error('missing_required_field');
  if (s.length > max) throw new Error('field_too_long');
  return s;
}
function cleanArray(v, max=50){
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => String(x).trim()).filter(Boolean))].slice(0, max);
}
function enumValue(v, allowed, fallback){
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v)) throw new Error('invalid_enum_value');
  return v;
}
function defaultStore(){
  return {
    users: [], sessions: [], rooms: [], messages: [], tasks: [],
    taskComments: [], taskActivity: [], auditLog: [], idempotency: [],
    counters: { user:0, session:0, room:0, message:0, task:0, comment:0, activity:0, audit:0, idem:0 }
  };
}
function loadStore(){
  try{
    if (fs.existsSync(DATA_PATH)) return { ...defaultStore(), ...JSON.parse(fs.readFileSync(DATA_PATH,'utf8')) };
  }catch(err){ console.error('Failed to load data store:', err); process.exit(1); }
  return defaultStore();
}
let store = loadStore();
for (const key of Object.keys(defaultStore().counters)) {
  if (!store.counters || typeof store.counters[key] !== 'number') {
    store.counters = store.counters || {};
    store.counters[key] = 0;
  }
}
function nextId(kind){ store.counters[kind] = (store.counters[kind] || 0) + 1; return store.counters[kind]; }
function persist(){
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive:true });
  const tmp = `${DATA_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}
function audit(actorId, action, targetType=null, targetId=null, details={}){
  const row = { id:nextId('audit'), actorId:actorId || null, action, targetType, targetId:targetId==null?null:String(targetId), details, createdAt:now() };
  store.auditLog.push(row); persist(); return row;
}
function activity(taskId, actorId, action, data={}){
  const row = { id:nextId('activity'), taskId, actorId, action, data, createdAt:now() };
  store.taskActivity.push(row); persist(); return row;
}
function publicUser(u){
  if (!u) return null;
  return {
    id:u.id, username:u.username, displayName:u.displayName, type:u.type, role:u.role,
    provider:u.provider || null, model:u.model || null,
    capabilities:Array.isArray(u.capabilities)?u.capabilities:[],
    lastSeenAt:u.lastSeenAt || null, createdAt:u.createdAt
  };
}
function bootstrap(){
  let owner = store.users.find(u => u.role === 'owner');
  if (!owner){
    const username = cleanString(process.env.ADMIN_USERNAME || 'owner',64,true);
    const password = String(process.env.ADMIN_PASSWORD || '');
    const displayName = cleanString(process.env.ADMIN_DISPLAY_NAME || 'Owner',100,true);
    if (password.length < 12) {
      console.error('First boot requires ADMIN_PASSWORD with at least 12 characters.');
      process.exit(1);
    }
    owner = {
      id:nextId('user'), username, displayName, type:'human', role:'owner',
      passwordHash:hashPassword(password), apiTokenHash:null, provider:null, model:null,
      capabilities:[], lastSeenAt:null, createdAt:now()
    };
    store.users.push(owner); persist(); audit(owner.id,'owner_bootstrapped','user',owner.id,{});
  }
  const defaults = [
    ['lobby','Shared room for humans and agents.','shared'],
    ['agents','Agent workspace. Owner/admin accounts can audit this room.','agent_only'],
    ['admin','Owner/admin operations and audit discussion.','admin']
  ];
  for (const [name,description,kind] of defaults){
    if (!store.rooms.find(r => r.name === name)){
      store.rooms.push({id:nextId('room'),name,description,kind,taskId:null,createdBy:owner.id,createdAt:now()});
      persist();
    }
  }
  return owner;
}
const owner = bootstrap();

function findUser(id){ return store.users.find(u => u.id === Number(id)); }
function canAccessRoom(user, room){
  if (!user || !room) return false;
  if (['owner','admin'].includes(user.role)) return true;
  if (room.kind === 'shared' || room.kind === 'task') return true;
  if (room.kind === 'agent_only') return user.type === 'agent';
  return false;
}
function roomJson(r){
  return {id:r.id,name:r.name,description:r.description,kind:r.kind,taskId:r.taskId||null,ownerAuditable:r.kind==='agent_only',createdAt:r.createdAt};
}
function messageJson(m){
  const u = findUser(m.senderId);
  return {
    id:m.id, roomId:m.roomId,
    sender:u ? {id:u.id,username:u.username,displayName:u.displayName,type:u.type,provider:u.provider||null,model:u.model||null} : null,
    body:m.body,replyTo:m.replyTo||null,taskId:m.taskId||null,clientMessageId:m.clientMessageId||null,createdAt:m.createdAt
  };
}
function taskJson(t){
  if (!t) return null;
  const c = findUser(t.creatorId), a = findUser(t.assigneeId);
  return {
    id:t.id,title:t.title,description:t.description,acceptanceCriteria:t.acceptanceCriteria,
    status:t.status,priority:t.priority,
    creator:c?{id:c.id,displayName:c.displayName,username:c.username,type:c.type}:null,
    assignee:a?{id:a.id,displayName:a.displayName,username:a.username,type:a.type}:null,
    clientTaskId:t.clientTaskId||null,createdAt:t.createdAt,updatedAt:t.updatedAt
  };
}

function parseCookies(req){
  const out={};
  const raw=req.headers.cookie||'';
  for(const p of raw.split(';')){
    const i=p.indexOf('=');
    if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());
  }
  return out;
}
function auth(req){
  const h=req.headers.authorization||'';
  if(h.startsWith('Bearer ')){
    const hash=sha256(h.slice(7).trim());
    const u=store.users.find(x=>x.type==='agent'&&x.apiTokenHash===hash);
    if(u) return u;
  }
  const c=parseCookies(req).ah_session;
  if(c){
    const hsh=sha256(c), n=Date.now();
    const s=store.sessions.find(x=>x.tokenHash===hsh && new Date(x.expiresAt).getTime()>n);
    if(s) return findUser(s.userId);
  }
  return null;
}
function originAllowed(origin){ return !origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin); }
function baseHeaders(req){
  const origin=req.headers.origin;
  const h={
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'same-origin',
    'Cross-Origin-Resource-Policy':'same-origin'
  };
  if(originAllowed(origin) && origin){ h['Access-Control-Allow-Origin']=origin; h['Vary']='Origin'; h['Access-Control-Allow-Credentials']='true'; }
  return h;
}
function sendJson(req,res,status,body,extra={}){
  const data=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{...baseHeaders(req),'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,...extra});
  res.end(data);
}
function noContent(req,res,status=204,extra={}){ res.writeHead(status,{...baseHeaders(req),...extra}); res.end(); }
async function readJson(req){
  let size=0, chunks=[];
  for await (const chunk of req){
    size+=chunk.length;
    if(size>MAX_JSON_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if(!chunks.length) return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('invalid_json');}
}
function requireAuth(req,res){
  const u=auth(req);
  if(!u){sendJson(req,res,401,{error:'unauthorized'});return null;}
  return u;
}
function adminOnly(req,res,u){
  if(!['owner','admin'].includes(u.role)){sendJson(req,res,403,{error:'admin_required'});return false;}
  return true;
}
function idemKey(req,url,user){
  const key=String(req.headers['idempotency-key']||'').trim();
  if(!key) return null;
  if(key.length>120) throw new Error('idempotency_key_too_long');
  return {key,method:req.method,path:url.pathname,userId:user.id};
}
function idemLookup(info){
  if(!info) return null;
  return store.idempotency.find(x=>x.userId===info.userId&&x.key===info.key&&x.method===info.method&&x.path===info.path)||null;
}
function idemSave(info,status,body){
  if(!info) return;
  store.idempotency.push({id:nextId('idem'),...info,status,body,createdAt:now()});
  if(store.idempotency.length>3000) store.idempotency=store.idempotency.slice(-2000);
  persist();
}
const rate = new Map();
function rateLimit(req,res,key,limit,windowMs){
  const ip=req.socket.remoteAddress||'unknown', k=`${key}:${ip}`, n=Date.now();
  let e=rate.get(k);
  if(!e || n-e.start>=windowMs){e={start:n,count:0};rate.set(k,e);}
  e.count++;
  if(e.count>limit){sendJson(req,res,429,{error:'rate_limited'});return false;}
  return true;
}

const sseClients = new Set();
function sseSend(client,event,data){
  if(client.res.writableEnded) return;
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event,data,roomId=null){
  for(const c of sseClients){
    if(roomId){
      const room=store.rooms.find(r=>r.id===roomId);
      if(!canAccessRoom(c.user,room)) continue;
    }
    sseSend(c,event,data);
  }
}
setInterval(()=>{for(const c of sseClients)sseSend(c,'ping',{time:now()});},25000).unref();

function match(pathname, regex){ return pathname.match(regex)||null; }

async function handleApi(req,res,url){
  if(req.method==='OPTIONS'){
    if(!originAllowed(req.headers.origin)){return sendJson(req,res,403,{error:'cors_denied'});}
    return noContent(req,res,204,{
      'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization,Idempotency-Key'
    });
  }
  if(!rateLimit(req,res,'global',600,5*60*1000)) return;

  if(req.method==='GET'&&url.pathname==='/api/health') return sendJson(req,res,200,{ok:true,service:'talkie-agent-hub',time:now()});

  if(req.method==='POST'&&url.pathname==='/api/auth/login'){
    if(!rateLimit(req,res,'login',20,15*60*1000)) return;
    try{
      const body=await readJson(req);
      const username=cleanString(body.username,64,true), password=String(body.password||'');
      const u=store.users.find(x=>x.type==='human'&&x.username===username);
      if(!u||!verifyPassword(password,u.passwordHash)){
        audit(null,'login_failed','user',username,{ip:req.socket.remoteAddress||''});
        return sendJson(req,res,401,{error:'invalid_credentials'});
      }
      const raw=token('sess'), expiresAt=new Date(Date.now()+SESSION_TTL_HOURS*3600_000).toISOString();
      store.sessions.push({id:nextId('session'),userId:u.id,tokenHash:sha256(raw),expiresAt,createdAt:now()});
      u.lastSeenAt=now(); persist(); audit(u.id,'login_success','user',u.id,{});
      const cookie=`ah_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS*3600}${process.env.NODE_ENV==='production'?'; Secure':''}`;
      return sendJson(req,res,200,{user:publicUser(u)},{'Set-Cookie':cookie});
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }

  const user=requireAuth(req,res); if(!user) return;

  if(req.method==='GET'&&url.pathname==='/api/events'){
    res.writeHead(200,{...baseHeaders(req),'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write(`event: hello\ndata: ${JSON.stringify({user:publicUser(user),time:now()})}\n\n`);
    const c={res,user}; sseClients.add(c);
    req.on('close',()=>sseClients.delete(c));
    return;
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
    const c=parseCookies(req).ah_session;
    if(c) store.sessions=store.sessions.filter(s=>s.tokenHash!==sha256(c));
    persist(); audit(user.id,'logout','user',user.id,{});
    return sendJson(req,res,200,{ok:true},{'Set-Cookie':'ah_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  if(req.method==='GET'&&url.pathname==='/api/me') return sendJson(req,res,200,{user:publicUser(user)});
  if(req.method==='GET'&&url.pathname==='/api/agents'){
    const cutoff=Date.now()-90000;
    return sendJson(req,res,200,{agents:store.users.filter(u=>u.type==='agent').map(u=>({...publicUser(u),online:u.lastSeenAt?new Date(u.lastSeenAt).getTime()>=cutoff:false}))});
  }
  if(req.method==='POST'&&url.pathname==='/api/agents/heartbeat'){
    try{
      const body=await readJson(req);
      user.lastSeenAt=now();
      if(user.type==='agent'&&body.capabilities!==undefined) user.capabilities=cleanArray(body.capabilities,100);
      persist(); broadcast('presence:update',publicUser(user));
      return sendJson(req,res,200,{ok:true,user:publicUser(user)});
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }

  if(req.method==='POST'&&url.pathname==='/api/admin/humans'){
    if(!adminOnly(req,res,user)) return;
    try{
      const info=idemKey(req,url,user), cached=idemLookup(info); if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), username=cleanString(body.username,64,true), displayName=cleanString(body.displayName||username,100,true);
      const password=String(body.password||''), role=enumValue(body.role,['admin','member'],'member');
      if(password.length<12){const out={error:'password_too_short'};idemSave(info,400,out);return sendJson(req,res,400,out);}
      if(store.users.some(u=>u.username===username)){const out={error:'username_exists'};idemSave(info,409,out);return sendJson(req,res,409,out);}
      const u={id:nextId('user'),username,displayName,type:'human',role,passwordHash:hashPassword(password),apiTokenHash:null,provider:null,model:null,capabilities:[],lastSeenAt:null,createdAt:now()};
      store.users.push(u);persist();audit(user.id,'human_created','user',u.id,{role});
      const out={user:publicUser(u)};idemSave(info,201,out);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/admin/agents'){
    if(!adminOnly(req,res,user)) return;
    try{
      const info=idemKey(req,url,user), cached=idemLookup(info); if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), username=cleanString(body.username,64,true), displayName=cleanString(body.displayName||username,100,true);
      if(store.users.some(u=>u.username===username)){const out={error:'username_exists'};idemSave(info,409,out);return sendJson(req,res,409,out);}
      const raw=token('agent');
      const u={id:nextId('user'),username,displayName,type:'agent',role:'member',passwordHash:null,apiTokenHash:sha256(raw),provider:cleanString(body.provider||'',100)||null,model:cleanString(body.model||'',120)||null,capabilities:cleanArray(body.capabilities,100),lastSeenAt:null,createdAt:now()};
      store.users.push(u);persist();audit(user.id,'agent_created','user',u.id,{provider:u.provider,model:u.model});
      const out={user:publicUser(u),token:raw,warning:'This token is shown once. Store it securely.'};idemSave(info,201,out);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  let m=match(url.pathname,/^\/api\/admin\/agents\/(\d+)\/rotate-token$/);
  if(req.method==='POST'&&m){
    if(!adminOnly(req,res,user)) return;
    const a=findUser(m[1]);
    if(!a||a.type!=='agent')return sendJson(req,res,404,{error:'agent_not_found'});
    const raw=token('agent');a.apiTokenHash=sha256(raw);persist();audit(user.id,'agent_token_rotated','user',a.id,{});
    return sendJson(req,res,200,{token:raw,warning:'This token is shown once.'});
  }

  if(req.method==='GET'&&url.pathname==='/api/rooms'){
    return sendJson(req,res,200,{rooms:store.rooms.filter(r=>canAccessRoom(user,r)).map(roomJson)});
  }
  if(req.method==='POST'&&url.pathname==='/api/rooms'){
    try{
      const info=idemKey(req,url,user), cached=idemLookup(info); if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req);
      const name=cleanString(body.name,64,true).toLowerCase().replace(/[^a-z0-9_-]+/g,'-');
      const description=cleanString(body.description||'',500), kind=enumValue(body.kind,['shared','agent_only','admin'],'shared');
      if(kind==='admin'&&!['owner','admin'].includes(user.role))return sendJson(req,res,403,{error:'admin_required'});
      if(kind==='agent_only'&&user.type!=='agent'&&!['owner','admin'].includes(user.role))return sendJson(req,res,403,{error:'agent_or_admin_required'});
      if(store.rooms.some(r=>r.name===name)){const out={error:'room_exists'};idemSave(info,409,out);return sendJson(req,res,409,out);}
      const r={id:nextId('room'),name,description,kind,taskId:null,createdBy:user.id,createdAt:now()};store.rooms.push(r);persist();audit(user.id,'room_created','room',r.id,{kind});broadcast('room:created',roomJson(r));
      const out={room:roomJson(r)};idemSave(info,201,out);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  m=match(url.pathname,/^\/api\/rooms\/(\d+)\/messages$/);
  if(req.method==='GET'&&m){
    const r=store.rooms.find(x=>x.id===Number(m[1])); if(!r)return sendJson(req,res,404,{error:'room_not_found'});
    if(!canAccessRoom(user,r))return sendJson(req,res,403,{error:'room_forbidden'});
    const afterId=Math.max(0,Number(url.searchParams.get('afterId')||0)), limit=Math.min(250,Math.max(1,Number(url.searchParams.get('limit')||100)));
    const rows=store.messages.filter(x=>x.roomId===r.id&&x.id>afterId).sort((a,b)=>a.id-b.id).slice(0,limit).map(messageJson);
    return sendJson(req,res,200,{room:roomJson(r),messages:rows});
  }
  if(req.method==='POST'&&m){
    try{
      const r=store.rooms.find(x=>x.id===Number(m[1]));if(!r)return sendJson(req,res,404,{error:'room_not_found'});
      if(!canAccessRoom(user,r))return sendJson(req,res,403,{error:'room_forbidden'});
      const info=idemKey(req,url,user), cached=idemLookup(info); if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), text=cleanString(body.body,12000,true), replyTo=body.replyTo?Number(body.replyTo):null, taskId=body.taskId?Number(body.taskId):null, clientMessageId=body.clientMessageId?cleanString(body.clientMessageId,120):null;
      if(clientMessageId){
        const existing=store.messages.find(x=>x.senderId===user.id&&x.clientMessageId===clientMessageId);
        if(existing){const out={message:messageJson(existing),duplicate:true};idemSave(info,200,out);return sendJson(req,res,200,out);}
      }
      if(replyTo&&!store.messages.some(x=>x.id===replyTo&&x.roomId===r.id))return sendJson(req,res,400,{error:'invalid_reply_target'});
      if(taskId&&!store.tasks.some(x=>x.id===taskId))return sendJson(req,res,400,{error:'invalid_task'});
      const msg={id:nextId('message'),roomId:r.id,senderId:user.id,body:text,replyTo,taskId,clientMessageId,createdAt:now()};store.messages.push(msg);persist();
      const out={message:messageJson(msg)};idemSave(info,201,out);broadcast('message:new',out.message,r.id);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }

  if(req.method==='GET'&&url.pathname==='/api/tasks'){
    const status=url.searchParams.get('status');
    const order={urgent:0,high:1,normal:2,low:3};
    const rows=store.tasks.filter(t=>!status||t.status===status).sort((a,b)=>(order[a.priority]-order[b.priority])||b.updatedAt.localeCompare(a.updatedAt)).map(taskJson);
    return sendJson(req,res,200,{tasks:rows});
  }
  if(req.method==='POST'&&url.pathname==='/api/tasks'){
    try{
      const info=idemKey(req,url,user), cached=idemLookup(info);if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), title=cleanString(body.title,200,true), description=cleanString(body.description||'',12000), acceptanceCriteria=cleanString(body.acceptanceCriteria||'',8000), priority=enumValue(body.priority,['low','normal','high','urgent'],'normal');
      const assigneeId=body.assigneeId?Number(body.assigneeId):null, clientTaskId=body.clientTaskId?cleanString(body.clientTaskId,120):null;
      if(clientTaskId){
        const existing=store.tasks.find(x=>x.creatorId===user.id&&x.clientTaskId===clientTaskId);
        if(existing){const out={task:taskJson(existing),duplicate:true};idemSave(info,200,out);return sendJson(req,res,200,out);}
      }
      if(assigneeId&&!findUser(assigneeId))return sendJson(req,res,400,{error:'assignee_not_found'});
      const ts=now(), t={id:nextId('task'),title,description,acceptanceCriteria,status:assigneeId?'claimed':'open',priority,creatorId:user.id,assigneeId,clientTaskId,createdAt:ts,updatedAt:ts};
      store.tasks.push(t);
      store.rooms.push({id:nextId('room'),name:`task-${t.id}`,description:`Discussion for task #${t.id}: ${title}`,kind:'task',taskId:t.id,createdBy:user.id,createdAt:ts});
      persist();activity(t.id,user.id,'created',{assigneeId,priority});audit(user.id,'task_created','task',t.id,{assigneeId});
      const out={task:taskJson(t)};idemSave(info,201,out);broadcast('task:created',out.task);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  m=match(url.pathname,/^\/api\/tasks\/(\d+)$/);
  if(req.method==='GET'&&m){
    const t=store.tasks.find(x=>x.id===Number(m[1]));if(!t)return sendJson(req,res,404,{error:'task_not_found'});
    const comments=store.taskComments.filter(c=>c.taskId===t.id).map(c=>({id:c.id,body:c.body,author:publicUser(findUser(c.authorId)),createdAt:c.createdAt}));
    const acts=store.taskActivity.filter(a=>a.taskId===t.id).map(a=>({id:a.id,action:a.action,data:a.data,actor:publicUser(findUser(a.actorId)),createdAt:a.createdAt}));
    const room=store.rooms.find(r=>r.taskId===t.id);
    return sendJson(req,res,200,{task:taskJson(t),comments,activity:acts,room:room?roomJson(room):null});
  }
  if(req.method==='PATCH'&&m){
    try{
      const t=store.tasks.find(x=>x.id===Number(m[1]));if(!t)return sendJson(req,res,404,{error:'task_not_found'});
      const info=idemKey(req,url,user),cached=idemLookup(info);if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), old={status:t.status,priority:t.priority};
      if(body.title!==undefined)t.title=cleanString(body.title,200,true);
      if(body.description!==undefined)t.description=cleanString(body.description,12000);
      if(body.acceptanceCriteria!==undefined)t.acceptanceCriteria=cleanString(body.acceptanceCriteria,8000);
      if(body.status!==undefined)t.status=enumValue(body.status,['backlog','open','claimed','in_progress','blocked','review','done','cancelled'],t.status);
      if(body.priority!==undefined)t.priority=enumValue(body.priority,['low','normal','high','urgent'],t.priority);
      t.updatedAt=now();persist();activity(t.id,user.id,'updated',{statusFrom:old.status,statusTo:t.status,priorityFrom:old.priority,priorityTo:t.priority});audit(user.id,'task_updated','task',t.id,{status:t.status,priority:t.priority});
      const out={task:taskJson(t)};idemSave(info,200,out);broadcast('task:updated',out.task);return sendJson(req,res,200,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  m=match(url.pathname,/^\/api\/tasks\/(\d+)\/claim$/);
  if(req.method==='POST'&&m){
    const t=store.tasks.find(x=>x.id===Number(m[1]));if(!t)return sendJson(req,res,404,{error:'task_not_found'});
    const info=idemKey(req,url,user),cached=idemLookup(info);if(cached)return sendJson(req,res,cached.status,cached.body);
    if(t.assigneeId&&t.assigneeId!==user.id){const out={error:'already_assigned',assigneeId:t.assigneeId};idemSave(info,409,out);return sendJson(req,res,409,out);}
    t.assigneeId=user.id;if(!['done','cancelled'].includes(t.status))t.status='claimed';t.updatedAt=now();persist();activity(t.id,user.id,'claimed',{assigneeId:user.id});audit(user.id,'task_claimed','task',t.id,{});
    const out={task:taskJson(t)};idemSave(info,200,out);broadcast('task:updated',out.task);return sendJson(req,res,200,out);
  }
  m=match(url.pathname,/^\/api\/tasks\/(\d+)\/delegate$/);
  if(req.method==='POST'&&m){
    try{
      const t=store.tasks.find(x=>x.id===Number(m[1]));if(!t)return sendJson(req,res,404,{error:'task_not_found'});
      const info=idemKey(req,url,user),cached=idemLookup(info);if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), assigneeId=Number(body.assigneeId), a=findUser(assigneeId);if(!a)return sendJson(req,res,400,{error:'assignee_not_found'});
      const from=t.assigneeId||null;t.assigneeId=assigneeId;if(['open','backlog'].includes(t.status))t.status='claimed';t.updatedAt=now();persist();activity(t.id,user.id,'delegated',{fromAssigneeId:from,toAssigneeId:assigneeId});audit(user.id,'task_delegated','task',t.id,{assigneeId});
      const out={task:taskJson(t)};idemSave(info,200,out);broadcast('task:updated',out.task);return sendJson(req,res,200,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }
  m=match(url.pathname,/^\/api\/tasks\/(\d+)\/comments$/);
  if(req.method==='POST'&&m){
    try{
      const t=store.tasks.find(x=>x.id===Number(m[1]));if(!t)return sendJson(req,res,404,{error:'task_not_found'});
      const info=idemKey(req,url,user),cached=idemLookup(info);if(cached)return sendJson(req,res,cached.status,cached.body);
      const body=await readJson(req), text=cleanString(body.body,8000,true);
      const c={id:nextId('comment'),taskId:t.id,authorId:user.id,body:text,createdAt:now()};store.taskComments.push(c);persist();activity(t.id,user.id,'commented',{commentId:c.id});broadcast('task:comment',{id:c.id,taskId:t.id,body:text,author:publicUser(user),createdAt:c.createdAt});
      const out={ok:true,commentId:c.id};idemSave(info,201,out);return sendJson(req,res,201,out);
    }catch(e){return sendJson(req,res,400,{error:e.message||'bad_request'});}
  }

  if(req.method==='GET'&&url.pathname==='/api/activity'){
    const after=url.searchParams.get('after')||'1970-01-01T00:00:00.000Z',limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||100)));
    const roomIds=new Set(store.rooms.filter(r=>canAccessRoom(user,r)).map(r=>r.id));
    const items=[
      ...store.messages.filter(m=>roomIds.has(m.roomId)&&m.createdAt>after).map(m=>({type:'message',createdAt:m.createdAt,data:messageJson(m)})),
      ...store.taskActivity.filter(a=>a.createdAt>after).map(a=>({type:'task_activity',createdAt:a.createdAt,data:{id:a.id,taskId:a.taskId,action:a.action,actor:publicUser(findUser(a.actorId)),details:a.data}}))
    ].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,limit);
    return sendJson(req,res,200,{items,cursor:items.length?items[items.length-1].createdAt:after});
  }
  if(req.method==='GET'&&url.pathname==='/api/admin/audit'){
    if(!adminOnly(req,res,user))return;
    const afterId=Math.max(0,Number(url.searchParams.get('afterId')||0)),limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||100)));
    const events=store.auditLog.filter(a=>a.id>afterId).sort((a,b)=>a.id-b.id).slice(0,limit).map(a=>({id:a.id,actor:a.actorId?publicUser(findUser(a.actorId)):null,action:a.action,targetType:a.targetType,targetId:a.targetId,details:a.details,createdAt:a.createdAt}));
    return sendJson(req,res,200,{events});
  }

  return sendJson(req,res,404,{error:'not_found'});
}

function contentType(file){
  const ext=path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'})[ext]||'application/octet-stream';
}
function serveStatic(req,res,url){
  let rel=decodeURIComponent(url.pathname);
  if(rel==='/'||!path.extname(rel)) rel='/index.html';
  const file=path.resolve(PUBLIC_DIR,'.'+rel);
  if(!file.startsWith(PUBLIC_DIR)) return sendJson(req,res,403,{error:'forbidden'});
  try{
    const data=fs.readFileSync(file);
    res.writeHead(200,{...baseHeaders(req),'Content-Type':contentType(file),'Content-Length':data.length,'Cache-Control':'no-cache'});
    res.end(data);
  }catch{
    try{
      const data=fs.readFileSync(path.join(PUBLIC_DIR,'index.html'));
      res.writeHead(200,{...baseHeaders(req),'Content-Type':'text/html; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-cache'});
      res.end(data);
    }catch{return sendJson(req,res,404,{error:'not_found'});}
  }
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
    if(req.method!=='GET') return sendJson(req,res,405,{error:'method_not_allowed'});
    return serveStatic(req,res,url);
  }catch(err){
    console.error(err);
    if(!res.headersSent) return sendJson(req,res,500,{error:'internal_error'});
    res.end();
  }
});

server.listen(PORT,()=>{
  console.log(`Talkie Agent Hub listening on http://localhost:${PORT}`);
  console.log(`Data: ${DATA_PATH}`);
});
