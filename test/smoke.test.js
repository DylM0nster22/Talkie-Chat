const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talkie-agent-hub-'));
const port = 32000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let proc;
let cookie = '';
let agentToken = '';

async function request(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie && !token) h.Cookie = cookie;
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { res, data };
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

test.before(async () => {
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tmp, 'test.json'),
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD: 'correct-horse-battery-staple',
      ADMIN_DISPLAY_NAME: 'Test Owner',
      ALLOWED_ORIGINS: base,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('exit', code => {
    if (code && code !== 0) console.error('server exited', code, stderr);
  });
  await waitForHealth();
});

test.after(() => {
  if (proc && !proc.killed) proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('owner login and identity', async () => {
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'owner', password: 'correct-horse-battery-staple' }
  });
  assert.equal(login.res.status, 200);
  const setCookie = login.res.headers.get('set-cookie');
  assert.ok(setCookie);
  cookie = setCookie.split(';')[0];

  const me = await request('/api/me');
  assert.equal(me.res.status, 200);
  assert.equal(me.data.user.role, 'owner');
  assert.equal(me.data.user.type, 'human');
});

test('owner creates agent and raw token works as bearer auth', async () => {
  const created = await request('/api/admin/agents', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'create-codex-agent' },
    body: {
      username: 'codex',
      displayName: 'Codex',
      provider: 'OpenAI',
      model: 'codex',
      capabilities: ['code', 'review']
    }
  });
  assert.equal(created.res.status, 201);
  assert.match(created.data.token, /^agent_/);
  agentToken = created.data.token;

  const me = await request('/api/me', { token: agentToken });
  assert.equal(me.res.status, 200);
  assert.equal(me.data.user.username, 'codex');
  assert.equal(me.data.user.type, 'agent');

  const invalid = await request('/api/me', { token: agentToken + 'x' });
  assert.equal(invalid.res.status, 401);
});

test('agent sees allowed rooms, heartbeats, and sends idempotent message', async () => {
  const rooms = await request('/api/rooms', { token: agentToken });
  assert.equal(rooms.res.status, 200);
  assert.ok(rooms.data.rooms.some(r => r.name === 'lobby'));
  assert.ok(rooms.data.rooms.some(r => r.name === 'agents' && r.ownerAuditable === true));
  assert.ok(!rooms.data.rooms.some(r => r.name === 'admin'));

  const hb = await request('/api/agents/heartbeat', {
    method: 'POST', token: agentToken,
    body: { capabilities: ['code', 'review', 'chat'] }
  });
  assert.equal(hb.res.status, 200);
  assert.deepEqual(hb.data.user.capabilities, ['code', 'review', 'chat']);

  const lobby = rooms.data.rooms.find(r => r.name === 'lobby');
  const first = await request(`/api/rooms/${lobby.id}/messages`, {
    method: 'POST', token: agentToken,
    headers: { 'Idempotency-Key': 'hello-idem' },
    body: { body: 'Hello from Codex', clientMessageId: 'hello-1' }
  });
  assert.equal(first.res.status, 201);

  const second = await request(`/api/rooms/${lobby.id}/messages`, {
    method: 'POST', token: agentToken,
    headers: { 'Idempotency-Key': 'hello-idem' },
    body: { body: 'THIS SHOULD NOT REPLACE', clientMessageId: 'hello-1' }
  });
  assert.equal(second.res.status, 201);
  assert.equal(second.data.message.id, first.data.message.id);

  const history = await request(`/api/rooms/${lobby.id}/messages`, { token: agentToken });
  assert.equal(history.res.status, 200);
  assert.equal(history.data.messages.filter(m => m.clientMessageId === 'hello-1').length, 1);
});

test('task creation, claim, delegation, update, comments, and activity', async () => {
  const created = await request('/api/tasks', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'task-create-1' },
    body: {
      title: 'Review parser',
      description: 'Check parser correctness',
      acceptanceCriteria: 'Review notes posted',
      priority: 'high',
      clientTaskId: 'review-parser-1'
    }
  });
  assert.equal(created.res.status, 201);
  const taskId = created.data.task.id;

  const claimed = await request(`/api/tasks/${taskId}/claim`, {
    method: 'POST', token: agentToken,
    headers: { 'Idempotency-Key': `claim-${taskId}` }, body: {}
  });
  assert.equal(claimed.res.status, 200);
  assert.equal(claimed.data.task.assignee.username, 'codex');

  const owner = (await request('/api/me')).data.user;
  const delegated = await request(`/api/tasks/${taskId}/delegate`, {
    method: 'POST', token: agentToken,
    headers: { 'Idempotency-Key': `delegate-${taskId}` },
    body: { assigneeId: owner.id }
  });
  assert.equal(delegated.res.status, 200);
  assert.equal(delegated.data.task.assignee.id, owner.id);

  const updated = await request(`/api/tasks/${taskId}`, {
    method: 'PATCH', token: agentToken,
    headers: { 'Idempotency-Key': `update-${taskId}` },
    body: { status: 'in_progress' }
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.data.task.status, 'in_progress');

  const comment = await request(`/api/tasks/${taskId}/comments`, {
    method: 'POST', token: agentToken,
    headers: { 'Idempotency-Key': `comment-${taskId}` },
    body: { body: 'Working on it.' }
  });
  assert.equal(comment.res.status, 201);

  const detail = await request(`/api/tasks/${taskId}`, { token: agentToken });
  assert.equal(detail.res.status, 200);
  assert.ok(detail.data.comments.some(c => c.body === 'Working on it.'));
  assert.ok(detail.data.activity.some(a => a.action === 'delegated'));

  const activity = await request('/api/activity?after=1970-01-01T00:00:00.000Z', { token: agentToken });
  assert.equal(activity.res.status, 200);
  assert.ok(activity.data.items.some(i => i.type === 'task_activity' && i.data.taskId === taskId));
});

test('owner can inspect audit log; agent cannot', async () => {
  const audit = await request('/api/admin/audit?limit=200');
  assert.equal(audit.res.status, 200);
  assert.ok(audit.data.events.some(e => e.action === 'agent_created'));
  assert.ok(audit.data.events.some(e => e.action === 'task_delegated'));

  const denied = await request('/api/admin/audit', { token: agentToken });
  assert.equal(denied.res.status, 403);
});
