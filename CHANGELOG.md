# Changelog

All notable changes to Piper, newest first. Versions follow [Semantic Versioning](https://semver.org/).

## [1.1.5] - 2026-10-22

### Fixed
- **The Signal daemon was never actually starting.** It was invoked as `signal-cli -a <number> daemon
  --json-rpc`, but signal-cli's `daemon` subcommand is for its dbus/socket/tcp/http service modes and
  does not accept a `--json-rpc` flag at all -- it refused with "unrecognized arguments: '--json-rpc'"
  and exited immediately, every single time, crash-looping on respawn forever. The real subcommand for
  reading JSON-RPC requests on stdin and writing responses on stdout is `jsonRpc`, not `daemon`. Linking
  a number or sending a message would fail with "the signal-cli daemon is not running" the entire time
  this was broken -- which was always, since v1.1.0. Added a test asserting the actual command line
  passed to the subprocess, since the existing test coverage mocked the spawn away entirely and would
  never have caught a wrong command regardless of how it was invoked.

## [1.1.4] - 2026-10-22

### Fixed
- `deploy.sh --signal-number ... --install-signal-cli`, run a second time after a native build that
  turned out not to run on the host's CPU, kept finding that same broken leftover binary and trusting
  it blindly -- the "already there" check never verified it actually ran, only that it existed, so the
  Java-build fallback from the previous fix never engaged on a retry, only on the very first attempt.
  The "already found" path (whether via `command -v` or a previous install of this script's own) now
  runs `--version` before trusting it, same as a fresh install does; a broken one found this way is
  replaced automatically when `--install-signal-cli` is given (skipping straight to the Java build
  without re-downloading the native one it already knows fails, if that's what was found), or reported
  clearly with the real error if not.

## [1.1.3] - 2026-10-22

### Fixed
- `deploy.sh --install-signal-cli` now falls back to signal-cli's ordinary Java build when the native
  one (correctly extracted since the last fix) actually fails to run -- its native build is compiled
  for a specific, fairly modern x86-64 microarchitecture and refuses to start ("CPU ISA level is lower
  than required") on an older or more constrained CPU, common on budget or heavily virtualized hosts.
  There's no reliable way to detect this in advance, so it tries the native build and switches to the
  Java one the moment that attempt fails, rather than leaving the operator stuck. On non-x86_64 hosts
  (no native build exists) it goes straight to the Java build. If the Java build also can't run --
  missing or too old a JRE -- the failure message now includes the actual error (e.g. the exact class
  file version mismatch), instead of a generic "does not run here", so the operator knows precisely
  what to fix. The same final check now also runs for a pre-existing `signal-cli` this script merely
  found rather than installed, so a broken one is caught before the (confusing) registration step
  rather than during it.

## [1.1.2] - 2026-10-22

### Fixed
- `deploy.sh --install-signal-cli` extracted the downloaded tarball with `--strip-components=1`,
  copying Node's own install pattern -- but unlike Node's tarball (a top-level versioned directory),
  signal-cli's native release is a single executable at the tarball's root, so stripping one path
  component left nothing to extract: the install step reported success, but the binary was never
  actually there, and the next step failed with "No such file or directory" trying to run it.
  Extracts without `--strip-components` now, at `~/.local/signal-cli/signal-cli` (not
  `~/.local/signal-cli/bin/signal-cli`), and `chmod +x`s it explicitly rather than trusting the
  archive's permission bits alone.

## [1.1.1] - 2026-10-22

### Added
- **`deploy.sh` can now set up Signal for you.** New `--signal-number +<country code><number>`: finds
  (or, with `--install-signal-cli`, installs signal-cli's native Linux x86_64 build, no Java needed)
  signal-cli, and if the number isn't registered yet, requests a verification code and prints the
  exact command to run by hand once it arrives (that part can't be automated -- the code comes over
  SMS or a voice call, outside the script). Run again after verifying to store `SIGNAL_PHONE_NUMBER`/
  `SIGNAL_CLI_PATH`/`SIGNAL_ENABLED` and finish. Works against a fresh deploy or an existing one --
  it writes straight into `gateway.db` when one already exists, the same way `PI_AGENT_PACKAGE`
  detection already does, rather than only ever seeding a first start. New `--signal-voice` requests
  the code by voice call instead of SMS. See DEPLOYMENT.md's new Signal section.

### Fixed
- `deploy.sh --help` was printing a stray `set -euo pipefail` line at the end of its usage text (the
  extraction range included one line past the actual help comment).

## [1.1.0] - 2026-10-22

### Added
- **Signal messenger integration.** An agent (or a plain key) with the new `can_signal` switch gets
  three tools -- `piper_signal_enable`, `piper_signal_contacts`, `piper_signal_disable` -- to link a
  phone number to itself. Linking sends that number a real message right away from Piper's own,
  single registered Signal account; from then on, a Signal message from that exact number is routed
  to that agent/key's own persistent conversation and answered over Signal, and every other number is
  silently discarded. Off by default everywhere (global `SIGNAL_ENABLED`, and `can_signal` on both
  `agents` and `api_keys`, neither on by default even for a newly created agent -- unlike scheduling,
  this can message a real third party, so it's always an explicit opt-in). Bounded by a per-scope cap
  on how many numbers one agent/key may link and a gateway-wide daily cap on how many get linked at
  all, both configurable in Settings → Signal, plus a new dashboard Signal page listing every linked
  number with a one-click revoke -- the operator's brake pedal, independent of anything an agent does.
  Runs a supervised `signal-cli daemon --json-rpc` subprocess for the gateway's whole lifetime;
  signal-cli itself must already be installed and the number already registered and verified on the
  host before `SIGNAL_ENABLED` is turned on (see DEPLOYMENT.md's new Signal section) -- Piper only
  ever drives an already-registered account's daemon mode, it never registers or verifies one.

## [1.0.29] - 2026-10-22

### Added
- **A recurring job can now be told to stop after N runs.** Previously an interval/daily/weekly job ran
  forever once enabled, the same as "unlimited" -- there was no way to say "check this 5 times, then
  stop" without remembering to disable it by hand. The Jobs tab's job form has a new "runs, then stop"
  field (blank is unlimited, as before); the job list shows progress as "(3/5 runs)" next to its next
  run time. Reaching the limit switches the job off exactly the way repeated failures already do --
  `disabledReason` explains why, the owner is told, and turning it back on gives it a fresh run budget.
  A manual or webhook-triggered run never counts against the limit, only a scheduled one. Also exposed to
  an agent's own `piper_schedule` tool as `max_runs`, since "watch this N times then stop" is exactly the
  kind of thing an agent books for itself.

## [1.0.28] - 2026-10-22

### Added
- **Self-service scheduling for plain API keys, not just agent endpoints.** Previously `piper_schedule`
  and its sibling tools only ever appeared for a chat going through a configured Agent endpoint (gated
  on that agent's own "may schedule" switch) -- a chat running directly as a bare key had no way to get
  them, even with `AGENT_JOBS_ENABLED` on, since there was no per-key flag to hold the setting. Added a
  `can_schedule` column on `api_keys` (off by default, an explicit opt-in -- unlike a newly created
  agent, an existing key should not silently gain a new capability) and a matching "schedule" checkbox
  column on the API Keys table. A key with it on gets the same `piper_schedule`/`piper_schedules`/
  `piper_unschedule`/`piper_run_schedule` tools an agent gets, scoped to that key's own agentless jobs
  (an agent of the same key cannot see or touch them, and vice versa).

## [1.0.27] - 2026-10-22

### Added
- **"restart gateway" button on the dashboard's Containers → Pi on this host panel.** Handy after
  updating Pi on the host or rebuilding the chat image -- previously the only way to pick up either was
  `./piper.sh restart` over SSH. The new `POST /dashboard/hostpi/restart` route spawns `./piper.sh
  restart` as a detached child and returns immediately; that script's own `stop()` then finds this very
  process (by PID, the way it always has) and sends it SIGTERM, so the restart goes through the gateway's
  ordinary graceful-shutdown path (open chats hibernate, spend is recorded) rather than a bare
  `process.exit()`. Works the same whether the install is a plain background process or a systemd unit,
  since piper.sh already handles both. Gated the same way Pi updates are: refuses with a clear message if
  no dashboard password is set. The button disables itself and polls `/health` until the new process
  answers, then reloads the page.

## [1.0.26] - 2026-10-20

### Changed
- **The client portal's attach button is now a paperclip**, with its tooltip updated to "attach a file
  (image or any document)". The underlying feature was already there -- the same button has always
  accepted any file type, not just images, uploading non-image files straight into the agent's workspace
  for it to read -- it just looked like an image-only "+" button and wasn't clearly labelled as a general
  file attach. No behavior change, just the icon/tooltip now matching what it already does.

## [1.0.25] - 2026-10-18

### Changed
- **Creating or editing an agent's default model now offers the actual model catalogue to pick from**,
  instead of a bare free-text box: both the "Create an agent endpoint" form and the per-agent editor's
  model field are backed by a shared, page-wide list of every model the gateway can currently reach
  (`dashboard/models.json`), loaded as soon as the dashboard opens rather than only after visiting the
  Models tab. Still a plain text field underneath, so a custom provider/model string typed by hand still
  works -- the list is there to pick from, not to lock the field down.

### Added
- **The 32 KB-per-message cap on an external model chat's history is now a dashboard setting**
  (`EXTERNAL_HISTORY_MESSAGE_MAX_BYTES`, under Limits), not a fixed constant. The client portal and
  dashboard Playground both resend a conversation's whole history on every turn when chatting with an
  external OpenAI-compatible model (there's no server-side session to keep it for them), so a
  long-running chat with a long reply or a large pasted block could hit the old fixed limit with no way
  around it.

## [1.0.23] - 2026-10-18

### Changed
- **A code block's "copy"/"preview" buttons now sit in a bar of their own right below the code, not
  above it.** For anything longer than a screenful -- a full HTML page is the common case -- reaching
  them used to mean scrolling back up past everything just read. The language label stays at the top
  of the block as before.
- Widened the portal's message column from 860px to 1080px.

## [1.0.22] - 2026-10-18

### Fixed
- **A reconnected chat (portal or Playground, agent or external model) that kept going past ~16KB of
  reply text silently froze at that point** -- it looked like it was still streaming or had finished
  normally, but the text just stopped growing, well short of what the model actually said. The
  reconnect routes read a turn's answer back out of `LiveLog` (lib/livesession.mjs), which caps any
  single message's text at `MAX_TEXT` -- a limit that only ever mattered for the dashboard's live
  session *preview* before 1.0.20/1.0.21 made this the one place a reconnecting client's answer comes
  from, where it has to be the complete answer, not a preview. Raised `MAX_TEXT` from 16KB to 1MB.
  Verified with a real headless-browser run reloading mid-stream on a 40KB reply (agent chat and
  external model both): the capped version visibly truncated at 16,385 characters; fixed, it comes back
  whole.

## [1.0.21] - 2026-10-18

### Fixed
- **Chatting with an external model (not an agent) in the client portal or the Dashboard Playground
  still couldn't survive a refresh mid-reply**, even after 1.0.20 fixed this for agent chats: an
  external-model turn is just a plain streaming HTTP call with no Pi session behind it, so there was
  nothing at all for a reconnecting tab to catch up on -- a reload left the message stuck on "Thinking…"
  forever, even though the model had already answered and the reply was sitting unseen in the server's
  response.
  - New `lib/externallive.mjs`: a small in-memory record of an external-model turn in flight (built on
    the same `LiveLog` agent sessions already use), keyed per key+conversation so one key's tabs can
    never reconnect into another key's turn. A finished turn's record lingers for two minutes so a
    reload landing just after "done" still sees the real answer.
  - `portalExternalChat()`/`playgroundExternalChat()` now feed every delta into that record and no
    longer abort on disconnect (the Playground's version used to, whenever the client didn't send a
    `requestId` -- which it never did, so every disconnect there was actually killing the turn).
  - The existing reconnect/interrupt routes (`GET .../events`, `POST .../interrupt`) fall back to this
    new registry whenever there's no agent session to find, so the client's own "is this chat still
    live?" logic needed only one change: stop skipping external-model conversations.
  - Verified with a real headless-browser run against a real server for both the portal and the
    Playground: a message sent to a fake external endpoint, a genuine page reload mid-stream, and the
    full answer arriving live afterward once the endpoint finishes.

## [1.0.20] - 2026-10-18

### Added
- **A chat in the Dashboard Playground now survives a refresh mid-turn, the same way the client portal
  already does.** Previously the Playground had no reconnect mechanism at all: a reload while the agent
  was still thinking or replying left the cached "pending" message stuck forever, and -- worse -- the
  browser going away actually aborted the turn server-side (`res.on("close")` called the turn's own
  abort controller), so the reply was lost for good, not just hidden. Three changes, mirroring the
  portal's own design (lib/portal.mjs) closely:
  - `playgroundChat()` no longer aborts the turn on disconnect -- only this request's own plumbing comes
    down; the turn keeps running.
  - A new `GET /dashboard/playground/conversation/<id>/events` catches a reconnecting tab up on a turn
    still running: the full log so far, then live updates until it settles. Folds the same cold-start
    race fix (`record.inflight`) the portal's own reconnect route already has.
  - A new `POST /dashboard/playground/conversation/<id>/interrupt` is the Playground's real "stop"
    button now that disconnecting no longer doubles as one.
  - `pgSend()` now saves to this browser's local history the moment a turn starts, not only once it
    finishes -- without that, a reload before the first save had nothing to even try reconnecting to.
  Verified with a real headless-browser run against a real server (not just reasoned about): a message
  sent, a genuine page reload mid-reply, and the answer arriving live afterward, confirmed via the
  server's own access log showing the reconnect request land.

## [1.0.19] - 2026-10-18

### Added
- **A download button in the HTML preview pane.** Sits next to "open in a new tab", next to the version
  picker. Saves the currently selected version as a standalone `.html` file, named from its own `<title>`
  when it has one (falling back to "preview.html"). Verified with an actual headless-browser download,
  not just read over.

## [1.0.18] - 2026-10-18

### Fixed
- **The actual reason the HTML preview pane was still clipping content after the last fix: `#previewbody`
  had no `class="previewbody"` on it, only the `id` -- the `.previewbody { ... }` CSS rule from that fix
  was targeting a class the element never had, so none of it ever applied. The iframe's `position:absolute`
  then resolved against the next positioned ancestor up the tree instead (`.chat-split`), stretching it
  to roughly double the pane's own width while `#previewbody` itself stayed at zero height. This time
  verified with an actual headless-browser render (not just reasoned about from the CSS) before and after
  the fix, including confirming the iframe now scrolls its own overflow correctly.

## [1.0.17] - 2026-10-18

### Fixed
- **The HTML preview pane was silently clipping most of the rendered page, with no scrollbar to reveal
  the rest.** `#previewbody` (the box holding the preview `iframe`) had no CSS rule of its own, so it
  stayed a plain block instead of a flex container -- `.previewframe`'s `flex:1` had nothing to flex
  *within*, and the iframe fell back to the browser's own tiny default height. Fixed by making
  `#previewbody` a flex container that fills the pane, with `min-height:0` added through the whole
  chat-col/previewpane/previewbody chain (a flex column's default `min-height` is "at least as tall as
  my content," which fights the very shrinking a fixed split depends on).

## [1.0.16] - 2026-10-18

### Changed
- **The HTML preview pane splits the chat window 50/50 again, and can now be dragged to any size.** A
  draggable handle sits on the border between the chat and the preview (`col-resize` on desktop, stacked
  and `row-resize` on a phone) -- drag it to whatever split suits the page you're looking at, clamped to
  20%-75% so neither side disappears. Not persisted across a reload: it resets to 50/50 next time, same
  as the rest of the preview pane's own state.

## [1.0.15] - 2026-10-18

### Fixed
- **The new HTML preview pane was taking most of the chat window, and "copy" sat stranded in the middle
  of a code block's toolbar.** Both were flex layout bugs from the same release: the preview pane's
  `flex:1 1 50%` against the chat column's bare `flex:1` (basis 0%) handed the pane most of the window's
  extra space rather than splitting it evenly -- fixed with a basis split (60/40, chat/preview) that adds
  up to 100% so there's no extra space left to redistribute. And a code block's toolbar laid out "copy"
  and "preview" as two of three bare children under `justify-content:space-between`, which pushed the
  middle one -- "copy" -- toward the center of the bar instead of next to "preview"; both buttons are now
  one group at the end of the bar, the lang label the only thing at the other.

## [1.0.14] - 2026-10-18

### Added
- **A live HTML preview in the client portal, split beside the chat.** Any ```html code block an agent
  produces now gets a "preview" button next to its existing "copy" one. Clicking it splits the chat
  window to show the rendered page beside the conversation, in a sandboxed `iframe`
  (`sandbox="allow-scripts"`, no `allow-same-origin` -- it can run its own script, but can never read
  this page's session or API key, the same boundary the workspace file preview already uses). A long
  chat that produces several different pages gets a dropdown to switch between every distinct one seen
  anywhere in that conversation, oldest first, titled from the page's own `<title>` when it has one. An
  "open in a new tab" button is also available, via a `noopener` blob URL so that tab has no way back
  into this page either. Nothing here is separately saved -- the panel rebuilds itself from the
  conversation's own (already persisted) messages, so there is nothing new to lose or get out of sync.

## [1.0.13] - 2026-10-18

### Fixed
- **"Pi did not answer "prompt" within 30s" could cut off a message on a long session that needed to
  auto-compact first.** Accepting a prompt (`send({type:"prompt",...})`) was bound by
  `PI_COMMAND_TIMEOUT_MS` (default 30s), a limit meant for quick, already-started RPCs like `get_state`
  or `abort` -- never for accepting a new prompt, since Pi auto-compacting a long session happens
  *before* it acks the prompt, not after, and can legitimately take longer than that. The prompt send
  now waits however long it takes (same as `init()`'s own first command), with the existing idle
  watchdog (`PI_IDLE_TIMEOUT_MS`, 20 minutes of total silence) still catching a genuinely wedged Pi --
  compaction's own progress events count as activity, so a session that's actively compacting, however
  slowly, is never mistaken for stuck.

## [1.0.12] - 2026-10-18

### Changed
- **The "compaction was interrupted" note now says whether Pi is going to try again.** Pi doesn't say
  *why* an auto-compaction attempt was aborted or failed, but it does say whether it will retry on its
  own (`willRetry`) -- that distinction wasn't being shown. Without it, a chat doing a lot of back-to-
  back tool calls could show the same "context is getting full; compacting automatically…" / "compaction
  was interrupted; nothing changed" pair repeatedly and look identically broken whether Pi was about to
  quietly succeed on a later turn or had actually given up, leaving the context to keep growing with
  nothing left to free it. The note now ends with "; it'll try again" or "; it won't retry on its own"
  accordingly.

## [1.0.11] - 2026-10-17

### Added
- **Chat errors in Portal and the Dashboard Playground now say why, not just that.** A dropped
  connection, a server restart mid-reply, or a cold-start hiccup only ever reaches the browser as one
  generic, useless string -- "Load failed" in Safari, "Failed to fetch" in Chrome, "NetworkError when
  attempting to fetch resource." in Firefox -- with no indication of what actually went wrong. The
  browser never hands JS the real cause, but it does expose enough around the edges to narrow it down:
  whether any reply had already started streaming in before it died, how long the request had been
  running, whether the browser itself currently thinks it's offline, and any `cause` chain some browsers
  attach. Every chat error now carries this as an expandable "why?" detail line under the message, and
  the full raw error object is also logged to the browser console (`piper: a chat request failed` /
  `piper: a playground request failed`) for anyone digging deeper in devtools.

## [1.0.10] - 2026-10-13

### Fixed
- **A hard refresh while a reply was still coming could leave the Portal showing a dead "Thinking..."
  with no updates, no error, and no way to tell what actually happened.** Root cause, found by tracing
  the real reconnect path end to end (not guessed at): `GET .../events` decided whether a turn was
  still running purely from `LiveLog`'s own `working` flag, which only flips true once Pi actually
  emits its first event for the turn. There is a real window before that -- most visibly a cold
  container start, which can easily take several seconds -- where a turn has been accepted and is
  genuinely in flight (`record.inflight > 0`) but has not produced anything yet. A reconnect landing in
  that window was wrongly told the turn was already "done": the server closed the stream right then,
  and the actual reply -- which kept running server-side the whole time, as it always has -- finished
  with nobody left watching. The refreshed page never heard about it again. `conversationEvents()` now
  folds `record.inflight` into that decision, so a turn that is running but hasn't started producing
  output yet correctly keeps the connection open (and correctly reports itself as still thinking)
  instead of being told it already ended.
- Hardened the same reconnect path on the client regardless: a watchdog now gives up loudly (with a
  visible error, not a silent freeze) if a reconnect goes more than 30s without any progress at all,
  and an exception while handling any single event from it no longer kills the rest of the stream
  silently -- both are a safety net on top of the real fix above, not the fix itself.

## [1.0.9] - 2026-10-13

### Fixed
- **A chat refreshed mid-reply could stay stuck on "Thinking..." forever, with no live updates and
  nothing clickable.** 1.0.8 handled the server reporting the session was no longer live, but
  `resumeIfLive()`'s own reconnect fetch could reject outright (a network hiccup is especially likely
  right at a page reload, with everything else also loading at once) *before* its `msg` variable was
  ever assigned -- the catch handler's `if (msg && msg.pending)` guard then silently skipped doing
  anything, since `msg` was still `null`. It now falls back to reading the conversation's last message
  straight from `c` when that happens, so a reconnect failure always resolves the stuck message with
  an error instead of leaving the plain, non-interactive "Thinking…" placeholder up indefinitely.

## [1.0.8] - 2026-10-13

### Fixed
- **The Portal's thinking panel could still occasionally lose a click while a reply was streaming.**
  1.0.6/1.0.7 reused the thinking `<details>` element's *content* across redraws, but every redraw
  still built a brand-new row and `.body` wrapper and moved the reused node into it, then swapped it
  into the live page in place of the old row -- a real (if synchronous) detach-and-reattach of the
  exact node a click might be landing on. `buildMessageNode()` now patches an existing row and its
  thinking block fully in place instead: once created, a message's row, its `.body` wrapper, and its
  thinking element are never removed or reparented again for as long as that row is on screen, so a
  click toggling it open or closed can never land on a node mid-replacement. `renderMessages()` and
  `frameMessages()` were both updated to patch rows this way (matched by position, guarded against
  reusing a previous conversation's rows after switching chats) instead of ever calling
  `replaceChild()`/`replaceChildren()` on them.
- **A chat left "Thinking..." from before a page reload could get stuck that way forever.**
  `resumeIfLive()`'s reconnect silently swallowed two cases: the server reporting `{live:false}`
  (the session was already gone by the time of reconnect) and the reconnect attempt itself failing
  (a dropped connection, a bad response) -- in both cases the cached message's `pending` flag was
  simply left `true` with nothing left to ever clear it, so the chat looked permanently hung after a
  refresh with no error and no way to tell it was actually over. Both paths now resolve the stuck
  message with a clear error instead of leaving it dangling.

## [1.0.7] - 2026-10-13

### Fixed
- **The Portal's thinking panel could still lose a click right when a reply finished.** 1.0.6 fixed the
  mid-stream redraw; the stream's `done` event (and a conversation switch) still called the plain,
  full `renderMessages()`, which rebuilt every message's thinking block from scratch with no reuse at
  all -- and the exact moment a reply finishes "Thinking…" is exactly when someone is likely to be
  clicking it. `renderMessages()` now reuses each message's existing thinking element the same way the
  mid-stream path already did, so the panel survives every re-render, not just the streaming ones.

## [1.0.6] - 2026-10-13

### Fixed
- **The main chat (the Portal) had the same "can't close the thinking panel while it streams" bug the
  Playground had, in a separate implementation.** 1.0.4 fixed the Playground by patching its message
  body in place instead of rebuilding it on every token; the Portal's own streaming redraw
  (`frameMessages()`) still recreated the thinking `<details>` from scratch every frame, so a click to
  close it (or open it) could land on a node already on its way out. The Portal now reuses that same
  element across redraws instead of recreating it, so opening and closing both stick.

## [1.0.5] - 2026-10-13

### Fixed
- **The main chat (the Portal) had the same "stuck chat can't be deleted" bug as the Playground, in a
  separate copy of the guard.** 1.0.4 fixed this for the dashboard's Playground, but the client portal's
  own delete ("Clear chat") is a completely separate code path with its own `isBusy` check, which was
  still blocking it. Deleting a conversation there now also always goes through, regardless of whether
  it still looks busy — the only real way out of one that is stuck.

## [1.0.4] - 2026-10-13

### Fixed
- **The Playground's thinking panel couldn't be closed while a reply was still streaming.** The 1.0.3
  fix made an open panel stay open across the per-token re-renders, but every one of those re-renders
  still recreated the `<details>` element from scratch — so a click meant to close it could land on a
  node that was about to be (or had just been) replaced, and the browser's own default-closed state
  for the new one lost the click entirely. The whole message body is now patched in place instead of
  rebuilt: a part already on screen is updated where it stands, not torn down and recreated, so
  opening and closing both stick regardless of how fast the reply is streaming.
- **A chat stuck behind a turn that never answered an abort (closing the tab, a page refresh, mid tool
  call) could neither be used nor deleted.** Deleting a conversation is the only way out of one that's
  wedged, so it's no longer blocked by the same "busy" flag that disables sending — deleting now always
  stops the in-flight request first and proceeds, which also tears the server-side session (and its
  container) down for good, clearing whatever it was stuck on.

## [1.0.3] - 2026-10-13

### Fixed
- **The Playground's "thinking" block sometimes couldn't be expanded.** While a reply was still streaming,
  every incoming token rebuilt the whole message's DOM from scratch, including a brand-new `<details>` for
  the thinking block that always defaulted to closed — so clicking it open got undone by the very next delta.
  It now remembers which thinking blocks are open (the same approach the main chat portal already used) and
  restores that state across rebuilds, so expanding one sticks even while the model is still generating.

## [1.0.2] - 2026-10-13

### Changed
- **A job interrupted by a restart now tries recovery before anything else.** 1.0.1 could only classify an
  interrupted run as safe-to-retry or not; it had no way to tell a run that had genuinely finished (no tool
  ever needed, the model just answered) from one truly cut off mid-thought, so either could be requeued and
  asked the same question a second time. The sweep now reopens the run's own session first and asks it for
  nothing new — if it already has a finished answer, that's read straight back out, no retry, no second model
  call. Only once that finds nothing does the old requeue-or-report choice apply.
- **Not every tool call makes a run unsafe to retry.** Calling something read-only — `read`, `grep`, `find`,
  `ls`, `piper_knowledge_search`, `piper_recall`, or any other lookup — doesn't risk a real side effect, so it
  no longer blocks the automatic requeue; only a tool Piper can't prove is read-only (`bash`, `write`, `edit`,
  a hand-off, a schedule, or anything it doesn't recognize at all) still does.
- **The owner is told, not just the audit log.** A run reported after a restart (or recovered by it) now goes
  through the job's own notify setting — the inbox and alert webhook — exactly like any other finished or
  failed run, instead of only ever showing up for whoever happens to read the audit page
  (`lib/jobs.mjs`, `lib/agentrun.mjs`).

### Added
- **`COMPACT_AT_PERCENT`: force every agent to auto-compact at a percentage of its context, instead of
  Pi's own flat 16384-token reserve.** Pi's own auto-compaction triggers a fixed number of tokens short
  of a model's context window, regardless of whether that window is 8K or 1M — so the same setting
  compacts an 8K model almost immediately and a 1M model only once it's nearly full. Setting
  `COMPACT_AT_PERCENT` (Settings → Agent, 0 by default — off) computes `reserveTokens` as a share of
  each model's own context window and writes it into every profile's `settings.json` as a
  `compaction.modelOverrides` entry — the same mechanism Pi's own `/settings` uses — so compaction
  fires at the same percentage on every model, including one switched to mid-chat. Only the entries
  this feature wrote are ever touched again, so a model-specific override set by hand for a model it
  doesn't know about is left alone, and turning it back off removes exactly what it added. The sweep
  that keeps every profile in sync runs at startup, when the setting changes, and when the model
  catalogue reloads, so a model added later is covered too (`lib/compaction.mjs`).
- **An external-model turn (Integrations) can now survive a dropped connection or a gateway restart
  mid-stream without being billed twice.** That turn is one direct, stateless HTTP call with nothing
  durable behind it; today, if the connection that started it was already gone by the time it finished,
  the finished answer was just discarded, and the caller's only option was to resend the whole message
  as a brand-new turn — including a brand-new call to the model. A caller may now send an optional
  `requestId` with the turn; the answer is committed under that id the moment it's ready (even if
  nobody is still listening), and resending the same message with the same `requestId` replays the
  committed answer instead of calling the model again. Scoped to the same key and model, short-lived
  (10 minutes), and fully opt-in — a caller that sends no `requestId` is completely unaffected
  (`lib/externalreplay.mjs`).

### Fixed
- **A scheduled job's run that was still going when the gateway restarted was always reported dead,
  even when its turn had done nothing yet.** `startJobs()` used to mark every run still `"running"` as
  an error on restart, whether or not it had reached a tool call — true restart safety would mean
  knowing whether a tool had already done something in the run's container, which Piper has no way to
  verify, so blindly replaying it was never an option. A run is now marked `touched` the moment its
  first tool call starts (not only once it finishes); one left `"running"` by a dead process that never
  got that far couldn't have done anything, so it's requeued and actually runs again instead of being
  reported as a failure. One that had already touched a tool keeps today's behavior exactly: reported,
  not retried (`lib/jobs.mjs`).

## [1.0.0] - 2026-10-12

### Added
- **Integrations: external OpenAI-compatible chat endpoints, assignable to API keys.** A new dashboard
  section (Integrations, under Infrastructure) for adding a chat endpoint outside Pi's own provider
  catalogue — self-hosted inference, a third-party API — with an optional API key. **Overview** lists
  every endpoint's models, each row directly editable in place (context window, vision/embedding/audio,
  reasoning and its effort, enabled, a **save** button per row — chat is always implied) and whether the
  endpoint answered last time it was checked (an on-demand **recheck**, not polling); changing the
  endpoint's own name, URL or API key opens an inline panel. A reasoning-flagged model also gets a
  configurable effort level (default, low, medium, high, xhigh — the same level names as Pi's own
  agents, and the same `reasoning_effort` field Piper's own `/v1/chat/completions` already accepts);
  default sends nothing at all. **External Endpoints** lists
  the endpoints. **Wizard** adds one in three steps: name/URL/key, a **detect models** button that
  probes the endpoint's own `/v1/models` (best-effort, always editable, or add a model by hand), then
  review and save. **Access Control** grants specific models to specific API keys. A key with a
  granted model sees it in the client portal's own target picker, and in the dashboard Playground's own
  target picker too (any key the operator chooses, same as an agent there) — and can chat with it
  exactly like an agent — except chat only: no tools, skills or extensions, since a bare completion
  endpoint can't run them, and no container either. Both show a live "Thinking…" block when a reasoning model
  streams its own reasoning content (`reasoning_content`/`reasoning`, whichever the endpoint sends) and
  the same status bar (model, context, generation speed) an agent turn shows, measured around the call
  itself. It's one direct, streaming, stateless HTTP call to the endpoint's own `/v1/chat/completions`
  (`lib/externalmodels.mjs`) — the browser resends the whole conversation each time, since there is no
  Pi session to keep it in.
- **Notebooks can be processed by a granted model instead of an agent.** Creating a notebook now opens
  a modal (title + a picker: the key's main endpoint, an agent, or a granted external model) instead of
  a plain prompt; the same picker in the notebook's own bar changes it afterward. A model notebook's
  **Chat** and **Generated** go straight through it (no tools, no Pi session, so a follow-up question
  has no memory of the one before it — unlike an agent notebook's persistent session); extracting a new
  source still always runs through the key's main endpoint either way, since a model has no
  file-reading or URL-fetching ability at all.
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
  tier as RSS's own feed-fetching (a fixed, operator-configured address). `NOTEBOOK_ENABLED`
  (Settings → Sessions → Notebooks) also hides the Notebooks button in the client portal's sidebar
  entirely when off, not just refuse the page if it's clicked. `NOTEBOOK_SOURCE_MAX_BYTES`,
  `NOTEBOOK_MAX_SOURCES` round out the new settings.
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
- **The client portal's chat history could go silently stale, making a conversation look "missing" after
  logging in again (or from another device) — with no error anywhere.** `saveConvos()` PUT the whole
  history to the server in the background but never checked the response status, only whether the
  request itself failed outright; a 413 (over `PORTAL_HISTORY_MAX_BYTES`, easy to hit with a few
  file-heavy conversations) came back as an ordinary successful response as far as the client could
  tell, so the server-side copy just stopped updating with no sign anything was wrong. The default cap
  is now 16 MiB (was 4 MiB), and a save that still gets refused shows a clear warning in the sidebar
  instead of failing invisibly.
- **A portal or dashboard chat could silently lose all its context and restart from nothing partway
  through a conversation, with no error, nothing in the audit log — just the agent suddenly acting
  like it was hearing everything for the first time.** `ONE_SHOT_TTL_MS` ("End a session used exactly
  once and then quiet this long") exists for genuine one-off calls like title/summary generation, which
  get a random, throwaway session id nobody will ever ask for again. But `reap()` had no way to tell
  those apart from a human's **first** message in a brand new portal or dashboard conversation, which
  looks identical by the only signal it checked (`requests <= 1`, idle) — and the default window is
  just 2 minutes, easily spent reading a reply and typing one back. Once that timer fired, the session
  wasn't stopped-but-resumable like every other idle timeout; it was ended outright, row and all, so
  the very next message silently started a brand new one from scratch. Sessions now carry whether their
  id was chosen by the caller (a portal/dashboard conversation, a job, a raw API call with its own
  `X-Session-Id`) rather than handed out at random — only the latter is ever treated as one-shot, no
  matter how long the pause before someone's second message.
- **Downloading a file from the client portal's file browser (or a notebook's) could fail outright with
  Chrome's "Try to sign in to the site. Then download again," no error shown anywhere else.** The
  download button was a plain `<a href="..." download>` pointing straight at `/api/files/:path` — a
  native browser navigation, which cannot carry a custom `Authorization` header, and that endpoint has
  no cookie fallback (unlike the dashboard's own file browser, which does and was never affected). A
  file that can be previewed inline (an image, a small text file) never hit this, since the preview
  itself is an authenticated `fetch()`; anything that can't be inline-previewed (too large, or a binary
  format like a `.tar.gz`) forced the user onto the broken link, which answered 401 every single time —
  not a size or extension bug, just a credential that structurally could never reach the server that
  way. The download link is now built from the same already-authenticated blob the preview itself
  fetches, the same way an attached image already worked.
- **Raw file reads/writes also now ask the profile helper container for 1GB of memory instead of the
  256MB a small JSON profile operation needs** (`PROFILE_MAX_BYTES`-bounded) — a workspace file has no
  size ceiling of its own (`WORKSPACE_MAX_BYTES` is 0, unlimited by default), and running out of room
  mid-transfer is an OOM kill after the response has already started streaming: a failed, truncated
  download with no clear reason. Not what turned out to cause the above (that was the missing
  `Authorization` header, not file size), but a real gap worth closing regardless.
- **An unrelated settings change could cut off a chat that was actively working, with just "the chat
  was put to sleep" and no clue why.** `closeByKey`/`closeByScope` — used whenever a key's container
  settings change, a shared extension grant changes, a profile gets locked, and a few other places —
  hibernated every session of that key or scope unconditionally, including one in the middle of a turn
  right now. Only `reap()` and LRU eviction were ever careful about this (a session doing real work is
  never touched); these two call the very same `hibernate()` but had no such guard, so changing, say,
  one key's container memory limit could silently abort a completely unrelated conversation of that
  key that happened to be mid-answer. They now leave a session with work in flight alone by default —
  it simply picks up the new settings whenever it next goes idle, the same deferred-but-never-lost
  behavior `reap()`/eviction already guarantee — and only force it through (`{ force: true }`) at the
  handful of call sites that are about to remove the very directory or container that turn is using
  (resetting a profile, deleting a shared bundle, rebuilding an agent's container, deleting a key),
  where leaving it running really would be the wrong kind of safe.
- **Deleting a client portal chat silently did nothing once its container had already stopped.**
  `DELETE /api/conversation/:id` only ever closed a *live* session; a chat left idle for a while (or
  just not reopened in a bit) gets hibernated well before anyone deletes it — stopped, but kept,
  resumable, in the `chats` table — and `sessions.has()` is false for one of those, so the delete
  quietly did nothing: no error, but the row and its container were never actually removed. The portal
  dropped it from the visible list regardless (it never checked the response), making it look deleted
  when it was not. It now falls back to ending the stored row (and its container) the same way the
  dashboard's own container cleanup already does for a stopped chat.
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

### Changed (continued)
- **A newly created agent can now schedule its own recurring jobs from the start**, instead of needing
  an operator to flip its "may schedule recurring tasks for itself" switch by hand on every agent, one
  at a time, before it could use the scheduling tools at all. `agents.create()` now sets `can_schedule`
  on by default (an operator can still turn it off per agent, same as today); the one agent that
  already existed had its switch flipped the same way to match.

### Fixed (continued)
- **A long conversation could slow down or break in the client portal and dashboard Playground.**
  Every streamed delta re-rendered the entire message list from scratch instead of just the message
  still arriving, which got visibly slower the longer a chat ran; the browser's own stored copy of all
  conversations had no cap and could silently hit the browser's storage quota; and resending the whole
  history to a stateless external (non-agent) model every turn could eventually exceed the server's
  history limit outright. Streaming now redraws only the last message, stored conversations are capped
  and oldest-evicted before every save, and an external model is only ever sent its most recent 150
  messages.
- **The client portal was effectively unusable on a phone.** The layout never had a narrow-screen
  breakpoint: the message input stayed a single fixed-height line no matter how much was typed, and the
  chats/files/tools/skills rail had nowhere to go but stay permanently docked next to the chat, leaving
  almost no room for the conversation itself. A `@media (max-width: 760px)` layout now lets the message
  box grow with what's typed, and moves the rail behind a hamburger (☰) menu.
- **The first mobile pass left the rail docked while a panel opened as a second, overlapping layer
  beside it**, which looked broken and ghosted on a narrow screen — the rail and an open panel are now
  mutually exclusive full-screen overlays, never both on screen together.
- **Making a panel take the whole screen on mobile also covered the only things that could close it**
  (the backdrop and the rail button that opened it), so once Files, Skills, Tools or Chats was open on a
  phone there was no way to close it short of reloading the page. Each panel's header now has an
  explicit × close button.
- **The status pill overflowed the top bar on a phone**, running off the edge of the screen instead of
  wrapping or scrolling. It now also renders into a compact, horizontally-scrollable strip shown above
  the composer on mobile, with the original top-bar copy hidden there instead.

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
