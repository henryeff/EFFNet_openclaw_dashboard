const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const CONFIG = {
  port: Number(process.env.PORT || 4789),
  host: process.env.BIND_HOST || '127.0.0.1',
  container: process.env.DOCKER_CONTAINER_NAME || 'openclaw-openclaw-gateway-1',
  workspaceDir: expandHome(process.env.OPENCLAW_WORKSPACE_DIR || '/home/node/.openclaw'),
  todoFile: expandHome(process.env.TODO_FILE_PATH || '/home/node/.openclaw/workspace/publisher-space/todo.md'),
  activeWindowMs: Number(process.env.ACTIVE_WINDOW_MS || 120000),
  statusMode: (process.env.STATUS_MODE || 'processing-only').trim(),
  processingWindowMs: Number(process.env.PROCESSING_WINDOW_MS || 15000),
};


function getWorkspaceCandidates() {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  push(CONFIG.workspaceDir);
  push('/home/node/.openclaw');
  push('/home/hendryeff/.openclaw');
  return out.filter((d) => {
    try { return fs.existsSync(path.join(d, 'agents')); } catch { return false; }
  });
}

const RUN_TRACKER = {
  activeByAgent: {}, // agentId -> { startedAtMs, source }
  lastPollMs: 0,
  pollIntervalMs: 2000,
};


function ensureTodoFile() {
  const dir = path.dirname(CONFIG.todoFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG.todoFile)) {
    fs.writeFileSync(CONFIG.todoFile, '# TODO\n\n<!-- managed by dashboard -->\n');
  }
}

ensureTodoFile();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function run(cmd, args = [], timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve((stdout || '').toString());
    });
  });
}

async function runOpenclaw(args = []) {
  try {
    return await run('openclaw', args, 25000);
  } catch (e) {
    if (!String(e.message || '').includes('ENOENT')) throw e;
    return await run('docker', ['exec', CONFIG.container, 'openclaw', ...args], 30000);
  }
}

async function runInContainerSh(script, timeout = 30000) {
  return await run('docker', ['exec', CONFIG.container, 'sh', '-lc', script], timeout);
}

async function readJsonFromContainer(filePath) {
  const out = await runInContainerSh(`cat ${JSON.stringify(filePath)}`);
  return JSON.parse(out);
}

async function tailLinesFromContainerFile(filePath, n = 1000) {
  const out = await runInContainerSh(`tail -n ${Number(n)} ${JSON.stringify(filePath)} || true`);
  return out.split('\n').filter(Boolean);
}

function tailLinesFromFile(filePath, n = 1000) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function parseSessionLine(line) {
  try {
    const obj = JSON.parse(line);
    const ts = obj.ts || obj.timestamp || obj.createdAt || null;
    const role = obj.role || obj.type || 'event';
    const raw = obj.text ?? obj.message ?? obj.content ?? obj.delta ?? obj.payload ?? obj.data ?? obj;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { ts, role, text };
  } catch {
    return { ts: null, role: 'raw', text: line };
  }
}

function formatSessionLine(l) {
  const ts = l.ts ? new Date(l.ts).toISOString() : '';
  return `${ts} [${l.role}] ${l.text}`.trim();
}

async function getAgentSessionLogs(agentId, tail = 1000) {
  const idxPath = `${CONFIG.workspaceDir}/agents/${agentId}/sessions/sessions.json`;
  let idx = null;

  try {
    if (fs.existsSync(idxPath)) idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    else idx = await readJsonFromContainer(idxPath);
  } catch {
    return [];
  }

  const files = Object.entries(idx || {})
    .filter(([k, v]) => k.startsWith(`agent:${agentId}:`) && v && typeof v === 'object' && v.sessionFile)
    .map(([, v]) => v.sessionFile)
    .filter((f) => typeof f === 'string');

  if (!files.length) return [];

  const all = [];
  const perFileTail = Math.max(200, Math.floor(tail / Math.max(files.length, 1)));
  for (const f of files) {
    const lines = fs.existsSync(f) ? tailLinesFromFile(f, perFileTail) : await tailLinesFromContainerFile(f, perFileTail);
    for (const line of lines) all.push(parseSessionLine(line));
  }

  all.sort((a, b) => (new Date(a.ts || 0).getTime()) - (new Date(b.ts || 0).getTime()));
  return all.slice(-tail).map(formatSessionLine).reverse(); // newest first
}

function parseIsoMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function extractTotalTokens(obj) {
  const usage = obj?.usage || obj?.message?.usage || null;
  if (!usage || typeof usage !== 'object') return 0;

  const direct = Number(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const inTok = Number(usage.input ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outTok = Number(usage.output ?? usage.output_tokens ?? usage.completion_tokens ?? 0);
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write_input_tokens ?? 0);
  const total = inTok + outTok + cacheRead + cacheWrite;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

async function getTokenUsage24h(bucketMinutes = 30) {
  const safeBucket = Math.max(5, Math.min(120, Number(bucketMinutes) || 30));
  const bucketMs = safeBucket * 60 * 1000;
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  const bucketCount = Math.ceil((now - start) / bucketMs);
  const bucketStarts = Array.from({ length: bucketCount }, (_, i) => start + (i * bucketMs));

  const roots = getWorkspaceCandidates();
  if (!roots.length) return { start, end: now, bucketMinutes: safeBucket, bucketStarts, series: {}, totals: {} };

  const series = {};
  const totals = {};

  for (const root of roots) {
    const agentsDir = path.join(root, 'agents');
    let agentIds = [];
    try { agentIds = fs.readdirSync(agentsDir).filter(Boolean); } catch { continue; }

    for (const agentId of agentIds) {
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      let files = [];
      try {
        files = fs.readdirSync(sessionsDir)
          .filter((n) => n.endsWith('.jsonl'))
          .map((n) => path.join(sessionsDir, n));
      } catch {
        continue;
      }

      // fallback to sessions.json index if present and no plain jsonl discovered
      if (!files.length) {
        const idxPath = path.join(sessionsDir, 'sessions.json');
        if (fs.existsSync(idxPath)) {
          try {
            const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
            files = Object.entries(idx || {})
              .filter(([k, v]) => k.startsWith(`agent:${agentId}:`) && v && typeof v === 'object' && typeof v.sessionFile === 'string')
              .map(([, v]) => v.sessionFile)
              .filter((f) => typeof f === 'string' && fs.existsSync(f));
          } catch {}
        }
      }

      if (!files.length) continue;

    const arr = new Array(bucketCount).fill(0);

    for (const f of files) {

      let raw;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }

      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const ts = parseIsoMs(obj?.timestamp || obj?.ts || obj?.createdAt || obj?.message?.timestamp);
        if (!ts || ts < start || ts > now) continue;

        const tok = extractTotalTokens(obj);
        if (!tok) continue;

        const idxBucket = Math.floor((ts - start) / bucketMs);
        if (idxBucket >= 0 && idxBucket < bucketCount) arr[idxBucket] += tok;
      }
    }

      const total = arr.reduce((a, b) => a + b, 0);
      if (total > 0) {
        if (!series[agentId]) {
          series[agentId] = arr;
          totals[agentId] = total;
        } else {
          // merge totals across roots
          for (let i = 0; i < arr.length; i++) series[agentId][i] += arr[i] || 0;
          totals[agentId] = (totals[agentId] || 0) + total;
        }
      }
    }
  }

  return { start, end: now, bucketMinutes: safeBucket, bucketStarts, series, totals };
}

function isLineForAgent(line, agentId) {
  const checks = [`agent:${agentId}:`, `"agentId":"${agentId}"`, `agent ${agentId}`, `[${agentId}]`];
  return checks.some((c) => line.includes(c));
}

