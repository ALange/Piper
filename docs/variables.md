# Configuration reference: settings and environment variables

Every knob Piper has. Almost all of them are **settings**: stored in the database, edited in the dashboard
(Settings), and applied live unless marked *restart*. Only a handful of real **environment variables** exist.

## How settings work

- **Stored in `gateway.db`** (table `settings`). The dashboard is the place to change them; each change is checked
  (a bad value is refused with the reason naming the setting) and recorded in the audit log.
- **Seeded from the environment once.** The first time a setting has no row, the environment variable of the same
  name (if set) provides its value, and the row records that it came from `env`. After that the database wins and
  the environment is ignored. So `HOST=0.0.0.0 PORT=9000 node server.mjs` only takes effect on a fresh database.
- **Defaults** are in the table below; a setting you never touched shows its default.
- **Restart** marks those read only at start-up (address, port, the folders). Everything else is live.
- **Secrets** (`GATEWAY_API_KEY`, the dashboard password) are stored as hashes and never shown again. *Sensitive*
  values (the webhook URL, container environment) are shown to you in the dashboard but only reported as "changed" in
  the audit log.
- **Renamed settings** from older versions are migrated with their values on the first start.

## Environment variables that do something

| Variable | Read by | Meaning |
|---|---|---|
| `GATEWAY_DB` | gateway, `piper-backup.mjs`, `piper-watchdog.mjs`, `piper.sh` | Path of the database (default `gateway.db` beside `server.mjs`). It also decides the *instance id* that names containers and firewall rules, so a second gateway with its own `GATEWAY_DB` is independent. `piper.sh` ignores gateways with another `GATEWAY_DB` |
| `DASHBOARD_PASSWORD` | gateway (at **every** start), `deploy.sh` | Replaces the dashboard password with this one (only its hash is kept; the variable can be unset afterwards). This is the **recovery path** for a forgotten password: set it, restart, sign in, unset it |
| `PI_CODING_AGENT_DIR` | gateway | The operator's Pi folder (default `~/.pi/agent`), where Pi's login lives. The gateway never reads its credentials; the bridge uses them through Pi |
| *any setting name* | gateway, first start only | Seeds that setting as described above. `deploy.sh` uses this for `HOST`, `PORT` and `PI_AGENT_PACKAGE` |
| `PI_AGENT_PACKAGE` | `deploy.sh`, `piper.sh`, tests | Where the Pi package is, when `npm root -g` does not find it. Also a setting |
| `PORT`, `LOG`, `STOP_WAIT`, `CONTAINER_IMAGE` | `piper.sh` | Port to health-check, log file, seconds to wait for a clean stop, image name for `image` |
| `NODE_VERSION`, `NODE_MIN` | `deploy.sh` | The Node version it installs with `--install-node`, and the minimum it accepts |

Inside containers the gateway sets `PI_CODING_AGENT_DIR=/profile`, `PI_CONFIG_DIR=/profile/config`,
`PIPER_BRIDGE_SOCKET`, `PIPER_WORKSPACE_DIR`, `PIPER_DEFAULT_MODEL`/`PIPER_DEFAULT_THINKING` (new chats), `HOME=/root`,
`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`. Names starting `PI_` or `PIPER_`, and `PATH`, `HOME`,
`TERM`, `LANG`, cannot be set through `CONTAINER_ENV`.

## Per-key and per-agent overrides

Some values have a default here and can be overridden for one API key (Profiles → the key → Container, and API
Management):

| Override | Default it follows |
|---|---|
| Max sessions | `KEY_MAX_SESSIONS` |
| Daily spend | `KEY_DAILY_SPEND_USD` |
| Allowed models | `KEY_ALLOWED_MODELS` |
| Shared bundles | `SHARED_BUNDLES` |
| Memory, CPU cores, processes | `CONTAINER_MEMORY_MB`, `CONTAINER_CPUS`, `CONTAINER_PIDS` |
| Network | `CONTAINER_NETWORK` |
| Image | `CONTAINER_IMAGE` |
| Extra mounts, extra environment | added to `CONTAINER_MOUNTS`, `CONTAINER_ENV` (a key's own entry for the same path or name wins) |
| Persistent container | off |

An **agent endpoint** layers its own container limits over its key's, then the defaults. A blank field follows the
level below; `0` is a value (unlimited) and lifts a limit. Session, spend and model limits stay on the key.

## All settings

<!-- generated:settings -->

## Values and formats

- **Durations** accept a number of milliseconds or a number with a unit: `90s`, `15m`, `12h`, `30d`.
- **`CONTAINER_MOUNTS`**: `host` or `host:container` entries, separated by spaces, always read-only. Refused: `/`,
  `/root`, `/home`, `/etc`, `/var`, `/run`, the gateway's own folders, engine sockets, anything that is or holds
  `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
  `.password-store`, `.config/gh`, `.config/gcloud`, `id_rsa*` or `id_ed25519*` (two levels deep are scanned).
- **`CONTAINER_ENV`**: `NAME=value` pairs separated by whitespace.
- **`CONTAINER_ALLOW`**: `host:port` entries for private addresses containers may reach on the `internet` policy (for
  example an internal DNS server).
- **`KEY_ALLOWED_MODELS`**: comma-separated `provider/model` patterns, `*` matches anything; empty allows every model.
- **`AGENT_PORT_RANGE`**: `FROM-TO`, both between 1024 and 65535.

## See also

[Files and data](files.md), [Security](security.md), [Operations](operations.md).
