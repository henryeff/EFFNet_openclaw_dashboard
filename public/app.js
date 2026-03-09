let selectedAgent = null;
let agentsTimer = null;
let logStream = null;
let lastRenderedLogSig = '';
let tokenChartTimer = null;
let tokenChartState = null;
const hiddenTokenAgents = new Set();

const agentsEl = document.getElementById('agents');
const dashboardAgentsEl = document.getElementById('dashboardAgents');
const logsEl = document.getElementById('logs');
const logTitleEl = document.getElementById('logTitle');
const logSourceEl = document.getElementById('logSource');
const metaEl = document.getElementById('meta');
const refreshBtn = document.getElementById('refreshBtn');
const tokenUsageChart = document.getElementById('tokenUsageChart');
const tokenUsageLegend = document.getElementById('tokenUsageLegend');
const tokenUsageTooltip = document.getElementById('tokenUsageTooltip');
const tokenBucketSelect = document.getElementById('tokenBucketSelect');
const themeToggle = document.getElementById('themeToggle');
const tabs = document.querySelectorAll('.tab-btn');
const panels = {
  dashboard: document.getElementById('tab-dashboard'),
  logs: document.getElementById('tab-logs'),
  todos: document.getElementById('tab-todos'),
  settings: document.getElementById('tab-settings'),
};

const todoInput = document.getElementById('todoInput');
const todoAddBtn = document.getElementById('todoAddBtn');
const todoList = document.getElementById('todoList');
const settingsForm = document.getElementById('settingsForm');
const settingsMsg = document.getElementById('settingsMsg');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeToggle) themeToggle.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  localStorage.setItem('dashboardTheme', theme);
}
(function initTheme() {
  const saved = localStorage.getItem('dashboardTheme') || 'light';
  applyTheme(saved);
})();
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });
}

function switchTab(tab) {
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === tab));
  if (tab === 'todos') loadTodos();
  if (tab === 'settings') loadSettings();
  if (tab === 'logs') updateTokenChart();
}

