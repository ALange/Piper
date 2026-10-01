# Deploying Piper on a new host

This takes a freshly installed Linux machine to a running gateway: what to install, how to run it
as a service, and how to check that a chat's container is really confined. The README explains *why*
things work the way they do; this file is the *how*.

The dashboard's **Documentation** page is a handbook for running Piper (architecture, operations, every setting, API,
security, troubleshooting); this file is also in it, as the *Deployment guide*.

It was written against Debian 13 (Docker 26.1, Node 22, `iptables` 1.8 on the nftables backend).
Other distributions work if they meet the requirements below.

**What has been run.** On that host, with the gateway running as root and the system Docker: the
image build, chats, the resume across a restart, the network policy, the memory and process limits,
the file API, two of the three MCP tool servers in a container, and the data migration from the
bubblewrap version on a copy of real data. **What has not:** the dedicated-user and rootless-Docker
setups in sections 2 and 6, which follow the same code paths except for the network policy. Do
section 9's checks once after deploying, whichever way you run it.

## Quick path: `deploy.sh`

On a Linux host that already has Docker, `deploy.sh` does sections 1 to 6 below for you. Clone or copy
the repository, then run it from there:

```bash
git clone https://github.com/ALange/Piper.git ~/piper && cd ~/piper
./deploy.sh --install-node                       # checks the host, installs Node and Pi, builds the image, starts it
```

It is safe to run again: what is already in place is left alone, and the image is rebuilt only when
Pi's version changed. It never asks questions; `--dry-run` prints what it would do and changes
nothing. The options you are most likely to want:

```bash
DASHBOARD_PASSWORD='a-long-one' ./deploy.sh --install-node --host 0.0.0.0    # expose it, with a password from the start
sudo ./deploy.sh --systemd --run-as piper --create-user --install-node       # a service, as its own user
sudo ./deploy.sh --systemd --backups                                          # ... and a daily backup timer
./deploy.sh --systemd --print-unit                                            # just show the unit it would install
```

