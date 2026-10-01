# Operations: running Piper day to day

Starting and stopping, logs and health, upgrades, backups, keeping Pi and the containers current, disk, and
a few routines worth doing on a schedule. The one-time install is in the [Deployment guide](deployment.md).

## Control it: `piper.sh`

Run it from the gateway's folder. With no argument it restarts.

<!-- generated:commands -->

- The gateway is found as the `node server.mjs` process started from this folder, so a second copy elsewhere (or a
  test gateway with its own `GATEWAY_DB`) is left alone.
- When a systemd unit named `piper` runs this folder's gateway, `start`, `stop`, `restart`, `status` and `logs` go
  through it (`systemctl`, `journalctl`), so the script never starts a second copy that fights the unit for the port.
- Stopping sends `SIGTERM`: open chats' containers are stopped and their spend recorded; they resume on the next
  message. A gateway that does not stop within `STOP_WAIT` seconds is killed.

## As a service

`./deploy.sh --systemd` (as root) installs, enables and starts three units:

| Unit | What it does |
|---|---|
| `piper.service` | The gateway. `Restart=on-failure`, `After=docker.service`, `PATH` including `/usr/sbin` (or `iptables` would not be found), 30 s to stop |
| `piper-watchdog.timer` / `.service` | Every minute asks `/health`; after two failures in a row it alerts through the webhook, and again when it answers. State is in `.watchdog-state`. Does nothing without a webhook |
| `piper-backup.timer` / `.service` | With `--backups`: a daily backup at 03:30 keeping the newest 7. Missed runs happen at the next boot |

```bash
systemctl status piper                  # is it up
journalctl -u piper -f                  # follow the log
systemctl list-timers 'piper-*'         # the watchdog and backup timers
systemctl restart piper                 # the same as ./piper.sh restart
./deploy.sh --systemd --print-unit      # show the unit it would install, change nothing
```

Without systemd the log is `gw.log` in the gateway folder (`./piper.sh logs` follows it).

## Is it healthy

- **`GET /health`** (no key needed) returns `{"status":"ok","sessions":{…},"docker":true,"diskFreeMb":…}`. It says
  nothing sensitive. `docker` is whether containers can run.
- **`./piper.sh doctor`** checks Docker, the image (and that its Pi matches the gateway's) and the network policy.
- **The dashboard** shows a red strip on every page when chats cannot start or the disk is nearly full, and the
  Containers page has the detail. Settings → Containers → *Container health* has a button to check again.
- **Start-up line** in the log names the version, address, auth mode, image, network policy and limits, then reports
  Docker, the image and any problem.

## Update Piper

1. Take a backup: `./piper.sh backup`.
2. Get the new files (`git pull`, or replace the repository files including `lib/` and `docker/`).
3. `node test.mjs` (no Docker needed).
4. If `docker/` changed: `./piper.sh image`.
5. `./piper.sh restart` (or `systemctl restart piper`). Open chats resume; a chat whose image, mounts or limits
   changed gets a fresh container, or, for a persistent container, a rebuilt one that keeps what is installed.
6. `./piper.sh doctor`.

`gateway.db`, `profiles/`, `workspaces/`, `shared/` and `container-pi/` carry over. New settings appear with their
defaults; renamed ones are migrated on start.

## Update Pi, then everything that follows it

The gateway loads Pi once, at start, and every container's Pi must speak the same protocol. So the order matters:

1. **Update the host's Pi**: Containers page → *Pi on this host* → **check for updates**, **update** (needs a
   dashboard password), or by hand `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<version>`.
   This changes what is *installed*; the gateway still *runs* the old version.
2. **Restart the gateway** (`./piper.sh restart`). Now it runs the new version.
3. **Rebuild the image**: Containers → Images → rebuild, or `./piper.sh image`. New chats' containers get it.
4. **Update the existing containers**: Containers → **update all** (or **update** on a row, an agent's row, or a
   profile's detail). Each is rebuilt keeping what is installed, its Pi set to the gateway's version, its
   extensions updated.

Until step 4, the Containers and Agents pages show the old Pi versions in red. A container whose Pi is *newer* than
the gateway's shows amber: update the host first.

## Containers: what to do with them

| Want | Do |
|---|---|
| Free a container's memory, keep its state | **stop** (Containers page) |
| Pick up new settings, keep installs, refresh Pi | **update** |
| Wipe what an agent installed, start from the image | **recreate** (chat container) or **reset** (an agent's) |
| End a chat and remove its container | **remove** (workspace and profile stay) |
| Run something inside one | Command box (password required) |
| See why one died | The events list: OOM kills and unexpected stops are recorded and shown to the chat on its next reply |

Containers that belong to nothing (their chat or key is gone) are marked *orphan*; the ten-minute sweep removes
them, or remove them by hand.

## Backups

`./piper.sh backup [--out DIR] [--keep N] [--no-chats]` writes one owner-only (`0600`) `.tar.gz` of the database
(a consistent copy, safe while running), profiles, workspaces, shared bundles, container Pi config and, unless
`--no-chats`, chat sessions, with a manifest of checksums. It refuses when it would leave under 1 GB free. Containers
are not included; a chat whose container is missing gets a fresh one. The archives are as safe as the disk they
sit on: copy them off the machine.

`./piper.sh restore FILE [--stop]` refuses while the gateway runs (or stops it with `--stop`), verifies the
checksums, moves everything it replaces aside as `*.before-restore-<time>` (never deleting), extracts, and checks
the database. Do a restore into a scratch folder once, before you need it.

## Disk

Docker's data (images, containers, saved states) is usually the big user. Look at:

- **Overview → Resources**: free disk and what containers have written.
- **Containers**: each container's written size; `CONTAINER_DISK_MB` warns when one passes it.
- **Images**: old and untagged images (**prune**); every image build leaves build cache, which `docker builder
  prune -f` clears safely.
- **`piper-keystate:*` images**: the saved state of rebuilt containers; removed with their container.
- `workspaces-archive/` and `*.before-restore-*` folders are safe to delete when you are sure (archives expire
  on their own after `ARCHIVE_TTL_MS`).

`DISK_FREE_WARN_MB` (default 5 GB) raises the red banner and an alert.

## Alerts

Set `ALERT_WEBHOOK_URL` (Settings → Containers → Disk and alerts) and press **send a test alert**. The body is JSON
with `text` and `content`, so Slack and Discord webhooks work as they are. Raised for: Docker or the network policy
failing (and recovering), low disk, a container killed for memory or over its disk warning, an agent losing its
port, and, from the watchdog, the gateway not answering. The same kind is sent at most once an hour.

## Behind a proxy: the terminal

The Terminal page is a WebSocket. A reverse proxy has to pass `Upgrade`/`Connection: upgrade` and a long read timeout, and
the `Host` (or `X-Forwarded-Host`) must be the one the page was served from, or the gateway refuses it as a foreign origin.
nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
proxy_read_timeout 1h;`. Check `TERMINAL_*` under Settings → Containers.

## Routine checks

- Weekly: Containers page for red Pi versions and orphans; Overview for disk; the Audit page for anything odd.
- After any Docker or kernel upgrade: `./piper.sh doctor`, and one real chat.
- Monthly: restore a backup into a scratch folder; update Pi (above); prune images.
- When a key's person leaves: revoke and delete the key (its agent endpoints and their containers go with it).

## See also

[Deployment guide](deployment.md), [Troubleshooting](troubleshooting.md), [Files and data](files.md).
