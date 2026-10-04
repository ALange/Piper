# Changelog

All notable changes to Piper, newest first. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Scheduled tasks reach their owner.** A job has a `notify` setting (never, changes, always). A finished run is put in an
  inbox that the next reply of a chat of that key and agent shows at the top, once, and is sent to the alert webhook
  (`JOBS_NOTIFY_ALERTS`). With `changes` nothing is sent when the task answers `NO_CHANGE` or repeats its last report.
  Schedules an agent makes for itself default to `changes`; the operator's jobs to `never`.
- **Previous-run context.** A new session mode, `memory`, starts every run fresh but shows it its last three real reports, so
  a recurring check can compare without a conversation that grows forever. It is the default for an agent's own schedules.
- **Guards for unattended runs.** A job whose scheduled runs fail `JOBS_MAX_FAILURES` times in a row (default 3) is switched
  off and the owner is told; turning it on again resets the count. A job has a 24-hour spend cap (`AGENT_JOBS_DAILY_COST`,
  default $1, for schedules agents made; settable per job by the operator): over it, scheduled runs are skipped and the owner is
  told once. The Jobs page has the new fields.

### Added
- **Live progress of hand-offs.** While an agent waits for a colleague, what the colleague does appears in the waiting
  agent's reasoning stream (Open WebUI's "Thinking"): `[coder] ▸ started: …`, each tool it runs (`▸ bash: …`), failures,
  the first line of each message it writes (`› …`), a sign of life when it is quiet for 20 s, and `✓ done in 42s` or
  `✗ stopped: …`. A colleague's own colleagues are indented under it. `DELEGATE_PROGRESS` chooses off, tools or full
  (default); it works for every client because it uses the reasoning field, and also in jobs and the Playground.

- **Colleague messages in the reply.** With `DELEGATE_MESSAGES` = chat (the default), each finished message a colleague writes
  while the agent waits appears in the reply as `(coder): …`, and a colleague's own colleague as `(coder › tester): …`;
  tool calls stay in the reasoning stream. `thinking` keeps only the first line of each message in the reasoning, `off` shows
  none. Jobs and hand-offs never put them in their result. Each agent can override the setting for itself (Endpoints → edit →
  *colleague messages*); blank follows the setting.

### Fixed
- **Colleagues dying before they could report.** A streamed reply sent nothing while the agent waited on a colleague (or any
  long tool), so a proxy or client such as Open WebUI timed the idle connection out; the dropped connection aborted the
  orchestrator's turn and, with it, the colleague's. Streamed replies now send an invisible SSE comment every
  `STREAM_KEEPALIVE_MS` (15 s; 0 turns it off). A hand-off that fails now tells the caller what the colleague had written so
  far, what happened to its container (killed for memory, gone), and that its conversation is kept so it can be asked to
  continue, instead of only "it took too long".

## [0.7.0] - 2026-10-01

### Added
- **Extension library and per-agent access.** Pi extensions (`npm:`, `git:` or `https://` packages) can be installed **on the
  host** from the dashboard into a library (`EXTENSIONS_ROOT`): the host's npm or git downloads them with install scripts off by
  default, git hooks disabled and an environment that holds nothing but `PATH`, and the result must be a Pi package. They are
  never run on the host: each is mounted read-only into the containers of the keys and agents it is granted to. Grants work at
  three levels, the global default, a key (all its agents) and an individual agent, each following the one above unless it has
  its own list. A new **Extensions** page has a Library tab (install, update, remove) and an Access tab (a matrix of who gets
  what, with the effective result). Settings: `EXTENSIONS_ENABLED`, `EXTENSIONS_ROOT`, `EXTENSION_MAX_BYTES`.
- **Agent creation wizard.** Agents → Wizard: an existing key or a new one made with the agent, and a template, identity, instructions and skills (leave template skills out, add
  your own), extensions (follow the key or its own list, plus packages to install into its profile), limits and hand-offs, then a
  review. The server validates it all in one place and removes the agent again if anything fails.
- **Template details and editing.** Click a template on Agents → Templates & import to see it in full and, for your own, change its
  fields and files; built-in templates can be copied to edit.
- **Playground file view.** A Files panel shows the workspace of the agent you are chatting with, refreshed after each answer, with a
  preview window for text, Markdown, images and downloads.
- **Playground.** A chat with any key's agent, first in the menu: streaming Markdown answers, collapsible thinking and tool calls,
  Stop, retry, copy, a list of chats with search, rename, delete and export, a model picker, phone-friendly. It runs as the chosen
  key or agent (their limits and spend apply), keeps the messages in the browser only, and needs a dashboard password. Setting:
  `PLAYGROUND_ENABLED`.

## [0.6.0] - 2026-10-01

### Added
- **Live view.** *watch* on the Agents page follows a running chat as it happens (messages, thinking, each tool call
  and its result), with an *interrupt* button and a Markdown/JSON transcript download. Needs a dashboard password;
  watches, interrupts and downloads are audited without content. Setting: `LIVE_VIEW_ENABLED`.
- **Spend per agent.** Spend records which agent endpoint a session belonged to; the Spend page has a "by key and
  agent" table and the Endpoints page shows each agent's spend today.

- **Packages and MCP servers from the dashboard.** The Profiles detail view installs and removes Pi packages (`npm:`,
  `git:` or `https://` sources only) and adds, removes, enables and tests MCP servers, each as Pi's own command in a
  throwaway container with only that profile mounted. Secrets are never written to `mcp.json` (only `${NAME}` references).
  Needs a dashboard password. Setting: `PACKAGES_ENABLED`.
- **Shared bundles from the dashboard.** Files → Bundles creates, edits and deletes the bundles under `SHARED_ROOT` with the
  same browser and editor, and reloads the live chats of every key that gets the bundle.
