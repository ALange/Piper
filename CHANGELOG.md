# Changelog

All notable changes to Piper, newest first. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Integrations: external OpenAI-compatible chat endpoints, assignable to API keys.** A new dashboard
  section (Integrations, under Infrastructure) for adding a chat endpoint outside Pi's own provider
  catalogue — self-hosted inference, a third-party API — with an optional API key. **Overview** lists
  every endpoint's models, their capabilities (vision/embedding/audio/reasoning — chat is always
  implied) and whether the endpoint answered last time it was checked (an on-demand **recheck**, not
  polling); editing an endpoint opens an inline panel. A reasoning-flagged model also gets a
  configurable effort level (low/medium/high — the same `reasoning_effort` field Piper's own
  `/v1/chat/completions` already accepts); left blank, nothing is sent. **External Endpoints** lists
  the endpoints. **Wizard** adds one in three steps: name/URL/key, a **detect models** button that
  probes the endpoint's own `/v1/models` (best-effort, always editable, or add a model by hand), then
  review and save. **Access Control** grants specific models to specific API keys. A key with a
  granted model sees it in the client portal's own target picker and can chat with it exactly like an
  agent — except chat only: no tools, skills or extensions, since a bare completion endpoint can't run
  them, and no container either. The portal shows a live "Thinking…" block when a reasoning model
  streams its own reasoning content (`reasoning_content`/`reasoning`, whichever the endpoint sends) and
  the same status bar (model, context, generation speed) an agent turn shows, measured around the call
  itself. It's one direct, streaming, stateless HTTP call to the endpoint's own `/v1/chat/completions`
  (`lib/externalmodels.mjs`) — the browser resends the whole conversation each time, since there is no
  Pi session to keep it in.
