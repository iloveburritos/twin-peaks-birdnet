#!/usr/bin/env bash
# Twin Peaks BirdNET - install the uploader on the Raspberry Pi.
# Run ON THE PI, from the folder that contains this file:
#     bash install.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/twinpeaks"
CONF_DIR="$HOME/.config/twinpeaks"
CONF="$CONF_DIR/uploader.env"

mkdir -p "$APP" "$CONF_DIR"
install -m 755 "$HERE/uploader.py" "$APP/uploader.py"

if [ ! -f "$CONF" ]; then
  read -r -p "Public site address (e.g. https://twin-peaks-birdnet.yourname.workers.dev): " SITE_URL
  read -r -s -p "Upload key (the INGEST_TOKEN you set in Cloudflare; hidden as you paste): " TOKEN
  echo
  umask 077
  cat > "$CONF" <<EOF
SITE_URL=$SITE_URL
INGEST_TOKEN=$TOKEN
# Audio is only published for detections recorded at or after this moment
# ("YYYY-MM-DD HH:MM:SS"). Empty means no cutoff: audio is published for
# all detections, including ones recorded before the uploader was installed.
CLIPS_SINCE=
WINDOW_DAYS=30
MAX_CLIPS_PER_RUN=25
EOF
  chmod 600 "$CONF"
  echo "Saved settings to $CONF (readable only by you)."
fi

sudo tee /etc/systemd/system/twinpeaks-uploader.service >/dev/null <<EOF
[Unit]
Description=Twin Peaks BirdNET uploader
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER
ExecStart=/usr/bin/python3 $APP/uploader.py
Nice=15
IOSchedulingClass=idle
MemoryMax=96M
TimeoutStartSec=600
EOF

sudo tee /etc/systemd/system/twinpeaks-uploader.timer >/dev/null <<EOF
[Unit]
Description=Run the Twin Peaks BirdNET uploader every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now twinpeaks-uploader.timer
echo "Running a first upload now..."
python3 "$APP/uploader.py" || true
echo "Done. Check anytime with:  journalctl -u twinpeaks-uploader -n 20 --no-pager"
