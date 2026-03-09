# OpenClaw Agent Dashboard

A lightweight local dashboard for monitoring OpenClaw agents, streaming logs, and managing `todo.md`.

> Built for local-first operations. Default bind is `127.0.0.1`.

---

## Features

### 1) Agents & Logs
- Agent registry cards:
  - agent id
  - model
  - allow tools
  - allow agents
  - online/offline indicator
- Default agent sorted first
- Log stream (newest on top)
- Auto fallback for OpenClaw access:
  - host `openclaw` CLI
  - or `docker exec <container> openclaw ...`

### 2) Todo
- Reads/writes Markdown todo file (`todo.md`)
- Add task
- Toggle done/undone (`- [ ]` / `- [x]`)
- Delete task

### 3) Settings
- Shows active runtime configuration values

### 4) UX
- Light / Dark theme switch
- Full-screen dashboard layout

---

## Screenshots

Add screenshots to `./docs/` (recommended names):
- `docs/agents-logs.png`
- `docs/todo-tab.png`
- `docs/settings-tab.png`

Example markdown once added:

```md
![Agents & Logs](docs/agents-logs.png)
```

---

## Requirements

- Node.js 18+
- Docker CLI access on host
- OpenClaw running (gateway container)

---

## Quick Start

```bash
cd openclaw-agent-dashboard
cp .env.example .env
npm install --cache .npm-cache
npm start
```

Open:
- `http://127.0.0.1:4789`

---

## Configuration

Set values in `.env`:

- `PORT` (default: `4789`)
- `BIND_HOST` (default: `127.0.0.1`)
- `DOCKER_CONTAINER_NAME` (default: `openclaw-openclaw-gateway-1`)
- `OPENCLAW_WORKSPACE_DIR` (default: `/home/node/.openclaw`)
- `TODO_FILE_PATH` (default: `/home/node/.openclaw/workspace/publisher-space/todo.md`)
- `ACTIVE_WINDOW_MS` (default: `120000`)

---

## Security Notes

- Binds to localhost by default (`127.0.0.1`)
- `.env` is ignored by git
- File operations are limited to configured paths

---

## Project Structure

```text
openclaw-agent-dashboard/
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

---

## License

MIT — see [LICENSE](./LICENSE)
