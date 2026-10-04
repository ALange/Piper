# Piper

**An OpenAI-compatible HTTP gateway in front of the [Pi](https://pi.dev) coding agent.**

![The Piper dashboard: live agents, model usage, spend and the limits in force](docs/dashboard-overview.png)

Point any OpenAI client — Continue, Cursor, an SDK, `curl` — at this, and Pi answers with its
full agent behind it: its tools, your project context, its skills.

```text
OpenAI client ──HTTP──▶ Piper ──RPC──▶ pi --mode rpc   (one Docker container per conversation; Pi has full rights in it)
                          ▲                 │ the API key's workspace · its own profile of skills, extensions
                          │                 │ and settings · internet only, not your machine or LAN
                          └── model calls ──┘ over a per-chat socket for models Piper holds keys for;
                                              models you configure for containers are called directly
```

## Why

Pi is a terminal agent. Its shell, file tools, context files, skills and session memory live in
the CLI. This puts an OpenAI-compatible HTTP surface in front of it without giving any of that up,
and adds the three things a gateway that more than one caller can reach actually needs:

- **Session isolation** — one agent per conversation, never shared, each in its own container.
- **Docker as the sandbox** — Pi inside is a stock install with full rights: root, a writable
  filesystem, `apt`, `pip`, a network. Piper does not try to restrict what it does in there; it
  decides what the container can *reach*: the API key's own workspace and profile, the internet
  but not your machine or LAN, and a memory, process and CPU ceiling.
- **User control without a shared Pi** — every API key has its own profile of skills, extensions,
  prompts and settings, which its agent can edit and `/reload`, and which no other key sees.
- **Operational control** — a dashboard, settings that live in a database, model fallback, and an
  access log.

It is deliberately small: a handful of plain modules, a plain HTML dashboard, no build step, and no
runtime dependencies beyond Node's standard library, the Pi package you already have, and Docker.

## Features

- **OpenAI-compatible** — `POST /v1/chat/completions` (streaming and non-streaming) and
  `GET /v1/models`, so clients that know nothing about Pi work unmodified.
- **One agent per conversation** — with session identity you don't have to configure: send
  `X-Session-Id` to pin one, or omit it and the gateway derives a stable key.
- **A Docker container per conversation** — Pi, its tools and its extensions all run inside it, as
  a stock Pi with full rights. The container reaches its key's workspace and profile, the internet,
  and nothing else of your machine. Models the gateway holds keys for are served over a socket
  only that container can reach, so those keys never enter it.
- **A profile per API key** — skills, extensions, prompts, `AGENTS.md` and settings that persist
  across that key's chats. The agent can create a skill or install an extension, `/reload`, and use
  it; another key never sees it.
- **Chats survive restarts** — a chat's container is stopped, not removed, and its Pi session is
  kept, so a restart, an eviction or a crash resumes the same agent with its context and its
  installed packages rather than replaying the transcript into a new one.
- **One workspace per API key** — every chat of a key works in the same `/workspace`, which
  outlives any chat.
- **A Containers page** — every container with its key, state, live CPU, memory and disk, buttons to
  stop, recreate or remove one, a box to run a command in it (only once a dashboard password is set),
  and an audit trail.
- **Per-key container settings** — memory, CPU, processes, network, image, extra mounts and
  environment for one key, over the defaults, like the per-key limits that already existed.
- **Resource usage on the Overview** — host CPU, memory, load and disk, the gateway process, and the containers
  added up (with the heaviest named), with a short history, read cheaply from `/proc`, Docker's cached stats and
  the disk guard.
- **Terminal and file browser** — an interactive root shell in a running container (full-screen programs, resize,
  idle timeout, audited, never recording keystrokes) and a browser for a key's or agent's workspace and profile with
  upload, rename, delete and a conflict-safe text editor.
- **Live view, jobs, templates, hand-offs and teams** — watch a running chat live (with interrupt and a transcript), run
  agents on a schedule, by webhook or through an async API, start agents from templates (clone, export, import), let agents
  hand work to each other, chain them into a team endpoint, install Pi packages and MCP servers from the dashboard, and edit
  shared bundles in the browser. See Help → Documentation for each.
- **Model speed** — each running agent's average generation and prompt-processing speed (tokens per second) in
  the Live chats table, and per-model charts of both on the Overview, from timing every model call's event stream.
- **Documentation and About** — an administrator's handbook inside the dashboard (architecture, operations, every setting
  generated from the code, API, security, troubleshooting), with search; release notes, version and author.
- **Pi versions at a glance** — the Containers and Live chats pages show the Pi version each container and live agent
  runs, green when it matches the gateway's and red when behind.
- **Audit log and host Pi update** — an Audit page whose recorded categories, retention and row cap are set under
  Settings → Audit, and a panel that updates the Pi the gateway runs on and its extensions.
- **Agent endpoints** — named permanent agents of a key (architect, coder, researcher), each with its own
  instructions, profile, container and OpenAI-compatible port.
- **Persistent keys** — one container per key, shared by its chats and kept between them, so packages
  and tools the agent installs survive new sessions, reloads and restarts.
- **Several images** — a full environment and a slim one out of the box, more by adding a folder;
  build, rebuild and prune them from the dashboard.
- **Idle chats stop, they do not vanish** — an idle chat's container is stopped (freeing its memory)
  and kept; only a chat unused for a month, or a one-off request, ends.
- **Alerts and a watchdog** — a webhook is told when Docker is unreachable, the firewall rules are
  missing, the disk is low, a container is killed for memory, or the gateway stops answering.
- **Backup and restore** — `./piper.sh backup` and `restore`, and a daily timer if you want one.
- **Starts at boot** — `deploy.sh --systemd` installs the service, so a reboot does not take it down.
- **Models for containers** — configure the models the containers' Pi calls directly (your local
  endpoint) on the dashboard, separately from your own `~/.pi/agent`.
- **Tool activity in the reasoning stream**, optional — when switched on, each command and file the
  agent touches appears as `▸ bash: ls -la` in `reasoning_content`, which clients such as Open
  WebUI show as "Thinking".
- **Per-key model allow-list** — limit a key to `local-openai/*` or a handful of models; every
  way of choosing a model honours it.
- **A file API for the workspace** — upload, download, list and delete a key's files over HTTP or
  from the dashboard.
- **Status dashboard** — live agents, their models, when each will be reaped, the model catalogue,
  and an editable settings page. No framework, no CDN.
- **A password on the dashboard** — salted and scrypt-hashed in the database, set or changed from
  the Access Control tab. `GATEWAY_API_KEY` keeps working, so existing scripts are unaffected.
- **Settings in SQLite rather than environment variables**, editable from the dashboard and applied
  without a restart where possible.
- **Model fallback** — when the active model runs out of credit or stops responding, the turn is
  retried once on a configured model and the switch is announced inline in the reply.
- **Reasoning passthrough** — the model's thinking is forwarded as `reasoning_content`, kept out of
  `content` so clients that ignore it are unaffected.
- **Cost tracking** — per-session spend from Pi's own token accounting, plus a ledger in
  `gateway.db` so totals survive a restart, broken down by model — per call, even when a chat
  switches models — and by day.
- **Multiple API keys** — named, optionally expiring, revocable, and each shown only once because
  only a hash is kept. Every request is attributed to the key that made it, with a per-key usage
  report by model and by day.
- **Images**, multi-part content, `reasoning_effort`, and per-request model selection.
- **No npm dependencies** — Node built-ins plus the installed Pi package. Nothing to `npm install`;
  the only build is the container image (`./piper.sh image`).

## Requirements