- **Notebooks: a NotebookLM-style feature in the client portal.** A new page (`/notebook`, linked from
  the chat portal's sidebar, same login) where a key holder uploads documents or adds URLs as a
  notebook's **sources**; each is extracted by that notebook's own agent (in its own container, the
  same way RSS extraction already works — the gateway never parses a file or fetches a URL itself),
  then chunked and embedded. **Chat** asks grounded questions against just those sources, with
  citations back to which one the answer came from; a question that can't be answered from them says
  so rather than guessing. **Generated** produces a summary, an FAQ, or a study guide from the whole
  notebook. A failed extraction is discarded and can simply be re-added, the same tolerance this
  session's own RSS fix already established — never a dead "failed" row.
  Retrieval is a plain cosine-similarity scan over embeddings kept as BLOBs in the existing SQLite
  database — no new service, no vector database; the one new host-side network call is to an
  OpenAI-compatible embeddings endpoint (`NOTEBOOK_EMBEDDING_URL`/`_MODEL`/`_API_KEY`), the same trust
  tier as RSS's own feed-fetching (a fixed, operator-configured address). `NOTEBOOK_ENABLED`,
  `NOTEBOOK_SOURCE_MAX_BYTES`, `NOTEBOOK_MAX_SOURCES` round out the new settings.
- **Edit an environment's Dockerfile right from Containers → Images.** An **edit Dockerfile** button
  next to each environment's **build**/**rebuild** opens it as plain text (Ctrl+S to save). Saving only
  changes the file on disk — nothing is built automatically; use the existing build/rebuild button
  afterward, same as editing it by hand always required.
- **Edit the default container settings (image, network, memory, cpus, pids, mounts, env) right from
  Containers → Images**, next to the environments they apply to — the same settings Settings →
  Containers already has, just surfaced where you're already looking when picking or building an
  image. Saving applies to a container the next time it's created or recreated, same as before.
- **A username+password login for the client portal, as an alternative to pasting the API key.** Set
  one up once (the ⚙ button next to **log out**) and the login screen's **Password** tab logs in with
  it from then on. This never hands back the raw key: a successful password login issues a separate
  session token of its own (`PORTAL_SESSION_MS`, default 30 days), signed with that key's own password
  hash the same one-way way the dashboard's own password already is — changing or removing the
  password ends every session of its own at once, with nothing to separately revoke. Wrong attempts
  are throttled per username (exponential backoff, same mechanism the dashboard's login already uses).
- **Auto-compaction is now visible in the client portal.** When an agent's context gets full and Pi
  compacts it automatically (or recovers from an overflow), a short note now appears in the chat
  ("context is getting full; compacting automatically…", then "compacted the context: 42000 → 18000
  tokens") and the context figure in the status bar updates live, mid-turn, instead of only reflecting
  it once the whole turn finishes. Built on the same live-session log already used for reconnecting to
  a running turn: `LiveLog` now understands Pi's own `compaction_start`/`compaction_end` events.
- **An HTML file previews as a rendered page in the client portal, not just as text.** Clicking a
  `.html`/`.htm` file in the workspace browser (one an agent just wrote, or one you uploaded) now opens
  it in a sandboxed `<iframe>` (`sandbox="allow-scripts"`, no `allow-same-origin`) instead of dumping its
  source — it can run its own script, but can never read this page's session or API key.
- **Multiple conversations in the client portal can be busy at once.** A single page-wide "busy" flag
  used to block sending (or even switching away) while any one chat was streaming — in practice, only
  one conversation could ever be running at a time. Busy is now tracked per conversation: start a turn
  in one, switch to another, and send there too; each streams independently, and the sidebar marks
  every conversation still working with a small dot.
- **A turn in the client portal survives closing the tab, and reconnecting catches up on it.**
  Previously, losing the connection (closing the tab, a network drop) aborted the agent's turn in
  progress — the opposite of "it kept running while I was away." The turn is no longer tied to the
  connection that started it: closing the tab lets it keep going, and reloading the page, logging back
  in, or just switching back to that conversation now catches up on whatever happened while you were
  disconnected, live if it's still running. A real "stop" button (`POST /api/conversation/:id/interrupt`)
  replaces the old "the browser going away stops it" trick. Built on the same live-session log the
  dashboard's own operator view already used (`GET /api/conversation/:id/events`).
- **Tools & Extensions and Skills sidebars in the client portal.** Two new buttons next to **files**
  open a sidebar listing what the current agent has loaded: Skills shows each skill command with its
  description and where it came from (your own profile, a shared bundle, or this workspace); Tools &
  Extensions shows your own extension files, any shared (read-only) ones granted by the operator, and
  the commands extensions have added. Backed by two new routes, `GET /api/skills` and
  `GET /api/extensions`, which ask the same running Pi session the `/skills` and `/extensions` chat
  commands already did — the text and the sidebar can never show something different.
- **`/reload` and the other gateway chat commands now work in the client portal and the dashboard
  Playground, not just the plain API.** `/piper`, `/reload`, `/skills`, `/extensions`, `/settings` and
  `/profile` were only ever intercepted inside `/v1/chat/completions`; a chat through the Portal or
  the Playground sent the literal text to the agent instead, since both go through `runAgentTurn`
  directly. `runAgentTurn` now answers these itself, the same as the plain API always did.
- **Attachments in the client portal.** A message can now carry images and documents: a 📎 button
  beside the composer or a plain paste into it (a screenshot, a copied file). An image goes through
  the same native vision pipeline the dashboard's Playground already has — shown as a readable
  thumbnail in the chat, click for full size — and is dropped with a note instead of sent if the
  agent's own model cannot see images. A document has no such pipeline in Pi's own protocol, so it is
  uploaded straight to the agent's workspace (`uploads/<name>`) with a line added to the message
  mentioning it, for the agent to read with its own tools; it shows as a small 📄 link in the chat
  after sending. `PORTAL_ATTACHMENT_MAX_BYTES` caps one image's decoded size (a document instead uses
  the ordinary `FILE_UPLOAD_MAX_BYTES`).
- **The client portal's chat history is kept server-side.** A key's whole conversation list (titles,
  which agent, every message) now syncs to the gateway (`GET`/`PUT /api/history`), not just the
  browser it was started in — log in from another browser or device and the same chats are there to
  continue. The browser's own local copy stays as the fast, offline-friendly first read; the server
  sync is fire-and-forget and never blocks the UI. `PORTAL_HISTORY_MAX_BYTES` is a hard backstop on one
  key's total stored history (the browser already trims itself well under it); deleting a key deletes
  its stored history with it.
- **Regenerate an API key.** The full value of a key is shown only once, right when it is created —
  it is never stored, so there was no way to get a working copy back if it was lost, short of deleting
  the key and starting over (losing its name, limits and grants with it). API keys → **regenerate**
  issues a brand-new secret for that same key in place: same name, limits, bundles and agents, shown
  once in the same reveal panel to copy. The old secret stops working immediately.
- **A client portal.** A standalone page, on its own port (`PORTAL_PORT`, off by default —
  `PORTAL_ENABLED`), where a key holder logs in with their own API key — no dashboard password, and
  no way to pick any key or agent but their own — and chats with their own agents and browses their
  own workspace files. Reuses the same chat mechanism as the dashboard's Playground (a real turn,
  streamed) and the existing workspace file API, with every route locked to the key presented in
  `Authorization: Bearer <key>`; a `keyId` in a request body is never trusted, only `credentialFor`'s
  own ownership check. The key is kept in the browser's `sessionStorage` only — gone on logout or when
  the tab closes, never remembered across restarts.
- **Knowledge base, with RSS as its first source.** The gateway polls RSS/Atom feeds you add, and for every
  new entry has a real agent of yours (your choice of model, memory, extensions and skills) fetch the article
  and extract it clean — no ads, navigation or sponsored sections — into title, text, a short summary and
  tags. Every chat can then search and read it through two new tools, `piper_knowledge_search` and
  `piper_knowledge_read` — read and search only, never write or delete, so an agent can draw on it without
  being able to corrupt it. A feed's first poll only seeds its current entries; nothing is extracted until
  something genuinely new shows up, so adding a feed never backfills a history you did not ask for. The
  storage itself (`knowledge_entries`, keyed by a source type and reference) is source-agnostic by design —
  RSS is the first producer, not the only one planned. A new **Knowledge** page manages feeds (add, edit,
  pull now, delete) on its Feeds tab, and every entry (view, retry a failed one, delete, clear a whole
  source) on its Entries tab. `KNOWLEDGE_ENABLED`/`RSS_ENABLED` are separate switches on purpose, so new
  extraction can be paused without losing agents' ability to read what is already there; `RSS_MAX_FEEDS`,
  `RSS_MAX_PARALLEL_EXTRACTIONS`, `RSS_EXTRACT_TIMEOUT_MS`, `RSS_MAX_ARTICLE_BYTES`, `RSS_DEFAULT_AGENT` and
  `KNOWLEDGE_RETENTION_DAYS` round out the Settings → Knowledge group. The Feeds tab shows each feed's last
  poll and its last article's own outcome (success, blocked, failed), so a problem is visible without opening
  the Entries tab. When a fetch looks blocked rather than merely failed (a 403, Cloudflare, a CAPTCHA), the
  same agent gets one more try in the same turn — the Wayback Machine, a search for the same report
  elsewhere, or whatever its tools allow — before the entry is marked **blocked** (a status distinct from a
  plain failure) instead of giving up on the first try; `RSS_AUTO_UNBLOCK` (on by default) is the switch. The
  Entries tab can search by title, and select and delete entries one at a time or in bulk; it no longer shows
  a feed's skipped (backfilled) entries, since there is nothing to read or act on there. A new **Log** tab
  lists every poll, extraction and operator action (newest first) — the audit log, filtered to Knowledge and
  RSS actions.
- **Agent memory.** A chat can remember durable notes across its own chats and containers, through three new
  tools: `piper_remember` (write or update a note), `piper_recall` (read one back by name), `piper_memories`
  (list or search notes, newest first). Never read or written through the container's own filesystem — every
  call crosses the bridge, and only the gateway itself ever touches the data. A key's own chats always share
  one memory; a named agent's does too, either its own or (chosen when the agent is created, fixed afterward
  like its workspace mode) folded into its key's. The agent can write and read but not delete — a new Memory
  page lists every scope with notes (count, size, last updated), and lets the operator view, delete one, or
  clear a whole scope. `AGENT_MEMORY_ENABLED` (on by default) is the one switch; `MEMORY_MAX_ENTRIES`,
  `MEMORY_MAX_NAME_BYTES`, `MEMORY_MAX_VALUE_BYTES` and `MEMORY_LOOKUP_LIMIT` keep one memory bounded. Deleting
  an agent or a key removes its memory with it.