- **Hand-offs between agents.** An agent can be allowed to give tasks to the other agents of its key (`piper_agents`,
  `piper_delegate`), with a description for each agent, a depth limit, no loops, a timeout, and the cost on the key. The
  caller stopping stops the colleague. Settings: `DELEGATE_ENABLED`, `DELEGATE_MAX_DEPTH`, `DELEGATE_TIMEOUT_MS`.
- **Orchestrator template.** A built-in template whose agents may hand work to the other agents of their key and are shown the current
  list of colleagues, with descriptions, at the start of every turn: new agents are used on the next message. Templates, export,
  import and clone now carry the hand-offs switch.
- **Teams.** A chain of agents behind an OpenAI-compatible endpoint of its own: each step's instruction gets the task and the
  previous answer, progress streams as reasoning, and a failing step is named. Setting: `TEAM_MAX_STEPS`.
- **Agent templates, clone, export and import.** New agents can start from a template (five ship: architect, coder,
  researcher, reviewer, devops), an agent can be saved as a template, cloned, or exported to one JSON file and imported
  into any key. A bundle holds regular files only, is validated path by path and written by the profile helper, never
  carries keys, environment, mounts or network, and needs a dashboard password to import. Agents also gain a description.
  Settings: `EXPORT_MAX_BYTES`, `TEMPLATE_MAX_BYTES`.
- **Jobs.** Prompts an agent runs on its own: on a schedule (every N minutes or hours, daily, chosen weekdays, once),
  from a webhook with a per-job token, or asynchronously through `POST /v1/piper/jobs`. They run as the owning key and
  agent (its limits, spend cap and model list apply), never overlap, make up a missed run once, stop at a time limit
  and keep a history with results and cost. Finished runs can be POSTed to a signed webhook. A Jobs page manages them.
  Settings: `JOBS_ENABLED`, `JOBS_MAX_PARALLEL`, `JOBS_MIN_INTERVAL_MS`, `JOBS_MAX_PER_KEY`, `JOBS_RESULT_DAYS`.

### Fixed
- **Docker images that could not be removed.** An old image stayed because stopped containers (this gateway's, or another Piper gateway's
  on the same machine) still referred to it, and neither **remove** nor prune could touch it. Images now say what holds them (running,
  stopped, kept, from another gateway); **remove** names the stopped containers and removes them with your go-ahead; a new **clean up…**
  shows a plan with the reason and size of each candidate (and a list of what is not offered, and why) and removes only what you choose, then
  keeps the result on screen with the reason for anything that could not be removed; stopped chat containers that keep old images and saved
  states alive (each update keeps what a chat installed in a saved copy of the image, so the old builds stay behind them) are offered as
  the way to free them, never preselected, and the saved states and builds under them go in the same run; saved container states and unlabelled
  leftovers are listed; and unused superseded images are tidied automatically after a build and every few hours
  (`IMAGE_AUTO_PRUNE`), never one in use.
- The unit tests no longer fail when the host's Pi ends in `.0` (for example 1.0.0): the "an older Pi" in the container-version test was
  made by lowering the last digit, which stays 1.0.0 there. Checked against Pi 1.0.0 end to end (see below).
- `./piper.sh doctor` (and the check at the end of `deploy.sh`) no longer fails with a JSON error when the dashboard has a password: it
  signs in with `DASHBOARD_PASSWORD` when that is set, and otherwise says the network check was skipped because the dashboard is
  locked.

### Changed
- **Dashboard navigation.** The 15-item sidebar is now 12 items in four groups (Monitor, Build, Infrastructure, Admin), and the
  long pages are split into tabs: Agents (Agents, Teams, Templates & import, Create), Files & profiles (Files, Profiles &
  packages), Containers (Containers, Terminal, Images, Pi on this host, Events & command) and Help (Documentation, About).
  The old *Agents* page is **Live chats**, *Endpoints* is **Agents**, *API Management* is **API keys**; Terminal, Profiles,
  Documentation and About moved into tabs, and the live-chat and container counts show as badges in the sidebar. Links
  of earlier versions (`#endpoints`, `#terminal`, `#profiles`, `#docs`, `#about`) keep working; `#agents` now opens the
  new Agents page rather than the live chats.
- A chat request and a run without a client (`runAgentTurn`, the base for jobs, delegation and teams) now share one
  path for session limits, crashed-session replacement, spend cap and model allow-list.

## [0.5.0] - 2026-10-01

### Added
- **Terminal.** An interactive root shell inside a running container, from the dashboard, with full-screen programs
  (vim, top), resizing and Ctrl-C. It needs a dashboard password, checks the request's origin, limits how many are
  open and closes idle ones, and every open and close is recorded without what was typed. Jobs a shell started do
  not outlive it. Settings: allow terminals, idle time, how many at once.
- **File browser.** Browse a key's or an agent's workspace and profile: folders, upload with progress and drag and
  drop, download, rename and move, delete, new folders and files, and a text editor that refuses to overwrite a file
  an agent changed meanwhile. Profile edits respect locks and size limits; changes are audited by path, never content.

### Changed
- Model speed is timed from the request going out (the event before the reply is announced), so providers that hold
  their response until the first token now report a prompt speed too.
- The dashboard serves xterm.js and its fit addon (MIT, in `vendor/`, listed in `THIRD_PARTY.md` and on the About
  page) from the gateway; they load only when the Terminal page is opened.

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
- **Model speed.** The Agents table shows each running agent's average token generation speed and prompt
  processing speed, and the Overview has a per-model chart of both over the last hour, 6 hours, day or week, kept for
  a configurable number of days (only model names, token counts and times are stored).
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
