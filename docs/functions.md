# Functions: what Piper can do, and where

A tour of every feature by the dashboard page that holds it. Use it to find where something is done; the
[Reference manual](reference.md) explains each in depth and [Variables](variables.md) lists every setting.

The dashboard is at `/dashboard`. With no dashboard password set it is open to whoever can reach the port:
**set one first** (Settings → Access). Several actions (the command box, updating the host's Pi) are refused
until a password exists.

The sidebar groups the pages by what you are doing:

| Group | Page | What it holds |
|---|---|---|
| (top) | Playground | A chat with any key's agent, in the dashboard |
| **Monitor** | Overview, Live chats, Spend, Audit | How the gateway is doing, what is running now, what it cost, what happened |
| **Build** | Agents, Extensions, Jobs, Files & profiles | Named agents (with teams, templates, import), prompts that run on their own, and what agents are given: files, profiles, packages, MCP servers, bundles |
| **Infrastructure** | Containers, Models | Containers (with a terminal, images, the host's Pi), and the models that can be used |
| **Admin** | API keys, Settings, Help | Keys and their limits, configuration, this handbook |

Pages with several parts have tabs along the top (Agents: Agents, Teams, Templates & import, Quick create, Wizard; Files & profiles: Files,
Profiles & packages; Containers: Containers, Terminal, Images, Pi on this host, Events & command; Help: Documentation,
About). A link such as `#agents/teams` opens a tab directly, and the links of earlier versions (`#endpoints`,
`#terminal`, `#profiles`, `#docs`, `#about`) still work. The old Agents page of live chats is now **Live chats**; the old
Endpoints page is now **Agents**.

## Playground

The first item of the menu: a chat with an agent, laid out like the chat apps you know. Pick **who to talk to** (a key's main
endpoint, or one of its agents) and optionally a **model** from what that key may use, then type. Answers stream in as they are
written, with **Markdown** (headings, lists, tables, quotes, code blocks with a copy button) and, collapsed above the answer, the
agent's **thinking** and each **tool call** with what it ran and what came back. **Enter** sends, **Shift+Enter** is a new line,
**Stop** ends the turn (the agent's turn is stopped too), **retry** asks the last question again, **copy** copies an answer.
The left column lists your chats (search, rename by double-click, delete); **export** downloads one as Markdown.

It is a real chat: it runs as that key or agent, so the key's session cap, daily spend cap and model list apply, the cost is
the key's and the agent's, and the agent can use its tools in its container. A chat keeps its agent for its whole life and
continues after a gateway restart. The messages you see are kept **in this browser only** (the gateway keeps just the live session,
which expires like any chat's); deleting a chat also ends its session. It needs a dashboard password and `PLAYGROUND_ENABLED`.
Slash commands and image attachments are not part of it yet.

## Overview

Live numbers at a glance: conversations, working and idle agents, free slots, one-off requests, requests, models,
spend, oldest agent. Below them a **Model speed** section: one card per model that agents used, with its average
generation and prompt-processing speed (tokens per second), the number of calls and a chart of each over the last
hour, 6 hours, day or week. Speed is timed from the agent's own event stream on every model call: generation is the
output tokens after the first one over the time from the first token to the end; prompt speed is the processed
prompt tokens (input plus cache writes, not cache reads) over the time from the request going out (the event before
the reply is announced: the prompt, or a tool result) to the first token, so it includes network and queueing time
and reads low for short prompts. Calls with under 64 prompt tokens or under 8 output tokens are
not counted for that figure, and a provider that does not stream cannot be timed. Averages are token totals over
time totals. `SPEED_HISTORY_DAYS` (Settings → Server) sets how long the history is kept (0 keeps none); only model
names, token counts and times are stored. Below it a **Resources** section: host CPU, memory, load and free disk, the gateway
process, and the containers added up (running, CPU, memory against limits, processes, what they wrote to their
own disks), two charts over the last hour, and the five heaviest containers. Charts are real samples taken while a
dashboard is open, so they start empty after a restart. The top of every page shows a warning when chats cannot
start (Docker, the image or the network policy) or the disk is nearly full.

## Live chats

Every live conversation: session fingerprint, model, the **Pi version in its container** (green when it matches
the gateway's, red when behind), its average **generation speed** and **prompt processing speed** in tokens per
second (hover for the last call and each model's figure), age, idle time, time to expiry and what happens then (stops or ends), requests,
cost and state. **watch** opens a live view of the chat (below). **kill** ends one session; **kill all agents** ends every live session. Killing ends a chat for
good, unlike idling, which only stops it.

### Live view

**watch** on a row opens a drawer that follows the chat as it happens: what you and the agent said, its thinking
(dimmed), and each tool call with what it ran and what came back (results are cut at 2 KB). The header shows the
model, tokens and cost. **interrupt** stops the turn that is running (the chat stays, and the next message
continues it); **transcript** downloads the conversation so far as Markdown (tool results cut at 4 KB each).
Only a chat that is running can be watched, and what it shows is what happened since the chat was last started:
the last 300 items, kept in memory. It needs a dashboard password, because it shows what people say to agents.

## Spend

What agents have cost, per model and per day, **per key and agent**, today and all time, tokens, cache reads and writes, and what is
running now. Costs for bridged models are the gateway's own metering; for direct models they come from the
container's event stream.

## Audit

What was done to the gateway and what happened to it, with filters, paging and CSV export. What is recorded is set
in Settings → Audit. See [Security](security.md) for the categories.

## Agents

Named, permanent agents of an API key, each on its own port, for different roles on one key (an `architect`, a
`coder`, a `researcher`).

- **Create** for a usable key: a name, optional default model and thinking level, workspace `own` or `shared` with
  the key, optional container limits, and **instructions** (written to the agent's `AGENTS.md`).
- **Each row** shows the URL to point an OpenAI client at, its state (`listening`, `disabled`, `port-lost`), the
  workspace, model and live chats. Buttons: **edit** (name, model, instructions, limits), **disable** / **enable**,
  **new port**, **update**, **reset**, **delete**.
- **Rules.** The port accepts only the owning key and serves only the API. The agent always has one persistent
  container. Limits, spend and the model allow-list stay on the key. Deleting archives its profile and own
  workspace instead of deleting them.

### The creation wizard

**Agents → Wizard** creates an agent step by step, with a review before anything is made (the Quick create tab does the same
in one form):

1. **Key & template**: **use an existing key or create a new one** (a name and an expiry; the new key is made together with the agent and
   its secret is shown once on the last screen), and a template (or a blank agent), each shown with its description, skills and
   hand-off setting.
2. **Identity**: name, description, model, thinking level, own or shared workspace.
3. **Instructions & skills**: the instructions (prefilled from the template) and the template's skills as checkboxes; you can leave
   skills out and **add your own** (a name and a `SKILL.md` with a name and description header).
4. **Extensions**: the agent follows its key, or gets **its own list** of library extensions and shared bundles; and optionally up
   to five Pi packages to install into **its own profile** (queued after creation, with the output shown).
5. **Limits & hand-offs**: container limits and network, and whether it may hand work to its key's other agents.
6. **Review**: everything that will be created, with warnings (a missing name, no description).

Everything is checked again on the server, in one place: names and paths, sizes, the model against the key's allow-list, container
settings. If anything fails the agent is removed again, so nothing half-made is left. Granting extensions and installing packages
need a dashboard password, like the Extensions page.

### Hand-offs between agents

Switch **may hand work to the other agents of its key** on an agent's editor (and give each agent a **description**: what
it is for). That agent then gets two tools: `piper_agents` lists its colleagues with their descriptions, and
`piper_delegate` gives one of them a self-contained task and waits for the text answer. The colleague is a whole turn on
the other agent with its own instructions, skills, files and container, run with the same key, so the key's limits and spend
apply and the cost is the key's. Colleagues are only the **enabled agents of the same key**: never itself, never anyone
already waiting in the chain (a call back would never be answered), and the chain is at most `DELEGATE_MAX_DEPTH` deep. A
colleague keeps its conversation across the calls of one chat. If the caller is stopped (interrupt, kill), so is the
colleague's turn; a hand-off that takes longer than `DELEGATE_TIMEOUT_MS` is stopped and the caller told. Each hand-off is
a `runtime.delegate` audit row and a note in the live view.

### The orchestrator template

Create an agent from the **orchestrator** template (Agents → Create → pick the template) and talk to it: it coordinates the
other agents of its key. Hand-offs are on from the start, and at the start of **every turn** it is given the list of its
colleagues with their descriptions, so an agent created a minute ago is used on the next message with nothing changed on the
orchestrator. Its instructions make it split the request, match parts to colleagues by their descriptions, write each hand-off
as a self-contained brief, send independent ones together (Pi runs tool calls from one message at the same time, so different
colleagues work in parallel), check what comes back, and report who did what. Its workspace is shared with the key, so files a
colleague writes are visible to the others.

It chooses by what each agent says it is for, so **give every agent a description** (Agents → edit). An agent without one is listed by
name only, and the orchestrator says it is guessing. Any agent with hand-offs switched on gets the same list; the orchestrator is
just the one made for it. Every hand-off is a model turn on the key, so the key's spend and session caps, `DELEGATE_MAX_DEPTH` and
`DELEGATE_TIMEOUT_MS` bound it.

### Teams

A **team** is a fixed chain of agents of one key with an OpenAI-compatible endpoint of its own (a port, like an agent's;
only the owning key may use it). A chat completion runs the steps in order: each step has an agent and an instruction
containing `{{task}}` (the newest user message) and/or `{{previous}}` (the last step's answer); the last step's text is
the reply. Progress (`▸ step 1 of 3: architect`) streams as reasoning. The agents keep their context across follow-ups of
the same conversation (send `X-Session-Id`). A failing step stops the run and is named in the error. At most
`TEAM_MAX_STEPS` steps; every step is a turn on the key.

### Templates, clone, export and import

On the Agents page (Templates & import tab, and the buttons on each agent's row):

- **Templates.** Pick one when you create an agent and it starts with that profile: instructions, skills and settings
  (model, thinking level, workspace mode). Five ship with Piper (`architect`, `coder`, `researcher`, `reviewer` with a
  review checklist skill, `devops`; the files are in `templates/`). **save as template** on an agent keeps a copy of its
  profile in the database (up to `TEMPLATE_MAX_BYTES`) for new agents; deleting a template never touches agents made from it.
- **Details and editing.** Click a template to see its description, model, thinking level, workspace mode, hand-off setting and
  every file with its text. Your own templates can be edited in place (fields, instructions, skills, any file; add or remove
  files); the built-in ones are read-only, so **copy to edit** makes one of yours. Changes apply to agents created from it from
  then on, never to agents already made.
- **Clone** makes a new agent of the same key with this one's profile and settings. Its workspace and its container's
  installed state are not copied: it starts clean.
- **Export** downloads one JSON file (`piper-agent`, version 1): the agent's name, description, model, thinking level,
  workspace mode and memory/process/CPU limits, plus its instructions, settings, skills, extensions, prompts and agent
  definitions. Never `auth.json`, model files, environment, mounts, image or network, and never a key.
- **Import** reads such a file into any key, here or on another gateway, under a name you choose. It needs a dashboard
  password, because a bundle can carry extensions (code). A model the gateway does not have is dropped and reported.

Only regular files travel. A link or an odd file in the profile is skipped on export, and cannot be expressed in a
bundle; every path is checked when the bundle is read and again by the profile helper that writes it.

## Jobs

A job is a prompt an agent runs with nobody at a client. Each belongs to a key (and optionally one of its agents) and
runs **as that key**: its session cap, daily spend cap and model list apply, the cost is counted to it and to the
agent, and a revoked, expired or switched-off key runs nothing (the run is recorded as *skipped*, with the reason).

Three things start a run:

- **A schedule**, in the gateway's local time: every N minutes or hours, every day at a time, on chosen weekdays at a
  time, once, or only when started. A job never overlaps itself (a run that finds the previous one still going is
  recorded as skipped). After downtime a missed run is made up **once**, not once per missed time.
- **A webhook**: *create webhook trigger* gives the job a token, shown once and stored only as a hash. `POST
  /v1/piper/jobs/<id>/trigger` with `Authorization: Bearer <token>` (or `X-Piper-Token`) starts it; the request body (cut
  at 16 KB) replaces `{{payload}}` in the prompt. Calls closer than `JOBS_MIN_INTERVAL_MS` get 429. Revoke it any time.
- **A request** through the API: `POST /v1/piper/jobs` (see the [API](api.md)).

Each run has a time limit (the turn is stopped when it passes), a history with status, duration, cost and the full
result text, and a **cancel** while it is going. A job can **continue one conversation** (the agent remembers earlier
runs) or start fresh each time. With a **webhook URL** the finished run is POSTed there as JSON, signed in the
`X-Piper-Signature` header (`t=<seconds>,v1=<hex>`: HMAC-SHA256 of `<seconds>.<body>` with the job's signing secret,
shown once); a failed delivery is retried once and the outcome is written on the run.

Settings (Settings → Jobs): `JOBS_ENABLED`, `JOBS_MAX_PARALLEL`, `JOBS_MIN_INTERVAL_MS`, `JOBS_MAX_PER_KEY`,
`JOBS_RESULT_DAYS`.

## Files & profiles

Browse the **workspace** (what the agents see at `/workspace`) or the **profile** (skills, extensions, `AGENTS.md`,
settings) of a key or an agent. Folders first, then files; click a folder to enter it. **upload** takes many files
(or drop them on the table), with progress; per row: **download**, **rename** (also moves: give a new path),
**delete**; **new folder** and **new file** in the current folder. Clicking a text file opens an **editor**: Ctrl+S
saves, and if an agent changed the file after you opened it the save is refused as a conflict, with **reload from
disk** and **overwrite anyway**. Binary and very large files (over 1 MB) are download-only.

- A **locked** profile is read-only here, a profile over `PROFILE_MAX_BYTES` refuses saves, and a workspace over
  `WORKSPACE_MAX_BYTES` is frozen for writes (delete still works, to make room). Uploads are limited by
  `FILE_UPLOAD_MAX_BYTES`.
- Everything runs in a throwaway container with only that folder mounted; **links an agent planted are never
  followed**, in the browser or the downloads.
- Changes are audited with the path (`files.*` rows), never the content. Editing a profile reloads that scope's live
  chats, as the profile API does.

### Profiles

One row per key's profile (and per agent's): size, skills, extensions, workspace size, live chats, locked state.
Open one to see everything its agents get: its own skills and extensions, what each granted bundle adds, what a
running agent has loaded, the workspace with download, the container settings and **Update container**.
**lock** freezes a profile (mounted read-only, refused by the profile API); **reset** archives it and starts over.
Bundles are operator-owned folders of skills, extensions and prompts under `shared/`, granted per key.

### Extensions (library and access)

The **Extensions** page installs Pi extensions **on this host** and decides who gets them.

- **Library tab.** Install a package from `npm:name[@version]`, `git:host/owner/repo[@ref]` or an `https://` repository. The host's
  own npm or git downloads it into the library (`EXTENSIONS_ROOT`), with **install scripts off** unless you tick *allow install
  scripts* (they would run as the gateway's user), git hooks disabled, and an environment holding nothing but `PATH`. What arrives
  must be a Pi package (a `pi` section in `package.json`, the `pi-package` keyword, or `extensions/`, `skills/` or `prompts/`
  folders) and fit `EXTENSION_MAX_BYTES`, or it is removed again. **update** installs it again from the same source; **remove**
  asks first when something gets it. The code is never run on the host.
- **Access tab.** A matrix of who gets which library extension or shared bundle, at three levels: the **default** for every key
  (`SHARED_BUNDLES`), a **key** (all of its agents) and an **agent**. A key or agent either *follows* the level above or has *its own
  list*; the last column shows what it finally gets. A change stops the affected live chats, and each resumes on its next message
  with the new set. An agent's own installs (Files & profiles → Profiles → Packages) are separate and always its own.
- A granted extension is **mounted read-only into the container and run there**, under that agent's network policy and limits, the
  same as a shared bundle.

Needs a dashboard password; `EXTENSIONS_ENABLED` switches installs off.

### Packages and MCP servers

The detail view of a key's or an agent's profile (Files & profiles → Profiles) has a **Packages and MCP servers** section.

- **Packages.** The packages in the profile's settings; **install** (`npm:name[@version]`, `git:host/owner/repo[@ref]` or an
  `https://` repository, nothing else: no local paths, no flags), **remove**, **update all**. They are Pi's own packages, so
  skills, extensions and prompts they carry load in that agent's chats.
- **MCP servers.** The servers in the profile's `mcp.json` with what each runs; **add** a command (stdio: one program, its
  arguments, environment) or a URL (HTTP, with a bearer-token variable), **remove**, **enable/disable**, and **test
  connections** (`pi mcp list`: state, tools and errors). **Secrets are never written to `mcp.json`**: an environment value
  must be a `${NAME}` reference, and the variable itself goes in the key's or agent's extra environment (container settings).
- Each action is Pi's own command (`pi install`, `pi mcp add`) run in a **throwaway container**: the scope's image and limits,
  only that profile mounted, no other mount or key, a ten-minute limit, and a network only when needed (an install, a test)
  and only if the scope's policy is not `none`. Output streams into the panel. The live chats of that scope reload after.
- Packages and MCP servers **run third-party code**. Changes need a dashboard password; `PACKAGES_ENABLED` switches the
  feature off.

### Shared bundles

**Files → Bundles** (the third root of the file browser) edits the shared bundles under `SHARED_ROOT`: **new bundle** (creates `skills/`, `extensions/` and
`prompts/`), the same browser and text editor as for profiles, upload, rename, delete, and **delete bundle**. Granting a
bundle to keys stays on the API keys page. After a change the live chats of every key and agent that gets the bundle reload.
A bundle that is a link (you pointed it at another folder) is shown but not edited here. Changes need a dashboard
password, because every granted key runs a bundle's extensions.

## Containers

Everything Docker-related.

- **Containers table.** One row per container this gateway made: key, chat, state, **Pi version** (green current,
  red older than the gateway's, amber newer, grey being read), uptime, CPU, memory, what it wrote to disk, network,
  requests, last use. Persistent containers are marked ★.
- **Row actions.** **stop** (the chat resumes on its next message, with what was installed), **update** (rebuild
  with current settings *keeping what is installed*, set Pi to the gateway's version, update its extensions),
  **recreate** (remove the container and its saved state: a clean start; a persistent container's installs are lost)
  and **remove** (end the chat and remove its container; the workspace stays).
- **Update all** does that for every container in turn, skipping any with a request running. Progress shows in the
  panel at the bottom right and stays until closed.
- **Command box.** Runs one shell command as root in a running container, with a time and output limit. Refused
  until a dashboard password is set. Every command is recorded.
- **Pi on this host.** The Pi the gateway itself runs on: running, installed and newest versions, **check for
  updates**, and **update** for Pi and/or its extensions (password required; update only, then restart the gateway
  yourself). The host's extensions are listed as a table.
- **Images.** The environments chats run in (`full`, `slim`, any folder under `docker/environments`), build and
  rebuild with a live log, per-image Pi version and how many containers are behind, and prune.
- **Audit and events.** Kills, deaths and every action taken here, most recent first.
- **Health.** In Settings → Containers: whether Docker, the image and the network policy are in order, with a
  button to look again.

### Terminal

An interactive **root shell inside a running container**, in its `/workspace`: pick a container (or press **terminal**
on its row on the Containers tab, or the Terminal tab) and **connect**. It is a real terminal: colours, line editing, full-screen programs
such as `vi` and `top`, resizing with the window, Ctrl-C. Rules:

- It needs a **dashboard password** (like the command box), only attaches to a container that is **already running**
  (it never starts one), and the page must have been served by this gateway.
- It ends when you disconnect, when the shell exits, after `TERMINAL_IDLE_MS` with no typing (15 minutes by default),
  or when the container stops. Jobs the shell started in the foreground or background are ended with it; start
  something with `setsid` or `nohup setsid` if it must outlive the terminal.
- At most `TERMINAL_MAX_SESSIONS` (4) are open at once, and `TERMINAL_ENABLED` switches the feature off.
- Every open and close is in the audit log (container, who, from where, how long, bytes typed and shown). **What you
  type and what is printed is never recorded.**

## Models

Every model the gateway can route to, grouped by provider, from the operator's Pi and from the container
configuration. A **reload** button re-reads them.

## API keys

Create, revoke and delete API keys (a key is shown once, then only its hash is stored). Per key: expiry, session
cap, daily spend cap, allowed models, shared bundles, usage. In each key's detail (on Files & profiles → Profiles) a
**Container** section holds its overrides (memory, CPU, processes, network, image, mounts, environment) and the
**persistent container** switch.

## Settings

Tabs, each a set of variables stored in the database and applied live unless marked *restart*:
**Containers** (image, network, mounts, environment, limits, disk and alerts, agent port range, workspaces, Pi
config for containers, container health), **Sessions**, **Usage limits**, **Profiles**, **Models** (fallback),
**Audit**, **Access** (dashboard password, settings key), **Server** (address, port, logging, Pi location) and
**Other**. [Variables](variables.md) lists every one.

## Help

This handbook, and the About tab: version, author, this installation's facts and the changelog.

## In a chat

Messages starting with a slash are answered by the gateway, not the model:

| Command | What it does |
|---|---|
| `/piper` | List these commands |
| `/skills` | Skills loaded in this chat, marking shared ones |
| `/extensions` | Extensions in the profile and the commands they add |
| `/settings` | Show the profile's `settings.json` |
| `/settings set <key> <value>` | Change one setting, then reload |
| `/settings unset <key>` | Remove one setting, then reload |
| `/profile` | Size, quota and contents of the profile |
| `/profile reset` | Start the profile over from the template (asks to confirm) |
| `/reload` | Re-read skills, extensions, prompts and settings |

An agent can also write a skill or extension into its profile folder and `/reload`.

## See also

[Architecture overview](overview.md), [Operations](operations.md), [API](api.md).
