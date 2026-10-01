# Architecture overview

How Piper is put together, what runs where, and how one request travels through it. Read this first: the
other pages assume these terms.

## What Piper is

Piper is a gateway that speaks the **OpenAI API** (`/v1/chat/completions`, `/v1/models`) and answers with the
**Pi coding agent**. Every conversation gets its own Pi, running inside its own **Docker container** as a stock
Pi with full rights there. Piper's job is everything around the container: who may call, what the container can
reach, how much it may use, what it remembers, and keeping the model providers' credentials out of it.

| Piece | What it is | Where |
|---|---|---|
| **Gateway** | One Node.js process: HTTP server, sessions, dashboard, settings, the database | `server.mjs`, `lib/*.mjs` |
| **Engine layer** | The only code that runs `docker` and `iptables`; injectable for tests | `lib/engine.mjs` |
| **Container layer** | Builds a chat's container spec, starts Pi in it, sweeps, lists and controls containers | `lib/containers.mjs` |
| **Bridge** | A Pi extension in every container and a socket server in the gateway: model calls go through it so credentials stay out | `piper-bridge.mjs`, `lib/runner.mjs` |
| **Profile helper** | Reads and edits a profile or workspace from a throwaway container with one folder mounted | `piper-profile.mjs` |
| **Agent servers** | One extra HTTP port per agent endpoint | `lib/agentservers.mjs` |
| **Dashboard** | A single page served at `/dashboard`, behind the dashboard password | `dashboard.html` |
| **Database** | SQLite (`node:sqlite`): settings, keys, spend, chats, agents, audit | `gateway.db` |
| **Helpers** | Backup and restore, watchdog, deploy and control scripts | `piper-backup.mjs`, `piper-watchdog.mjs`, `deploy.sh`, `piper.sh` |

## One request, step by step

1. **Authenticate.** `Authorization: Bearer <key>` is matched against the stored key hashes. No key is needed only
   while the gateway has no keys and no settings key at all. A revoked or expired key is refused.
2. **Find the session.** The client's id (`X-Session-Id` header or `session_id` in the body) is scoped to the
   credential, so the same id under another key is a different, fresh session. With no id, one is derived from
   the client and the first user message, or minted, and returned in the `X-Session-Id` response header.
3. **Limits.** The key's session cap (least recently used idle session makes room), its daily spend cap and the
   model allow-list are checked before anything starts.
4. **A container.** For a new or resumed session the gateway builds the container spec, makes sure the container
   exists with the right mounts and limits (creating, starting or rebuilding it as needed), and starts Pi in it
   with `docker exec -i ... pi --mode rpc`, speaking JSON lines over stdin and stdout.
5. **The turn.** Only the new user turn is forwarded; Pi keeps its own history. Pi runs its tools (read, bash, edit,
   write, and any extensions) inside the container. Model calls either go through the **bridge** (the gateway calls
   the provider with its credentials and meters it) or, for models configured for containers, straight from Pi.
6. **The reply.** The agent's text is streamed back as server-sent events, or returned whole when `stream` is false.
   Tool activity is not turned into OpenAI `tool_calls`; it can be shown in the stream as a setting.
7. **Afterwards.** Spend is recorded. The session waits: idle or long-running sessions are **stopped** (the
   container is kept and the chat resumes on its next message), one-off requests are **ended**.

## Identities

Everything is per API key, and an **agent endpoint** is a second level under a key.

- **API key.** Owns a profile (`profiles/key-<id>`), a workspace (`workspaces/key-<id>`), limits, spend, a model
  allow-list, bundle grants and container settings.
- **Owner key and scope id.** Limits, spend and the allow-list always belong to the **owner key**. Where things
  *live* (profile, workspace, container, session folders) follows the **scope id**: the key's id for its main
  endpoint, `<keyId>--<agentId>` for an agent. A key's agents count together against its caps.
- **Agent endpoint.** A named, permanent agent of a key with its own instructions, profile, persistent container
  and port. Its port accepts only the owning key.