tabs.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function fmtDate(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function chips(values) {
  if (!values || (Array.isArray(values) && values.length === 0)) return '<span class="badge">none</span>';
  if (typeof values === 'string') return `<span class="badge">${values}</span>`;
  return values.map(v => `<span class="badge">${v}</span>`).join('');
}

async function fetchAgents() {
  const res = await fetch('/api/agents');
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load agents');
  metaEl.textContent = `container: ${data.container}`;
  return data.agents;
}


function sourceBadge(a) {
  const src = a.statusSource || 'none';
  if (!a.active) return `<span class="badge">source: ${src}</span>`;
  return `<span class="badge">source: ${src}</span>`;
}

function statusText(a) {
  if (a.active) return '<span style="color:#22c55e;font-weight:600;">online</span>';
  return `<span style="color:#fca5a5;">last seen: ${fmtDate(a.lastSeen)}</span>`;
}

function orderAgents(agents) {
  return [...agents].sort((a, b) => {
    const ad = a.default ? 1 : 0;
    const bd = b.default ? 1 : 0;
    if (ad !== bd) return bd - ad;

    const aa = a.active ? 1 : 0;
    const ba = b.active ? 1 : 0;
    if (aa !== ba) return ba - aa;

    const als = Number(a.lastSeen || 0);
    const bls = Number(b.lastSeen || 0);
    if (als !== bls) return bls - als;

    return String(a.id).localeCompare(String(b.id));
  });
}

function agentCardHTML(a) {
  return `
    <div class="agent-top">
      <div class="agent-id">${a.id}${a.default ? ' <span class="badge">default</span>' : ''}</div>
      <span class="status-dot ${a.active ? 'green' : 'red'}" title="${a.active ? 'online' : 'offline'}"></span>
    </div>
    <div class="model">model: ${a.model}</div>
    <div class="meta-line">allow tools:</div>
    <div>${chips(a.allowTools)}</div>
    <div class="meta-line">allow agents:</div>
    <div>${chips(a.allowAgents)}</div>
    <div class="meta-line">${statusText(a)} ${sourceBadge(a)}</div>
  `;
}

function renderDashboardAgents(agents) {
  dashboardAgentsEl.innerHTML = '';
  orderAgents(agents).forEach((a) => {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML = agentCardHTML(a);
    dashboardAgentsEl.appendChild(card);
  });
}

function renderAgents(agents) {
  agentsEl.innerHTML = '';
  orderAgents(agents).forEach((a) => {
    const card = document.createElement('div');
    card.className = 'agent-card' + (selectedAgent === a.id ? ' active-selected' : '');
    card.innerHTML = agentCardHTML(a);
    card.addEventListener('click', () => {
      selectedAgent = a.id;
      renderAgents(agents);
      startLogStream();
    });
    agentsEl.appendChild(card);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tryParseJson(line) {
  const t = String(line || '').trim();
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function renderLogs(lines, source = '') {
  if (logSourceEl) logSourceEl.textContent = `source: ${source || '-'}`;
  const sig = `${source}:${lines.length}:${lines[0] || ''}`;
  if (sig === lastRenderedLogSig) return;
  lastRenderedLogSig = sig;

  if (!lines.length) {
    logsEl.innerHTML = `<div class="log-line">No matched log lines for agent: ${escapeHtml(selectedAgent)}</div>`;
    return;
  }

  const html = lines.map((line) => {
    const parsed = tryParseJson(line);
    if (!parsed) return `<div class="log-line">${escapeHtml(line)}</div>`;
    const compact = escapeHtml(JSON.stringify(parsed).slice(0, 180));
    const pretty = escapeHtml(JSON.stringify(parsed, null, 2));
    return `<details class="log-json"><summary>${compact}</summary><pre>${pretty}</pre></details>`;
  }).join('');

  logsEl.innerHTML = html;
  logsEl.scrollTop = 0;
}

function colorForIndex(i) {
  const palette = ['#60a5fa','#f472b6','#34d399','#f59e0b','#a78bfa','#22d3ee','#f87171','#84cc16','#fb7185','#2dd4bf'];
  return palette[i % palette.length];
}

function getBucketMinutes() {
  return Number(tokenBucketSelect?.value || 30);
}

async function fetchTokenUsage24h(bucketMinutes = 30) {
  const res = await fetch('/api/token-usage-24h?bucketMinutes=' + bucketMinutes);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load token usage');
  return data;
}

function buildTokenState(data) {
  const entries = Object.entries(data.series || {}).sort((a, b) => (data.totals?.[b[0]] || 0) - (data.totals?.[a[0]] || 0));
  const visible = entries.filter(([agent]) => !hiddenTokenAgents.has(agent));
  return { entries, visible, labels: data.bucketStarts || [], totals: data.totals || {} };
}

function renderTokenLegend(state) {
  if (!tokenUsageLegend) return;
  tokenUsageLegend.innerHTML = state.entries.slice(0, 14).map(([agent], i) => {
    const total = Number(state.totals?.[agent] || 0).toLocaleString();
    const color = colorForIndex(i);
    const off = hiddenTokenAgents.has(agent) ? ' off' : '';
    return '<span class="token-legend-item' + off + '" data-agent="' + agent + '"><span class="token-legend-dot" style="background:' + color + '"></span>' + agent + ': ' + total + '</span>';
  }).join('');

  tokenUsageLegend.querySelectorAll('.token-legend-item').forEach((el) => {
    el.addEventListener('click', () => {
      const agent = el.getAttribute('data-agent');
      if (!agent) return;
      if (hiddenTokenAgents.has(agent)) hiddenTokenAgents.delete(agent);
      else hiddenTokenAgents.add(agent);
      if (tokenChartState?.raw) renderTokenChart(tokenChartState.raw);
    });
  });
}

function renderTokenChart(data) {
  if (!tokenUsageChart || !tokenUsageLegend) return;
  tokenChartState = { raw: data };

  const state = buildTokenState(data);
  renderTokenLegend(state);

  const labels = state.labels;
  const seriesEntries = state.visible;
  const W = 900, H = 220;
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  if (!labels.length) {
    tokenUsageChart.innerHTML = '<text x="20" y="28" fill="currentColor" opacity="0.7" font-size="12">No token buckets available.</text>';
    return;
  }

  if (!seriesEntries.length && state.entries.length) {
    hiddenTokenAgents.clear();
    return renderTokenChart(data);
  }

  if (!seriesEntries.length) {
    tokenUsageChart.innerHTML = '<text x="20" y="28" fill="currentColor" opacity="0.7" font-size="12">No token usage data in last 24h.</text>';
    return;
  }

  const maxY = Math.max(1, ...seriesEntries.flatMap(([, arr]) => arr));
  const x = (i, n) => pad.l + (n <= 1 ? 0 : (i * innerW / (n - 1)));
  const y = (v) => pad.t + innerH - (v / maxY) * innerH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => {
    const yy = pad.t + innerH - innerH * g;
    const val = Math.round(maxY * g).toLocaleString();
    return '<line x1="' + pad.l + '" y1="' + yy + '" x2="' + (W - pad.r) + '" y2="' + yy + '" stroke="currentColor" opacity="0.12" />' +
      '<text x="4" y="' + (yy + 4) + '" font-size="10" fill="currentColor" opacity="0.55">' + val + '</text>';
  }).join('');

  const paths = seriesEntries.map(([agent, arr], i) => {
    const d = arr.map((v, idx) => (idx ? 'L ' : 'M ') + x(idx, arr.length) + ' ' + y(v)).join(' ');
    const color = colorForIndex(i);
    return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.95" data-agent="' + agent + '" />';
  }).join('');

  const mid = Math.floor(labels.length / 2);
  const tickIdx = Array.from(new Set([0, mid, labels.length - 1]));
  const ticks = tickIdx.map((i) => {
    const tx = x(i, labels.length);
    const label = new Date(labels[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return '<text x="' + tx + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + label + '</text>';
  }).join('');

  const overlay = '<rect id="tokenChartHoverLayer" x="' + pad.l + '" y="' + pad.t + '" width="' + innerW + '" height="' + innerH + '" fill="transparent" />';
  tokenUsageChart.innerHTML = grid + paths + ticks + overlay;

  const layer = document.getElementById('tokenChartHoverLayer');
  if (!layer) return;

  layer.onmousemove = (e) => {
    if (!tokenUsageTooltip) return;
    const rect = tokenUsageChart.getBoundingClientRect();
    const rx = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round((rx - pad.l * rect.width / W) / ((innerW * rect.width / W) / Math.max(labels.length - 1, 1)))));
    const when = new Date(labels[idx]).toLocaleString();
    const rows = seriesEntries
      .map(([agent, arr], i) => ({ agent, v: Number(arr[idx] || 0), i }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 6)
      .map((r) => '<div><span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:' + colorForIndex(r.i) + ';margin-right:6px"></span>' + r.agent + ': ' + r.v.toLocaleString() + '</div>')
      .join('');
    tokenUsageTooltip.innerHTML = '<div style="margin-bottom:4px;font-weight:600">' + when + '</div>' + rows;
    tokenUsageTooltip.hidden = false;
    const tx = Math.min(rect.width - 270, Math.max(8, rx + 12));
    const ty = Math.max(8, e.clientY - rect.top - 12);
    tokenUsageTooltip.style.left = tx + 'px';
    tokenUsageTooltip.style.top = ty + 'px';
  };
  layer.onmouseleave = () => {
    if (tokenUsageTooltip) tokenUsageTooltip.hidden = true;
  };
}

async function updateTokenChart() {
  try {
    const data = await fetchTokenUsage24h(getBucketMinutes());
    renderTokenChart(data);
  } catch (e) {
    if (tokenUsageChart) tokenUsageChart.innerHTML = '<text x="20" y="28" fill="currentColor" opacity="0.7" font-size="12">Chart error</text>';
  }
}

function stopLogStream() {
  if (logStream) {
    logStream.close();
    logStream = null;
  }
}

function startLogStream() {
  stopLogStream();
  if (!selectedAgent) {
    logsEl.textContent = 'Select an agent card from the left.';
    return;
  }

  logTitleEl.textContent = `Agent Logs — ${selectedAgent}`;
  logsEl.textContent = 'Streaming logs...';
  if (logSourceEl) logSourceEl.textContent = 'source: connecting...';
  lastRenderedLogSig = '';

  const url = `/api/logs/stream/${encodeURIComponent(selectedAgent)}?tail=1000`;
  logStream = new EventSource(url);

  logStream.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (!data.ok) {
        logsEl.textContent = `Log stream error: ${data.error || 'unknown error'}`;
        return;
      }
      renderLogs(data.lines || [], data.source || '');
    } catch (e) {
      logsEl.textContent = `Stream parse error: ${e.message}`;
    }
  };

  logStream.onerror = () => {
    logsEl.textContent = 'Log stream disconnected. Retrying...';
  };
}

async function refreshAgentsOnly() {
  try {
    const agents = await fetchAgents();
    if (!selectedAgent && agents.length) selectedAgent = orderAgents(agents)[0].id;
    renderDashboardAgents(agents);
    renderAgents(agents);
  } catch (e) {
    logsEl.textContent = `Dashboard error: ${e.message}`;
  }
}

const KANBAN_ORDER = ['open', 'in_progress', 'in_review', 'completed'];
const KANBAN_LABEL = {
  open: 'Open',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Completed',
};

function nextStatus(status, dir) {
  const i = KANBAN_ORDER.indexOf(status);
  if (i < 0) return status;
  const n = Math.max(0, Math.min(KANBAN_ORDER.length - 1, i + dir));
  return KANBAN_ORDER[n];
}

function renderKanban(columns) {
  todoList.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'kanban-board';

  KANBAN_ORDER.forEach((key) => {
    const col = document.createElement('section');
    col.className = 'kanban-col';
    col.innerHTML = `<div class="kanban-col-title">${KANBAN_LABEL[key]}</div>`;

    const items = (columns && columns[key]) ? columns[key] : [];
    const body = document.createElement('div');
    body.className = 'kanban-col-body';
    body.dataset.status = key;
    body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('drag-over'); });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', async (e) => {
      e.preventDefault(); body.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/todo-id'));
      if (!Number.isFinite(id)) return;
      await fetch(`/api/todos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: key, done: key === 'completed' })});
      loadTodos();
    });

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'kanban-empty';
      empty.textContent = 'No tasks';
      body.appendChild(empty);
    } else {
      items.forEach((t) => {
        const card = document.createElement('div');
        card.className = `kanban-card ${t.done ? 'done' : ''}`;
        card.draggable = true;
        card.addEventListener('dragstart', (e) => { card.classList.add('dragging'); e.dataTransfer.setData('text/todo-id', String(t.id)); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        card.innerHTML = `
          <div class="kanban-card-text"></div>
          <div class="kanban-card-actions">
            <button class="mv-left">←</button>
            <button class="mv-right">→</button>
            <label><input class="done-toggle" type="checkbox" ${t.done ? 'checked' : ''}/> done</label>
            <button class="todo-del">Delete</button>
          </div>
        `;
        card.querySelector('.kanban-card-text').textContent = t.text;

        card.querySelector('.mv-left').disabled = key === 'open';
        card.querySelector('.mv-right').disabled = key === 'completed';

        card.querySelector('.mv-left').addEventListener('click', async () => {
          await fetch(`/api/todos/${t.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus(key, -1) })
          });
          loadTodos();
        });

        card.querySelector('.mv-right').addEventListener('click', async () => {
          await fetch(`/api/todos/${t.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus(key, +1) })
          });
          loadTodos();
        });

        card.querySelector('.done-toggle').addEventListener('change', async (e) => {
          const checked = e.target.checked;
          await fetch(`/api/todos/${t.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ done: checked, status: checked ? 'completed' : key })
          });
          loadTodos();
        });

        card.querySelector('.todo-del').addEventListener('click', async () => {
          await fetch(`/api/todos/${t.id}`, { method: 'DELETE' });
          loadTodos();
        });

        body.appendChild(card);
      });
    }

    col.appendChild(body);
    wrap.appendChild(col);
  });

  todoList.appendChild(wrap);
}


