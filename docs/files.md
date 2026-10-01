# Files and data

Where Piper keeps things on the host and inside containers, what is in the database, what a backup holds, and
what is safe to delete. Paths are relative to the gateway folder unless they start with `/`.

## Layout on the host

| Path | What it holds | Sensitive? | In a backup? |
|---|---|---|---|
| `gateway.db` | Settings, API key hashes, spend, stored chats, agents, locks, audit log (SQLite) | Hashes only; no key is stored | yes |
| `profiles/key-<id>/` | A key's Pi profile: `settings.json`, `skills/`, `extensions/`, `prompts/`, `AGENTS.md`, `config/` | The agent may keep anything here | yes |
| `profiles/key-<id>--<agent>/` | The same for an agent endpoint | as above | yes |
| `workspaces/key-<id>/` | The key's workspace, mounted at `/workspace` | Whatever the agents wrote | yes |
| `workspaces-chats/<chat>/` | A chat's own state: `session/` (Pi's session files), `etc/` (rendered `models.json`), `sys/` (its `resolv.conf`, `hosts`, `hostname`) | Conversation contents | yes (unless `--no-chats`) |
| `workspaces-chats/key-<hash>/` | The same for a persistent container, with `session/<chat>/` per chat | Conversation contents | yes |
| `workspaces-run/` | Bridge sockets, one folder per container (transient; falls back to `/tmp/piper-<uid>-run` when the path would be too long for a socket) | no | no |
| `workspaces-archive/` | Profiles that were reset, agents that were deleted; expires after `ARCHIVE_TTL_MS` | Old profile and workspace contents | no |
| `extensions/<name>/` | The extension library: one folder per installed Pi package with an `entry.json`, mounted read-only where granted | Third-party code | yes |
| `shared/<bundle>/` | Operator bundles of skills, extensions and prompts, granted read-only | no | yes |
| `container-pi/` | `models.json` for container Pi, **with the API keys of the models you configured** (mode `0600`), and `settings.json` | **Yes** | yes |
| `backups/` | Archives made by `./piper.sh backup` (mode `0600`) | As the data they hold | n/a |
| `docker/` | The image definitions: `Dockerfile` (the `full` environment) and `environments/<name>/Dockerfile` | no | no (in the repository) |
| `docs/` | This handbook's pages | no | no (in the repository) |
| `templates/` | The built-in agent templates: a `template.json` and a `profile/` tree each | no | no (in the repository) |
| `vendor/xterm/` | xterm.js and its fit addon (MIT), served to the Terminal tab; see `THIRD_PARTY.md` | no | no (in the repository) |
| `gw.log` | The log when the gateway is run by `piper.sh` without systemd | Some request metadata | no |
| `.watchdog-state` | The watchdog's memory of whether it has said the gateway is down | no | no |

Roots are settings: `PROFILE_ROOT`, `WORKSPACE_ROOT` (the chats, run and archive folders sit beside it),
`SHARED_ROOT`, `EXTENSIONS_ROOT`, `CONTAINER_PI_DIR`. Put them on a disk with room. The operator's own Pi folder
(`~/.pi/agent`) is **outside** this list: it holds the Pi login that the bridge uses, and nothing else reads it.

## The database

`gateway.db` is one SQLite file, opened with `node:sqlite`. Tables:

| Table | Holds |
|---|---|
| `settings` | `key`, `value`, `source` (`default`, `env`, `ui`, `deploy`), `updated_at`. One row per setting; the dashboard password and the settings key are stored as hashes |
| `api_keys` | `id`, `name`, `prefix` (for display), `hash` (SHA-256 of the key), `created_at`, `expires_at`, `revoked_at`, `last_used_at`, and per-key overrides: `max_sessions`, `daily_spend`, `shared_bundles`, `allowed_models`, `container_json` |
| `agents` | `id`, `key_id`, `name`, `port`, `workspace` (`own` or `shared`), `model`, `thinking`, `container_json`, `enabled`, `created_at` |
| `chats` | Resumable chats: `id_hash` (the session id is stored only hashed), `key_id`, `workspace`, timestamps, request count, `state_json` |
| `spend` | One row per closed session and model: cost, input, output, cache read and write tokens, requests, `closed_at`, `key_id` |
| `profile_locks` | Scopes the operator has frozen |
| `audit` | `ts`, `action`, `target`, `detail`, `category`, `actor`, `ip`; bounded by the audit retention settings |
| `meta` | One-time jobs already run (migrations), by name |

You can read it with any SQLite tool while the gateway runs (use `.backup` or `VACUUM INTO` for a copy). Do not edit
it while the gateway runs; use the dashboard.

## Inside a container

What the agent sees, at fixed paths that do not depend on the host:

<!-- generated:paths -->

Everything else in the container is its own filesystem: a chat's container keeps it until the chat ends, a persistent
one keeps it until reset or deleted. `/etc/resolv.conf`, `hosts` and `hostname` are files of the container's own (in
its `sys/` folder), so what an agent changes in them survives restarts; they must be edited in place (`echo >`, `tee`),
because a mounted file cannot be replaced by `sed -i` or `mv`.

## Docker objects

| Object | Name | Notes |
|---|---|---|
| Containers | `piper-<instance>-<chat>`, `piper-<instance>-key-<hash>` | Labels `piper.managed=1`, `piper.instance`, `piper.key`, `piper.agent`, `piper.persistent`, `piper.sig` |
| Images | `piper-agent` (full), `piper-agent-<name>` | Labels `piper.image=1`, `piper.pi-version`, `piper.env` |
| Saved states | `piper-keystate:<name>` | Made when a container is rebuilt keeping its installs; removed with the container |
| Networks | `piper`, `piper-open` | See [Security](security.md) for ranges |

## What a backup holds

The database (a consistent copy), `profiles/`, `workspaces/`, `shared/`, `container-pi/` and, unless `--no-chats`,
`workspaces-chats/`, plus a manifest with a checksum per part. **Not** in it: containers and their installed state,
images, the archive, sockets, logs. Restoring onto a host gives every chat a fresh container and its conversation
back; persistent containers are built again from the clean image.

## What is safe to delete

- `workspaces-archive/` and `*.before-restore-*` folders, when you are sure; archives expire by themselves.
- Old `backups/` archives (`--keep N` does this for you).
- `gw.log` when the gateway is stopped.
- Docker images and build cache you do not use (`docker builder prune -f`).
- **Not** `workspaces-chats/` while chats exist (their conversations live there), `profiles/`, `workspaces/` or
  `container-pi/`.

## See also

[Operations](operations.md), [Variables](variables.md), [Security](security.md).