- **Settings key and open gateway.** `GATEWAY_API_KEY` is the operator's own credential (unlimited); with no keys
  and no settings key the API is open and is treated as one more scope.

## Containers

- **Naming.** `piper-<instance>-<chat>` for a chat's own container and `piper-<instance>-key-<hash>` for a
  persistent one. `<instance>` is the first 8 hex of the SHA-1 of the database path, so two gateways on one Docker
  never touch each other's containers.
- **Shape.** Root inside, Docker's default capabilities, `no-new-privileges`, `--memory` equal to `--memory-swap`
  (no swap), `--pids-limit`, `--cpus`, a writable filesystem, no engine socket, no host namespaces.
- **Kept or persistent.** A chat's container is kept while the chat can resume and removed when it ends. A
  **persistent** container belongs to a key or agent, is shared by its chats, keeps running between them, and keeps
  what the agent installed through settings changes (its state is saved to an image and the container rebuilt).
- **Mounts.** The key's workspace and profile, operator bundles, the chat's session folder, the rendered
  `models.json`, the bridge socket folder and `/etc/resolv.conf`, `hosts` and `hostname` as files of the
  container's own. See [Files and data](files.md) for the table.
- **Signature.** A hash of everything fixed at creation (image, mounts, limits, network, paths). If it changes the
  container is recreated on its next start. Changing a key's container settings stops the key's live chats so they
  resume in the new container.

## Models: the bridge and direct

- **Bridge.** The default. The container's Pi has a provider that talks to a socket; the gateway makes the real
  call with credentials from the operator's Pi login (`~/.pi/agent/auth.json`, never read by anything else), and
  meters tokens and cost itself. The per-key model allow-list is enforced at the bridge.
- **Direct.** Models defined in `container-pi/models.json` (for example a local LiteLLM) are called by Pi inside the
  container, with their key inside the container. They are metered from Pi's event stream, their endpoints are let
  through the firewall automatically, and the allow-list is advisory for them. A network policy of `none` cuts them
  off by design.

## What runs as whom

- The gateway runs as one host user. It needs the Docker socket, which is root-equivalent; a dedicated user with
  rootless Docker is the safer arrangement (see [Security](security.md)). `deploy.sh` runs it as the user who runs it (root on many hosts) unless `--run-as` names another.
- Containers run as root *inside*. The profile and file helper run as the gateway user's uid, with no network, no
  capabilities and a read-only filesystem, and only the one folder mounted.

## Ports and processes

| What | Default | Notes |
|---|---|---|
| Gateway HTTP | `127.0.0.1:8787` (`HOST`, `PORT`) | API, dashboard and `/health` |
| Agent endpoints | a free port each, or inside `AGENT_PORT_RANGE` | API only, owning key only |
| Docker networks | `piper` 172.29.0.0/24, `piper-open` 172.30.0.0/24 | created on demand |
| Firewall rules | tagged `piper:<instance>:<id>` in `INPUT` and `DOCKER-USER` | installed while any policy is `internet` |
| systemd (optional) | `piper`, `piper-watchdog.timer`, `piper-backup.timer` | from `deploy.sh --systemd` |

## Lifecycle of a chat

| Event | Effect |
|---|---|
| Idle for `SESSION_IDLE_MS`, or running for `SESSION_MAX_LIFETIME_MS` | **Stopped**: Pi exits, the container stops (a persistent one keeps running); the chat resumes on its next message |
| One-off request (used once) idle for `ONE_SHOT_TTL_MS` | **Ended**: container and chat state removed |
| Stopped chat unused for `CHAT_KEEP_MS` | **Ended** |
| Over `MAX_SESSIONS` | The least recently used idle chat is stopped |
| Gateway restart or `SIGTERM` | Every chat is stopped and its spend recorded; they resume afterwards |
| Dashboard kill / remove | Ended (kill all ends every live session) |

## See also

[Functions](functions.md), [Operations](operations.md), [Files and data](files.md), [Security](security.md).
