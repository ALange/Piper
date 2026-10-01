# Security model and hardening

What Piper protects, how, and what it does not. Read the checklist at the end before exposing a gateway beyond the
machine it runs on.

## The threat model

The agent in a container is treated as **untrusted and capable**: it can run any command as root *inside* its
container, install software, fill its disk, and try the network. Piper's job is to make sure that is all it can do.
The people holding API keys are trusted only as far as their keys allow, and the dashboard is the operator's.

## Layers around a container

1. **The container itself.** Root inside, but Docker's default capabilities only (no `--privileged`, no added
   capabilities), `no-new-privileges`, no engine socket, no host namespaces, a writable filesystem of its own.
2. **Resources.** `--memory` equal to `--memory-swap` (a runaway process is killed, not swapped), `--pids-limit`
   (a fork bomb stops at the limit), `--cpus`, and a disk warning. Per key overrides exist.
3. **What is mounted.** Only the key's workspace and profile, the bundles it is granted (read-only), the chat's
   session folder, a rendered `models.json`, the bridge socket folder and the container's own `/etc` files. No
   host folder unless the operator lists it in `CONTAINER_MOUNTS`, read-only, and then it may not be `/`, `/root`,
   `/home`, `/etc`, `/var`, `/run`, the gateway's own folders, an engine socket, or anything containing SSH, cloud,
   `kube`, `docker`, npm, git or password-store credentials (two levels are scanned).
4. **The network policy** (next section).
5. **Credentials stay out.** See below.
6. **Helpers are stricter than agents.** The profile and file helper runs with `--network none`, `--cap-drop ALL`,
   a read-only root and **one** folder mounted, so a symlink an agent plants in its profile leads nowhere; the gateway
   never opens an agent-writable file on the host.

## Network policy

A container's network is chosen by the policy of its key (or the default, `CONTAINER_NETWORK`):

<!-- generated:networks -->

- **`internet`** (default): containers can reach the internet but not the host, the LAN, cloud metadata addresses, or
  each other. The gateway installs iptables rules (tagged `piper:<instance>:<id>`) in `INPUT` (from the container
  bridge to the host) and `DOCKER-USER` (to the ranges above), with holes only for the host's DNS servers
  (port 53) and the endpoints of models you configured for containers, plus anything in `CONTAINER_ALLOW`. The rules
  are installed while *any* effective policy is `internet`, and removed when none is. **It fails closed:** if the
  rules cannot be installed (no `iptables`, no permission), chats on that policy refuse to start instead of running
  open. The dashboard and `./piper.sh doctor` say so.
- **`none`**: no network at all. Models configured for containers (which Pi calls directly) cannot work; bridged
  models still do. Pi and extension updates are skipped for such a container.
- **`open`**: a separate network with **no rules**: the container reaches the host, the LAN and the internet. Use it
  for a key that is meant to, knowing that an open dashboard is then reachable from it.

## Credentials

| Secret | Where it lives | Who can read it |
|---|---|---|
| Provider logins (`~/.pi/agent/auth.json`) | The operator's Pi folder | Pi (the bridge calls providers for containers). Never mounted, copied or read by the gateway. **Never print it.** |
| Keys of models configured for containers (`container-pi/models.json`) | That file, mode `0600` | The agent: Pi in the container calls those models directly, so the key is inside the container. Give it a key limited to what you accept an agent holding |
| API keys | Shown once; SHA-256 stored | Nobody can recover one |
| Dashboard password, settings key | scrypt hash / hash | Nobody |
| Session ids | Stored hashed in `chats` | Nobody |
| Webhook URL, container environment | `settings` table | The dashboard user; the audit log says only "changed" |

The bridge is the reason provider credentials are safe: the container asks the gateway over a socket, the gateway makes
the call, and only the model's answer goes back. The per-key model allow-list and spend cap are enforced there.

## The dashboard

- **Set a password** (Settings → Access). Until one is set the dashboard is open to anyone who can reach the port, and
  it can create keys, change settings, and read every profile. Two features refuse to work until a password exists:
  the **command box** (root in a container) and **updating the host's Pi** (installs software as the gateway's user).
