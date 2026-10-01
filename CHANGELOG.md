# Changelog

All notable changes to Piper, newest first. Versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-09-30

### Added
- **Persistent keys.** A key can have one container that lasts: packages and tools an agent installs survive new
  chats, reloads and gateway restarts. A changed setting rebuilds it from a saved copy of its state, so installs
  are kept; Reset starts clean.
- **Agent endpoints.** Named, permanent agents of an API key (an architect, a coder, a researcher), each with its
  own instructions, profile, container and OpenAI-compatible port. A port accepts only the key it belongs to and
  serves only the API. Spend and limits stay on the key.
- **Update container.** Rebuild a container with today's settings keeping what is installed, set its Pi to the
  version the gateway runs and update its extensions, for one container or all of them, with a live log.
- **Update the host's Pi** and its extensions from the dashboard, with the running, installed and newest versions
  side by side.
- **Audit log.** An Audit page with filters, paging and CSV export. Settings → Audit chooses what is recorded
  (sign-ins, settings changes, keys and profiles, operations, runtime events, and opt-in request and failed-auth
  logging), how long it is kept and how many rows. Secrets and message content are never written.
- **Resource usage** on the Overview: host CPU, memory, load and disk, the gateway process, and the containers
  added up, with charts and the heaviest containers.
- **Pi version per container and per live agent**, marked green when it matches the gateway's and red when it is
  behind. The host's extensions are shown as a table.
- **About** and **Documentation** pages: release notes and an administrator's wiki inside the dashboard.

### Changed
- A container's `/etc/resolv.conf`, `hosts` and `hostname` are files of its own, so what an agent sets (a
  resolver for Tor, a hosts entry) survives stops, restarts and rebuilds.
- `deploy.sh` finds an existing Pi on its own (environment, gateway setting, the `pi` command, `npm root -g`,
  nvm, fnm, asdf, volta) and uses it for the tests, the image build and the gateway.
- The gateway's Pi version means the version it loaded, not what is on disk, so images and containers never follow
  a version the gateway is not running.

### Fixed
- The test suite no longer depends on where the author's Pi is installed or on which folders a host has.

## [0.3.0] - 2026-09-30

### Added
- **Docker only.** Every chat runs Pi in its own container, a stock Pi with full rights inside it; the gateway
  decides what the container can reach. One workspace per API key, shared by its chats.
- **Network policy** per container: internet only (the host, the LAN and other containers are blocked by rules the
  gateway installs, and it fails closed), none, or open.
- **Containers page** with live CPU, memory and disk, stop, recreate, remove, a command box that refuses until a
  dashboard password is set, and an audit trail.
- **Per-key container settings**: memory, CPU, processes, network, image, mounts and environment, with credential
  folders refused as mounts.
- **Idle chats stop instead of ending**; stopped chats are ended after a retention period.
- **Docker events and a disk guard**, an alert webhook, and a watchdog that reports when the gateway stops answering.
- **Several images** (full and slim), built and pruned from the dashboard.
- **Backup and restore** that never deletes what it replaces, `deploy.sh` for a new host, and a systemd service with
  watchdog and backup timers.

### Changed
- Models configured for containers are called directly by Pi; the bridge serves the rest.
- The profile helper and the file API run in a throwaway container with one folder mounted.

### Removed
- The bubblewrap and in-process runners.

### Fixed
- `/health` answered with an empty body; a service `PATH` without `/usr/sbin` hid `iptables`; a refused upload could
  leave an empty temporary file; removing an image with a blank name matched every image.

## [0.2.0] - 2026-09-26

### Added
- **Resumable chats.** A restarted, evicted or crashed chat continues its Pi session instead of replaying the
  transcript; session ids are stored hashed.
- **Model allow-list** for all keys and per key, enforced wherever a model is chosen.
- **File API** for a key's shared folder, and dashboard download and upload.
- **Tool activity** can be shown in the stream, off by default, as a setting.
- `piper.sh` to start, stop and restart the gateway from a console.
- Extension settings kept per key, so extensions that store settings (web search providers, for one) keep them.
- A per-key shared folder, visible only to that key, with an optional size limit.

### Changed
- The code is split into modules. Shutdown hibernates every agent and records its spend.
- The model catalogue reloads when the host's Pi configuration changes; spend is recorded per model and per call.

## [0.1.0] - 2026-09-26

### Added
- First release: an OpenAI-compatible gateway that runs one sandboxed Pi agent per conversation behind
  `/v1/chat/completions`, with a model bridge that keeps provider credentials out of every sandbox, per-key
  profiles and shared bundles of skills and extensions, per-key limits, and a dashboard.