async function loadTodos() {
  const res = await fetch('/api/todos');
  const data = await res.json();
  if (!data.ok) {
    todoList.textContent = `Error: ${data.error}`;
    return;
  }
  renderKanban(data.columns || {});
}

async function addTodo() {
  const text = String(todoInput.value || '').trim();
  if (!text) return;
  await fetch('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, status: 'open' })
  });
  todoInput.value = '';
  loadTodos();
}

async function loadSettings() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  if (!data.ok) {
    settingsMsg.textContent = `Error: ${data.error}`;
    return;
  }
  const s = data.settings;
  settingsForm.container.value = s.container ?? '';
  settingsForm.workspaceDir.value = s.workspaceDir ?? '';
  settingsForm.todoFile.value = s.todoFile ?? '';
  settingsForm.activeWindowMs.value = s.activeWindowMs ?? '';
  settingsForm.host.value = s.host ?? '';
  settingsForm.port.value = s.port ?? '';
  if (settingsForm.statusMode) settingsForm.statusMode.value = s.statusMode ?? 'processing-only';
  if (settingsForm.processingWindowMs) settingsForm.processingWindowMs.value = s.processingWindowMs ?? 15000;
  settingsMsg.textContent = '';
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  settingsMsg.textContent = 'Saving...';
  const payload = {
    container: settingsForm.container.value,
    workspaceDir: settingsForm.workspaceDir.value,
    todoFile: settingsForm.todoFile.value,
    activeWindowMs: Number(settingsForm.activeWindowMs.value),
    host: settingsForm.host.value,
    port: Number(settingsForm.port.value),
    statusMode: settingsForm.statusMode ? settingsForm.statusMode.value : undefined,
    processingWindowMs: settingsForm.processingWindowMs ? Number(settingsForm.processingWindowMs.value) : undefined,
  };
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  settingsMsg.textContent = data.ok ? 'Saved ✅' : `Error: ${data.error}`;
  if (data.ok) await refreshAgentsOnly();
});

todoAddBtn.addEventListener('click', addTodo);
todoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });

refreshBtn.addEventListener('click', async () => {
  await refreshAgentsOnly();
  startLogStream();
  await updateTokenChart();
});

if (tokenBucketSelect) {
  tokenBucketSelect.addEventListener('change', () => updateTokenChart());
}

async function boot() {
  await refreshAgentsOnly();
  startLogStream();
  await updateTokenChart();
}

boot();
agentsTimer = setInterval(refreshAgentsOnly, 5000);
tokenChartTimer = setInterval(updateTokenChart, 10000);

window.addEventListener('beforeunload', () => {
  if (agentsTimer) clearInterval(agentsTimer);
  if (tokenChartTimer) clearInterval(tokenChartTimer);
  stopLogStream();
});
