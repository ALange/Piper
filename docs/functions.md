# Functions: what Piper can do, and where

A tour of every feature by the dashboard page that holds it. Use it to find where something is done; the
[Reference manual](reference.md) explains each in depth and [Variables](variables.md) lists every setting.

The dashboard is at `/dashboard`. With no dashboard password set it is open to whoever can reach the port:
**set one first** (Settings → Access). Several actions (the command box, updating the host's Pi) are refused
until a password exists.

## Overview

Live numbers at a glance: conversations, working and idle agents, free slots, one-off requests, requests, models,
spend, oldest agent. Below them a **Resources** section: host CPU, memory, load and free disk, the gateway
process, and the containers added up (running, CPU, memory against limits, processes, what they wrote to their
own disks), two charts over the last hour, and the five heaviest containers. Charts are real samples taken while a
dashboard is open, so they start empty after a restart. The top of every page shows a warning when chats cannot
start (Docker, the image or the network policy) or the disk is nearly full.

## Agents (live sessions)

Every live conversation: session fingerprint, model, the **Pi version in its container** (green when it matches
the gateway's, red when behind), age, idle time, time to expiry and what happens then (stops or ends), requests,
cost and state. **kill** ends one session; **kill all agents** ends every live session. Killing ends a chat for
good, unlike idling, which only stops it.

## Endpoints (agent endpoints)

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

## Models

Every model the gateway can route to, grouped by provider, from the operator's Pi and from the container
configuration. A **reload** button re-reads them.

## Spend

What agents have cost, per model and per day, today and all time, tokens, cache reads and writes, and what is
running now. Costs for bridged models are the gateway's own metering; for direct models they come from the
container's event stream.

## API Management

Create, revoke and delete API keys (a key is shown once, then only its hash is stored). Per key: expiry, session
cap, daily spend cap, allowed models, shared bundles, usage. In each key's detail (on the Profiles page) a
**Container** section holds its overrides (memory, CPU, processes, network, image, mounts, environment) and the
**persistent container** switch.

## Profiles

One row per key's profile (and per agent's): size, skills, extensions, workspace size, live chats, locked state.
Open one to see everything its agents get: its own skills and extensions, what each granted bundle adds, what a
running agent has loaded, the workspace with download, the container settings and **Update container**.
**lock** freezes a profile (mounted read-only, refused by the profile API); **reset** archives it and starts over.
Bundles are operator-owned folders of skills, extensions and prompts under `shared/`, granted per key.

## Audit

What was done to the gateway and what happened to it, with filters, paging and CSV export. What is recorded is set
in Settings → Audit. See [Security](security.md) for the categories.

## Settings

Tabs, each a set of variables stored in the database and applied live unless marked *restart*:
**Containers** (image, network, mounts, environment, limits, disk and alerts, agent port range, workspaces, Pi
config for containers, container health), **Sessions**, **Usage limits**, **Profiles**, **Models** (fallback),
**Audit**, **Access** (dashboard password, settings key), **Server** (address, port, logging, Pi location) and
**Other**. [Variables](variables.md) lists every one.

## Documentation and About

This handbook, and the About page: version, author, this installation's facts and the changelog.

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