- Sign-in is throttled per address with a growing wait; a wrong password is an audit row. The session cookie is
  signed, expires after `DASHBOARD_SESSION_MS`, is `HttpOnly` and `SameSite=Strict`, and is marked `Secure` when the proxy sends
  `X-Forwarded-Proto: https`. Changing the password ends every session.
- Forgot it: set `DASHBOARD_PASSWORD` in the environment and restart; it replaces the stored one.
- Bind to `127.0.0.1` and put a **TLS reverse proxy** in front for anything else. On the `open` policy containers can
  reach the dashboard.

## Packages, MCP servers and bundles

All of these end up as code an agent runs, so changing them needs a dashboard password and each can be switched off
(`PACKAGES_ENABLED`). Package and server commands run **in a throwaway container**, never on the host: the scope's image
and limits, **only that profile mounted** (no engine socket, no key, no workspace), a read-only root with a scratch
`/tmp`, a ten-minute limit, and the network only for commands that need it and only if the scope's policy is not `none`.
Everything typed is validated (package sources are `npm:`, `git:` or `https://` forms only; server names, commands,
environment names and URLs are checked) and handed to Pi as separate arguments, never a shell string. `mcp.json` never holds
a secret: values must be `${NAME}` references. Bundle edits go through the same profile helper, in a container with only that
bundle mounted; a bundle that is a link is not edited from the dashboard. Remember that a package or server is trusted
code under the agent's network policy: it can send out anything the agent can read.

## Hand-offs and teams

Delegation is bound to the chat's own bridge socket: the gateway decides who is calling from which socket the request came
on, so an agent cannot claim to be another agent or key, and it can only reach the **enabled agents of its own key**. Chains
are depth-limited and loop-free, a hand-off is a normal turn under the key's session and spend limits, and stopping the caller
stops the colleague. A key that has agents delegating can therefore spend more per request than one agent would: each hand-off
is a model turn, so keep `DELEGATE_MAX_DEPTH` small and give the key a daily spend cap. Teams answer only to their owning key,
serve nothing but the chat API, and each step is a turn under that key.

## Templates and import

An imported bundle is untrusted input. It is JSON of regular files only (no links, devices or ownership), every path is
checked against an allow-list (`AGENTS.md`, `settings.json`, `skills/`, `extensions/`, `prompts/`, `agents/`; plain names,
no `..`, no absolute paths, no duplicates, at most 8 deep and 500 files), data must be base64, the total is capped by
`EXPORT_MAX_BYTES`, and the profile helper checks everything again and refuses to write through a link, inside a throwaway
container with only that profile mounted. A refused bundle leaves nothing behind. Importing needs a dashboard password
because **extensions are code** that runs in the agent's container (under its network policy and limits). A bundle can
never set environment, mounts, an image or the network. Export carries no keys or secrets, but instructions and skills
may mention things you consider private: read a bundle before sharing it.

## Jobs

Jobs run agents without a person watching, so they go through the same limits as a chat: the owning key's session cap,
daily spend cap and model allow-list, with the cost attributed to the key and agent. Revoking or expiring the key stops
its jobs; deleting the key or agent deletes them. `JOBS_MAX_PARALLEL` and `JOBS_MAX_PER_KEY` bound the load and
`JOBS_ENABLED` stops everything.

The webhook trigger is its own credential: 192 random bits, shown once, stored hashed, compared in constant time,
revocable, and valid for that one job only. A wrong token is the same 404 as an unknown job, rate-limited by
`JOBS_MIN_INTERVAL_MS`, and the body is cut at 16 KB. Put the token in a header, never in the URL (URLs are logged).
Result webhooks are signed (`X-Piper-Signature`); the URL a **client** sets over the API may not point at an internal
address (checked again when connecting), while one set on the dashboard by the operator may, like `ALERT_WEBHOOK_URL`.
The signing secret is stored in the database so the gateway can sign with it.

## The live view

