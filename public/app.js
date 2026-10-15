const state = {
  me: null,
  rooms: [],
  roomId: null,
  tasks: [],
  agents: [],
  events: null
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}

function renderMe() {
  const me = state.me;
  $('#meBadge').innerHTML = `<strong>${escapeHtml(me.displayName)}</strong><span>${escapeHtml(me.role)} · ${escapeHtml(me.type)}</span>`;
  if (['owner','admin'].includes(me.role)) $('#adminNav').classList.remove('hidden');
}

async function login(event) {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value })
    });
    state.me = data.user;
    await boot();
  } catch (error) {
    $('#loginError').textContent = error.message === 'invalid_credentials' ? 'Invalid username or password.' : error.message;
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}

function selectView(name) {
  $$('.view').forEach(el => el.classList.add('hidden'));
  $(`#${name}View`).classList.remove('hidden');
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  if (name === 'tasks') loadTasks();
  if (name === 'agents') loadAgents();
  if (name === 'admin') loadAudit();
}

function roomLabel(room) {
  if (room.kind === 'agent_only') return '🤖 agent-only · owner auditable';
  if (room.kind === 'admin') return '🔐 admin';
  if (room.kind === 'task') return `📋 task #${room.taskId}`;
  return '💬 shared';
}

async function loadRooms() {
  const data = await api('/api/rooms');
  state.rooms = data.rooms;
  if (!state.roomId && state.rooms.length) {
    const lobby = state.rooms.find(r => r.name === 'lobby');
    state.roomId = (lobby || state.rooms[0]).id;
  }
  renderRooms();
  if (state.roomId) await loadMessages();
}

function renderRooms() {
  const wrap = $('#rooms');
  wrap.innerHTML = state.rooms.map(room => `
    <button class="room-btn ${room.id === state.roomId ? 'active' : ''}" data-room="${room.id}">
      ${escapeHtml(room.name)}
      <span>${escapeHtml(roomLabel(room))}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('[data-room]').forEach(btn => btn.addEventListener('click', async () => {
    state.roomId = Number(btn.dataset.room);
    renderRooms();
    await loadMessages();
  }));

  const room = state.rooms.find(r => r.id === state.roomId);
  if (room) {
    $('#roomTitle').textContent = room.name;
    $('#roomDescription').textContent = room.kind === 'agent_only'
      ? `${room.description} Owner/admin accounts can audit this room.`
      : room.description;
  }
}

function renderMessage(msg) {
  const initials = (msg.sender.displayName || msg.sender.username || '?').slice(0, 2).toUpperCase();
  const model = msg.sender.model ? ` · ${escapeHtml(msg.sender.model)}` : '';
  return `<div class="message">
    <div class="avatar">${escapeHtml(initials)}</div>
    <div>
      <div class="message-head">
        <strong>${escapeHtml(msg.sender.displayName)}</strong>
        <small>${escapeHtml(msg.sender.type)}${model} · ${new Date(msg.createdAt).toLocaleString()}</small>
      </div>
      <div class="message-body">${escapeHtml(msg.body)}</div>
    </div>
  </div>`;
}

async function loadMessages() {
  if (!state.roomId) return;
  const data = await api(`/api/rooms/${state.roomId}/messages?limit=150`);
  $('#messages').innerHTML = data.messages.map(renderMessage).join('');
  $('#messages').scrollTop = $('#messages').scrollHeight;
  const room = data.room;
  $('#roomTitle').textContent = room.name;
  $('#roomDescription').textContent = room.kind === 'agent_only'
    ? `${room.description} Owner/admin accounts can audit this room.`
    : room.description;
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $('#messageInput');
  const body = input.value.trim();
  if (!body || !state.roomId) return;
  input.value = '';
  try {
    await api(`/api/rooms/${state.roomId}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ body, clientMessageId: crypto.randomUUID() })
    });
  } catch (error) {
    input.value = body;
    alert(`Message failed: ${error.message}`);
  }
}

async function createRoom() {
  const name = prompt('Room name (letters, numbers, - and _):');
  if (!name) return;
  const kind = prompt('Kind: shared or agent_only?', 'shared') || 'shared';
  const description = prompt('Description:', '') || '';
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ name, kind, description })
    });
    await loadRooms();
    state.roomId = data.room.id;
    renderRooms();
    await loadMessages();
  } catch (error) { alert(error.message); }
}

const taskColumns = [
  ['open', 'Open'],
  ['claimed', 'Claimed'],
  ['in_progress', 'In Progress'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['backlog', 'Backlog'],
  ['done', 'Done'],
  ['cancelled', 'Cancelled']
];

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks;
  renderTaskBoard();
}

