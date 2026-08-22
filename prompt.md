# MISSION: Production-Ready Homehost Service Dashboard

Act as the Lead Systems Architect. You are tasked with building a production-grade, extensible local home server status dashboard from scratch in this workspace.

## System Requirements & Technical Stack

1. **Backend (`server/app.py`):**
   - Framework: **Python Flask / FastAPI** running with Gunicorn or Uvicorn.
   - Integration: Official `docker` Python library + standard `subprocess` for systemctl.
   - Endpoint `/api/v1/status`: Returns container name, status (running/paused/exited), memory/CPU usage stats, container ports, and status of defined systemd services (`nginx`, `openvpn`, `fail2ban`, `ssh`).
   - Endpoint `/api/v1/health`: System stats (Host CPU %, RAM usage, Uptime, Disk space).
   - Extensibility: A plugin/config model (`config.json`) where users can add arbitrary systemctl services or container tags to monitor without editing code.

2. **Frontend (`public/`):**
   - **Zero frameworks** (Pure Vanilla JS ES6 modules, CSS3 flex/grid, HTML5).
   - **UI Design:** Dark cyber/retro aesthetic (Deep dark slate `#0B0E14`, glowing neon green/amber state indicators, monospace accents, responsive grid cards).
   - **Extensibility:** An expandable card system. Include a dynamic search/filter bar to filter services by status or name instantly.
   - **Performance:** Live websocket or 3-second smart polling cycle with CSS transition animations and error state fallback UI.

3. **Production Deployment (`deploy/`):**
   - `Dockerfile` & `docker-compose.yml` mounting `/var/run/docker.sock` (read-only) and host systemctl access.
   - `systemd` service file (`homehost-dash.service`) for running as a native host daemon.
   - Complete `.gitignore` (excluding virtual environments, secrets, logs).

---

## Execution Instructions for Claude Code:

1. **Phase 1 (Delegated Exploration & Scaffolding):**
   - Dispatch task to `@backend-architect` to build `server/app.py`, `server/config.json`, and `requirements.txt`.
   - Dispatch task to `@ui-architect` to build `public/index.html`, `public/style.css`, and `public/app.js`.

2. **Phase 2 (Integration & System Integration):**
   - Review both backend and frontend deliverables.
   - Ensure CORS is correctly handled for local dev and production serving.

3. **Phase 3 (Deployment & Verification):**
   - Create `docker-compose.yml` and native installation setup scripts.
   - Create a `README.md` detailing how to run in development mode and production daemon mode.
   - Run a validation check on all generated files to guarantee zero syntax or import errors.