async function getContainerLogs(tail = 1000) {
  return await run('docker', ['logs', '--tail', String(tail), CONFIG.container], 30000).catch(async () => {
    return await new Promise((resolve) => {
      execFile('docker', ['logs', '--tail', String(tail), CONFIG.container], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (_err, stdout, stderr) => {
        resolve(`${stdout || ''}${stderr || ''}`);
      });
    });
  });
}

async function getAgentsRegistry() {
  const raw = await runOpenclaw(['config', 'get', 'agents.list']);
  const agents = JSON.parse(raw || '[]');
  return (agents || []).map((a) => ({
    id: a.id,
    model: a.model || '(default)',
    allowTools: a.tools?.allow || a.tools?.profile || [],
    allowAgents: a.subagents?.allowAgents || [],
    default: !!a.default,
  }));
}



async function pollRunLifecycle() {
  const now = Date.now();
  if (now - RUN_TRACKER.lastPollMs < RUN_TRACKER.pollIntervalMs) return;
  RUN_TRACKER.lastPollMs = now;

  let raw;
  try {
    raw = await runOpenclaw(['logs', '--json', '--limit', '400', '--timeout', '5000']);
  } catch {
    return;
  }

  const lines = raw.split('\n').filter(Boolean);
  for (const ln of lines) {
    let ev;
    try { ev = JSON.parse(ln); } catch { continue; }
    if (ev.type !== 'log') continue;

    const msg = String(ev.message || '');

    // Start markers
    let m = msg.match(/elevated command openclaw agent --agent\s+([a-zA-Z0-9_-]+)/);
    if (!m) m = msg.match(/elevated command openclaw cron run\s+/); // cron run usually publisher
    if (m) {
      const agentId = m[1] || 'publisher';
      RUN_TRACKER.activeByAgent[agentId] = { startedAtMs: now, source: 'run-lifecycle' };
    }

    // Finish markers from JSON run output with sessionKey
    if (msg.includes('"runId"') && msg.includes('"status"')) {
      const sk = msg.match(/"sessionKey"\s*:\s*"agent:([a-zA-Z0-9_-]+):/);
      const aid = sk && sk[1] ? sk[1] : null;
      if (aid && RUN_TRACKER.activeByAgent[aid]) {
        delete RUN_TRACKER.activeByAgent[aid];
      }
    }
  }

  // cleanup stale active runs safety cap (2h)
  for (const [aid, v] of Object.entries(RUN_TRACKER.activeByAgent)) {
    if (now - Number(v.startedAtMs || 0) > 2 * 60 * 60 * 1000) delete RUN_TRACKER.activeByAgent[aid];
  }
}

function listKnownAgentIds() {
  const dir = `${CONFIG.workspaceDir}/agents`;
  try {
    if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(Boolean);
  } catch {}
  return [];
}

async function getAgentActivityMap(agents) {
  const now = Date.now();
  const map = {};

  // Signal A: sessions metadata
  const sessionMap = {};
  try {
    const raw = await runOpenclaw(['sessions', '--all-agents', '--json']);
    const data = JSON.parse(raw);
    const sessions = data.sessions || [];
    for (const a of agents) {
      const hits = sessions.filter((x) => x.agentId === a.id);
      sessionMap[a.id] = hits.length ? Math.max(...hits.map((h) => Number(h.updatedAt || 0))) : null;
    }
  } catch {
    for (const a of agents) sessionMap[a.id] = null;
  }

  // Signal B: container log mentions (helps while run is in-flight)
  const logMap = {};
  try {
    const raw = await getContainerLogs(4000);
    const lines = raw.split('\n').filter(Boolean);
    for (const a of agents) {
      const relevant = lines.filter((l) => isLineForAgent(l, a.id));
      let ts = null;
      for (const l of relevant) {
        const m = l.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
        if (!m) continue;
        const t = new Date(m[1]).getTime();
        if (!Number.isFinite(t)) continue;
        if (!ts || t > ts) ts = t;
      }
      logMap[a.id] = ts;
    }
  } catch {
    for (const a of agents) logMap[a.id] = null;
  }

  if (CONFIG.statusMode === 'processing-only') {
    await pollRunLifecycle();
  }

  for (const a of agents) {
    const lastSeen = Math.max(Number(sessionMap[a.id] || 0), Number(logMap[a.id] || 0)) || null;
    let active;
    let statusSource = 'none';
    if (CONFIG.statusMode === 'processing-only') {
      // primary lifecycle tracking
      active = !!RUN_TRACKER.activeByAgent[a.id];
      if (active) {
        statusSource = 'lifecycle';
      }
      // fallback for direct-chat/default agent where explicit start markers may be missing
      if (!active && lastSeen && (now - lastSeen <= CONFIG.processingWindowMs)) {
        active = true;
        statusSource = 'recent-fallback';
      }
    } else {
      active = !!(lastSeen && now - lastSeen <= CONFIG.activeWindowMs);
      statusSource = active ? 'recent-activity' : 'none';
    }
    map[a.id] = { active, lastSeen, statusSource };
  }

  return map;
}

async function fetchAgentLines(agentId, tail) {
  // strict mode: never mix agents
  const sessionLines = await getAgentSessionLogs(agentId, tail);
  if (sessionLines.length) return { source: 'session-jsonl', lines: sessionLines };

  const raw = await getContainerLogs(tail);
  const lines = raw.split('\n').filter(Boolean).filter((l) => isLineForAgent(l, agentId)).reverse();
  return { source: 'container-filter', lines };
}

const TODO_COLUMNS = [
  { key: 'open', title: 'Open' },
  { key: 'in_progress', title: 'In Progress' },
  { key: 'in_review', title: 'In Review' },
  { key: 'completed', title: 'Completed' },
];

function headingToKey(h) {
  const t = String(h || '').trim().toLowerCase();
  if (t === 'open') return 'open';
  if (t === 'in progress') return 'in_progress';
  if (t === 'in review') return 'in_review';
  if (t === 'completed') return 'completed';
  return null;
}

function parseTodos(text) {
  const lines = text.split('\n');
  const columns = { open: [], in_progress: [], in_review: [], completed: [] };
  let current = 'open';

  lines.forEach((line, idx) => {
    const hm = line.match(/^##\s+(.+)$/);
    if (hm) {
      const k = headingToKey(hm[1]);
      if (k) current = k;
      return;
    }

    const tm = line.match(/^\s*- \[( |x)\]\s*(.*)$/i);
    if (!tm) return;

    const text = String(tm[2] || '').trim();
    if (!text) return;

    const done = tm[1].toLowerCase() === 'x' || current === 'completed';
    columns[current].push({ id: idx, text, done, status: current });
  });

  return { lines, columns };
}

function serializeTodos(columns) {
  const out = [];
  out.push('# TODO (Kanban)');
  out.push('');
  out.push('<!-- Hendry task board: move cards between sections -->');
  out.push('');

  for (const c of TODO_COLUMNS) {
    out.push(`## ${c.title}`);
    const items = columns[c.key] || [];
    if (!items.length) {
      out.push('- [ ]');
    } else {
      for (const t of items) {
        const mark = (c.key === 'completed' || t.done) ? 'x' : ' ';
        out.push(`- [${mark}] ${t.text}`);
      }
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function readTodoState() {
  const content = fs.readFileSync(CONFIG.todoFile, 'utf8');
  return parseTodos(content);
}

function writeTodoColumns(columns) {
  fs.writeFileSync(CONFIG.todoFile, serializeTodos(columns));
}


function sanitizeInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function persistEnv() {
  const envPath = path.join(__dirname, '.env');
  let lines = [];
  try { lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/); } catch {}

  const kv = {
    PORT: String(CONFIG.port),
    BIND_HOST: String(CONFIG.host),
    DOCKER_CONTAINER_NAME: String(CONFIG.container),
    OPENCLAW_WORKSPACE_DIR: String(CONFIG.workspaceDir),
    TODO_FILE_PATH: String(CONFIG.todoFile),
    ACTIVE_WINDOW_MS: String(CONFIG.activeWindowMs),
    STATUS_MODE: String(CONFIG.statusMode),
    PROCESSING_WINDOW_MS: String(CONFIG.processingWindowMs),
  };

  const used = new Set();
  const out = lines.map((ln) => {
    const m = ln.match(/^([A-Z0-9_]+)=/i);
    if (!m) return ln;
    const k = m[1];
    if (!(k in kv)) return ln;
    used.add(k);
    return k + '=' + kv[k];
  });

  for (const [k,v] of Object.entries(kv)) {
    if (!used.has(k)) out.push(k + '=' + v);
  }

  fs.writeFileSync(envPath, out.filter(Boolean).join('\n') + '\n');
}

function getRecentSessionStats(hours = 24) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  const roots = getWorkspaceCandidates();
  const byAgent = {};

  for (const root of roots) {
    const agentsDir = path.join(root, 'agents');
    let agents = [];
    try { agents = fs.readdirSync(agentsDir).filter(Boolean); } catch { continue; }

    for (const aid of agents) {
      const sessionsDir = path.join(agentsDir, aid, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      let files = [];
      try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(sessionsDir, f)); } catch { continue; }

      let events = 0;
      let errors = 0;
      let lastTs = 0;
      for (const f of files) {
        let raw = '';
        try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const lines = raw.split('\n').filter(Boolean).slice(-2000);
        for (const line of lines) {
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          const t = parseIsoMs(obj?.timestamp || obj?.ts || obj?.createdAt || obj?.message?.timestamp);
          if (!t || t < cutoff) continue;
          events += 1;
          if (t > lastTs) lastTs = t;
          const msg = String(obj?.message?.content || obj?.message || obj?.text || '').toLowerCase();
          if (msg.includes('error') || msg.includes('failed') || msg.includes('exception')) errors += 1;
        }
      }

      if (!byAgent[aid]) byAgent[aid] = { events: 0, errors: 0, lastTs: 0 };
      byAgent[aid].events += events;
      byAgent[aid].errors += errors;
      byAgent[aid].lastTs = Math.max(byAgent[aid].lastTs, lastTs);
    }
  }

  return byAgent;
}


app.get('/api/settings', (_req, res) => {
  res.json({
    ok: true,
    settings: {
      container: CONFIG.container,
      workspaceDir: CONFIG.workspaceDir,
      todoFile: CONFIG.todoFile,
      activeWindowMs: CONFIG.activeWindowMs,
      host: CONFIG.host,
      port: CONFIG.port,
      statusMode: CONFIG.statusMode,
      processingWindowMs: CONFIG.processingWindowMs,
    }
  });
});

app.patch('/api/settings', (req, res) => {
  try {
    const body = req.body || {};

    if (body.container !== undefined) CONFIG.container = String(body.container || '').trim() || CONFIG.container;
    if (body.workspaceDir !== undefined) CONFIG.workspaceDir = expandHome(String(body.workspaceDir || '').trim() || CONFIG.workspaceDir);
    if (body.todoFile !== undefined) CONFIG.todoFile = expandHome(String(body.todoFile || '').trim() || CONFIG.todoFile);
    if (body.activeWindowMs !== undefined) CONFIG.activeWindowMs = sanitizeInt(body.activeWindowMs, CONFIG.activeWindowMs, 5000, 86_400_000);
    if (body.host !== undefined) CONFIG.host = String(body.host || '').trim() || CONFIG.host;
    if (body.port !== undefined) CONFIG.port = sanitizeInt(body.port, CONFIG.port, 1, 65535);
    if (body.statusMode !== undefined) {
      const m = String(body.statusMode || '').trim();
      CONFIG.statusMode = (m === 'recent-activity' || m === 'processing-only') ? m : CONFIG.statusMode;
    }
    if (body.processingWindowMs !== undefined) CONFIG.processingWindowMs = sanitizeInt(body.processingWindowMs, CONFIG.processingWindowMs, 1000, 600000);

    ensureTodoFile();
    persistEnv();

    return res.json({ ok: true, settings: {
      container: CONFIG.container,
      workspaceDir: CONFIG.workspaceDir,
      todoFile: CONFIG.todoFile,
      activeWindowMs: CONFIG.activeWindowMs,
      host: CONFIG.host,
      port: CONFIG.port,
      statusMode: CONFIG.statusMode,
      processingWindowMs: CONFIG.processingWindowMs,
    }, note: 'Saved to .env. Restart required only if host/port changed.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/api/graph', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const activity = await getAgentActivityMap(agents);

    let raw = '';
    try { raw = await runOpenclaw(['logs', '--json', '--limit', '2000', '--timeout', '5000']); } catch {}

    const lines = raw.split('\n').filter(Boolean);
    const edgeCount = new Map();

    for (const ln of lines) {
      let ev; try { ev = JSON.parse(ln); } catch { continue; }
      if (ev.type !== 'log') continue;
      const msg = String(ev.message || '');
      const m = msg.match(/elevated command openclaw agent --agent\s+([a-zA-Z0-9_-]+)/);
      if (!m) continue;
      const child = m[1];
      const parent = 'publisher';
      const k = `${parent}->${child}`;
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }

    const nodes = agents.map(a => ({
      id: a.id,
      active: activity[a.id]?.active || false,
      statusSource: activity[a.id]?.statusSource || 'none',
    }));

    const edges = Array.from(edgeCount.entries()).map(([k,count]) => {
      const [from,to] = k.split('->');
      return { from, to, count };
    }).filter(e => nodes.some(n => n.id===e.from) && nodes.some(n=>n.id===e.to));

    res.json({ ok: true, nodes, edges });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/agents', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const activity = await getAgentActivityMap(agents);
    const out = agents.map((a) => ({ ...a, active: activity[a.id]?.active || false, lastSeen: activity[a.id]?.lastSeen || null, statusSource: activity[a.id]?.statusSource || 'none' }));
    res.json({ ok: true, container: CONFIG.container, activeWindowMs: CONFIG.activeWindowMs, agents: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/logs/:agentId', async (req, res) => {
  const agentId = req.params.agentId;
  const tail = Math.min(Number(req.query.tail || 1000), 5000);
  try {
    const out = await fetchAgentLines(agentId, tail);
    res.json({ ok: true, agentId, tail, source: out.source, total: out.lines.length, lines: out.lines });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/api/token-usage-24h', async (req, res) => {
  const bucketMinutes = Number(req.query.bucketMinutes || 30);
  try {
    const out = await getTokenUsage24h(bucketMinutes);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/logs/stream/:agentId', async (req, res) => {
  const agentId = req.params.agentId;
  const tail = Math.min(Number(req.query.tail || 1000), 5000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let lastSig = '';
  const send = async () => {
    try {
      const out = await fetchAgentLines(agentId, tail);
      const sig = `${out.source}:${out.lines.length}:${out.lines[0] || ''}`;
      if (sig !== lastSig) {
        lastSig = sig;
        res.write(`data: ${JSON.stringify({ ok: true, source: out.source, lines: out.lines })}\n\n`);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ ok: false, error: e.message })}\n\n`);
    }
  };

  const t = setInterval(send, 2000);
  send();

  req.on('close', () => {
    clearInterval(t);
    res.end();
  });
});

app.get('/api/todos', (_req, res) => {
  try {
    const { columns } = readTodoState();
    res.json({ ok: true, columns, order: TODO_COLUMNS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/todos', (req, res) => {
  const text = String(req.body?.text || '').trim();
  const status = String(req.body?.status || 'open');
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });

  try {
    const state = readTodoState();
    const key = TODO_COLUMNS.some((c) => c.key === status) ? status : 'open';
    state.columns[key].push({ id: Date.now(), text, done: key === 'completed', status: key });
    writeTodoColumns(state.columns);
    const { columns } = readTodoState();
    res.json({ ok: true, columns, order: TODO_COLUMNS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const nextStatus = req.body?.status ? String(req.body.status) : null;
  const hasDone = req.body?.done !== undefined;
  const done = !!req.body?.done;

  try {
    const state = readTodoState();
    const keys = TODO_COLUMNS.map((c) => c.key);
    let found = null;

    for (const k of keys) {
      const idx = state.columns[k].findIndex((t) => Number(t.id) === id);
      if (idx >= 0) {
        found = { k, idx, item: state.columns[k][idx] };
        break;
      }
    }

    if (!found) return res.status(404).json({ ok: false, error: 'todo not found' });

    const target = keys.includes(nextStatus) ? nextStatus : found.k;
    const item = { ...found.item };
    if (hasDone) item.done = done;
    if (target === 'completed') item.done = true;
    item.status = target;

    state.columns[found.k].splice(found.idx, 1);
    state.columns[target].push(item);

    writeTodoColumns(state.columns);
    const { columns } = readTodoState();
    res.json({ ok: true, columns, order: TODO_COLUMNS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    const state = readTodoState();
    const keys = TODO_COLUMNS.map((c) => c.key);
    let removed = false;

    for (const k of keys) {
      const idx = state.columns[k].findIndex((t) => Number(t.id) === id);
      if (idx >= 0) {
        state.columns[k].splice(idx, 1);
        removed = true;
        break;
      }
    }

    if (!removed) return res.status(404).json({ ok: false, error: 'todo not found' });

    writeTodoColumns(state.columns);
    const { columns } = readTodoState();
    res.json({ ok: true, columns, order: TODO_COLUMNS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/api/triage-inbox', async (_req, res) => {
  try {
    const stats = getRecentSessionStats(24);
    const entries = Object.entries(stats).map(([agentId, v]) => {
      const risk = Math.min(100, Math.round((v.errors * 10) + (v.events === 0 ? 25 : 0)));
      const reason = v.errors > 0 ? (v.errors + ' error-like events in 24h') : (v.events === 0 ? 'No activity in last 24h' : 'Healthy activity');
      return { agentId, risk, reason, sessionKey: 'agent:' + agentId, lastTs: v.lastTs || null };
    }).sort((a,b) => b.risk - a.risk);
    const needsAction = entries.filter(x => x.risk >= 30).length;
    const highRisk = entries.filter(x => x.risk >= 70).length;
    res.json({ ok: true, summary: { needsAction, highRisk }, top: entries.slice(0, 12) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/orchestration', async (_req, res) => {
  try {
    const g = await (async () => {
      const agents = await getAgentsRegistry();
      const activity = await getAgentActivityMap(agents);
      const active = agents.filter(a => activity[a.id]?.active).map(a => ({ agentId: a.id, ageSec: activity[a.id]?.lastSeen ? Math.max(0, Math.round((Date.now() - activity[a.id].lastSeen)/1000)) : 0 }));
      let recentSpawns = [];
      try {
        const raw = await runOpenclaw(['logs', '--json', '--limit', '1500', '--timeout', '5000']);
        recentSpawns = raw.split('\n').filter(Boolean).map((ln) => {
          try { return JSON.parse(ln); } catch { return null; }
        }).filter(Boolean).filter((ev) => ev.type === 'log').map((ev) => String(ev.message || '')).map((msg) => {
          const m = msg.match(/openclaw agent --agent\s+([a-zA-Z0-9_-]+)/);
          return m ? { parent: 'publisher', child: m[1] } : null;
        }).filter(Boolean).slice(-20).reverse();
      } catch {}
      return { active, recentSpawns };
    })();
    res.json({ ok: true, summary: { activeBranches: g.active.length, recentSpawns: g.recentSpawns.length }, active: g.active, recentSpawns: g.recentSpawns });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/routing-bindings', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const routes = agents.map((a) => ({ channel: 'telegram', agentId: a.id, chat: a.default ? 'default' : 'bound' }));
    const defaultCount = routes.filter(r => r.chat === 'default').length;
    const flags = defaultCount > 1 ? ['Multiple default routes detected'] : [];
    res.json({ ok: true, summary: { uniqueRoutes: routes.length, possibleMisroutes: flags.length }, routes, flags });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/prompt-skill-trace', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const traces = agents.map((a) => ({ agentId: a.id, model: a.model, skill: Array.isArray(a.allowTools) && a.allowTools.length ? String(a.allowTools[0]) : null, truncation: false, sessionKey: 'agent:' + a.id }));
    res.json({ ok: true, summary: { withSkillSignals: traces.filter(t => t.skill).length, truncationWarnings: 0 }, traces });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/delivery-reliability', async (_req, res) => {
  try {
    let ok = 0, fail = 0;
    let samples = [];
    try {
      const raw = await getContainerLogs(3000);
      const lines = raw.split('\n').filter(Boolean);
      for (const l of lines) {
        const s = l.toLowerCase();
        if (s.includes('telegram') || s.includes('delivery')) {
          if (s.includes('fail') || s.includes('error')) { fail += 1; if (samples.length < 12) samples.push('fail: ' + l.slice(0, 120)); }
          else if (s.includes('sent') || s.includes('ok') || s.includes('success')) { ok += 1; if (samples.length < 12) samples.push('ok: ' + l.slice(0, 120)); }
        }
      }
    } catch {}
    const total = ok + fail;
    const successRate = total ? Math.round((ok / total) * 100) : 100;
    res.json({ ok: true, summary: { successRate, retries: fail }, channels: [{ channel: 'telegram', ok, fail }], retrySamples: samples });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/memory-state', async (_req, res) => {
  try {
    const memPath = path.join(process.cwd(), 'MEMORY.md');
    let text = '';
    try { text = fs.readFileSync(memPath, 'utf8'); } catch {}
    const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
    const facts = lines.filter(x => x.startsWith('-') || x.startsWith('*'));
    res.json({
      ok: true,
      mode: 'transcript-first',
      summary: { entityCount: 1, factCount: facts.length, uniqueFactCount: new Set(facts).size, conflictCandidates: 0 },
      conflictLog: [],
      retrievalTrace: { sampledBreakdown: [{ source: 'MEMORY.md', share: facts.length ? 0.7 : 0 }, { source: 'recent sessions', share: 0.3 }] }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/morning-brief', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const activity = await getAgentActivityMap(agents);
    const activeAgents = agents.filter(a => activity[a.id]?.active).length;
    const triage = getRecentSessionStats(24);
    const needsAction = Object.values(triage).filter(v => v.errors > 0 || v.events === 0).length;
    const deliverySuccessRate = 100;
    const health = needsAction > 2 ? 'watch' : 'good';
    const focus = [
      'Clear high-risk sessions first',
      'Prioritize lead-capture and conversion tasks',
      'Batch repetitive ops into automation scripts'
    ];
    res.json({ ok: true, summary: { health, activeAgents, totalAgents: agents.length, needsAction, deliverySuccessRate }, focus });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/morning-brief-text', async (_req, res) => {
  try {
    const agents = await getAgentsRegistry();
    const activity = await getAgentActivityMap(agents);
    const activeAgents = agents.filter(a => activity[a.id]?.active).length;
    const text = [
      'Morning brief',
      'Active agents: ' + activeAgents + '/' + agents.length,
      'Priority: revenue-impact tasks first, then automation, then reliability hardening.',
      'Action: review triage inbox and ship first high-upside item before noon.'
    ].join('\n');
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[dashboard] running on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[dashboard] container: ${CONFIG.container}`);
});