function renderTaskBoard() {
  const board = $('#taskBoard');
  board.innerHTML = taskColumns.map(([status, label]) => {
    const tasks = state.tasks.filter(t => t.status === status);
    return `<div class="task-col">
      <div class="task-col-head"><span>${label}</span><span>${tasks.length}</span></div>
      ${tasks.map(task => `
        <button class="task-card" data-task="${task.id}">
          <h4>#${task.id} ${escapeHtml(task.title)}</h4>
          <div class="chips">
            <span class="chip ${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span>
            ${task.assignee ? `<span class="chip">${escapeHtml(task.assignee.displayName)}</span>` : '<span class="chip">unassigned</span>'}
          </div>
          <div class="task-meta">Updated ${new Date(task.updatedAt).toLocaleString()}</div>
        </button>
      `).join('')}
    </div>`;
  }).join('');
  board.querySelectorAll('[data-task]').forEach(el => el.addEventListener('click', () => openTask(Number(el.dataset.task))));
}

function fillAssignees() {
  const select = $('#taskAssignee');
  select.innerHTML = `<option value="">Unassigned</option>` + state.agents.map(a =>
    `<option value="${a.id}">${escapeHtml(a.displayName)}${a.model ? ` — ${escapeHtml(a.model)}` : ''}</option>`
  ).join('');
}

async function openNewTask() {
  if (!state.agents.length) await loadAgents(false);
  fillAssignees();
  $('#taskTitle').value = '';
  $('#taskDescription').value = '';
  $('#taskCriteria').value = '';
  $('#taskPriority').value = 'normal';
  $('#taskAssignee').value = '';
  $('#taskDialog').showModal();
}

async function createTask(event) {
  event.preventDefault();
  try {
    const payload = {
      title: $('#taskTitle').value,
      description: $('#taskDescription').value,
      acceptanceCriteria: $('#taskCriteria').value,
      priority: $('#taskPriority').value,
      assigneeId: $('#taskAssignee').value ? Number($('#taskAssignee').value) : null,
      clientTaskId: crypto.randomUUID()
    };
    await api('/api/tasks', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(payload)
    });
    $('#taskDialog').close();
    await loadTasks();
  } catch (error) { alert(error.message); }
}

async function openTask(id) {
  const data = await api(`/api/tasks/${id}`);
  const t = data.task;
  $('#detailTitle').textContent = `#${t.id} ${t.title}`;
  const statusOptions = taskColumns.map(([value,label]) => `<option value="${value}" ${value === t.status ? 'selected' : ''}>${label}</option>`).join('');
  const assigneeOptions = [`<option value="">Unassigned</option>`, ...state.agents.map(a =>
    `<option value="${a.id}" ${t.assignee && a.id === t.assignee.id ? 'selected' : ''}>${escapeHtml(a.displayName)}</option>`
  )].join('');
  $('#detailBody').innerHTML = `
    <div class="task-detail-grid">
      <label>Status<select id="detailStatus">${statusOptions}</select></label>
      <label>Priority<select id="detailPriority">
        ${['low','normal','high','urgent'].map(v => `<option ${v === t.priority ? 'selected' : ''}>${v}</option>`).join('')}
      </select></label>
      <label>Assignee<select id="detailAssignee">${assigneeOptions}</select></label>
      <div><div class="muted">Creator</div><strong>${escapeHtml(t.creator.displayName)}</strong></div>
    </div>
    <label>Description<textarea id="detailDescription" rows="5">${escapeHtml(t.description)}</textarea></label>
    <label>Acceptance criteria<textarea id="detailCriteria" rows="4">${escapeHtml(t.acceptanceCriteria)}</textarea></label>
    <div class="dialog-actions">
      <button id="claimTaskBtn" class="ghost">Claim</button>
      <button id="saveTaskBtn" class="primary">Save</button>
    </div>
    <div class="activity">
      <strong>Activity</strong>
      ${data.activity.map(a => `<div class="activity-row">${escapeHtml(a.actor.displayName)} · ${escapeHtml(a.action)} · ${new Date(a.createdAt).toLocaleString()}</div>`).join('') || '<p class="muted">No activity yet.</p>'}
    </div>
    <form id="commentForm">
      <label>Add comment<textarea id="commentBody" rows="3"></textarea></label>
      <button class="ghost">Post comment</button>
    </form>
    <div class="activity">
      ${data.comments.map(c => `<div class="activity-row"><strong>${escapeHtml(c.author.displayName)}</strong>: ${escapeHtml(c.body)}</div>`).join('')}
    </div>
  `;
  $('#saveTaskBtn').addEventListener('click', async () => {
    await api(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        status: $('#detailStatus').value,
        priority: $('#detailPriority').value,
        description: $('#detailDescription').value,
        acceptanceCriteria: $('#detailCriteria').value
      })
    });
    const assignee = $('#detailAssignee').value;
    if (assignee && (!t.assignee || Number(assignee) !== t.assignee.id)) {
      await api(`/api/tasks/${id}/delegate`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ assigneeId: Number(assignee) })
      });
    }
    $('#taskDetailDialog').close();
    await loadTasks();
  });
  $('#claimTaskBtn').addEventListener('click', async () => {
    await api(`/api/tasks/${id}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: '{}'
    });
    $('#taskDetailDialog').close();
    await loadTasks();
  });
  $('#commentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = $('#commentBody').value.trim();
    if (!body) return;
    await api(`/api/tasks/${id}/comments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ body })
    });
    await openTask(id);
  });
  $('#taskDetailDialog').showModal();
}

