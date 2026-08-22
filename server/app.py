import configparser
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import docker
import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR.parent / "public"
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULT_CONFIG: Dict[str, Any] = {
    "systemd_services": [],
    "container_filters": [],
    "poll_interval_seconds": 3,
}

# fail2ban's control socket and SQLite ban database are root-only (0600),
# so `fail2ban-client status` isn't an option for an unprivileged service
# user. Its jail configs (/etc/fail2ban/jail.conf, jail.d/*.conf,
# jail.local) are world-readable, and its log is group-readable by "adm"
# on Debian/Ubuntu — the same read-only-group-access pattern this app
# already uses for the Docker socket, just a different group. Add the
# service user to "adm" (see deploy/install.sh) to enable this section.
FAIL2BAN_JAIL_CONF = Path("/etc/fail2ban/jail.conf")
FAIL2BAN_JAIL_LOCAL = Path("/etc/fail2ban/jail.local")
FAIL2BAN_JAIL_D_DIR = Path("/etc/fail2ban/jail.d")
FAIL2BAN_LOG_PATH = Path("/var/log/fail2ban.log")
FAIL2BAN_LOG_LINE_RE = re.compile(r"\[(?P<jail>[\w.-]+)\]\s+(?P<action>Ban|Unban)\s+(?P<ip>[0-9a-fA-F:.]+)")
FAIL2BAN_MAX_BANNED_IPS = 50

# Local-dev defaults. For a real deployment, set ALLOWED_ORIGINS to the exact
# scheme+host+port the dashboard is served from on the LAN, e.g.
# "http://homeserver.lan:8000,http://192.168.1.10:8000" — do not use "*"
# once this leaves localhost, since credentials/cookies are not involved here
# but tightening origins still prevents other LAN devices/browsers from
# scripting against this API.
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000"
)

app = FastAPI(title="Homehost Dashboard API", version="1.0.0")

allowed_origins = [
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


def load_config() -> Dict[str, Any]:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as config_file:
            data = json.load(config_file)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return dict(DEFAULT_CONFIG)

    merged = dict(DEFAULT_CONFIG)
    merged.update(data if isinstance(data, dict) else {})
    return merged


def compute_cpu_percent(stats: Dict[str, Any]) -> float:
    # Docker's stats API reports cumulative CPU counters, not an instantaneous
    # percentage. A single stream=False call still returns both the current
    # sample (cpu_stats) and the immediately preceding one (precpu_stats), so
    # the standard approach is to take the delta of both the container's and
    # the whole host's CPU usage between those two samples and scale by the
    # number of CPUs, matching what `docker stats` itself displays.
    cpu_stats = stats.get("cpu_stats") or {}
    precpu_stats = stats.get("precpu_stats") or {}
    cpu_usage = cpu_stats.get("cpu_usage") or {}
    precpu_usage = precpu_stats.get("cpu_usage") or {}

    cpu_delta = cpu_usage.get("total_usage", 0) - precpu_usage.get("total_usage", 0)
    system_delta = cpu_stats.get("system_cpu_usage", 0) - precpu_stats.get(
        "system_cpu_usage", 0
    )

    online_cpus = (
        cpu_stats.get("online_cpus")
        or len(cpu_usage.get("percpu_usage") or [])
        or psutil.cpu_count(logical=True)
        or 1
    )

    if system_delta > 0 and cpu_delta > 0:
        return (cpu_delta / system_delta) * online_cpus * 100.0
    return 0.0


def compute_memory(stats: Dict[str, Any]) -> Tuple[int, int, float]:
    memory_stats = stats.get("memory_stats") or {}
    usage = memory_stats.get("usage", 0)
    limit = memory_stats.get("limit", 0) or 0
    cache = (memory_stats.get("stats") or {}).get("cache", 0)
    actual_usage = max(usage - cache, 0)
    percent = (actual_usage / limit) * 100.0 if limit else 0.0
    return actual_usage, limit, percent


def build_container_payload(container: Any) -> Dict[str, Any]:
    container.reload()
    attrs = container.attrs or {}

    try:
        image_tags = container.image.tags
    except Exception:
        image_tags = None
    image_name = (
        image_tags[0]
        if image_tags
        else attrs.get("Config", {}).get("Image", "unknown")
    )

    ports: List[Dict[str, Optional[str]]] = []
    port_bindings = (attrs.get("NetworkSettings") or {}).get("Ports") or {}
    for container_port, bindings in port_bindings.items():
        if not bindings:
            ports.append(
                {"container_port": container_port, "host_ip": None, "host_port": None}
            )
            continue
        for binding in bindings:
            ports.append(
                {
                    "container_port": container_port,
                    "host_ip": binding.get("HostIp"),
                    "host_port": binding.get("HostPort"),
                }
            )

    cpu_percent = 0.0
    memory_usage_bytes = 0
    memory_limit_bytes = 0
    memory_percent = 0.0

    if container.status == "running":
        try:
            stats = container.stats(stream=False)
            cpu_percent = compute_cpu_percent(stats)
            memory_usage_bytes, memory_limit_bytes, memory_percent = compute_memory(
                stats
            )
        except Exception:
            pass

    return {
        "id": container.short_id,
        "name": container.name,
        "image": image_name,
        "status": container.status,
        "cpu_percent": round(cpu_percent, 2),
        "memory_usage_bytes": memory_usage_bytes,
        "memory_limit_bytes": memory_limit_bytes,
        "memory_percent": round(memory_percent, 2),
        "ports": ports,
    }


def collect_containers() -> Tuple[List[Dict[str, Any]], Optional[str]]:
    try:
        client = docker.from_env(timeout=5)
    except Exception as exc:
        return [], f"Docker daemon unreachable: {exc}"

    try:
        containers = client.containers.list(all=True)
    except Exception as exc:
        return [], f"Failed to list containers: {exc}"
    finally:
        try:
            client.close()
        except Exception:
            pass

    payloads: List[Dict[str, Any]] = []
    for container in containers:
        try:
            payloads.append(build_container_payload(container))
        except Exception as exc:
            payloads.append(
                {
                    "id": getattr(container, "short_id", "unknown"),
                    "name": getattr(container, "name", "unknown"),
                    "error": str(exc),
                }
            )
    return payloads, None


def get_service_active_state(service_name: str) -> str:
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service_name],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return "unknown"

    state = (result.stdout or "").strip() or (result.stderr or "").strip()
    return state or "unknown"


