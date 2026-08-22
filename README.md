# Homehost Dashboard

📦 **Latest release:** [v1.0.0](https://github.com/imfronto/LastDash/releases/tag/v1.0.0)

A local, extensible status dashboard for a home server: Docker container health/stats, systemd
service state, fail2ban jail activity, and host resource usage — no frameworks, no build step, no
external dependencies beyond the Python backend.

```
server/    FastAPI backend (Docker + systemd + host stats)
public/    Vanilla JS/CSS/HTML frontend, served as static files
deploy/    Docker and native-systemd deployment artifacts
```

## How it works

- `GET /api/v1/status` — Docker containers (status, CPU %, memory, ports) via the `docker` SDK,
  systemd service states via `systemctl is-active`, and fail2ban jail stats (see below).
- `GET /api/v1/health` — host CPU/RAM/disk/uptime via `psutil`.
- `GET /api/v1/config` — the loaded `server/config.json`, so the frontend knows the poll interval
  and which services are being watched.

All three data sources degrade gracefully: if the Docker daemon is unreachable, `containers` comes
back empty with a `docker_error` message instead of a 500; systemd failures work the same way via
`services_error`, and fail2ban via `fail2ban_error`.

### Fail2ban jail stats

If fail2ban is installed, the dashboard shows a panel with each *enabled* jail's currently-banned
IPs and lifetime ban count. There's nothing to configure — it reads fail2ban's own jail configs
(`/etc/fail2ban/jail.conf`, `jail.d/*.conf`, `jail.local`) to find enabled jails, then tails
`/var/log/fail2ban.log` for `Ban`/`Unban` lines to compute current state. The panel simply stays
hidden if fail2ban isn't installed or has no jails enabled.

fail2ban's control socket and ban database are root-only, so `fail2ban-client status` isn't an
option for an unprivileged service user — using it would also require `sudo`, which the native
systemd deployment's `NoNewPrivileges=true` hardening deliberately blocks. The log file is the one
piece of fail2ban state that's readable without elevated privileges: on Debian/Ubuntu it's owned by
the `adm` group, which `deploy/install.sh` already adds the service user to. Deploying via Docker
requires bind-mounting `/etc/fail2ban` and `/var/log/fail2ban.log` instead (see
`deploy/docker-compose.yml`) — the container runs as root, so no group membership is needed there.

If the log exists but isn't readable, `fail2ban_error` explains exactly what's missing (usually:
add the service user to `adm`) instead of the panel silently failing.

### Adding services or containers to watch

Click the gear icon in the header to open **Settings**, where you can add/remove watched systemd
services and container filters, and change the poll interval, without touching a file. It saves
via `PUT /api/v1/config`, which validates and rewrites `server/config.json` — no restart needed,
the rest of the app already re-reads that file on every request.

You can still hand-edit `server/config.json` directly if you'd rather:

```json
{
  "systemd_services": ["openvpn", "fail2ban"],
  "container_filters": [],
  "poll_interval_seconds": 3
}
```

`systemd_services` is an allowlist of unit names to query with `systemctl is-active`. Only names
from this file are ever passed to `subprocess` — there is no way to inject arbitrary service names
through the API. `container_filters` is a free-form array of name/label substrings you can use to
tag containers of interest; leave it empty to show all containers.

The write endpoint has no effect beyond what's already true of the read side: `systemd_services`
entries only ever reach a read-only `systemctl is-active <name>` call (passed as a single argv
element, never shell-interpolated, so this was already injection-safe before it became editable),
and `container_filters` is purely client-side display filtering. There's no authentication on this
API (matching its "trusted local network" threat model — see the CORS section below), so anyone
who can reach the dashboard can change what it watches; they still can't use it to control
anything. In production, this needs a small write exemption in the deployment hardening: the
systemd unit's `ReadWritePaths=/opt/homehost-dash/server` and the Docker Compose `config.json`
bind mount being read-write rather than `:ro` — both already set up for you.

## Development mode

Run the backend and frontend as two separate processes so you get instant reloads on both sides.

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Terminal 1 — API on :8000, auto-reload on code changes
uvicorn server.app:app --reload --port 8000

# Terminal 2 — static frontend on :5500 (any static server works)
python3 -m http.server 5500 --directory public
```

Open `http://localhost:5500`. The frontend calls same-origin API paths by default; when the API
runs on a different port than the page, set `API_BASE` at the top of `public/app.js` (e.g.
`const API_BASE = 'http://localhost:8000';`) and add that origin to `ALLOWED_ORIGINS` (see below).

### CORS

The API only allows the origins listed in the `ALLOWED_ORIGINS` environment variable
(comma-separated), defaulting to `http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000`
for local dev. In production, where the backend serves `public/` itself, the page and API share an
origin and CORS is a non-issue — tighten `ALLOWED_ORIGINS` to just that origin (or drop the env var
override entirely and edit the default in `server/app.py`) so no other device on the LAN can script
against the API from a browser.

## Production: single process (backend serves the frontend)

The backend mounts `public/` as static files, so one process serves everything:

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
ALLOWED_ORIGINS=http://main.lan:8000 \
  uvicorn server.app:app --host 0.0.0.0 --port 8000 --workers 2
```

`main.lan` is this project's convention for the dashboard's LAN name (matching `hub.lan` in the
companion `webgui` project) — add `127.0.0.1 main.lan` to `/etc/hosts` yourself here, or use
`deploy/install.sh` below, which does it for you.

## Production: native systemd daemon (recommended)

Running natively on the host — rather than in Docker — gives the simplest, most reliable access to
both `/var/run/docker.sock` and `systemctl`, with no D-Bus socket plumbing required.

```bash
sudo deploy/install.sh
```

This adds `127.0.0.1 main.lan` to `/etc/hosts` (skipped if already present; override the domain
with `DASHBOARD_DOMAIN=other.lan sudo -E deploy/install.sh`), creates a `homehost` system user
(added to the `docker` and `adm` groups), syncs the app to `/opt/homehost-dash`, creates a venv,
and installs+enables `deploy/homehost-dash.service`. Re-run it any time to pick up code or config
changes. Once it's done, the dashboard is at `http://main.lan:8000`.

```bash
systemctl status homehost-dash.service
journalctl -u homehost-dash.service -f
```

Edit `/opt/homehost-dash/server/config.json` to change watched services, then
`systemctl restart homehost-dash.service` only if you also changed code — config is hot-reloaded.

## Production: Docker

```bash
cd deploy
docker compose up -d --build
```

The container mounts `/var/run/docker.sock` read-only (the dashboard only lists/inspects
containers, never controls them) and `server/config.json` so it's hand-editable without a rebuild.

Host systemd checks (`nginx`/`openvpn`/`fail2ban`/`ssh`) require bind-mounting the host's D-Bus
socket into the container (`/run/dbus/system_bus_socket`, already wired up in
`docker-compose.yml`) plus the `dbus`/`systemd` client packages, which the `Dockerfile` installs.
This is a reasonable default on most systemd-based Linux hosts, but it is inherently more fragile
than the native daemon mode above (socket path can differ across distros, and it only works when
the host actually runs systemd) — if systemd checks stop working in Docker mode, prefer switching
to the native systemd daemon instead of debugging D-Bus mounts.

Docker doesn't touch `/etc/hosts` for you — add `127.0.0.1 main.lan` yourself if you want the
`http://main.lan:8000` URL to work on this machine (`docker-compose.yml`'s `ALLOWED_ORIGINS`
already allows that origin).

## Frontend

Pure vanilla ES6 modules, CSS Grid/Flexbox, no build step. `public/app.js` polls
`/api/v1/status` and `/api/v1/health` every `poll_interval_seconds` (from `/api/v1/config`,
default 3s) using `AbortController` to avoid overlapping/racing requests, and diff-renders the
card grid so unchanged cards are never destroyed/rebuilt. Use the search box and status chips
above the grid to filter instantly, client-side. Cards expand on click (pure CSS, no layout
JS) to show CPU/memory/ports or the systemd unit's active state.

If the API becomes unreachable, an error banner appears while the last-known-good data stays on
screen; it retries automatically on the next poll tick.

## Validation

```bash
python3 -m py_compile server/app.py
python3 -c "import json; json.load(open('server/config.json'))"
node --check public/app.js
```