| | |
| --- | --- |
| Node.js | 22.19 or newer |
| Pi | installed and logged in — `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then run `pi` and `/login` |
| Docker Engine | 24 or newer, with `iptables` on the host (the network policy is a set of firewall rules). Build the chat image with `./piper.sh image`. Without Docker, chats **fail to start** with a message saying so; the dashboard stays up. |
| A dedicated user | recommended, with rootless Docker if you can: being in the `docker` group is root-equivalent, and the container is root inside. See [DEPLOYMENT.md](DEPLOYMENT.md). |

## Quick start

Setting it up on a new machine, as a service, behind a proxy: see [DEPLOYMENT.md](DEPLOYMENT.md), or on a
host that already has Docker just run `./deploy.sh --install-node`.

```bash
./piper.sh image        # once: build the chat image, pinned to your Pi version
node server.mjs
# Piper on http://127.0.0.1:8787  auth=off  dashboard=open  image=piper-agent  network=internet  limits=2048MB/2cpu/512pids  db=.../gateway.db
# containers: docker 26.1.5, image piper-agent (Pi 0.99.1), network internet, allowed: ...
```

Non-streaming:

```bash
curl -s localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"pi","messages":[{"role":"user","content":"List the files here and summarise the project."}]}'
```

Streaming:

```bash
curl -N localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"pi","stream":true,"messages":[{"role":"user","content":"Write a haiku about gateways."}]}'
```

Dashboard: <http://localhost:8787/dashboard>

Credentials come from your normal Pi configuration, so run this as the user whose Pi is set up.

## How it works

### One agent per session

A session controller owns one Pi per session id, each in its own container with its own context and
tool loop. Agents are never shared between ids — that is the point.

Session identity resolves in this order:

1. **`X-Session-Id`** (`session_id`, `X-Conversation-Id` and `conversation_id` work as aliases) —
   if the client sends one.
2. **Derived** from a hash of the client (address, user agent, `user`) plus the **first user
   message**. That is stable across the turns of one chat for any client that replays its
   transcript, so continuity needs no client changes at all.
3. **Minted** as a random UUID, returned in the `X-Session-Id` response header.

Only the **new** user turn is forwarded, because Pi already holds the earlier ones — so don't
resend the transcript on Pi's behalf. A chat whose agent was stopped (a restart, an eviction, a
crash) **resumes** it, as described next. Only a chat with nothing to resume — the first request, an
expired or ended one, or a derived key that changed — has the client's earlier turns replayed as a
framed transcript ahead of the newest question, so it never silently loses the conversation.

### Containers

Each chat gets one container, named `piper-<instance>-<chat>`, created from `CONTAINER_IMAGE` the
first time the chat speaks and kept until the chat ends. Pi runs in it through `docker exec`, in Pi's
RPC mode, so the gateway drives it over the exec's stdin and stdout.

```text
gateway ── docker exec -i ─────────────▶  pi --mode rpc          (root, in the container)
model bridge  <run>/<chat>/  ──────────▶  /run/piper/bridge.sock  model calls only, metered, allow-listed
workspaces/<key>/            read-write ▶ /workspace             shared by every chat of the key
profiles/<key>/              read-write ▶ /profile               skills, extensions, settings, config/
shared/<bundle>/             read-only ─▶ /shared/<bundle>
CONTAINER_MOUNTS             read-only ─▶ the same path
<chat state>/session         read-write ▶ /piper/session         Pi's session files for this chat
```

**Inside, Pi has full rights.** It is root, its filesystem is writable, and `apt-get install`,
`pip install` and `npm i -g` work. That is deliberate: the container *is* the sandbox, so Piper does
not restrict what the agent does in it. What it cannot do is reach beyond it. The container has
Docker's default capabilities and nothing more (no `--privileged`, no engine socket, no host
namespaces), `no-new-privileges` and Docker's default seccomp profile, and sees only the mounts above.
What the agent installs stays in *this chat's* container: another chat, even of the same key, does
not see it.

**Stopped, not lost.** Stopping an agent is not the same as ending a chat:

| | What happens | When |
| --- | --- | --- |
| **Stop** | Pi is asked to exit, its spend is recorded, and the container is *stopped*; the container, the chat's row and its Pi session all stay | idle for `SESSION_IDLE_MS`, running for `SESSION_MAX_LIFETIME_MS`, shutdown (`SIGTERM`/`SIGINT`), LRU eviction, a crashed agent, a profile reset or lock, the **stop** button |
| **End** | the container is *removed* with the chat's state and its row; the key's workspace stays | a one-off request (used once, then quiet, `ONE_SHOT_TTL_MS`), a stopped chat unused for `CHAT_KEEP_MS`, the **remove** button, a dashboard kill |

The next message to a stopped chat starts the same container and runs Pi in it with `--continue`:
the agent has its context, its model choice, its installed packages and its files back, and nothing
is replayed. So a chat that goes quiet overnight costs only disk until it is next used, and its
installs are there in the morning. A stopped chat is kept for `CHAT_KEEP_MS` after its last message
(30 days by default; `0` keeps it for ever), and then ended.

`SESSION_MAX_LIFETIME_MS` is how long one Pi process runs before it is stopped and restarted on the
next message, counted from when *that process* started, so a chat resumed after a month is not
stopped again the moment it wakes. It is not a limit on how long a chat lives.

The session id itself is a bearer secret and is stored only as a SHA-256 hash, in the `chats` table
of `gateway.db`. On shutdown the gateway stops accepting connections, stops every agent and exits
within ten seconds; anything that overruns is stopped by the next start's sweep.

**A container is recreated when what it was built with changes.** Mounts and limits are fixed when a
container is created, so each carries a *signature*: the image, whether the profile and workspace are
writable, the granted bundles, the mounts, the limits, the network (by name), the image (by id). If the
signature has changed when a chat resumes (you rebuilt the image, edited a setting or a key's own
settings, a profile was locked), the container is replaced. Changing a *key's* container settings
stops that key's running chats at once, so each resumes into a container built from the new ones. The chat's Pi session, workspace and profile are untouched; what the agent
installed in the old container is lost, and the log says so.

**Sweeps.** At start and every ten minutes the gateway reconciles Docker with its records: a running
container that no live chat owns is stopped (left behind by a gateway that was killed), one that
belongs to no chat is removed, and chat folders with no chat are deleted. Only this gateway's
containers and folders are touched (they carry an id derived from its database), so a second gateway
on the same Docker, such as a test copy, is left alone. Archives older than `ARCHIVE_TTL_MS` are
deleted too.

### Images

An **environment** is a folder with a Dockerfile, and each builds to an image tagged after it:

| Environment | Where | Image | What is in it |
| --- | --- | --- | --- |
| `full` | `docker/Dockerfile` | `piper-agent` | Pi at your gateway's version, `git`, `ripgrep`, `curl`, `jq`, Python 3 with `pip` and `venv`, a C toolchain, `binwalk`, Java and `jadx`, a minimal Rust toolchain and `bun` (on `node:22-trixie-slim`) |
| `slim` | `docker/environments/slim/Dockerfile` | `piper-agent-slim` | Pi, `git`, `ripgrep`, `curl`, `jq`, Python 3: no compilers, Java, Rust or bun |
| yours | `docker/environments/<name>/Dockerfile` | `piper-agent-<name>` | whatever you put in it |

`CONTAINER_IMAGE` is the default image (`piper-agent`); a key can use another in its own container
settings. Build one with `./piper.sh image [env]` (Pi is pinned to the version installed on the host;
`--build-arg WITH_RUST=0 --build-arg WITH_JAVA_TOOLS=0` leave the heavy parts of `full` out), or with
**Build** in the Images section of the Containers page, which runs the build in the background and
shows its output. Every image carries the labels `piper.image=1` and `piper.pi-version`, which is how
Piper recognises its own: a key can only be given an image that has them.

A rebuilt image has a new id, so containers built from the old one are recreated when their chat next
starts (what the agent installed in them is lost; its session, workspace and profile are not). The
Images section says how many containers a rebuild will affect before you do it, and the Containers page
flags the ones behind. Images are only removed when nothing uses them: not the default, not one named by
a key, not one a container is built from; **prune old images** removes the untagged ones a rebuild
leaves behind. At start the gateway compares the default image's Pi version with its own and warns on a
mismatch, and `./piper.sh doctor` prints the same checks. Tools that are not in an image can be shared
from the host, read-only, with `CONTAINER_MOUNTS`.

### Network

`CONTAINER_NETWORK` decides what a container can reach, and a key can choose its own (below):

| Value | A container can reach | Enforced by |
| --- | --- | --- |
| `internet` (default) | the internet; **not** this machine (so not the gateway or its dashboard), **not** your LAN, **not** cloud metadata addresses, **not** other containers | a bridge network `piper` with inter-container traffic off, and firewall rules the gateway installs |
| `none` | nothing | `--network none` |
| `open` | a second network, `piper-open`, with no rules, so also this machine and your LAN | nothing: set a dashboard password first |

The rules are `iptables` rules tagged with the gateway's id: one in `INPUT` (nothing from the
containers to a service on this machine, replies to connections it made excepted) and one per
private range in `DOCKER-USER` (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`,
`127/8`). They are installed at start and re-checked with each health check, a rule someone deleted
is put back, and a stale one is removed. They belong to the `piper` network only, so a chat on `open`
is not cut off by them, and they are installed **when any chat uses `internet`** (the default, or a key's
own choice) and taken away when none does. **If they cannot be installed, chats do not start**: the
gateway answers `503` naming `none` and `open` as the alternatives, rather than run containers
unprotected.

Two things are let through, because a container that cannot use them is useless. Your machine's DNS
resolvers (from `resolv.conf`), on port 53 only, since Docker's resolver forwards from the
container's network and a resolver on your LAN is otherwise cut off. And the endpoints of the models
you configured for containers (below). Anything else on the private network is opened one entry at a
time with `CONTAINER_ALLOW` (`192.168.1.50:4000`). Model calls for models the gateway holds keys for
never use the network: they go over the mounted socket.

### Per-key container settings

Each API key can override, for its own chats: memory, CPU cores, processes (`0` is unlimited, and lifts
a limit as well as lowers it), the network (`internet`, `none`, `open`), the image, and mounts and
environment variables that are *added* to the defaults (a key's mount of the same container path, or
value of the same variable, wins). Blank follows the default. It is set in the key's detail view on the
Files & profiles → Profiles, and the fields show what the key gets now.

- **Saved settings are checked like the global ones.** Mounts and environment go through the same strict
  parsers, an image has to be a Piper image that exists, numbers have to be numbers.
- **A change stops the key's running chats**, and each resumes into a container built from the new
  settings on its next message, with its conversation intact. Saving identical values stops nothing.
- **`none` also cuts off the models you configured for containers**, which Pi calls directly; models the
  gateway serves still work.
- **Mounts cannot reach credentials.** Whatever the source (the global setting or a key's), a mount is
  refused if it is `/`, `/root`, `/home`, `/etc`, `/var` or `/run`, if it is or is inside `.ssh`, `.aws`,
  `.gnupg`, `.kube`, `.docker`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.password-store`,
  `.config/gh` or `.config/gcloud`, or if it holds one of those, or an `id_rsa`/`id_ed25519` key,
  within two levels (deeper is not scanned: share the folder you mean, not its parent).
- Each change is in the audit trail (the fields and their values; environment variables only as a count,
  since they can hold secrets).

### Persistent keys

Tick **persistent container** when creating a key (or later in its detail view) and the key gets **one
container that lasts**, shared by all its chats, instead of one container per chat. A new chat, a reload
or a gateway restart finds it as it was:

- **Everything installed stays.** `apt install tor`, compilers, `pip`/`npm` globals, files in `/root`,
  services the agent left running: they are in the container, which no chat's ending removes. Skills,
  extensions, settings and files already persisted per key (`/profile`, `/workspace`); this adds the
  system to that.
- **One container, several chats.** Each chat still runs its own Pi in it (`docker exec`), with its own
  session folder and bridge socket, so conversations stay separate and ending one never touches another.
- **It keeps running** while the key's chats are idle or stopped, and through gateway restarts (a chat's
  own container is stopped instead). It stops only when you stop it on the Containers page, or the host
  restarts (then it starts again with the next message; background processes do not come back).
- **Changing the key's settings does not cost the installs.** A changed limit, network, mount or bundle
  rebuilds the container, but its state is first saved to an image (`piper-keystate:<name>`) and the new
  container starts from that. If other chats of the key are running, the rebuild waits until none is. A
  rebuilt *image* does not touch it: a persistent container keeps its own system, Pi included, until you
  reset it.
- **Reset** (Recreate on the Containers page, marked ★) deletes the container and its saved state; the
  next chat starts from the clean image. Turning persistence off, or deleting the key, does the same.
- **DNS and hosts are the agent's to change.** Docker rewrites a container's `/etc/resolv.conf`, `hosts` and
  `hostname` at every start, which used to throw away what an agent set (a resolver for Tor, a hosts entry).
  They are now files in the container's state folder, mounted into it: edited in place (`echo >`, `tee`, an
  editor's save) the change stays through stops, restarts and rebuilds. A bind-mounted file cannot be replaced,
  so `sed -i` and `mv` on them fail with "Device or resource busy"; the file's first line says so. Until the
  agent edits `resolv.conf` it follows the host's resolvers. Applies to every container, persistent or not; an
  existing container picks it up when it is next rebuilt.
- **Cost:** what is installed takes disk in the container's writable layer, which the Containers page
  shows per container and the disk guard watches. The network policy still decides what it can reach
  (`internet` by default, so `apt` works).

It is not available to the settings key or the open gateway (there is no key to keep a container for).

### Agent endpoints

An **agent** is a named, permanent Pi of an existing API key with **a port of its own**: one key can front
an `architect`, a `coder` and a `researcher`, each reachable as a separate OpenAI-compatible endpoint.
Create them on the **Agents** page (pick the key, name it, write its instructions) and point any
OpenAI client at `http://<host>:<port>/v1` with the key the agent belongs to.

- **What makes agents differ.** Each has its own **instructions** (written to the agent's `AGENTS.md`,
  which Pi puts in front of every conversation, through the profile helper, never by the gateway on the
  host), its own **profile** (skills, extensions, settings: `/skills`, `/settings` and the profile API work
  on the agent's), an optional **default model** and thinking level (for new chats; a request naming a model
  still wins, within the key's allowed models), and optional **container limits** (memory, CPU, processes,
  network, image, mounts, environment) layered over the key's and the defaults.
- **Always permanent.** An agent uses one persistent container (see Persistent keys): packages it installs,
  files in `/root`, processes left running, all survive new chats, reloads and restarts. Reset it from its
  row or the Containers page (marked ★, shown as `key / agent`) to start clean.
- **Workspace: your choice per agent.** `own` gives it a separate `/workspace`; `shared` mounts the key's
  existing one, so the key's agents see the same files (and can overwrite each other's). It cannot be changed
  afterwards, since it decides where the files are.