### Fixed
- **One missing or broken extension took a whole chat's container down.** A shared bundle or library
  extension that was granted but whose folder is no longer actually on the host (removed by hand, a restore
  that missed it), or is there but is not a usable Pi package (a half-written edit, a file deleted out from
  under it), was still mounted and pointed to; Pi refuses to start at all when even one of its `-e` extension
  paths does not exist or does not load, so the chat failed outright with "the chat's container failed to
  start". It is now left out of that run instead, the chat is told once ("an extension this chat was granted
  could not be found or loaded on the host and was left out: `<name>`. Reinstall or remove it on
  Extensions."), and it mounts again on its own the moment it is fixed.
- **Updating an extension could break an already-open chat, or leave one stuck failing to start.**
  Reinstalling a library extension under the same name swapped its content in place without changing
  anything a running container's bind mount or its signature cared about, so an open chat kept pointing at
  the old copy's files — and those were then deleted as part of the swap, right out from under it — while
  only getting a soft, in-place reload rather than a real restart. Installing (as an update), updating, or
  removing a library extension, and deleting a shared bundle, now close every chat currently using it and
  wait for its container to actually stop *before* touching the directory on disk, and a same-name reinstall
  now changes the container's signature too, so the chat's next message gets a freshly recreated container
  with the new content (what the agent had installed in it is carried over, same as any other settings
  change) instead of a stale or missing mount.

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
- **A wedged Pi could pin a chat's session forever.** Only starting a container raced against a timeout; every later
  command (a prompt, an abort, a model switch) waited however long Pi took, with no backstop, so a stalled Pi (not
  crashed, just silent) never freed the session for reaping or for the key's session cap. `PI_COMMAND_TIMEOUT_MS`
  bounds one command's round trip, `PI_IDLE_TIMEOUT_MS` ends a turn that goes fully silent while something still
  waits on it, and `SPAWN_TIMEOUT_MS` is now a setting instead of fixed in code.
