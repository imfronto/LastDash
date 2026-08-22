FROM python:3.12-slim

# `dbus` + `systemd` provide the `systemctl` client binary and its runtime
# libraries so /api/v1/status can query host systemd units over D-Bus when
# /run/dbus/system_bus_socket is bind-mounted in (see docker-compose.yml).
# This does not run systemd as PID 1 inside the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dbus systemd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY public/ public/

EXPOSE 8000

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