- **Who may call the port: only the owning key** (Bearer), nobody else, not even the settings key. No new
  secret; revoking or expiring the key closes every agent of it, and deleting the key deletes them.
- **Only the API is on the port:** `/v1/chat/completions`, `/v1/models`, the agent's own `/v1/piper/profile`
  and `/v1/piper/files`, and `/health`. Never the dashboard or settings.
- **Limits stay on the key.** Session caps, the daily spend cap and the model allow-list count all of a key's
  agents together; spend is recorded against the key. A conversation id on one port never reaches another
  agent or the key's main endpoint.
- **Ports.** Chosen once when the agent is created (any free port, or inside `AGENT_PORT_RANGE`, e.g.
  `20000-29999`, so a firewall can allow just that range) and kept, so the URL survives restarts. If the
  port is taken at start the agent moves to a new one, and that is written to the audit trail and sent as an
  alert. **new port** on the row gives it another on demand; **disable** closes the port and stops its chats
  (container and files stay).
- **Deleting an agent** closes its port, removes its container and saved state, and moves its profile and own
  workspace to the archive (kept `ARCHIVE_TTL_MS`); a workspace shared with the key is never touched.

Each agent opens a port on `HOST`, so on a machine reachable from elsewhere, allow `AGENT_PORT_RANGE` in the
firewall deliberately, or bind `HOST` to localhost and put a TLS reverse proxy in front.

### Updating a container