- **A container "recreate" or "remove" could race a message that resumed the same chat.** Stopping the old container
  and removing it were two separate steps; a message arriving in between could build and start a fresh container
  under the same name before the removal ran, which then destroyed it. `removeContainer` now checks the container's
  id is still the one it meant to remove, inside the same lock a concurrent rebuild uses, and skips the removal
  (telling the operator why) rather than destroying what was just resumed.
- **A schedule outlived the permission that made it.** Turning off an agent's own scheduling permission, the
  `AGENT_JOBS_ENABLED` switch, or the agent itself did not stop its jobs: they kept firing (or kept failing and
  eventually auto-disabling themselves, with the noise that makes). Such a job is now simply not queued on its due
  tick, and resumes on schedule, with no backlog, once the agent or its permission is back.
- **A hung `npm install` or `git clone` reported as a plain failure.** The extension library's host install killed a
  command that ran too long but then reported it the same as one that genuinely failed (`npm exited with code 1`),
  with no sign it was a timeout. It now says so (`npm timed out after 10 minutes`), and only when the timeout itself
  is what ended it — a coincidental matching exit code (the host killing it for memory, say) is not mistaken for one.

### Changed
- **One shared job tracker, instead of four copies.** The image build, host/container update, extension and package
  install jobs each kept their own copy of the same "one at a time" guard and log-trimming logic, which had already
  drifted (one kept 200 lines of log, the others 300). Both are now one small shared helper (`lib/jobtracker.mjs`);
  every job keeps 300 lines.