The live view of a chat shows conversations, so it is gated like the terminal's most important check: a dashboard
password must be set (403 otherwise) and `LIVE_VIEW_ENABLED` must be on. At most 5 people watch one chat and 20
streams are open in all. A chat is named by its fingerprint; the real session id never leaves the gateway. Watching,
interrupting and downloading a transcript are each an audit row (`session.watch`, `session.interrupt`,
`session.transcript`: who, which key and agent), never the content. The items are kept in memory only and go with
the chat.

## The terminal

The dashboard's Terminal opens a **root shell in a container** over a WebSocket. It is gated like the command box and
more: a dashboard password must be set (refused with 403 otherwise); the signed-in cookie must be valid; the request's
`Origin` must be this host (so a page on another site cannot open one with your cookie); the container must be this
gateway's and running; at most `TERMINAL_MAX_SESSIONS` at once; idle ones close after `TERMINAL_IDLE_MS`;
`TERMINAL_ENABLED` turns it off. The shell is in the container, under its network policy and limits, not on the host.
Every open and close is an audit row with who and from where; keystrokes and output are never stored. Closing the
connection hangs the shell up and ends the jobs it started.

## Agent endpoint ports

Each agent listens on its own port on `HOST`. It serves only the API and only for its owning key; the dashboard and
settings are never on it. It is still a listening socket: put the range (`AGENT_PORT_RANGE`) behind the same
firewall and proxy as the gateway.

## The audit log

What was done and what happened, with actor and address. Nothing secret or conversational is written. What is
recorded is chosen in Settings → Audit; the `audit` category (changes to those settings, purges) is always on.

<!-- generated:audit -->

Rows are only ever removed by retention (`AUDIT_RETENTION_DAYS`, `AUDIT_MAX_ROWS`); there is no delete in the
dashboard. The recorded address is the one the gateway sees, which behind a proxy is the proxy's; `X-Forwarded-For`
is client-controlled and is not trusted.

## Running as a dedicated user

Access to the Docker socket is root-equivalent on the host, for whoever has it. The default install runs the gateway
as whoever runs `deploy.sh`. Better: `sudo ./deploy.sh --systemd --run-as piper --create-user`, which runs it as its
own user in the `docker` group; best, rootless Docker for that user. Rootless Docker cannot install the firewall rules,
so use `none` or `open` there. The rootless and dedicated-user layouts follow the same code paths but have had less
testing than the default.

## Limits of the model

- A container shares the host's **kernel**. A kernel or runtime escape is out of Piper's hands; keep the host
  patched and consider gVisor or Kata as the runtime if the agents run untrusted workloads.
- An agent with `internet` can send out whatever it can read: its workspace, its profile, a direct model's key.
  Put nothing in a workspace that the key's holder should not be able to send anywhere.
- Persistent containers keep whatever was installed, including anything hostile an agent installed. **Reset** clears it.
- Spend and session limits are checked at call boundaries; a single very long model call can overshoot a cap.
- Shared workspaces (an agent endpoint with `shared`) let the key's agents overwrite each other's files.
- Docker's own disk use is warned about, not capped.

## Hardening checklist

- [ ] A dashboard password is set; the gateway listens on `127.0.0.1` behind TLS, or a firewall limits the port.
- [ ] `AGENT_PORT_RANGE` is set and the range is firewalled like the gateway.
- [ ] The gateway runs as a dedicated user (ideally rootless Docker), not root.
- [ ] `CONTAINER_NETWORK` is `internet` or `none` unless a key truly needs `open`.
- [ ] Every person or client has a **separate API key**, with a session cap, a daily spend cap and an allow-list that
      fit them; unused keys are revoked.
- [ ] `container-pi/models.json` holds keys with limited scope and spend.
- [ ] `CONTAINER_MOUNTS` is empty, or lists only folders you would hand to an agent.
- [ ] Audit categories you care about are on; request logging is on if you need attribution per call.
- [ ] An alert webhook is set and tested; the watchdog timer is enabled; backups run and are copied off the machine.
- [ ] The host, Docker and Pi are kept up to date ([Operations](operations.md)).

## See also

[Architecture overview](overview.md), [Troubleshooting](troubleshooting.md), [Variables](variables.md).
