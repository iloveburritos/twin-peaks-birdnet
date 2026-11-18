#!/usr/bin/env python3
"""Twin Peaks BirdNET - Pi uploader.

Runs every 5 minutes on the Raspberry Pi. It only makes OUTBOUND HTTPS
requests to the public archive; nothing connects in to the Pi.

What it sends:  date, time, scientific name, common name, confidence, and
                the detection's audio clip.
What it never sends: latitude/longitude, settings, logs, or live audio.

Detections deleted on the Pi are deleted from the public archive too.
Standard library only, and deliberately gentle on a 512 MB Pi.
"""
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
CONF = HOME / ".config" / "twinpeaks" / "uploader.env"
STATE = HOME / ".local" / "state" / "twinpeaks-uploader.json"
DB = HOME / "BirdNET-Pi" / "scripts" / "birds.db"
BY_DATE = HOME / "BirdSongs" / "Extracted" / "By_Date"
UA = "twin-peaks-birdnet-uploader/1.0"


def load_conf():
    conf = {"WINDOW_DAYS": "30", "MAX_CLIPS_PER_RUN": "25", "CLIPS_SINCE": ""}
    for line in CONF.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            conf[key.strip()] = value.strip().strip('"').strip("'")
    for key in ("SITE_URL", "INGEST_TOKEN"):
        if not conf.get(key):
            sys.exit(f"missing {key} in {CONF}")
    conf["SITE_URL"] = conf["SITE_URL"].rstrip("/")
    local = conf["SITE_URL"].startswith(("http://127.0.0.1", "http://localhost"))
    if not conf["SITE_URL"].startswith("https://") and not local:
        sys.exit("SITE_URL must start with https://")
    return conf


def call(conf, method, path, data=None, content_type="application/json", timeout=90):
    req = urllib.request.Request(conf["SITE_URL"] + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + conf["INGEST_TOKEN"])
    req.add_header("User-Agent", UA)
    if data is not None:
        req.add_header("Content-Type", content_type)
        req.add_header("Content-Length", str(len(data)))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def to_epoch(date, clock):
    return int(time.mktime(time.strptime(f"{date} {clock}", "%Y-%m-%d %H:%M:%S")))


def find_clip(date, file_name):
    day = BY_DATE / date
    if not day.is_dir():
        return None
    for species_dir in day.iterdir():
        candidate = species_dir / file_name
        if candidate.is_file():
            return candidate
    return None


def main():
    conf = load_conf()
    # Tell the site the station is up, so it can show when it's offline.
    call(conf, "POST", "/api/heartbeat", b"{}")
    window = int(conf["WINDOW_DAYS"])
    since_date = time.strftime("%Y-%m-%d", time.localtime(time.time() - window * 86400))
    clips_since = to_epoch(*conf["CLIPS_SINCE"].split(" ", 1)) if conf["CLIPS_SINCE"] else 0

    state = {"sent": {}}
    if STATE.exists():
        try:
            state.update(json.loads(STATE.read_text()))
        except ValueError:
            pass
    sent = state["sent"]  # file -> [date, clip_uploaded]

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=20)
    rows = db.execute(
        "SELECT Date, Time, Sci_Name, Com_Name, Confidence, File_Name "
        "FROM detections WHERE Date >= ? ORDER BY Date, Time", (since_date,)
    ).fetchall()
    db.close()

    current = {}
    for date, clock, sci, com, conf_value, file_name in rows:
        if file_name:
            current[file_name] = (date, clock, sci, com, conf_value)

    # 1. Detections deleted on the Pi are removed from the public archive.
    gone = [f for f, (date, _) in sent.items() if date >= since_date and f not in current]
    for i in range(0, len(gone), 200):
        chunk = gone[i:i + 200]
        call(conf, "POST", "/api/delete", json.dumps({"files": chunk}).encode())
        for f in chunk:
            sent.pop(f, None)
    # Forget anything older than the window (it stays in the archive).
    for f in [f for f, (date, _) in sent.items() if date < since_date]:
        sent.pop(f, None)

    # 2. New detection rows. Location columns are never read or sent.
    fresh = [f for f in current if f not in sent]
    for i in range(0, len(fresh), 200):
        chunk = fresh[i:i + 200]
        payload = [{
            "file": f, "date": current[f][0], "time": current[f][1],
            "ts": to_epoch(current[f][0], current[f][1]),
            "sci": current[f][2], "com": current[f][3], "conf": current[f][4],
        } for f in chunk]
        call(conf, "POST", "/api/ingest", json.dumps({"detections": payload}).encode())
        for f in chunk:
            sent[f] = [current[f][0], 0]
        save(state)

    # 3. Clips, oldest first, a limited number per run.
    budget = int(conf["MAX_CLIPS_PER_RUN"])
    for f in sorted(current, key=lambda name: current[name][:2]):
        if budget <= 0:
            break
        if sent.get(f, [None, 1])[1]:
            continue
        date, clock = current[f][0], current[f][1]
        if to_epoch(date, clock) < clips_since:
            sent[f][1] = 2  # recorded before the voice filter: row only, no audio
            continue
        clip = find_clip(date, f)
        if clip is None:
            continue  # not extracted yet; try again next run
        quoted = urllib.request.quote(f, safe="")
        call(conf, "PUT", f"/api/clip?file={quoted}", clip.read_bytes(), "audio/mpeg")
        sent[f][1] = 1
        budget -= 1
        save(state)

    save(state)
    print(f"ok: {len(fresh)} new, {len(gone)} removed, {len(current)} in window")


def save(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, STATE)


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.URLError, TimeoutError, sqlite3.OperationalError) as err:
        # Offline, archive unreachable, or database busy: try again next run.
        print(f"skipped this run: {err}")
        sys.exit(0)