- **One shared package-source check**, instead of two copies that had already drifted in wording (`lib/packagesource.mjs`),
  used by both the extension library and a key's or agent's own Pi packages.

### Fixed (continued)
- **Force-removing an image whose stopped container refused to go** removed the image anyway, discarding the
  container-removal failure. It now stops and names the container, the same way the Containers page's own cleanup
  already did (the two had drifted).
- **Deleting a key could stick partway** if one of its teams failed to delete cleanly (its own agents and jobs
  already gone). `deleteTeamsOfKey` now tolerates one bad team the same way `deleteAgentsOfKey` already does.
- **A team's port being taken on restart was silent.** An agent's own port being taken raises an alert and an
  audit row, so a client with the old address learns to update it; a team's equivalent fallback did the same
  thing with neither. It now matches.
- **A wizard package install could be silently dropped.** The package job tracker is global, not per agent, so
  two agents created around the same time (or an operator installing a package elsewhere) could make the
  wizard's own install find the tracker busy — and it gave up with no log, no audit, while still reporting the
  package as queued. It now waits the busy job out, and a genuine failure is recorded, not swallowed.
- **A transient failure to reach the bridge socket at container start disabled a chat's model providers and
  its delegate, schedule and model-switch tools for the container's whole life**, with no retry. The one call
  this could happen to (fetching the model catalogue, before anything else loads) now retries a few times and,
  failing that, continues with an empty catalogue instead of taking the rest of the extension down with it.
- **A client that sends only images, with no explicit session id, got a brand-new session (and container) on
  every single request** — nothing to derive a stable id from. An image-only first message now seeds one from
  the image itself.

### Added (continued)
- **`AGENT_MAX_PER_KEY` / `TEAM_MAX_PER_KEY`** (both default 50): a cap on agent endpoints and teams per key,
  matching every sibling resource (jobs, schedules, delegation depth, team steps). Each endpoint opens its own
  port from `AGENT_PORT_RANGE`, which had no guard against a scripted bulk-create exhausting it.

### Changed (continued)
- Dashboard JSON responses across the API-key, agent, container and host-Pi routes, the bundle/package routes
  and the file-browser routes now go through one shared `sendJson(res, status, value, {noStore})` instead of
  each repeating the same three lines (one copy, in `lib/profiles.mjs`, had already drifted into its own
  same-shaped `sendJsonHttp` function). An unused `node:path` import was also removed from `lib/http.mjs`.

### Testing
- Direct coverage added for several things that previously had none: `chatCompletions` itself (streamed and
  non-streamed, `X-Session-Id` resumption, audio rejection, the spend-cap ordering) over a real HTTP request
  against a fully scripted container; the dashboard's brute-force login backoff (not just one wrong password);
  the SSRF guard's actual wiring (`fetchImage`/`guardedLookup`), not only the address blocklist; and the
  workspace file API (`/v1/piper/files`) and the dashboard's file browser (list, text edit with its conflict
  check, mkdir, move, delete, upload/download/delete, the workspace quota), both run against the real profile
  helper script rather than mocked away.

### Fixed
- **A failed RSS article extraction is discarded and simply tried again next time its feed is polled,
  instead of sitting forever as a `failed` entry waiting for someone to notice and click retry.** The
  guid is freed the moment the row is gone, so the next poll sees it as new again; the reason is still
  on record in the Log tab. `blocked` (a site deliberately refusing automated fetches) is unchanged —
  that one is worth a person's attention and is still kept, still retriable by hand.

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