What it does, in order: checks Linux, Docker (24+ and answering), `iptables` and free disk; with
`--run-as` creates the user, adds it to the `docker` group and hands it the folder; finds Node 22.19+
(or installs it under `~/.local/node` with `--install-node`, checking the download's SHA-256);
installs Pi with that Node's `npm`; runs the unit tests; builds the chat image; seeds `--host`,
`--port` and `DASHBOARD_PASSWORD` on the first start; then starts the gateway with `piper.sh`, or
installs and starts a systemd unit with `--systemd` (plus a watchdog timer that alerts when the gateway
stops answering, and with `--backups` a daily backup timer); and finally runs `./piper.sh doctor`.

What it does not do: install Docker (that choice, rootless or not, is yours: section 2), log Pi in
(run `pi` and `/login`), or set up TLS in front. `--host`, `--port` and the password only apply the
first time the gateway creates its database; after that they are edited on the dashboard, and it says
so if you pass them anyway. It puts the password in the database by running the gateway once, never
in the systemd unit, because a password in the environment replaces the stored one on every start.

It has been run on the reference host (Debian 13) in dry-run mode and for real up to the start,
with the failure cases (no Docker, Docker not answering, Node too old, bad options) checked, and the
Node download's checksum logic and the generated unit checked separately. It has **not** been run on
a machine that started without Node, Pi or the image, so expect to read its output the first time.

## 1. What the host needs

| Need | Minimum | Why |
| --- | --- | --- |
| Docker Engine | 24 | Every chat runs in its own container. Debian's `docker.io` or Docker's own packages both work. |
| `iptables` | any 1.8 | The network policy is a few firewall rules in `INPUT` and `DOCKER-USER`. Without them chats refuse to start on the default policy (use `none` or `open` instead). |
| Node.js | 22.19 | The gateway itself. Containers carry their own Node. |
| Pi | installed with that Node's `npm`, and logged in | The gateway holds its credentials and runs the models it has keys for. The image gets the same version. |
| Disk | a few GB | The image is about 1.9 GB with all the tools; each chat's container adds what the agent installs in it. |
| systemd | optional | For running the gateway as a service. |

Check the host before going further:

```bash
docker version --format '{{.Server.Version}}'      # 24 or newer
docker run --rm hello-world | head -2               # the daemon works
iptables --version                                  # present
node -v                                             # v22.19 or newer
```

## 2. Create a dedicated user

The gateway needs to talk to Docker, and **access to the Docker socket is root-equivalent**: whoever
can start a container can mount the host's `/` into one. Two setups, in order of preference:

**Rootless Docker (recommended, not yet run with Piper).** The daemon and every container run as an
unprivileged user, so "root in a container" is only that user on the host, and a container escape is
not a host takeover. Follow Docker's own guide for your distribution
(<https://docs.docker.com/engine/security/rootless/>), as the `piper` user, with linger enabled so
its services survive logout, and point the gateway at that daemon with `DOCKER_HOST`
(`unix:///run/user/<uid>/docker.sock`).

Rootless Docker does its own networking, which does not pass through the host's `iptables`, so
Piper's network policy has nothing to act on there. **With rootless Docker use `CONTAINER_NETWORK=none`
or `open`**, and put a firewall of your own in front if you choose `open`. Models the containers'
Pi calls directly (section 8) need `open`; models served through the bridge work in every mode.

**A dedicated user in the `docker` group, or `userns-remap`.** Simpler, and the network policy works.
With `"userns-remap": "default"` in `/etc/docker/daemon.json`, container root maps to an unprivileged
host uid, which gives most of what rootless gives, and the files a container writes into a workspace
are owned by that mapped uid (mind that when you back them up or edit them).

```bash
sudo apt-get install -y docker.io iptables git
sudo useradd --create-home --shell /bin/bash --groups docker piper
sudo loginctl enable-linger piper
sudo -iu piper
```

**As root** works, and is how the reference host runs; the gateway logs a warning. Everything below
runs **as `piper`** unless marked otherwise.

## 3. Install Node.js and Pi

Any Node 22.19+ works. Pi must be installed with **the same Node's `npm`**, because the gateway finds
it with `npm root -g` and builds the image from that version.

```bash
# Node, e.g. the official tarball (or nvm, or your distribution's nodejs 22 package)
mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C ~/.local/node
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && . ~/.bashrc

# Pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi          # then type /login and sign in to your model provider(s); /quit when done
```

Pi keeps the credentials in `~/.pi/agent/auth.json`. The gateway reads them, and no container ever
sees them: model calls go through the gateway. `deploy.sh` finds an existing Pi on its own (in this
order: `PI_AGENT_PACKAGE`, the gateway's own setting, the `pi` command on the PATH, `npm root -g`, then
the usual nvm/fnm/asdf/volta folders) and uses that path for the tests, the image build and the gateway;
when `npm root -g` does not lead to it, it stores the path as the `PI_AGENT_PACKAGE` setting. By hand, set
`PI_AGENT_PACKAGE` to Pi's package directory.

## 4. Install Piper and build the image

```bash
git clone https://github.com/ALange/Piper.git ~/piper && cd ~/piper
# or copy the whole repository there; the gateway needs server.mjs, lib/, dashboard.html,
# piper-bridge.mjs, piper-profile.mjs, docker/ and package.json
node test.mjs                            # the unit tests; no Docker, and they touch only scratch paths
./piper.sh image                         # builds piper-agent, pinned to your Pi version (a few minutes)
./piper.sh doctor                        # Docker up, image built and current
```

`./piper.sh image` passes extra options to `docker build`: leave the heavy toolchains out with
`--build-arg WITH_RUST=0 --build-arg WITH_JAVA_TOOLS=0`, or put tools in by editing `docker/Dockerfile`.
Rebuild it whenever you update Pi; the gateway warns at start and on the dashboard when the versions
differ.

There is nothing to `npm install`: the gateway uses only Node's standard library and the Pi package.

At runtime it creates these next to `server.mjs`. All are owner-only, and all should be backed up
except the last two:

| Path | Holds |
| --- | --- |
| `gateway.db` | settings, API key hashes, dashboard password hash, spend ledger, resumable chats |
| `profiles/` | each API key's own skills, extensions, prompts and settings |
| `workspaces/` | each API key's workspace (`/workspace` in its chats) |
| `shared/` | the shared bundles you hand out (`shared/base/…`) |
| `container-pi/` | the Pi config for containers: `models.json` **with the keys of the models you configured**, and `settings.json` |
| `workspaces-archive/` | reset profiles, and workspaces from before containers, until `ARCHIVE_TTL_MS` |
| `workspaces-chats/` | each chat's Pi session files (needed to resume it) |
| `backups/` | archives made by `./piper.sh backup`, owner-only (they hold the database and an API key) |
| `.watchdog-state` | the watchdog's memory of whether it has already said the gateway is down |
| `workspaces-run/` | per-chat bridge sockets (transient) |

Docker itself holds the chats' containers (`docker ps -a --filter label=piper.managed=1`); they are
recreated when needed and are not worth backing up.

## 5. First start and settings

Every setting lives in `gateway.db` and is edited on the dashboard. An environment variable only
**seeds** a setting the first time the gateway starts. Two exceptions: `GATEWAY_DB` (where the
database is) and `DASHBOARD_PASSWORD`, which replaces the stored password hash on every start.

For the first start, pass what you want to begin with. For example, behind a reverse proxy on the
same host:

```bash
HOST=127.0.0.1 PORT=8787 DASHBOARD_PASSWORD='choose-a-long-one' node server.mjs
```

The startup lines tell you what is in force. Check them:

```text
Piper on http://127.0.0.1:8787  auth=off  dashboard=password  image=piper-agent  network=internet  limits=2048MB/2cpu/512pids  db=…
containers: docker 26.1.5, image piper-agent (Pi 0.99.1), network internet, allowed: 192.168.1.1:53/udp+tcp
```

- `network=internet`: containers reach the internet only. `open` is worth a second look, and `none`
  means no network at all.
- `containers: …` says whether Docker answers, the image exists and its Pi matches yours, and what
  private-network endpoints the firewall lets through (your DNS servers, and the endpoints of models
  you configured for containers). A line that starts `containers:` and names a problem means chats
  will answer `503` until it is fixed; the message says how.
- `user=ROOT` appears only if you run it as root.

Stop it with Ctrl+C, then unset `DASHBOARD_PASSWORD` so it isn't reset on every start.

To keep it running in the background without a service, `piper.sh` starts, stops and restarts the
gateway from its folder, logging to `gw.log`:

```bash
./piper.sh            # restart (the default); open chats' containers are stopped and resume
./piper.sh start | stop | status | logs | image [env] | doctor | backup | restore FILE
```

It finds the gateway as the `node server.mjs` process running from that folder with that folder's own
database (a test copy started with another `GATEWAY_DB` is left alone), stops it with `SIGTERM`
(then `SIGKILL` after `STOP_WAIT` seconds, default 20), and waits for `/health` before reporting it
started. Use it or the service below, not both.

## 6. Run it as a service

As a **systemd user service** of `piper` (with `DOCKER_HOST` set if you use rootless Docker):

```ini
# ~/.config/systemd/user/piper.service
[Unit]
Description=Piper - OpenAI-compatible gateway for Pi
After=network-online.target

[Service]
WorkingDirectory=%h/piper
# sbin too: iptables lives in /usr/sbin, and without it the network policy cannot be enforced
Environment=PATH=%h/.local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Rootless Docker only:
# Environment=DOCKER_HOST=unix:///run/user/%U/docker.sock
ExecStart=%h/.local/node/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now piper
journalctl --user -u piper -f            # the startup lines and the access log
```

`PATH` must include the Node that Pi was installed with, because the gateway runs `npm root -g` to
find Pi. If you run it as **root** instead, use a system unit in `/etc/systemd/system/piper.service`
(and order it `After=docker.service`).

Restarting the service does not lose open chats. On `SIGTERM` (what `systemctl stop` sends) the
gateway stops accepting connections, records every agent's spend, asks each Pi to exit and stops each
chat's container; the next message to a chat starts the same container and resumes the same agent
from its session files. Keep the default `TimeoutStopSec`: it needs up to ten seconds. A gateway that
is killed instead leaves its containers running; the next start stops them.

`./deploy.sh --systemd` writes a *system* unit instead of the user unit above (it needs root, runs as the
user you name with `--run-as`, and is ordered after `docker.service`), and `./piper.sh` then starts, stops,
restarts and shows the logs of that unit rather than starting a second copy that would fight it for the port.

### Backups, alerts and the watchdog

- **Backups.** `./piper.sh backup` writes one owner-only archive of the database, profiles, workspaces,
  shared bundles, container Pi config and chat sessions to `./backups` (`--keep N` keeps the newest N; it
  refuses to fill the disk). `./piper.sh restore FILE` puts one back, moving what it replaces aside and
  never deleting it, and works onto a host with a different folder. Take one before every upgrade.
  `deploy.sh --systemd --backups` adds a daily timer (03:30, keeps 7); check it with
  `systemctl list-timers piper-backup.timer`. Copy the archives off the machine: they are only as safe as
  its disk.
- **Alerts.** Set a webhook under Settings → Containers → Disk and alerts and press **send a test alert**.
  You are told when Docker or the network policy fails (and recovers), the disk Docker uses runs low
  (below 5 GB free by default), a container is killed for memory, or one grows past its disk warning.
- **The watchdog.** `deploy.sh --systemd` also installs a timer that asks the gateway `/health` every
  minute and sends an alert, through the same webhook, when it has not answered twice in a row, and when
  it does again. Without a webhook it does nothing. Check it with `systemctl list-timers piper-watchdog.timer`.
- **A dashboard password matters more now.** The Containers page's command box (root in a container)
  refuses to work until one is set, and the rest of an open dashboard can be used by anyone who reaches
  it: set one (Settings → Access), and bind to `127.0.0.1` behind a proxy.

## 7. Expose it safely

- **Bind to `127.0.0.1` and put a TLS reverse proxy in front** (Caddy, nginx) for anything beyond
  this machine. Send `X-Forwarded-Proto: https`, so the dashboard's sign-in cookie is marked
  `Secure`. Streaming responses must not be buffered. With nginx:
  `proxy_buffering off;` and `proxy_read_timeout 1h;`. For uploads to the workspace file API,
  also raise `client_max_body_size` to `FILE_UPLOAD_MAX_BYTES` (1 GiB by default) and set
  `proxy_request_buffering off;`. **The dashboard's Terminal is a WebSocket**, so the proxy must pass upgrades:
  with nginx `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
  (with `proxy_read_timeout 1h;` as above), and either keep the `Host` header or send `X-Forwarded-Host`: the gateway
  refuses a terminal whose `Origin` is not its own host. Caddy does this by default. **The live view is a Server-Sent Events stream** (`/dashboard/session/…/events`), so with nginx also `proxy_buffering off;` there (the gateway sends `X-Accel-Buffering: no`).
- **Set a dashboard password** (Settings → Access), unless you did at first start. On the default
  network containers cannot reach the dashboard; on `open` they can, and an open dashboard can
  reconfigure everything.
- **Create an API key per person or client** on API Management. While any key exists, `/v1/*`
  requires one.

Point clients at `https://your-host/v1` with that key. For example, in Open WebUI add an OpenAI
connection with that URL and key; the model list comes from `/v1/models`.

## 8. Models, tools and skills for agents

- **Models.** Two kinds, and a chat can use both.
  - **Models the gateway holds keys for** (your `~/.pi/agent`, logged in) need nothing more: they
    reach the container over the bridge, and no key enters it.
  - **Models the containers' Pi calls directly** (a local model server, say) go in Settings →
    Containers → *Pi config for containers*, as a `models.json`. The endpoint is opened in the
    firewall for you. The provider's key is stored in `container-pi/models.json` (mode `0600`) and
    is readable inside every container, so give the model server a key meant for it, and one per API
    key if you want to limit usage there.
- **Tools.** The image has the common ones. For anything else, either add it to `docker/Dockerfile`
  and `./piper.sh image` (reproducible, portable), or share its folder read-only with Settings →
  Containers → *Host folders to share* (`CONTAINER_MOUNTS`). A shared folder has to work against the
  image's Debian: a Python venv is fine when the image has the same Python; a binary that needs
  libraries from your host's `/usr/local` is not.
  - Follow symlinks: a tool that links into `/somewhere/else` needs that folder shared too.
  - Tools that must be told where they live get variables under *Extra environment variables*
    (`CONTAINER_ENV`), e.g. `RUSTUP_HOME=/usr/local/rustup`.
  - The gateway refuses to share `/`, its own folders, your `~/.pi/agent`, `/proc`, `/sys`, `/dev`,
    or a container engine socket.
- **Skills, extensions and prompts for everyone** go in a shared bundle:
  `shared/base/{skills,extensions,prompts}`.
  - Every key gets `base` by default. Grant other bundles per key on API Management.
  - An extension that starts a program by an absolute host path needs that path shared or in the image.
- **Network** is the internet only. Settings → Containers → *Network* switches it to none, or to
  open (also this machine and your LAN, which includes the dashboard: set a password first).

After changing any of these, new chats pick it up; an existing chat's container is recreated on its
next message when a mount, the image or a limit changed (what the agent installed in it is lost, its
workspace, profile and session are not). For bundle contents, open chats pick it up on `/reload`.
The dashboard's Profiles page shows what each key's agents actually get.

## 9. Check the containers

Create a key, then ask an agent to run a probe:

```bash
KEY=piper_…   # from API Management
curl -s http://127.0.0.1:8787/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model":"pi","messages":[{"role":"user","content":
  "Run with bash and reply with only the raw output: id -un; pwd; ls /var/run/docker.sock /home/piper/piper/gateway.db 2>&1; curl -s -m 5 -o /dev/null -w \"%{http_code}\\n\" https://example.com; curl -s -m 4 -o /dev/null -w \"%{http_code}\\n\" http://192.168.1.1/"}]}' \
  | jq -r '.choices[0].message.content'
```

Change `/home/piper/piper/gateway.db` to where your gateway's database is, and `192.168.1.1` to an
address of your own LAN. Expected with `CONTAINER_NETWORK=internet`:
- `root`, and `/workspace`;
- `No such file or directory` for both the engine socket and the database (and for any other host
  folder you did not share with `CONTAINER_MOUNTS`);
- `200` for the internet and `000` (blocked) for the LAN address.

And on the host:

```bash
docker ps --filter label=piper.managed=1               # one container per open chat
./piper.sh doctor                                       # the same checks, plus the firewall
sudo iptables -S DOCKER-USER | grep piper               # the rules, tagged with the gateway's id
```

Anything else means the containers are not what this guide describes.

## 10. Upgrading

- **Piper:** `git pull` (or replace the repository files, `lib/` and `docker/` included), run
  `node test.mjs`, rebuild the image if `docker/` changed (`./piper.sh image`), restart the service.
  Open chats resume; a chat whose image or mounts changed gets a fresh container.
  `gateway.db`, `profiles/`, `workspaces/`, `shared/` and `container-pi/` carry over.
- **Pi:** `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<version>` with the same
  Node, `./piper.sh image` to rebuild the image with it, then restart.
- **From the bubblewrap version:** see "Upgrading from the bubblewrap version" in the README. The
  first start moves each key's old shared folder to its workspace, archives the old per-chat
  workspaces, and resets stored chats once; settings are renamed with their values; the folders
  you had in `SANDBOX_ALLOW` become `CONTAINER_MOUNTS` (or go into the image).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Chats fail with 503 `the chat's container failed to start` | Read the reason in it. Usual causes: Docker is not running or the gateway's user cannot reach its socket; the image is not built (`./piper.sh image`); the network policy cannot be enforced (see below). The dashboard's red banner and `./piper.sh doctor` say the same. |
| 503 `the network policy "internet" cannot be enforced` | `iptables` is missing or the gateway's user may not change the firewall. Install `iptables` and run as root or with `CAP_NET_ADMIN`, or set `CONTAINER_NETWORK` to `none` or `open`. Rootless Docker needs one of those two. |
| Warning: the image has Pi X but the gateway runs Pi Y | Pi was updated after the image was built. `./piper.sh image`, then restart. |
| A container cannot resolve names (`apt` and `pip` hang) | Your DNS server is on a private address that was not allowed. The gateway allows the ones in `/etc/resolv.conf`; if you use another, add it as `host:53` in *Extra private endpoints* (`CONTAINER_ALLOW`). |
| A model at a private address is unreachable from a container | Add it to *Pi config for containers* (its endpoint is then allowed automatically), or to `CONTAINER_ALLOW`. |
| A tool works on the host but not for agents | It is not in the image. Add it to `docker/Dockerfile`, or share its folder with `CONTAINER_MOUNTS`. |
| An agent's `apt install` is gone after a change | The container was recreated because its image, mounts, limits or network changed. Put lasting tools in the image or the workspace. |
| Files in a workspace are owned by an odd uid | Container root is mapped (rootless or `userns-remap`). Expected. |
| Replies say `[model error: …]` | The provider call failed. For bridged models, check `pi` works for the service user and that `/login` was done as that user; for direct models, check the endpoint and key in *Pi config for containers*. |
| Dashboard reachable by anyone | Set a password (Settings → Access), and bind to `127.0.0.1` behind a proxy. |
| `firewall: NOT ENFORCED` right after installing the service, with `spawn iptables ENOENT` in the log | The service's `PATH` lacks `/usr/sbin`. The units `deploy.sh` writes have it, and the gateway also looks in the standard sbin folders itself; a hand-written unit needs `/usr/sbin` in `Environment=PATH=`. |
| The Containers page's command box is greyed out | No dashboard password is set. Set one under Settings → Access; the box refuses until then, by design. |
| A red "Disk is nearly full" banner | Less than `DISK_FREE_WARN_MB` is free where Docker keeps its data. Prune old images, clear Docker's build cache (`docker builder prune -f`: every image build leaves gigabytes of it, and it is only a speed-up), recreate the containers with the biggest disk on the Containers page, delete old `*.before-restore-*` and archive folders, or move Docker's data to a bigger disk. |
| Restarting the gateway with `./piper.sh` says it stops "the systemd unit" | A unit named `piper` runs this folder's gateway, so `piper.sh` uses it. Use `systemctl` or `piper.sh` (not a hand-started `node server.mjs`). |
| A key on `network: none` gets `[model error: … Connection error]` | The model is one you configured for containers, which Pi calls directly, and there is no network. Use a model the gateway serves, or another network for that key. |

## Agent endpoints and the firewall

Every agent created on the Endpoints page listens on a port of its own on `HOST` (the same address as the
gateway). Set `AGENT_PORT_RANGE` (Settings → Containers, e.g. `20000-29999`) before creating them, so the
ports come from a range you can open in the firewall on purpose; leave `HOST` on `127.0.0.1` and put a
TLS proxy in front if the gateway should not be reachable directly. An agent's port serves only the API
and only for the key it belongs to, but it is still a listening socket: treat it like the gateway's own.

## The audit log and updating the host Pi

The audit log lives in `gateway.db` (table `audit`), so `./piper.sh backup` includes it; it is bounded by
Settings → Audit (90 days and 50,000 rows by default). `piper-backup.mjs` and the watchdog do not write to it.

The dashboard can update the Pi the gateway runs on (Containers page, *Pi on this host*), but only when a
dashboard password is set and the install is the one the gateway's own `npm root -g` manages and its user can
write. The gateway keeps running the old Pi until restarted (`./piper.sh restart`, or `systemctl restart piper`):
do that, then rebuild the image (`./piper.sh image`, or the Images panel) and Update the containers.