def collect_services(config: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Optional[str]]:
    service_names = config.get("systemd_services") or []
    if not isinstance(service_names, list):
        return [], "Invalid systemd_services configuration"

    services: List[Dict[str, str]] = []
    for service_name in service_names:
        if not isinstance(service_name, str) or not service_name.strip():
            continue
        clean_name = service_name.strip()
        services.append(
            {
                "name": clean_name,
                "active_state": get_service_active_state(clean_name),
            }
        )
    return services, None


def collect_fail2ban_enabled_jails() -> List[str]:
    paths: List[str] = []
    if FAIL2BAN_JAIL_CONF.is_file():
        paths.append(str(FAIL2BAN_JAIL_CONF))
    if FAIL2BAN_JAIL_D_DIR.is_dir():
        paths.extend(sorted(str(p) for p in FAIL2BAN_JAIL_D_DIR.glob("*.conf")))
    if FAIL2BAN_JAIL_LOCAL.is_file():
        paths.append(str(FAIL2BAN_JAIL_LOCAL))
    if not paths:
        return []

    # RawConfigParser deliberately skips %(...)s interpolation: jail.conf
    # leans on it heavily (e.g. logpath = %(sshd_log)s) and we only need
    # the literal "enabled" value, not a fully resolved jail definition.
    parser = configparser.RawConfigParser()
    parser.read(paths)

    return [
        section
        for section in parser.sections()
        if parser.get(section, "enabled", fallback="false").strip().lower() == "true"
    ]


def collect_fail2ban_ban_counts(jail_names: List[str]) -> Dict[str, Dict[str, Any]]:
    stats: Dict[str, Dict[str, Any]] = {
        name: {"currently_banned_ips": set(), "total_banned": 0} for name in jail_names
    }
    jail_set = set(jail_names)

    with open(FAIL2BAN_LOG_PATH, "r", encoding="utf-8", errors="replace") as log_file:
        for line in log_file:
            match = FAIL2BAN_LOG_LINE_RE.search(line)
            if not match or match.group("jail") not in jail_set:
                continue
            jail = stats[match.group("jail")]
            if match.group("action") == "Ban":
                jail["currently_banned_ips"].add(match.group("ip"))
                jail["total_banned"] += 1
            else:
                jail["currently_banned_ips"].discard(match.group("ip"))

    return stats


def collect_fail2ban() -> Tuple[Dict[str, Any], Optional[str]]:
    try:
        jail_names = collect_fail2ban_enabled_jails()
    except Exception as exc:
        return {"jails": []}, f"Failed to read fail2ban jail config: {exc}"

    if not jail_names:
        return {"jails": []}, None

    try:
        ban_counts = collect_fail2ban_ban_counts(jail_names)
    except FileNotFoundError:
        return {"jails": []}, "fail2ban log not found — is fail2ban installed and running?"
    except PermissionError:
        return {"jails": []}, (
            "Permission denied reading /var/log/fail2ban.log "
            "(add this service's user to the 'adm' group)"
        )
    except Exception as exc:
        return {"jails": []}, f"Failed to read fail2ban log: {exc}"

    jails = []
    for name in sorted(jail_names):
        entry = ban_counts[name]
        banned_ips = sorted(entry["currently_banned_ips"])
        jails.append(
            {
                "name": name,
                "currently_banned": len(banned_ips),
                "banned_ips": banned_ips[:FAIL2BAN_MAX_BANNED_IPS],
                "total_banned": entry["total_banned"],
            }
        )
    return {"jails": jails}, None


@app.get("/api/v1/status")
def get_status() -> Dict[str, Any]:
    config = load_config()

    containers, docker_error = collect_containers()
    services, services_error = collect_services(config)
    fail2ban, fail2ban_error = collect_fail2ban()

    response: Dict[str, Any] = {
        "containers": containers,
        "services": services,
        "fail2ban": fail2ban,
    }
    if docker_error:
        response["docker_error"] = docker_error
    if services_error:
        response["services_error"] = services_error
    if fail2ban_error:
        response["fail2ban_error"] = fail2ban_error
    return response


@app.get("/api/v1/health")
def get_health() -> Dict[str, Any]:
    try:
        virtual_memory = psutil.virtual_memory()
        disk_usage = psutil.disk_usage("/")
        uptime_seconds = max(time.time() - psutil.boot_time(), 0)

        return {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory": {
                "used_bytes": virtual_memory.used,
                "total_bytes": virtual_memory.total,
                "percent": virtual_memory.percent,
            },
            "disk": {
                "used_bytes": disk_usage.used,
                "total_bytes": disk_usage.total,
                "percent": disk_usage.percent,
            },
            "uptime_seconds": int(uptime_seconds),
        }
    except Exception as exc:
        return {"health_error": f"Failed to read host stats: {exc}"}


@app.get("/api/v1/config")
def get_config() -> Dict[str, Any]:
    return load_config()


if PUBLIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
