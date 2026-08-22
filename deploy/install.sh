#!/usr/bin/env bash
# Installs Homehost Dashboard as a native systemd daemon at /opt/homehost-dash.
# Run as root (or with sudo). Safe to re-run to pick up code/config updates.
set -euo pipefail

INSTALL_DIR="/opt/homehost-dash"
SERVICE_USER="homehost"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo $0)" >&2
  exit 1
fi

if ! id "$SERVICE_USER" &>/dev/null; then
  echo "Creating service user '$SERVICE_USER' (member of 'docker' group)..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG docker "$SERVICE_USER" 2>/dev/null || echo "Warning: 'docker' group not found; skipping (container stats will be unavailable)."

echo "Syncing application files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude 'deploy' \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude 'venv' \
  "$REPO_DIR/" "$INSTALL_DIR/"

echo "Creating virtualenv and installing dependencies..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

echo "Installing systemd unit..."
cp "$REPO_DIR/deploy/homehost-dash.service" /etc/systemd/system/homehost-dash.service
systemctl daemon-reload
systemctl enable homehost-dash.service
systemctl restart homehost-dash.service

echo "Done. Check status with: systemctl status homehost-dash.service"
