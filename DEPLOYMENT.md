# Deploying Piper on a new host

This takes a freshly installed Linux machine to a running gateway: what to install, how to run it
as a service, and how to check that the sandbox is really in force. The README explains *why*
things work the way they do; this file is the *how*.

It was written against Debian 13 (bubblewrap 0.12, systemd 257, Node 22). Other distributions work
if they meet the requirements below. Watch the bubblewrap version in particular.

Tested so far: the gateway running as root with `ALLOW_ROOT=1` on that host, including every
sandbox check in section 9. The dedicated-user setup below (sections 2 and 6, and resource limits
through the user's systemd manager) follows the same code paths, but has not been run end to end.
Do section 9's check once after deploying.

## 1. What the host needs

| Need | Minimum | Why |
| --- | --- | --- |
| Linux kernel | 5.11 | Overlay mounts inside user namespaces (used for locked or over-quota profiles). |
| Unprivileged user namespaces | enabled | Every session runs in its own user namespace, as `nobody` with no capabilities. |
| bubblewrap | **0.11.0**, installed at `/usr/bin/bwrap` | The sandbox. 0.11 added `--tmp-overlay`; older versions run sessions but cannot start a locked or over-quota profile. |
| Node.js | 22.19 | The gateway, and the runtime mounted into every sandbox (at `/opt/node`). |
| Pi | installed with that Node's `npm`, and logged in | Each session runs the Pi CLI; the gateway holds its credentials. |
| systemd | optional, recommended | Per-sandbox memory, process and CPU limits (`SANDBOX_LIMITS=auto`). Without it, sandboxes run unlimited and the dashboard says so. |
| Tools for agents | optional | Whatever agents should be able to run: `git`, `python3`, `file`, `curl`, `ripgrep`… Anything under `/usr` is visible to them automatically. |

Distribution notes:

- **Debian 12** ships bubblewrap 0.8 and **Ubuntu 24.04** ships 0.9. Both are too old for overlays.
  Install 0.11 or newer from backports, a newer release, or source. Otherwise never lock a profile
  and keep `PROFILE_MAX_BYTES` generous.
- **Ubuntu 23.10 and later** block unprivileged user namespaces through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns=1`). Either add an AppArmor profile that allows
  `userns` for `/usr/bin/bwrap`, or set that sysctl to `0`.
- **bubblewrap must not be setuid.** Recent Debian packages refuse to run if it is.

Check the host before going further:

```bash
bwrap --version                                   # 0.11.0 or newer
bwrap --help | grep -q tmp-overlay && echo "overlays: ok"
uname -r                                          # 5.11 or newer
node -v                                           # v22.19 or newer
bwrap --unshare-user --ro-bind / / true && echo "user namespaces: ok"   # run as the service user
systemd-run --version | head -1                   # optional: resource limits
```

## 2. Create a dedicated user

Run the gateway as its own unprivileged user. As root it refuses to start unless `ALLOW_ROOT=1`.
Root works, and the sandbox holds either way, but a dedicated user adds ordinary file permissions
behind it.

```bash
sudo apt-get install -y bubblewrap git python3 file curl ripgrep   # plus any tools agents need
sudo useradd --create-home --shell /bin/bash piper
sudo loginctl enable-linger piper        # lets its systemd user services (and limits) run without a login
sudo -iu piper
```

Everything below runs **as `piper`** unless marked otherwise.

## 3. Install Node.js and Pi

Any Node 22.19+ works. A per-user install keeps the gateway and every sandbox on one runtime. Pi
must be installed with **the same Node's `npm`**, because the gateway finds Pi with `npm root -g`
and mounts that Node prefix into each sandbox.

```bash
# Node, e.g. the official tarball (or nvm, or your distribution's nodejs 22 package)
mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C ~/.local/node
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && . ~/.bashrc

# Pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi          # then type /login and sign in to your model provider(s); /quit when done
```

Pi keeps the credentials in `~/.pi/agent/auth.json`. The gateway reads them, and no sandbox ever
sees them: model calls go through the gateway. Set the default model the same way, with `pi` and
`/model`. New profiles start on it.

If Pi lives somewhere `npm root -g` does not find, set `PI_AGENT_PACKAGE` to its package directory.

## 4. Install Piper

```bash
mkdir -p ~/piper && cd ~/piper
# copy these files from the repository into ~/piper:
#   server.mjs  dashboard.html  piper-bridge.mjs  piper-profile.mjs  package.json
#   README.md  DEPLOYMENT.md  Dockerfile.sandbox  test.mjs
node test.mjs                            # the unit tests; they touch only scratch paths
```

There is nothing to build and nothing to `npm install`: the gateway uses only Node's standard
library and the Pi package.

At runtime it creates these next to `server.mjs`. All are owner-only, and all should be backed up
except `workspaces-run`:

| Path | Holds |
| --- | --- |
| `gateway.db` | settings, API key hashes, dashboard password hash, spend ledger |
| `profiles/` | each API key's own skills, extensions, prompts and settings |
| `files/` | each API key's shared folder (`/workspace/shared` in its chats) |
| `shared/` | the shared bundles you hand out (`shared/base/…`) |
| `workspaces/`, `workspaces-archive/` | per-chat working files and their archives |
| `workspaces-run/` | per-session bridge sockets (transient) |

## 5. First start and settings

Every setting lives in `gateway.db` and is edited on the dashboard. An environment variable only
**seeds** a setting the first time the gateway starts. Two exceptions: `GATEWAY_DB` (where the
database is) and `DASHBOARD_PASSWORD`, which replaces the stored password hash on every start.

For the first start, pass what you want to begin with. For example, behind a reverse proxy on the
same host:

```bash
HOST=127.0.0.1 PORT=8787 DASHBOARD_PASSWORD='choose-a-long-one' node server.mjs
```

The startup line tells you what is in force. Check it:

```text
Piper on http://127.0.0.1:8787  … runner=bwrap  limits=systemd (MemoryMax=2048M, …)  jail=on  sandbox-net=off  …
```

- `runner=bwrap`: sessions are sandboxed.
- `limits=systemd (…)`: resource limits are applied. `limits=none: …` means systemd scopes are
  unavailable here; see Troubleshooting.
- `sandbox-net=off`: sessions have no network (model calls still work).
- `user=ROOT` appears only if you run it as root.

Stop it with Ctrl+C, then unset `DASHBOARD_PASSWORD` so it isn't reset on every start.

## 6. Run it as a service

As a **systemd user service** of `piper`, so that per-sandbox limits come from its user manager:

```ini
# ~/.config/systemd/user/piper.service
[Unit]
Description=Piper - OpenAI-compatible gateway for Pi
After=network-online.target

[Service]
WorkingDirectory=%h/piper
Environment=PATH=%h/.local/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/node/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now piper
journalctl --user -u piper -f            # the startup line and the access log
```

`PATH` must include the Node that Pi was installed with, because the gateway runs `npm root -g` to
find Pi.

If you run it as **root** instead (not recommended), use a system unit with
`Environment=ALLOW_ROOT=1` in `/etc/systemd/system/piper.service`. Limits then come from the
system manager.

Restarting the service ends open chats. Clients that resend their conversation continue in a fresh
agent.

## 7. Expose it safely

- **Bind to `127.0.0.1` and put a TLS reverse proxy in front** (Caddy, nginx) for anything beyond
  this machine. Send `X-Forwarded-Proto: https`, so the dashboard's sign-in cookie is marked
  `Secure`. Streaming responses must not be buffered. With nginx:
  `proxy_buffering off;` and `proxy_read_timeout 1h;`.
- **Set a dashboard password** (Settings → Access), unless you did at first start. An open
  dashboard can reconfigure everything, including the sandbox.
- **Create an API key per person or client** on API Management. While any key exists, `/v1/*`
  requires one.

Point clients at `https://your-host/v1` with that key. For example, in Open WebUI add an OpenAI
connection with that URL and key; the model list comes from `/v1/models`.

## 8. Give agents tools and skills

- **Tools under `/usr`** (anything from `apt`, anything in `/usr/local`) are visible to agents
  already.
- **Tools elsewhere** (`/opt/...`, `~/.cargo/bin`, a tool built in a source tree) go in
  Settings → Sandbox → *Extra readable paths* (`SANDBOX_ALLOW`), read-only.
  - Follow symlinks: a `/usr/local/bin/x` that points into `/somewhere/else` needs
    `/somewhere/else` listed too.
  - Tools that must be told where they live get variables under *Extra environment variables*
    (`SANDBOX_ENV`), e.g. `RUSTUP_HOME=/home/piper/.rustup`.
  - `~/.pi/agent/bin` (Pi's own `fd` and `rg`) may be listed; the rest of `~/.pi/agent` never can.
- **Skills, extensions and prompts for everyone** go in a shared bundle:
  `shared/base/{skills,extensions,prompts}`.
  - Every key gets `base` by default. Grant other bundles per key on API Management.
  - Extensions that look things up under `$HOME` see `/workspace` inside a sandbox, and may need a
    path adjusted in the bundle's copy.
- **Network for agents** is off. Turn on Settings → Sandbox → *Network access* only if agents need
  to download packages or browse.

After changing any of these, new chats pick it up. For bundle contents, open chats pick it up on
`/reload`. The dashboard's Profiles page shows what each key's agents actually get.

## 9. Check the sandbox

Create a key, then ask an agent to run a probe:

```bash
KEY=piper_…   # from API Management
curl -s http://127.0.0.1:8787/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model":"pi","messages":[{"role":"user","content":
  "Run with bash and reply with only the raw output: ls /; ls /home /root 2>&1; id -u; pwd; cat /etc/passwd | wc -l"}]}' \
  | jq -r '.choices[0].message.content'
```

Expected:
- `ls /` lists only `bin dev etc lib… opt proc profile run sbin tmp usr var workspace`, plus
  `shared` when the key has bundles;
- `/home` and `/root` do not exist;
- `id -u` prints `65534`;
- `pwd` prints `/workspace`;
- `/etc/passwd` has 2 lines.

Anything else means the sandbox is not what this guide describes.

## 10. Upgrading

- **Piper:** stop the service, replace the files from section 4, run `node test.mjs`, start it.
  `gateway.db`, `profiles/`, `shared/` and the workspaces carry over.
- **Pi:** `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<version>` with the same
  Node, then restart. If you use the container runner, rebuild its image with the same Pi version.

## Optional: container runner

Instead of bubblewrap, sessions can run in Docker or Podman (Settings → Sandbox → Runner). Build
the image with the Pi version the gateway uses:

```bash
docker build -t piper-sandbox --build-arg PI_VERSION=<same version as the host> -f Dockerfile.sandbox .
```

A container sees only its image plus the mounts the gateway adds. `SANDBOX_ALLOW` and `SANDBOX_ENV`
do not apply, so bake agents' tools into the image. Memory, process and CPU limits are passed as
`--memory`, `--pids-limit` and `--cpus`. The container runner is unit-tested but has not been run
against a real Docker or Podman engine; try one chat before relying on it.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Refuses to start: `refusing to run as root` | Run as the dedicated user, or set `ALLOW_ROOT=1`. |
| Chats fail with 503 `the session's sandbox failed to start` | Read the reason in it. Usual causes: bubblewrap missing or not at `/usr/bin/bwrap`; user namespaces blocked (AppArmor on Ubuntu); Pi not found (set `PI_AGENT_PACKAGE`). |
| Banner shows `limits=none: systemd scopes are unavailable here` | As a non-root user, run the gateway as a systemd user service with linger enabled (section 6); from a plain `su` shell there is no user manager. Or set `SANDBOX_LIMITS=off` to silence it. |
| A locked or over-quota profile's chats fail to start | bubblewrap older than 0.11 (no `--tmp-overlay`). |
| A tool works on the host but not for agents | It lives outside `/usr`, or links there from `/usr/local`. Add its real folder to *Extra readable paths*. |
| Replies say `[model error: …]` | The provider call failed. Check `pi` works for the service user and that `/login` was done as that user. |
| Dashboard reachable by anyone | Set a password (Settings → Access), and bind to `127.0.0.1` behind a proxy. |