**Update** (Containers tab row, an agent's row on Agents, **Update container** in a profile's detail, and
**Update all**) rebuilds a container *keeping what is installed in it*, then brings Pi and its extensions up
to date. **Recreate**/**Reset** is the other tool: it throws the container and its installed state away.

What one update does, in order (its log is shown in a panel and stays until closed):
1. stops the chats in it (each resumes on its next message; a container with a request running is skipped);
2. rebuilds it with today's settings (limits, mounts, bundles, DNS/hosts files): its state is saved to an
   image (`piper-keystate:<name>`), the container removed and created again from that. A failed save removes
   nothing. Many updates add many layers, so a saved state over 100 layers is flattened into one, keeping its
   configuration. The free-space check refuses when the disk cannot hold the copy;
3. **Pi** is set to exactly the version the gateway runs (not the newest release: the container's Pi must
   speak the gateway's protocol, so update the host's Pi first to move both), logged as `old -> new`;
4. **`pi update --extensions`** updates the profile's packages. They live in the profile, so they survive any
   rebuild. Skipped, with the reason, when the profile is locked by the operator or is a throwaway copy
   (frozen or over its limit), and steps 3 and 4 are skipped for a container whose network policy is `none`;
5. a chat's own container is stopped again (as between messages); a persistent one keeps running.

A failing step is reported and does not stop the next. **Update all** goes container by container, skipping
any that is busy or belongs to nothing. A newly built `piper-agent` image is *not* picked up by an update (the
saved state carries the old system): use Recreate for that, and accept that installs are lost. Everything is
in the audit trail.

### Updating the Pi the gateway runs on

The **Pi on this host** panel (Containers page) updates the Pi installation the gateway itself runs on, and
the extensions installed for it. It is not about a chat's or a container's Pi (see Updating a container).

- It shows three versions: **running** (what the gateway loaded, and therefore speaks), **installed on disk**,
  and the **newest release** (asked from the npm registry with *check for updates*, cached for ten minutes).
- **Update** runs Pi's own `pi update` and/or `pi update --extensions` with this install's `pi`, from the temp
  folder, online, as the gateway's user, and streams the output to the update panel. The two steps are
  independent; a failing one does not stop the other.
- **Update only.** The gateway loads Pi once, so the new version is what is *installed* but not what is
  *running* until you restart the gateway. The panel says so, and that images and containers follow the running
  version: after restarting, rebuild the image and update the containers. Nothing restarts or rebuilds by itself.
- **Only where it is safe.** The install has to be the one the gateway's own `npm root -g` leads to, and writable
  by the gateway's user; otherwise the panel says why (a custom `PI_AGENT_PACKAGE`, another node, a read-only
  folder) and what to run by hand, and nothing is attempted.
- **Needs a dashboard password.** It installs software from a registry as the gateway's user, which on an open
  dashboard anyone on your network could start, so it is refused (403) until one is set, like the command box.
- The operator's Pi folder holds credentials. The gateway never reads it; `pi` does, as it would if you ran it.

### The Containers page

**Containers** in the sidebar lists every container this gateway made, with the key and chat it belongs
to, whether the chat is *live*, *stopped* (it will resume) or an *orphan* (no chat: the next sweep removes
it), its uptime, live CPU and memory against its limit, what it has written to its own filesystem, its
network, and when it was last used. A flag marks one built from an image that has since been rebuilt.

| Button | What it does |
| --- | --- |
| **stop** | stops the chat through the gateway (its spend is recorded, Pi exits first) and the container; the chat resumes on its next message |
| **recreate** | stops it, then removes the container but keeps the chat and its Pi session, so the next message builds a clean container and the conversation continues in it |
| **remove** | ends the chat and removes the container (the workspace stays) |

A box under the table **runs a command as root** in a running container, with a 30 s limit (up to 120 s)
and 64 KB of output. **It refuses to work until a dashboard password is set**: on a dashboard anyone on
your network can open, a command box would be remote command execution. The page says why, and the API
answers `403`. Every action, and every command (its first 200 characters), is recorded in the audit
trail under the table (`GET /dashboard/audit.json`).

### Events, disk and alerts

- **Events.** The gateway watches `docker events` for this gateway's containers. A process killed for
  memory, or a container that died without the gateway stopping it, is shown on the Containers page and
  told to the chat: its next reply starts with `[container: a process in this chat's container was
  killed: out of memory (limit 256 MB)]`, and a Pi that died at the time says why in its error. Stops the
  gateway causes itself are not reported.
- **Disk.** Every five minutes (and when the Containers page is opened with older figures) the gateway
  measures what each container has written to its own filesystem, and the free space on the disk Docker
  keeps its data on. Below `DISK_FREE_WARN_MB` (5 GB by default) a red banner shows on every page and an
  alert is sent; a container over `CONTAINER_DISK_MB` (off by default) is flagged and alerted. These are
  warnings, not actions; the remedies are **recreate** and **prune old images**. Sizes are in MiB, like the
  memory limits (Docker prints decimal, so its 400 MB is 381 here).
- **Alerts.** Set `ALERT_WEBHOOK_URL` (Settings → Containers → Disk and alerts; **send a test alert** checks
  it). Each alert is one JSON POST with `text` and `content` (so Slack and Discord webhooks work as they
  are) and `event`, `message`, `host`, `time`, `recovered` and `details`. Alerts are sent for: Docker or
  the network policy failing (and recovering), low disk, a container killed for memory or dead, a container
  over its disk warning. An alert of one kind is sent at most once an hour while its condition lasts, and
  its clearing is announced once. A failing webhook is logged, never fatal.
- **The watchdog** covers what the gateway cannot report about itself: `piper-watchdog.mjs`, run every minute
  by a systemd timer that `deploy.sh --systemd` installs, asks `/health` and alerts after **two failed
  checks in a row** (one can be a restart), and again when the gateway answers. It reads the webhook from
  `gateway.db` read-only and keeps its state in `.watchdog-state`. `/health` also reports `docker` (whether
  containers can run) and `diskFreeMb`.

### The audit log

The **Audit** page lists what was done to the gateway and what happened to it, newest first, with filters
(category, text, dates), *load more*, auto-refresh and CSV export. Every row has a category, an **actor**
(`dashboard`, `key:<name>`, `agent:<name>`, `settings-key`, `anonymous` or `system`), the address the request
came from as the gateway saw it (behind a proxy that is the proxy; `X-Forwarded-For` is client-controlled and
is not used), a target and a detail.

**What is recorded is chosen in Settings → Audit**, one switch per category; a category that is off is not
stored at all. Two more settings keep it bounded: keep for N days (default 90) and at most N rows (default
50,000); the sweep applies them hourly.

| Category | On by default | Covers |
|---|---|---|
| Sign-ins (`auth`) | yes | dashboard logins and failures, sign-outs, password set, changed or removed |
| Settings (`settings`) | yes | each changed setting, old -> new; secrets, the webhook URL and environment variables only say they changed |
| Keys and profiles (`keys`) | yes | key create, revoke, delete, changes; profile lock and reset; sessions killed; model reloads |
| Operations (`operations`) | yes | containers, images, agent endpoints, updates, commands run in a container, the host Pi update |
| Runtime events (`runtime`) | yes | containers killed or dead, Docker up or down, limits hit, model fallbacks, sweeps, alerts sent |
| API requests (`requests`) | **no** | one line per chat request: who, session fingerprint, model, status, time; never the messages |
| Failed API auth (`authfail`) | **no** | requests refused for a bad or missing key, one row per address per minute with a count |
| Audit settings (`audit`) | always | a change to these settings, and retention purges, so switching logging off is itself on record |

Nothing secret is written: not passwords, keys, webhook tokens, environment values, prompts or replies. The
only removal is retention: there is no way to delete or edit rows from the dashboard.

### Backup and restore

```bash
./piper.sh backup [--out DIR] [--keep N] [--no-chats]
./piper.sh restore FILE [--stop]
```

A backup is one owner-only `.tgz` (default in `./backups`) with a `.sha256` beside it: a consistent copy of
`gateway.db` (taken with SQLite's `VACUUM INTO`, safe while the gateway runs), the profiles, the workspaces,
the shared bundles, the container Pi config (whose `models.json` holds an API key: keep the archive private)
and, unless `--no-chats`, the chats' Pi session files, with a manifest of what went in. `--keep N` keeps the
newest N. It refuses when the data would leave under 1 GB free (`--force` overrides). **Containers are not in
it:** a chat whose container is missing gets a fresh one on its next message, with its session, workspace and
profile back.

`restore` refuses while the gateway is running (or stops it with `--stop`), checks the archive against its
checksum and its database against its manifest and an integrity check, and **never deletes**: everything it
replaces is moved aside as `<name>.before-restore-<time>` (remove those when you are satisfied). Folders under
the old gateway folder follow it to the new one, so a backup restores onto a host with a different path. On a
fresh host the target folder is created. `deploy.sh --systemd --backups` adds a daily timer (03:30, keeps 7).

### Models

There are two kinds, and a chat can use both.

**Models the gateway holds credentials for** (whatever `~/.pi/agent/auth.json` and `models.json`
give it) reach the container's Pi through `piper-bridge.mjs`, which is loaded into every Pi. It
registers the gateway's catalogue — names, limits and prices only — as providers whose calls go over
the socket. The gateway looks each model up in its own catalogue, runs the call with its own
credentials, and streams the events back. **No credential of these enters a container**, and their
spend is metered by the gateway, so the ledger cannot be understated by anything running inside.

**Models you configure for containers** are called by the container's Pi directly, as any stock Pi
would. They live in a folder of their own, `CONTAINER_PI_DIR` (default `container-pi/`), with a
`models.json` and a `settings.json`, edited on **Settings → Containers → Pi config for containers**.
Your own `~/.pi/agent` is never read for this and never mounted.

```json
{ "providers": { "local-openai": {
    "baseUrl": "http://192.168.1.50:4000/v1", "api": "openai-completions", "apiKey": "…",
    "models": [{ "id": "Qwen/Qwen3.8-Flash-Next" }, { "id": "hermes-adam" }] } } }
```

- **The provider's key is inside the containers**, readable by the agent, because Pi needs it to
  make the call. Use a key on the model server meant for this (one per API key, if you want to
  limit or attribute usage there). The file is mode `0600`, and the dashboard shows keys as `***`
  and keeps the stored one when you save a redaction.
- **Every key gets its own copy**, filtered by its model allow-list, mounted read-only and linked in
  as the profile's `models.json` unless the key's profile has its own (which then wins).
- **The endpoints are opened in the firewall automatically**, and listed on the health panel.
- **The bridge leaves these providers out**, so a provider is either direct or bridged, never both.
  `/v1/models`, `pi_set_model`, the fallback model and request `model` names all resolve over both
  kinds.
- **The default model** for new chats is the `defaultProvider`/`defaultModel`/`defaultThinkingLevel`
  in that `settings.json` when set, otherwise the default in your own `~/.pi/agent/settings.json`.
- **Spend** for these models is read from the event stream of the container's Pi, since the gateway
  does not see the calls: it is recorded and shown like any other, but it is only as reliable as
  the agent that reports it. Per-call limits (`KEY_DAILY_SPEND_USD`) cannot stop a direct call
  mid-run.
- **The allow-list is advisory for direct models.** The key they need is in the container, so an
  agent can write a `models.json` of its own with the same endpoint. To enforce which models a key
  may use, give each API key its own key on the model server.

### Profiles

**A profile per key.** `PROFILE_ROOT/<key>/` is a Pi agent directory — `settings.json`, `skills/`,
`extensions/`, `prompts/`, `AGENTS.md` — mounted read-write at `$PI_CODING_AGENT_DIR` (`/profile`)
in that key's containers. It starts from `PROFILE_TEMPLATE` (if set), never from your own
`~/.pi/agent`. A new chat starts on the default model above, unless a key has pinned its own with
`/settings set defaultModel <provider/id>`. What the user changes there persists across their chats:

```text
you:   Create a skill in $PI_CODING_AGENT_DIR/skills/release-notes that ...
agent: DONE
you:   /reload
you:   Write the release notes for v2.   ← the skill is used, in this chat and every later one
```

**Extension settings persist per key, too.** `~` in a container is that chat's own `/root`, so an
extension that keeps settings under `~/.pi` would lose them when the chat ends. Containers therefore
get `PI_CONFIG_DIR=/profile/config`, which such extensions read instead (for `@bytetrue/pi-web-search`,
`/profile/config/byte-pi-web/config.json`), and the bridge tells the agent so. A user can say "switch
web search to Brave, my key is …" once, and every later chat of that key uses it; no other key sees
it, and your own host configuration and keys never enter a container.

**The catalogue follows your Pi configuration.** The gateway rebuilds its model catalogue when
`models.json`, `auth.json` or `settings.json` in `~/.pi/agent` changes, checked at most every two
seconds, so a model you add or a login you make in `pi` shows up without a restart. Open chats see
it after `/reload`. The Models page has a **reload catalogue** button to force it.

Extensions are `.ts` or `.js` files (or a directory with `index.ts`) in the profile's
`extensions/`; Pi does not discover `.mjs` there. The open gateway and `GATEWAY_API_KEY` each get a
profile of their own, too.

### Workspace

Every API key gets one **workspace**: `workspaces/<key>/` on the host, mounted read-write at
`/workspace` in every one of that key's chats, and the working directory of each. A file one chat
writes there, any other chat of the same key can read, now or next week, and it outlives every chat.
The bridge tells each agent this, and to keep a chat's scratch files in a subfolder.

```text
chat 1:  echo hello > /workspace/note.txt
chat 2:  cat /workspace/note.txt      -> hello          (same key, another chat)
bob:     cat /workspace/note.txt      -> No such file   (another key's workspace)
```

It is created with the key's first chat, is invisible to every other key, and is kept by a profile
reset (it is data, not configuration). Everything outside it — installed packages, the home
directory, `/tmp` — belongs to one chat's container. There is no size limit unless you set
`WORKSPACE_MAX_BYTES`; past it, new chats get the workspace read-only until it is trimmed. Chats of
one key share it, so they can overwrite each other's files. Files & profiles → Profiles shows each key's
workspace size, and the key's detail view lists its contents, with a download link per file, delete
buttons and an upload control.

**Over HTTP**, with the key as the bearer token, the workspace is a small file API:

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/v1/piper/files` or `/v1/piper/files/<folder>/` (or `?path=<folder>`) | list: name, type, size, modified |
| `GET` | `/v1/piper/files/<path>` | download, streamed |
| `PUT` | `/v1/piper/files/<path>` | upload the request body, streamed; folders are created |
| `DELETE` | `/v1/piper/files/<path>` | delete a file or a folder |

```bash
curl -T report.pdf localhost:8787/v1/piper/files/reports/report.pdf -H "Authorization: Bearer $KEY"
curl -O localhost:8787/v1/piper/files/reports/report.pdf -H "Authorization: Bearer $KEY"
```

Like the profile, the workspace is written by agents and may hold links, so the gateway never opens
it itself: every operation runs `piper-profile.mjs` in a throwaway container with `--network none`,
no capabilities, a read-only root and **only that folder mounted**. Paths are always relative to the
folder (a leading `/` means its root), `..` is refused, and a link is neither served nor followed,
whether it is the file or a folder on the way. An upload goes to a temporary name and replaces the
file in one rename; it is capped by `FILE_UPLOAD_MAX_BYTES` and by what is left of
`WORKSPACE_MAX_BYTES`. Each operation costs about a fifth of a second for the container to start.

### Shared bundles

Skills, extensions and prompts the operator hands out to many keys at once, read-only, on top of
each key's own profile. A bundle is a folder under `SHARED_ROOT` laid out like a Pi package:

```text
shared/
├── base/                     # everyone gets this (the SHARED_BUNDLES default)
│   ├── skills/hallmark/SKILL.md
│   ├── extensions/house.ts
│   └── prompts/review.md
└── security/                 # only for keys given it
    └── skills/pentest-notes/SKILL.md
```

`SHARED_BUNDLES` (Settings → Profiles) is what every key gets: bundle names, `*` for all, or empty
for none; it defaults to `base`. A key can have its own list in the **bundles** column on API
Management (`base,security`, `*`, or `none`; blank follows the default). `GATEWAY_API_KEY` gets
every bundle.

Each granted bundle is mounted read-only into the key's containers and loaded as a Pi package, so
its extensions, skills and prompts all load. Only the granted bundles are mounted: a key cannot
see, let alone read, a bundle it was not given. Users cannot change a bundle; edits you make
reach open chats on their next `/reload`, and a changed grant applies to new chats. `/skills`
marks where each skill came from, `(shared: base)`, and Files & profiles → Profiles lists every bundle's
contents and who gets it.

To share things from your own Pi, copy them in — for example
`cp -r ~/.pi/agent/skills/hallmark shared/base/skills/`. Plain skills and self-contained
extensions work as they are. Two kinds need thought first: an extension that drives a tool or
service on the host will not find it inside the container (put the tool in the image, or share
its folder read-only with `CONTAINER_MOUNTS`; the network stops at the internet), and npm packages that keep state across sessions (`pi-memory`,
`context-mode`) would share it between everyone given the bundle.

### Controlling your profile

Three ways in, all acting on the profile of the key that makes the request — there is no way to
name another key's:

**In chat**, where the gateway answers these itself rather than passing them to the model:

| Command | Does |
| --- | --- |
| `/piper` | lists these commands |
| `/skills` | skills loaded in this chat, from the profile and the workspace |
| `/extensions` | extension files in the profile, and the commands extensions add |
| `/settings` | the profile's `settings.json` |
| `/settings set <key> <value>` | sets one key (value as JSON, else as text) and reloads |
| `/settings unset <key>` | removes one key and reloads |
| `/profile` | size against the quota, contents, and whether it is writable |
| `/profile reset` | asks for `/profile reset confirm`, then starts the profile over |
| `/reload` | re-reads skills, extensions, prompts and settings |

Only these exact names are intercepted: `/skill:name`, prompt templates and extension commands
still go to Pi. The agent can also edit `$PI_CODING_AGENT_DIR` itself when asked.

**Over HTTP**, with the key as the bearer token:

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/v1/piper/profile` | — summary, size, quota, writable |
| `GET` / `PUT` / `PATCH` | `/v1/piper/profile/settings` | `PUT`: the whole object; `PATCH`: `{"set": {...}, "unset": [...]}` |
| `GET` | `/v1/piper/profile/skills` | — |
| `GET` / `PUT` / `DELETE` | `/v1/piper/profile/skills/<name>` | `PUT`: a bare `SKILL.md` as text, or `{"files": {"SKILL.md": ..., "scripts/x.sh": ...}}` |
| `GET` | `/v1/piper/profile/extensions` | — |
| `GET` / `PUT` / `DELETE` | `/v1/piper/profile/extensions/<name>.ts` | `PUT`: the source as text, or `{"content": ...}` |
| `POST` | `/v1/piper/profile/reset` | `{"confirm": true}` |

```bash
curl -X PUT localhost:8787/v1/piper/profile/skills/release-notes \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: text/markdown' --data-binary @SKILL.md
```

Every change reloads that key's open chats, so it applies to them straight away.

**On the dashboard**, the Profiles view lists every profile with its size, skills and extensions,
and lets the operator **lock** one (read-only, its live agents closed so the lock applies at once)
or **reset** it.

**Locks and quotas.** A profile is frozen when it is locked, or when it has grown past
`PROFILE_MAX_BYTES`. Uploads to a frozen profile are refused, and its sessions get it as a
throwaway overlay: skills and settings load as usual, writes appear to succeed, and nothing
written survives the session. A profile over quota thaws once it is trimmed. A reset archives the
old profile beside the workspace archives, where `WORKSPACE_ARCHIVE_TTL_MS` expires it.

**The gateway never opens a profile's files itself.** A profile is written by its own sessions, so
it may contain anything — including a link such as `settings.json -> ~/.pi/agent/auth.json`, which
would turn "show my settings" into "show your credentials". Reading and editing therefore runs
`piper-profile.mjs` in a throwaway container with only that profile mounted, where such a link
leads nowhere. The dashboard and the quota check see only names and sizes, from
`lstat`, which never follows a link.

A Pi that crashes or is killed is replaced on the next request, which resumes its session file in
the same container exactly as a hibernated chat does.

### Limits

Two kinds, both applied per container or per key rather than to the gateway as a whole.

**What one container may use.** Docker enforces these per container, so a runaway chat cannot take
the machine with it: `CONTAINER_MEMORY_MB` (with swap disabled, so a hog is killed instead of
thrashing the host), `CONTAINER_PIDS` and `CONTAINER_CPUS`.

```text
python3 -c "a = 'x' * 4_000_000_000"      -> Killed (exit 137); the container, Pi and the chat carry on
:(){ :|:& };:                             -> "Cannot fork" at the process limit; the machine is unaffected
```

Verified on a live container: a memory hog was killed at the limit, and a fork bomb stopped at 512
processes with the host's load at 0.13 and the gateway answering in under a millisecond. A container's
*writable layer* (what the agent installs) has no size limit, which needs an XFS filesystem with
project quotas; the workspace and profile have theirs (`WORKSPACE_MAX_BYTES`, `PROFILE_MAX_BYTES`).

**What one key may use.** `KEY_MAX_SESSIONS` caps a key's live sessions: at the cap, a new chat
closes that key's least recently used idle one, and if all are busy the request gets `429`.
`KEY_DAILY_SPEND_USD` caps what a key may spend per local day, counted from the ledger since
midnight plus what its live sessions have run up. It is checked when a request arrives and again by
the bridge before every model call, so an agent loop on a bridged model that crosses the line stops
at its next call, with `[model error: daily spend limit reached ...]`. A key over its cap can still
use `/profile` and the other gateway commands; only model calls are refused. Calls a container's Pi
makes *directly* do not pass the gateway, so the cap is checked at the next request, not mid-run.
Both defaults can be overridden per key on the API keys page (blank follows the default, `0` is
unlimited). `GATEWAY_API_KEY` is the operator's and is never limited.

### The security model

**The container is the boundary.** Pi inside is root with a writable filesystem and a network, and
that is by design. What decides how much harm an agent can do is what the container can reach:

| Reach | What an agent has |
| --- | --- |
| Files | its key's `/workspace` and `/profile` (read-write), the granted bundles and `CONTAINER_MOUNTS` (read-only), its own chat's session folder. **Nothing else of the host**: no `/root`, no `/home`, no `gateway.db`, no other key's workspace or profile, no other chat's container. |
| Credentials | none for models the gateway holds keys for. The keys of models *you configured for containers* are in the container. |
| Network | the internet. Not this machine (so not the dashboard or gateway), not your LAN, not cloud metadata, not other containers. |
| Privileges | Docker's default capabilities, `no-new-privileges`, Docker's default seccomp profile. No `--privileged`, no engine socket, no host namespaces. |
| Resources | the memory, process and CPU limits; no swap. |

Verified against a live container: `id` is root; `apt-get install`, `pip install` and `npm i -g`
work; another chat's container cannot be reached; `curl https://…` works, and the gateway (on both
addresses), the router, the LAN and `169.254.169.254` do not answer; there is no `docker.sock`; the host's own folders
are not there; the bridge socket answers `/models` and the model routes and returns `404` for
`/dashboard` and `/settings`.

**Where the boundary is only as strong as Docker.** A container escape (a kernel or runc bug) by a
process that is root in the container reaches the host, and as whatever user runs the daemon. Two
mitigations: run Docker rootless, or with `userns-remap`, under a dedicated user, so container root
is an unprivileged user of the host (see [DEPLOYMENT.md](DEPLOYMENT.md)); and keep the host patched.
The gateway itself needs the Docker socket, and access to it is root-equivalent, so it warns at
start when it runs as root and treats the `docker` group accordingly.

**What the gateway never does**, whatever an agent plants: it does not open a key's profile or
workspace on the host (a link in there would turn "show my files" into "show the host's"). Every
read and write goes through a throwaway container with only that folder mounted. It does not put
the Docker socket, your `~/.pi/agent`, its own folder or its database into any container, and
`CONTAINER_MOUNTS` refuses those (and `/`, `/proc`, `/sys`, `/dev`, and anything inside or containing
what Piper protects) when you save it.

**What it cannot limit.** Outbound internet traffic is open, so an agent can download and upload
what it can reach, scan the internet, or send mail; only the destinations above are closed. A
per-domain allow-list is not built.

### Session lifetime

What the clock does to chats, whichever comes first, is described under Containers: a running chat that
is idle, or whose Pi has run for the lifetime, is **stopped** (and resumes); a one-off request is
**ended**; a stopped chat is **ended** after `CHAT_KEEP_MS`. A session with a request in flight is never
touched, and LRU eviction past `MAX_SESSIONS` stops the least recently used idle chat. Live agents are in
memory; chats that can resume are in the `chats` table. The Live chats page's "on" column says what will
happen and when (`idle → stops`, `one-shot → ends`).

### Model fallback

When a model call fails in a way a different model could survive, the turn is retried once on
`FALLBACK_MODEL` and the switch is announced inline:

```text
[model fallback: opencode-go/deepseek-v4-flash failed (quota: insufficient_quota) - switched
 to opencode-go/deepseek-v4.1-flash for this session]

PONG
```

A failed model call is not an exception — it is a message with `stopReason: "error"`, which the
gateway inspects. `quota` errors (credit exhausted) are permanent for the account; `transient` ones
only reach us once Pi has already exhausted its own retries. Anything else is a deterministic
request problem that a different model would not fix, so it is not retried. `FALLBACK_MODE` decides
whether the switch lasts for the session, just the request, or a cooldown.

When no fallback applies — none is configured, or the error is not one another model would fix —
the failure is reported inline as `[model error: provider/model: ...]` rather than as an empty reply.

### Tool activity

Optional, and off by default. Turn on **Show tool output in the stream** (Settings → Sessions, or
`STREAM_TOOL_ACTIVITY`) and every tool the agent starts is announced in the reasoning stream, one
line each, with a failed one marked:

```text
▸ bash: ls -la /workspace/shared
▸ read: /workspace/notes.md
▸ web_search: {"query":"pi coding agent"}
  ✗ web_search failed
```

The summary is the command for `bash`, the path for the file tools and compact JSON for anything
else (file contents left out), truncated to 200 characters. It goes to `reasoning_content`, never to
`content`, so a client that ignores reasoning sees no change. The switch applies from the next
request, including in chats already open.

### Spend

Cost is read from Pi rather than estimated. `getSessionStats()` reports a session's cost and token
counts, aggregated over every entry including history that was compacted away, so the figure is what
was actually billed rather than a local guess. Tiered pricing is handled inside Pi too.

Two numbers, because they answer different questions:

- **Live** — what the sessions currently in memory have spent so far. Immediate, and shown per
  agent in the Live chats table and on the Overview card.
- **The ledger** — a `spend` table in `gateway.db`, written once as a session closes. Close is the
  single funnel for every way a session can end — reaped, killed, evicted, or shut down — so one
  hook covers them all. A hibernated chat is recorded when it hibernates, and again for what it
  spends after it resumes. It survives a restart, which is what makes *today*, *per model* and
  *per day* mean anything.

Every model call is metered with its model, so a chat that switched models is recorded as one row
per model, and the per-model figures are exact rather than billed to whichever model came last.

A session that generated nothing is not recorded: a request rejected before it reached the model
cost nothing and would only add noise. Tokens are recorded even when the cost is zero, so a local
provider shows its usage at `$0.00` rather than showing nothing.

### Dashboard password

The dashboard has its own password, independent of `GATEWAY_API_KEY` so that protecting it does not
change what the OpenAI endpoints require. With no password stored the dashboard stays open, exactly
as before — set one from **Settings → Access Control**.

- **It is hashed, not encrypted.** Salted and hashed with `scrypt` (N=16384, r=8, p=1), compared
  with `timingSafeEqual`. Nothing ever reads it back; the page is only told whether one is set.
  Reversible encryption would need its key stored beside the ciphertext, which protects nothing a
  hash does not protect better.
- **A sign-in is a signed cookie.** It carries its issue time plus an HMAC of that time, keyed on
  the stored hash. That one choice buys three properties at once: an edited cookie cannot validate,
  changing the password ends every other session, and a restart does not sign you out.
- **Everything under `/dashboard` is behind it** — the page, all five JSON endpoints, and the
  mutating ones (`POST /dashboard/settings`, `kill-all`, `DELETE /dashboard/session/:fp`). `/v1/*`
  and `/health` are untouched, and a `Bearer` header is still accepted on the dashboard whenever
  `GATEWAY_API_KEY` is set, so scripts that already send one keep working.
- **Wrong passwords are throttled** per client: five free attempts, then an exponential wait capped
  at five minutes, answered as `429` with `Retry-After`. The same counter guards the
  current-password field, so a stolen cookie is not a fast way to guess one.
- **Forgetting it does not lock you out.** Start the gateway with `DASHBOARD_PASSWORD` set and the
  stored hash is replaced on startup. Only the hash is written, so unset the variable afterwards.

### API keys

`GATEWAY_API_KEY` remains a single always-valid key, and the **API keys** page adds as many
more as you like. A key has a name, an optional expiry, and one of four states:

| State | Meaning |
| --- | --- |
| `active` | Authenticates `/v1/*`. |
| `expired` | Past its date; kept so its usage stays attributed. Extending the date revives it. |
| `revoked` | Switched off deliberately. Usage history stays. Different from deleting. |
| `deleted` | The row is gone but its ledger rows are not, so usage reads `(deleted key)`. |

- **The value is shown once.** Only `sha256(key)` and a 14-character display prefix are stored, so the
  page can list `piper_a1b2c3d4…` but can never show the key again. Lost means issuing a new one. A
  256-bit random key has nothing to guess, so this hash is deliberately a fast SHA-256 rather than the
  password's slow scrypt: it is verified on every request, and blocking the event loop for tens of
  milliseconds each time would stall concurrent streams to slow down a value that cannot be guessed.
- **Keys authenticate `/v1/*` only.** The dashboard answers to its own password, and
  `GATEWAY_API_KEY` is the one credential that opens both — otherwise every API key you hand out
  would also be able to `POST /dashboard/settings` and change what containers may reach.
- **While any key row exists, `/v1/*` requires one**, including revoked and expired rows. Revoking
  your last key therefore locks the API rather than quietly opening it; delete every key to reopen.
- **Usage is attributed to the key that opened the session**, recorded once at creation: a session
  continued by a different key stays with its original. Revoking a key does not stop sessions it has
  already opened — it stops new requests.
- **Expiry is a date, or never.** A date means valid *through* that day, so picking today is not
  instantly expired. A later date extends it; clearing it means never.

**Allowed models.** `KEY_ALLOWED_MODELS` limits which models keys may use, and a key's detail view
on Profiles overrides it for that key. It is a comma-separated list of `provider/model` patterns
where `*` matches anything, e.g. `local-openai/*, github-copilot/gpt-5-mini`; empty allows every
model. It applies everywhere a model is chosen: `/v1/models` lists only allowed ones, a request
naming another gets `400 model_not_allowed`, the container's own catalogue omits the rest (the
bridge's, and the copy of the container `models.json` it gets), so `pi_set_model` and `/model`
cannot reach them, and the bridge refuses a call to a bridged one outright. For models the
container's Pi calls directly this is advisory; see Models.
`GATEWAY_API_KEY` is never limited.

The **Keys** table also shows each key's live sessions and today's spend against its limits, with
fields to override them (see Limits).

The **Usage** tab reports per key — requests, tokens, cost, last used — a per-model drill-down for
each key, and a per-day series for the page. Those figures come from the spend ledger, written when a
session closes, so anything still running is marked `live` in its row instead of being folded into
numbers that would then disagree with the per-model and per-day breakdowns beside them.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat completions, streaming or not |
| `GET` | `/v1/models` | Model list |
| `GET` / `PUT` / `DELETE` | `/v1/piper/files/...` | The key's workspace (see Workspace) |
| `*` | `/v1/piper/profile/...` | The key's profile (see Controlling your profile) |
| `GET` | `/health` | Liveness and session counts (unauthenticated) |
| `GET` | `/dashboard` | Status dashboard, or the sign-in page when locked |
| `POST` | `/dashboard/login` | Sign in; sets the session cookie |
| `POST` | `/dashboard/logout` | Clear the session cookie |
| `POST` | `/dashboard/password` | Set, change or remove the dashboard password |
| `GET` | `/dashboard/api-keys.json` | List keys (prefixes only) |
| `POST` | `/dashboard/api-keys` | Mint a key; returns the value once |
| `POST` | `/dashboard/api-keys/:id` | Rename, or set a new expiry |
| `POST` | `/dashboard/api-keys/:id/revoke` | Revoke, keeping the row and its usage |
| `DELETE` | `/dashboard/api-keys/:id` | Delete the row |
| `*` | `/v1/piper/profile/...` | The calling key's own profile; see Controlling your profile |
| `GET` | `/dashboard/profiles.json` | Every profile: size, skills, extensions, lock state |
| `POST` | `/dashboard/profiles/:scope/lock` | `{"locked": true}` freezes a profile and closes its agents |
| `POST` | `/dashboard/profiles/:scope/reset` | Archive a profile and start it over |
| `GET` | `/dashboard/profiles/:scope.json` | Everything one key's agents get: own profile, granted bundles, and a running agent's loaded tools and commands |
| `GET` | `/dashboard/files/:scope/:path` | A folder (or `?as=list`) lists it; `?as=text` returns an editor's text; otherwise download. `?root=profile` for the profile instead of the workspace |
| `PUT` / `DELETE` | `/dashboard/files/:scope/:path` | Upload to, or delete from, a workspace or profile; `PUT ?as=text` saves text (409 when the file changed since `expectModified`) |
| `POST` | `/dashboard/files/:scope/:path?op=mkdir` / `?op=move` | Make a folder; rename or move (`{"to", "overwrite"}`) |
| `POST` / `GET` / `DELETE` | `/v1/piper/jobs`, `/v1/piper/jobs/:id` | Run a prompt in the background as the key and poll for the result (see Help → Documentation) |
| `POST` | `/v1/piper/jobs/:id/trigger` | Start a job from its own token (`Authorization: Bearer <token>`), not an API key |
| `GET` (SSE) | `/dashboard/session/:fingerprint/events` | The live view of a running chat (dashboard password required) |
| `GET` (WebSocket) | `/dashboard/terminal/:container` | An interactive root shell in a running container (dashboard password, same origin) |
| `GET` / `PUT` | `/dashboard/container-pi` | The container Pi config: `models.json` (keys shown as `***`) and the default model |
| `POST` | `/dashboard/containers/recheck` | Check Docker, the image and the network policy again, and return the result |
| `GET` | `/dashboard/containers.json` | Every container with state, live usage and disk, the disk summary, recent events and the audit trail |
| `POST` | `/dashboard/containers/:name/stop` \| `recreate` \| `remove` | The buttons above |
| `POST` | `/dashboard/containers/:name/exec` | `{"command": "...", "timeoutMs": 30000}` → `{code, stdout, stderr}`; `403` until a dashboard password is set |
| `GET` | `/dashboard/audit.json` | What was done to containers, images and key container settings |
| `POST` | `/dashboard/alerts/test` | Send a test alert to the saved webhook |
| `GET` | `/dashboard/images.json` | Environments, images, what uses each, and the current build |
| `POST` | `/dashboard/images/build` \| `remove` \| `prune` | `{"env": "slim"}`, `{"image": "piper-agent-slim"}`, `{}` |
| `GET` | `/dashboard/api-keys/usage.json` | Per-key usage, per model and per day |
| `GET` | `/dashboard.json` | The same data as JSON, with `containers`: Docker, image, network and firewall status |
| `GET` | `/dashboard/models.json` | Model catalogue |
| `POST` | `/dashboard/models/reload` | Rebuild the catalogue from `~/.pi/agent` now |
| `GET` | `/dashboard/spend.json` | Spend ledger: totals, per model, per day |
| `GET` | `/dashboard/settings.json` | Current settings |
| `POST` | `/dashboard/settings` | Update settings |
| `DELETE` | `/dashboard/session/:fingerprint` | Close one session |
| `POST` | `/dashboard/kill-all` | Close every session |

## Configuration

Settings live in SQLite (`gateway.db` beside `server.mjs`, override with `GATEWAY_DB`) and are
editable at `/dashboard#settings`, grouped by purpose into **Containers**, **Sessions**, **Usage limits**,
**Profiles**, **Models**, **Access** and **Server** tabs (link one directly as `#settings/containers`). `GATEWAY_DB` is the only environment variable that seeds a setting: every
 knob below is read from its environment variable on first run, and the stored row wins from then
on — so a value you change in the dashboard is not silently overridden by the shell that launched
the gateway. `DASHBOARD_PASSWORD` is the one exception, and deliberately so: it replaces the stored
password hash on every startup, which is what makes it a recovery path rather than a seed.

Durations accept `90s`, `10m`, `24h`, `2d`, or a plain millisecond count. Every value is validated
on write, so a bad one is rejected with a message rather than reaching the running config.

| Group | Setting | Default | Meaning |
| --- | --- | --- | --- |
| Network | `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. `0.0.0.0` exposes it. *Restart.* |
| Security | `GATEWAY_API_KEY` | unset | When set, requests must send `Authorization: Bearer <key>`. |
| Access Control | `DASHBOARD_SESSION_MS` | `12h` | How long a dashboard sign-in lasts. `0` keeps it until the browser closes. |
| Sessions | `MAX_SESSIONS` | `128` | Cap on live sessions; the least-recently-used is disposed past it. |
| Sessions | `SESSION_MAX_LIFETIME_MS` | `1d` | The longest one Pi process runs before it is stopped (counted from when it started); the chat resumes on its next message. |
| Sessions | `SESSION_IDLE_MS` | `10m` | Stop a running chat after this long without a request; its container is kept. |
| Sessions | `CHAT_KEEP_MS` | `30d` | How long a stopped chat's container and session are kept after its last message, then the chat ends. `0` keeps them for ever. |
| Sessions | `ONE_SHOT_TTL_MS` | `2m` | End a session used exactly once and then quiet this long (its container is removed). `0` disables. |
| Limits | `BODY_LIMIT` | `33554432` | Largest accepted request body, in bytes. |
| Limits | `MAX_IMAGE_BYTES` | `20971520` | Largest image the gateway will fetch, in bytes. |
| Limits | `ALLOW_IMAGE_URLS` | off | Fetch `http(s)` image URLs. Off accepts `data:` URIs only. When on, internal addresses are refused and redirects are not followed. |
| Agent | `PI_AGENT_PACKAGE` | auto | Path to the Pi package when it cannot be resolved automatically. *Restart.* |
| Profiles | `PROFILE_ROOT` | `<gateway>/profiles` | Where each key's Pi profile lives. |
| Agent | `PROFILE_TEMPLATE` | empty | A directory copied into a key's profile when it is first created. |
| Limits | `KEY_MAX_SESSIONS` | `16` | Live sessions per key. `0` is unlimited. Overridable per key. |
| Limits | `KEY_ALLOWED_MODELS` | empty | Models keys may use: `provider/model` patterns, `*` as a wildcard. Empty allows all. Overridable per key. |
| Limits | `FILE_UPLOAD_MAX_BYTES` | `1073741824` | Largest file accepted by the workspace file API, in bytes. `0` is unlimited. |
| Limits | `KEY_DAILY_SPEND_USD` | `0` | Daily spend cap per key, in USD. `0` is unlimited. Overridable per key. |
| Limits | `CONTAINER_MEMORY_MB` | `2048` | Memory per chat's container, with no swap. `0` is unlimited. |
| Limits | `CONTAINER_PIDS` | `512` | Processes and threads per container. `0` is unlimited. |
| Limits | `CONTAINER_CPUS` | `2` | CPU cores per container, fractions allowed. `0` is unlimited. |
| Limits | `WORKSPACE_MAX_BYTES` | `0` | Workspace size limit per key, in bytes; past it new chats get it read-only. `0` is unlimited. |
| Agent | `SHARED_ROOT` | `<gateway>/shared` | Folder of shared bundles. |
| Agent | `SHARED_BUNDLES` | `base` | Bundles every key gets: names, `*` for all, or empty. Overridable per key. |
| Agent | `PROFILE_MAX_BYTES` | `104857600` | Profile size limit in bytes; past it uploads are refused and the profile is frozen. `0` is unlimited. |
| Containers | `CONTAINER_IMAGE` | `piper-agent` | The image every chat's container starts from; build it with `./piper.sh image`. |
| Containers | `CONTAINER_NETWORK` | `internet` | `internet` (the internet, not this machine, LAN or other containers), `none`, or `open`. See Network. |
| Containers | `CONTAINER_ALLOW` | empty | Private-network endpoints containers may reach even on `internet`, as `host` or `host:port`. |
| Containers | `CONTAINER_MOUNTS` | empty | Host folders shared read-only into every container, as `host` or `host:container`. The engine socket, `/`, and anything Piper protects are refused. |
| Containers | `CONTAINER_DISK_MB` | `0` | Warn when one container has written more than this to its own filesystem. `0` is off. |
| Containers | `DISK_FREE_WARN_MB` | `5120` | Warn (banner and alert) when the disk Docker uses has less than this free. `0` is off. |
| Containers | `TERMINAL_ENABLED`, `TERMINAL_IDLE_MS`, `TERMINAL_MAX_SESSIONS` | on, 15m, 4 | The dashboard terminal: whether it is allowed, how long without typing closes it, how many may be open at once. |
| Agent | `PLAYGROUND_ENABLED` | on | The dashboard Playground (a chat with an agent); needs a dashboard password. |
| Agent | `EXTENSIONS_ENABLED`, `EXTENSIONS_ROOT`, `EXTENSION_MAX_BYTES` | on, `extensions/`, 200 MB | The host extension library: whether installs are allowed, where it lives, the largest one package may be. |
| Containers | `LIVE_VIEW_ENABLED`, `PACKAGES_ENABLED` | on, on | The live view of a chat; installing Pi packages and MCP servers from the dashboard. Both need a dashboard password. |
| Agent | `EXPORT_MAX_BYTES`, `TEMPLATE_MAX_BYTES` | 20 MB, 5 MB | The most an exported or imported agent bundle, and a saved template, may hold. |
| Agent | `DELEGATE_ENABLED`, `DELEGATE_MAX_DEPTH`, `DELEGATE_TIMEOUT_MS`, `DELEGATE_PROGRESS`, `DELEGATE_MESSAGES`, `TEAM_MAX_STEPS` | on, 3, 10m, full, chat, 6 | Hand-offs between agents of a key: allowed, longest chain, longest hand-off, how much of a colleague's work is shown while the caller waits; most steps in a team. |
| Jobs | `JOBS_ENABLED`, `JOBS_MAX_PARALLEL`, `JOBS_MIN_INTERVAL_MS`, `JOBS_MAX_PER_KEY`, `JOBS_RESULT_DAYS`, `JOBS_MAX_FAILURES`, `JOBS_NOTIFY_ALERTS`, `AGENT_JOBS_DAILY_COST` | on, 2, 5m, 20, 30, 3, on, 1 | Scheduled, webhook and API jobs: on, runs at once, least time between webhook triggers, queued or running runs per key, days results are kept, failures in a row before a job is switched off, also send results to the alert webhook, daily dollar cap on agent-made schedules. |
| Audit | `AUDIT_AUTH`, `AUDIT_SETTINGS`, `AUDIT_KEYS`, `AUDIT_OPERATIONS`, `AUDIT_RUNTIME` | on | Record that category (see The audit log). Applied live. |
| Audit | `AUDIT_REQUESTS`, `AUDIT_AUTH_FAILURES` | off | Record every chat request / every refused API key (busy; deduplicated for the second). |
| Audit | `AUDIT_RETENTION_DAYS`, `AUDIT_MAX_ROWS` | 90, 50000 | Delete rows older than this many days, and the oldest beyond this many rows. 0 is no limit. |
| Containers | `ALERT_WEBHOOK_URL` | empty | A URL that gets a JSON POST for the alerts above. Empty turns alerts off. |
| Containers | `CONTAINER_ENV` | empty | `NAME=value` pairs set for Pi in every container (`RUSTUP_HOME=/usr/local/rustup`). Cannot override `PATH`, `HOME`, `TERM`, `LANG`, `PI_*` or `PIPER_*`. |
| Containers | `CONTAINER_PI_DIR` | `<gateway>/container-pi` | The Pi config for containers: `models.json` and `settings.json`. Edited on the dashboard. |
| Logging | `ACCESS_LOG` | on | One line per request to stderr. |
| Sessions | `STREAM_TOOL_ACTIVITY` | off | Announce each tool the agent runs, with its command or file, in `reasoning_content`. |
| Fallback | `FALLBACK_MODEL` | unset | `provider/model` to retry a failed turn on. Validated against the catalogue. |
| Fallback | `FALLBACK_MODE` | `session` | `session`, `request` or `cooldown` — how soon the primary is tried again. |
| Fallback | `FALLBACK_COOLDOWN_MS` | `5m` | How long to stay on the fallback in `cooldown` mode. |
| Containers | `WORKSPACE_ROOT` | `<gateway>/workspaces` | One workspace per API key under here, mounted at `/workspace` in its chats. |
| Containers | `ARCHIVE_TTL_MS` | `30d` | Delete archives (reset profiles, pre-container workspaces) older than this. `0` keeps them forever. |

**Pi keeps its own config.** `~/.pi/agent/settings.json`, `auth.json`, `models.json` and
`trust.json` are read by the Pi SDK directly and are deliberately left alone — folding them into
this database would break the agent. Only the gateway's own settings are stored here. The Pi config
containers use is a separate folder (`CONTAINER_PI_DIR`) and never your own.

**Upgrading from the bubblewrap version.** Settings that were renamed keep their values (the
`SANDBOX_*` limits and environment, `KEY_FILES_MAX_BYTES`, `WORKSPACE_ARCHIVE_TTL_MS`, and the old
network switch: `on` becomes `internet`, `off` becomes `none`); settings that only tuned the old
runners (`RUNNER`, `WORKSPACE_JAIL`, `GATEWAY_EXTENSIONS`, `PI_CWD`, `SANDBOX_LIMITS`,
`SANDBOX_ALLOW`, `WORKSPACE_ON_EXPIRY`, `KEY_FILES_ROOT`) are dropped. Once, at the first start, each
key's old shared folder (`files/<key>`) becomes its workspace, the old per-chat workspaces move to
the archive, and stored chats are forgotten, so those chats start over and the client's transcript
is replayed to them once. Folders in `SANDBOX_ALLOW` become `CONTAINER_MOUNTS` (or go into the image).
Keys, profiles, the ledger and your dashboard password are untouched.

## Dashboard

Fourteen pages in four groups (Monitor, Build, Infrastructure, Admin) behind a hash route; the larger ones have tabs
(`#agents/teams`, `#containers/terminal`, `#files/profiles`, `#help/docs`). Links from earlier versions still work. The main ones:

- **Overview** — live count, model usage, expiry reasons, and the reaping policy in force.
- **Live chats** — every live session with its model, age, last use, expiry and a kill control.
  **Conversations** are separated from **one-off** generations: a client that fires auxiliary
  requests alongside a chat (a title, a summary, suggested follow-ups) sends each as a bare
  single-message request, and each really is a separate generation. There is no way to tell one
  apart from a brand-new chat on the wire, so a chat counts as one-off until its second turn.
- **Models** — the catalogue, one tab per provider, with capabilities, context window and cost,
  and a **reload catalogue** button. Models the containers' Pi calls directly are marked.
- **Spend** — what agents have cost: today, all time, per model and per day, from the ledger, with
  what the live agents have spent so far shown alongside.
- **Files & profiles → Profiles** — each key's profile: size against the quota, skills, extensions, live agents, and
  lock and reset controls. Click a key (or **contents** on the API keys page, or open
  `#files/profiles/key-<id>`) for everything that key's agents get, in three parts:
  - **installed by the user** — their own skills, extensions, prompts, agent definitions
    (`agents/*.md`), packages and an `AGENTS.md` preview, read through the throwaway helper container;
  - **shared bundles** — each bundle the key is given, with its contents;
  - **loaded in a running agent** — every tool and command that agent actually has, labelled by
    where it came from (own, shared bundle, workspace, gateway, built into Pi). Tools exist only
    once extensions have started, so this part appears while one of the key's agents is running;
    it is fetched through the bridge and never touches the conversation.
- **Settings** — every setting, in tabs by purpose with titled sections. Each field has a
  plain-language label (the setting's key underneath), a one-line summary, units, and the full
  explanation under *details*. Settings that do nothing with the current choices — the extra
  private endpoints when the network is not “Internet only”, the fallback cooldown with no fallback
  model — are dimmed with a note saying when they apply, and follow unsaved changes live. There is a search across
  every tab, a per-field *default* button, and a save bar that counts unsaved changes; a rejected
  value takes you to its field. `restart` marks what needs a restart. The **Containers** tab starts
  with a **health** panel (Docker, the image and its Pi version against yours, the network and
  the firewall rules in place, with a *check again* button) and holds the editor for the Pi config
  containers use. The **Access** tab holds the dashboard password and its session lifetime. A
  problem that stops chats from starting is shown in a red banner above every view.

When a password is set, opening the dashboard asks for it first; a session that expires mid-view
reloads into the sign-in page instead of showing an error banner.

Session ids are never shown. Rows carry an 8-character fingerprint, and the kill control targets
that: the server resolves it to the real id internally, so the page never holds a usable
credential. Session ids are treated as bearer secrets — never logged, never listed.

## Security

Read this before exposing the port. The agent runs real tools, as root in its own container.
[The security model](#the-security-model) above says what a container can reach; this is what
surrounds it.

- **Bind to localhost unless you have a reason not to.** The default is `127.0.0.1` and
  authentication is off. `HOST=0.0.0.0` plus no API key means anyone who can reach the port can
  run an agent.
- **A container cannot reach this gateway's own API** on the default `internet` network, so an
  agent cannot call `/dashboard/settings`. With `CONTAINER_NETWORK=open` it can, and can reconfigure
  the gateway if the dashboard has no password: set one first, or `GATEWAY_API_KEY`.
- **The command box needs a dashboard password.** Running a command in a container is root, with the
  internet, on a machine on your network: on a dashboard anyone can open, that is remote command
  execution. It refuses (`403`, and the page says why) until a password is set. The rest of the Containers
  page (stop, recreate, remove, images) works without one, like the rest of an open dashboard: **anyone who
  can reach an open dashboard can mint API keys and change settings, so set a password** (Settings →
  Access), especially with `HOST=0.0.0.0`.
- **Mounts cannot reach credentials**, from either the global setting or a key's own: see Per-key
  container settings.
- **The Docker socket is root-equivalent.** The gateway needs it, and so does whoever runs it.
  Running as root works (the gateway warns), but a dedicated user with rootless Docker, or the
  daemon's `userns-remap`, turns "escaped the container" from "root on the host" into "an
  unprivileged user". See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Sessions are scoped to the credential that uses them.** A session id — sent, derived or minted
  — is stored under the key that presented it, so the same id under another key is a different,
  fresh session. Behind a proxy that serves many people from one address, two users who open with
  the same message used to derive the same agent; they no longer can, as long as each has a key.
  Users sharing one key still share its namespace, and its workspace.
- **Image URLs are fetched by the gateway, outside every container**, so they are off by default
  (`ALLOW_IMAGE_URLS`). When enabled, loopback, private, link-local and metadata addresses are
  refused at connection time, which also defeats DNS rebinding.
- **The dashboard password crosses the wire in clear text.** The cookie is `HttpOnly` and
  `SameSite=Strict`, and `Secure` is added when `X-Forwarded-Proto: https` says something in front
  terminated TLS — but over plain HTTP on a network, the password is readable in transit. This is
  the same caveat as `GATEWAY_API_KEY`.
- **`gateway.db` holds no readable secret.** `GATEWAY_API_KEY` is stored as a scrypt hash (a
  plaintext value from an older database is hashed in place on first load), and the dashboard password
  and every API key were already hashes. It is created `chmod 600` and should still not be committed
  or copied around, but a copy no longer hands over a usable credential. The settings page never
  receives any of them back. **`container-pi/models.json` is the exception**: it holds the keys of
  the models you configured for containers, readable by design, so it is mode `0600`, never committed,
  and its keys are worth scoping on the model server.
- **The bridge socket only answers model calls.** The model is looked up by name in the gateway's
  catalogue, and only sampling options are taken from the container — never a URL, header or key.
  Anything a key can do through it, it could do by chatting. Its routes are `/models`, `/stream`,
  `/resolve-model` and `/inventory`; everything else is a `404`.
- **A profile and a workspace are shared by a key's concurrent chats.** Two chats on one key see
  each other's files and profile changes. Issue one key per person if people should not share
  skills, settings or files.

## Limitations

Honest list of what this does not do:

- **The container is only as strong as Docker.** See the security model: run rootless or with
  `userns-remap`, and keep the host patched. Being in the `docker` group is root-equivalent.
- **Egress is open.** Only this machine, your LAN, cloud metadata addresses and other containers are
  closed to a container; the internet is not, so an agent can download, upload and scan. There is
  no per-domain allow-list.
- **The network policy is Docker-and-`iptables`.** Podman, `nftables`-only hosts without an
  `iptables` command and rootless Docker's own networking are not covered: there, use `none` or
  `open`. When the rules cannot be installed, chats refuse to start instead of running open.
- **A direct model's key is in the container**, and its allow-list is advisory. See Models.
- **A container's writable layer has no size limit** without XFS project quotas. Sweeps remove the
  containers of ended chats, but a chat that fills its own layer fills the disk Docker lives on.
  The workspace and profile have quotas.
- **Concurrent chats of one key share a workspace** and can overwrite each other's files.
- **A changed image, mount, limit or network recreates a chat's container** on its next start, and
  what the agent installed in it is lost (its session, workspace and profile are not).
- **A resumed chat is a new Pi process** in the same container: it gets a fresh meter and a fresh
  ledger row, and a process the agent had left running is gone (the container was stopped).
- **Starting a chat costs about two seconds** (the container, then Pi), up from one; resuming a
  stopped chat costs about the same. The profile and workspace operations start a container too, at
  about a fifth of a second each.
- **`r2mcp` and other tools that need libraries from your host** do not work unless those libraries
  are in the image or shared with `CONTAINER_MOUNTS`. The image has no radare2.
- **The image must be built, and rebuilt when Pi is updated.** The gateway warns when the versions
  differ, and the Images section rebuilds on request; it never rebuilds by itself.
- **The disk warnings are warnings.** Nothing is stopped or deleted when the disk runs low or a container
  grows large; the remedies are the recreate button and pruning images. Container disk figures come from
  `docker ps -s`, which walks layers, so they refresh at most every two minutes.
- **The mount scan is two levels deep.** A credential further down inside a shared folder is not found;
  share the folder you mean, not its parent.
- **A key on `network: none` cannot use the models configured for containers** (Pi calls them directly);
  models the gateway serves still work.
- **The watchdog needs systemd** (`deploy.sh --systemd`), and can only alert through a webhook. Without a
  webhook set it does nothing.
- **Backups leave out containers.** What an agent installed in one is not backed up; its workspace,
  profile and session are.
- **Alerts of one kind are sent at most once an hour**, so a condition that flaps is announced once, and
  its clearing once.
- **A spend cap stops the next call, not the current one.** A single model call that starts under
  the cap is allowed to finish, so a key can end the day slightly over it.
- **"Today" is the gateway's local day**, and a session is billed to the day it closes.
- **A chat whose container fails to start answers `503`** with the reason (no Docker, no image,
  the network policy could not be enforced), and the next request tries again.
- **Audio is rejected** with a 400. Pi's model type declares only `text` and `image` input, and
  there is no audio content type in its API.
- **Signing out is client-side.** The cookie is stateless, so logging out clears it in the browser
  but a copy taken beforehand stays valid until `DASHBOARD_SESSION_MS` elapses. Changing the
  password is what invalidates every outstanding session immediately.
- **An API key cannot be recovered once the page is left.** Only its hash is stored, by design. If it
  is lost, issue a new one — and update clients in the same window so they never have a gap.
- **Revoking a key does not close the sessions it opened.** They finish normally and their usage is
  still billed to it; only new requests are refused.
- **Usage is attributed at session creation**, when the ledger row is eventually written. A key that
  continues somebody else's session is not credited for it.
- **Spend is only as precise as the provider's pricing.** Providers priced at zero — the local ones
  — report `$0.00` however much they are used, though their tokens are still recorded. Cost covers
  model calls only; tool execution is local and free.
- **No `/v1/responses`, embeddings, or `n` > 1.** Tool calls are executed by the agent and are not
  surfaced as OpenAI `tool_calls`; you get the agent's text back.
- **`prompt_tokens` is a session delta**, so it includes Pi's own system prompt and tool context.

## Development

```bash
node test.mjs
```

The suite needs no Docker: everything that would run `docker` or `iptables` goes through one
injectable runner, which the tests replace with a fake engine. It covers the pure logic —
conversation mapping, session identity, model resolution and error classification, the settings
coercion, the path guard including symlink escapes, the spend ledger's aggregation and its refusal
to record a session that generated nothing, the password hashing including malformed rows, the
route guard — which has to recognise every `/dashboard` path, because a route it misses is served
to anyone who asks — the API key store's hashing, expiry, revocation and delete semantics, and the
shape of the credential chain from the request down to the ledger row. And the container layer:
the exact `docker create`, `exec` and helper command lines (no `--privileged`, no engine socket, the
mounts at their fixed paths, `--memory` equal to `--memory-swap`), the signature and when it
recreates a container, hibernate stopping and end removing, the sweeps and that they never touch
another gateway's containers, the firewall rules against a fake `iptables` that keeps its rules
(idempotent, in order, fails closed), the readiness messages, `CONTAINER_MOUNTS` refusing the engine
socket, protected paths and credential folders, the container Pi config with its redaction, direct-call
metering, the settings renames, and the one-time move from the old layout. And the operations layer:
per-key settings (validation, merging, the signature, the second network and when the firewall rules
exist), what the clock stops and ends (including that a resumed old chat is not stopped again), the
Containers page's listing, actions and command box (and its refusal without a password), events and disk
figures against a real local webhook, the alerts' hold-back and recovery, the watchdog against real local
servers, image environments, builds and removal, and backup and restore round trips (links kept, modes
kept, damage and foreign files refused, nothing deleted). It also covers resumable chats,
graceful shutdown, catalogue reload, tool-activity summaries, per-model metering, the model
allow-list, and the file helper's streaming and path safety, links included. It points its
database and every folder at scratch paths, so running it never touches a real `gateway.db` or a
live chat's files.

The code is split by concern: `server.mjs` is the entry point and router, and `lib/` holds
`settings`, `auth`, `paths`, `engine` (the only module that runs `docker` and `iptables`),
`containerpi` (the container Pi config), `keycontainer` (a key's own container settings),
`containers` (a chat's container, the Containers page, disk and events, sweeps, the migration),
`images` (environments and builds), `alerts`, `audit`, `models`, `sessions`, `runner`, `chat`, `profiles`
and `dashboard`. `piper-backup.mjs` and `piper-watchdog.mjs` are standalone scripts: they read the few
settings they need from `gateway.db` read-only and import no gateway module, because importing one would
open and migrate the database. `piper-bridge.mjs` is the
extension loaded into every container's Pi, `piper-profile.mjs` is the helper that reads and writes
profiles and workspaces inside a throwaway container, and `docker/` holds the image environments.
`piper.sh` starts, stops and restarts the gateway, builds images, checks the setup, and makes and
restores backups, from a console.

The dashboard is `dashboard.html`, served from disk on each request — edit and refresh, no restart
and no build step.

## License

Copyright 2026 ALange

Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE). You may not use these files
except in compliance with the License. Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.
