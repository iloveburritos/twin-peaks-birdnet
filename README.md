# Twin Peaks BirdNET

A public bird log for the Twin Peaks area of San Francisco. A Raspberry Pi
running [Avian Visitors](https://github.com/Twarner491/AvianVisitors) listens
for birdsong; this project publishes what it hears.

```
Raspberry Pi (home, private) --every 15 min, outbound only--> Cloudflare --> public site
```

- `src/index.js` — Cloudflare Worker: permanent archive (D1 database + R2
  clip storage), public read API, and a key-protected upload API.
- `public/` — the website: collage, map, recent detections with audio,
  species pages, CSV export.
- `pi/` — the uploader that runs on the Pi, plus its installer.

## Privacy and safety

- The Pi is never exposed to the internet. It only sends data out.
- Sent: date, time, species, confidence, audio clip. Never sent:
  coordinates, settings, logs, live audio.
- Detections go public 24 hours after they are heard
  (`PUBLISH_DELAY_HOURS` in `wrangler.toml`), leaving time to delete false
  positives on the Pi. Deletions on the Pi carry through to the archive.
- Audio is published for all detections, including ones recorded before the
  uploader was installed. To publish audio only from a certain moment on, set
  `CLIPS_SINCE` (`YYYY-MM-DD HH:MM:SS`) in the uploader config on the Pi.
- The map shows the general Twin Peaks area, not the station.

## Deploy (on your Mac, about 15 minutes)

Needs [Node.js](https://nodejs.org) and a Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler d1 create twin-peaks-birds      # copy the database_id it prints
npx wrangler r2 bucket create twin-peaks-clips
```

Paste the `database_id` into `wrangler.toml`. Then create the upload key
and deploy:

```sh
openssl rand -hex 32                          # this is your upload key; keep it private
npx wrangler secret put INGEST_TOKEN          # paste the key when asked
npx wrangler deploy                           # prints your site address
```

## Connect the Pi

Copy the `pi` folder to the Pi and run the installer (it asks for the site
address and the upload key):

```sh
scp -r pi pi@<your-pi-address>:~/twinpeaks-setup
ssh pi@<your-pi-address>
bash ~/twinpeaks-setup/install.sh
```

Check it any time with `journalctl -u twinpeaks-uploader -n 20 --no-pager`.

## Credits and license

Design and bird illustrations adapted from
[Avian Visitors](https://github.com/Twarner491/AvianVisitors) by Teddy Warner.
Built on [BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi) by Patrick
McGuire and contributors, and on BirdNET by the K. Lisa Yang Center for
Conservation Bioacoustics, Cornell Lab of Ornithology. Map data
© OpenStreetMap contributors.

Licensed [CC BY-NC-SA 4.0](LICENSE): non-commercial use, with attribution,
shared under the same terms.