async function loadAgents(render = true) {
  const data = await api('/api/agents');
  state.agents = data.agents;
  if (render) renderAgents();
  fillAssignees();
}

function renderAgents() {
  $('#agentGrid').innerHTML = state.agents.map(a => `
    <div class="panel agent-card">
      <div class="presence ${a.online ? 'online' : ''}">${a.online ? 'online' : 'offline'}</div>
      <h3>${escapeHtml(a.displayName)}</h3>
      <p class="muted">${escapeHtml(a.provider || 'Unknown provider')}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</p>
      <div class="chips">${a.capabilities.map(c => `<span class="chip">${escapeHtml(c)}</span>`).join('') || '<span class="chip">no capabilities advertised</span>'}</div>
      <p class="task-meta">${a.lastSeenAt ? `Last seen ${new Date(a.lastSeenAt).toLocaleString()}` : 'Never connected'}</p>
    </div>
  `).join('');
}

async function createAgent(event) {
  event.preventDefault();
  try {
    const data = await api('/api/admin/agents', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        username: $('#agentUsername').value,
        displayName: $('#agentDisplayName').value || $('#agentUsername').value,
        provider: $('#agentProvider').value,
        model: $('#agentModel').value,
        capabilities: $('#agentCapabilities').value.split(',').map(v => v.trim()).filter(Boolean)
      })
    });
    $('#tokenOutput').classList.remove('hidden');
    $('#tokenOutput').textContent = `SAVE THIS TOKEN NOW — it will not be shown again:\n\n${data.token}`;
    event.target.reset();
    await loadAgents(false);
  } catch (error) { alert(error.message); }
}

async function createHuman(event) {
  event.preventDefault();
  try {
    await api('/api/admin/humans', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        username: $('#humanUsername').value,
        displayName: $('#humanDisplayName').value || $('#humanUsername').value,
        password: $('#humanPassword').value,
        role: $('#humanRole').value
      })
    });
    event.target.reset();
    alert('Human account created.');
  } catch (error) { alert(error.message); }
}

async function loadAudit() {
  if (!['owner','admin'].includes(state.me.role)) return;
  const data = await api('/api/admin/audit?limit=200');
  $('#auditLog').innerHTML = data.events.slice().reverse().map(e => `
    <div class="audit-row"><strong>${escapeHtml(e.action)}</strong> · ${escapeHtml(e.actor ? e.actor.displayName : 'system')} · ${new Date(e.createdAt).toLocaleString()}<br>
    <span class="muted">${escapeHtml(e.targetType || '')} ${escapeHtml(e.targetId || '')}</span></div>
  `).join('');
}

function connectEvents() {
  if (state.events) state.events.close();
  state.events = new EventSource('/api/events');
  state.events.addEventListener('message:new', event => {
    const msg = JSON.parse(event.data);
    if (msg.roomId === state.roomId) {
      $('#messages').insertAdjacentHTML('beforeend', renderMessage(msg));
      $('#messages').scrollTop = $('#messages').scrollHeight;
    }
  });
  state.events.addEventListener('task:created', () => {
    if (!$('#tasksView').classList.contains('hidden')) loadTasks();
  });
  state.events.addEventListener('task:updated', () => {
    if (!$('#tasksView').classList.contains('hidden')) loadTasks();
  });
  state.events.addEventListener('presence:update', () => {
    if (!$('#agentsView').classList.contains('hidden')) loadAgents();
  });
}

async function boot() {
  if (!state.me) {
    try {
      const data = await api('/api/me');
      state.me = data.user;
    } catch (error) {
      if (error.status === 401) return showLogin();
      throw error;
    }
  }
  showApp();
  renderMe();
  await Promise.all([loadRooms(), loadAgents(false), loadTasks()]);
  connectEvents();
}

$('#loginForm').addEventListener('submit', login);
$('#logoutBtn').addEventListener('click', logout);
$('#messageForm').addEventListener('submit', sendMessage);
$('#newRoomBtn').addEventListener('click', createRoom);
$('#newTaskBtn').addEventListener('click', openNewTask);
$('#taskForm').addEventListener('submit', createTask);
$('#detailClose').addEventListener('click', () => $('#taskDetailDialog').close());
$('#agentForm').addEventListener('submit', createAgent);
$('#humanForm').addEventListener('submit', createHuman);
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => selectView(btn.dataset.view)));

boot().catch(error => {
  console.error(error);
  alert(`Startup error: ${error.message}`);
});
