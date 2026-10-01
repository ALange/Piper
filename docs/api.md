# HTTP API

What a client can call. Everything under `/v1` is for API keys; `/dashboard/*` is for the dashboard page and is
guarded by the dashboard password. An agent endpoint's own port serves a small subset of `/v1`.

## Authentication

```
Authorization: Bearer <api key>
```

- Keys are created on the dashboard (API Management) and shown once. `GATEWAY_API_KEY`, when set, is an operator key
  that is never limited.
- While **no** key and no settings key exist, `/v1/*` is open. Once any key exists (even a revoked one) a valid
  key is required, so revoking your last key locks the API rather than opening it.
- A wrong, revoked or expired key is `401 invalid_api_key`.

## Chat: `POST /v1/chat/completions`

OpenAI's chat completions request. `POST /chat/completions` is the same.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-Session-Id: my-first-chat" \
  -d '{"model":"github-copilot/claude-haiku-4.5","stream":true,
       "messages":[{"role":"user","content":"list the files in /workspace"}]}'
```

| Field | Notes |
|---|---|
| `messages` | Required. Only the **new user turn** is forwarded to the agent, which keeps its own history. The first turn of a session with no history gets the transcript replayed as context |
| `model` | `provider/model` or a bare model id from `/v1/models`. Must be allowed for the key. Blank uses the agent's default (an agent endpoint's own, else the container config's, else the host's) |
| `stream` | `true` for server-sent events, else one JSON response. `stream_options.include_usage` adds a usage chunk |
| images | `image_url` / `input_image` parts are forwarded to Pi. `data:` URIs always; `http(s)` URLs only when `ALLOW_IMAGE_URLS` is on (and never to private addresses). Audio is refused |
| Session | `X-Session-Id` (or `X-Conversation-Id`) header, or `session_id` / `conversation_id` in the body, continues a chat. Without one the gateway derives an id from the client and the first user message, or mints one. The id in use comes back in the **`X-Session-Id` response header** |

**Sessions are private to the key** (and to the agent endpoint): the same id under another key is a different, fresh
session. Tool activity is not returned as `tool_calls`; it can be shown in the text stream with
`STREAM_TOOL_ACTIVITY`.

**In-band commands.** A user message that is one of the `/…` commands (see [Functions](functions.md)) is answered
by the gateway instead of the model.

### Errors

Errors are OpenAI-shaped: `{"error": {"message", "type", "param", "code"}}`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Malformed body, no `messages`, unsupported input |
| 400 | `model_not_allowed` | The model is outside the key's allow-list |
| 401 | `invalid_api_key` | No or bad key |
| 403 | `forbidden` | The action needs a dashboard password (dashboard routes) |
| 409 | | Busy or not possible now (a job is running, a request is in flight, an install Piper cannot manage) |
| 423 | `profile_locked` | The profile is locked by the operator |
| 429 | `session_limit_exceeded` | The key's sessions are all busy and it is at its cap |
| 429 | `spend_limit_exceeded` | The key spent its daily cap; resets at local midnight |
| 500 | `server_error` | Anything unexpected; the model failing shows in the reply text as `[model error: …]` |
| 503 | | The container could not start (Docker down, image missing, network policy cannot be enforced). The message says which |

## Models: `GET /v1/models`

The models the key may use, from the operator's Pi and the container configuration, each as `provider/id` and as the
bare id.

## A key's profile: `/v1/piper/profile`

A key manages **its own** profile (never another's); after each change its live sessions reload.

| Request | Does |
|---|---|
| `GET /v1/piper/profile` | Summary, size and quota, lock state |
| `GET` / `PUT` / `PATCH /v1/piper/profile/settings` | Read `settings.json`; replace it; or `{"set": {…}, "unset": […]}` |
| `GET /v1/piper/profile/skills`, `GET` / `PUT` / `DELETE …/skills/<name>` | List; read; write (a bare `SKILL.md` body, or `{"files": {"SKILL.md": …, "scripts/run.sh": …}}`); remove |
| `GET /v1/piper/profile/extensions`, `GET` / `PUT` / `DELETE …/extensions/<name>.ts` | The same for extension files (`.ts` or `.js`) |
| `POST /v1/piper/profile/reset` with `{"confirm": true}` | Start the profile over; the old one is archived |

## A key's workspace: `/v1/piper/files`

| Request | Does |
|---|---|
| `GET /v1/piper/files/` or `?path=dir/` | List a folder |
| `GET /v1/piper/files/<path>` | Download a file (streamed; links are never followed) |
| `PUT /v1/piper/files/<path>` | Upload (replaces the file); limited by `FILE_UPLOAD_MAX_BYTES` and the workspace quota |
| `DELETE /v1/piper/files/<path>` | Delete a file or folder |

The files are read and written by the profile helper in a throwaway container, never by the gateway on the host.

## Agent endpoints

An agent on its own port serves `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (and
`/chat/completions`), `/v1/piper/profile/*` and `/v1/piper/files/*`, for **that agent's** profile and workspace, and
only for the key that owns it. Anything else (the dashboard, settings, other routes) is `404`. `OPTIONS` is answered
for browser clients.

## Files and the terminal (dashboard)

The file browser uses `/dashboard/files/<scope>/<path>` (scope is `key-<id>` or `key-<id>--<agent>`; add `?root=profile`
for the profile). `GET` a folder or `?as=list` lists (`{entries, truncated, total}`), `GET ?as=text` returns an editor's
text (`{text, bytes, modified}`, or `{binary: true}` / `{tooBig: true}`), a plain `GET` downloads, `PUT` uploads, `PUT
?as=text` with `{"text", "expectModified"}` saves (**409 `conflict`** when the file changed since `expectModified`),
`POST ?op=mkdir`, `POST ?op=move` with `{"to", "overwrite"}`, `DELETE` removes. A locked profile or a frozen workspace
answers 423.

The terminal is a **WebSocket** at `/dashboard/terminal/<container>?cols=&rows=` (dashboard cookie, same origin, running
container). Browser to gateway: a binary message is keystrokes, a text message is JSON `{"t":"resize","cols","rows"}`.
Gateway to browser: binary is the shell's output, text is JSON (`{"t":"exit","code"}`, `{"t":"error","message"}`,
`{"t":"idle"}`). Refusals are plain HTTP answers to the upgrade: 401 not signed in, 403 no dashboard password, wrong
origin or terminals off, 404 not one of this gateway's containers, 409 not running, 429 too many open.

## Health: `GET /health`

No key needed: `{"status":"ok","sessions":{…},"docker":true|false|null,"diskFreeMb":…}`.

## Dashboard endpoints

Used by the dashboard page; they need the dashboard cookie (or no password set). Listed for automation and
debugging, not as a stable interface.

| Route | Purpose |
|---|---|
| `POST /dashboard/login`, `/logout`, `/password` | Sign in and out; set, change or remove the password |
| `GET /dashboard.json` | The live snapshot: sessions, history, spend, Docker readiness, resources, Pi versions |
| `GET /dashboard/settings.json`, `POST /dashboard/settings` | Read and change settings |
| `/dashboard/api-keys…` | List (`.json`, `/usage.json`), create, update, revoke, delete keys |
| `/dashboard/profiles…`, `/dashboard/files/<scope>/…` | Profiles, lock and reset, update a profile's container; a key's workspace |
| `/dashboard/agents…` | Agent endpoints: list, create, update, `enable`, `disable`, `new-port`, `reset`, `update`, delete |
| `/dashboard/containers.json`, `/dashboard/containers/<name>/<action>` | List; `stop`, `update`, `recreate`, `remove`, `exec` |
| `/dashboard/containers/update-all`, `/dashboard/updates.json` | Update every container; the running or last update job |
| `/dashboard/images.json`, `/dashboard/images/build`, `…/remove`, `…/prune` | Images |
| `/dashboard/hostpi.json[?check=1]`, `POST /dashboard/hostpi/update` | The host's Pi |
| `/dashboard/audit.json`, `/dashboard/audit.csv` | The audit log (filters: `category`, `q`, `actor`, `since`, `until`, `before`, `limit`) |
| `/dashboard/models.json`, `/dashboard/models/reload`, `/dashboard/spend.json` | Models and spend |
| `/dashboard/container-pi`, `/dashboard/containers/recheck`, `/dashboard/alerts/test` | Container Pi config, re-check readiness, test alert |
| `/dashboard/about.json`, `/dashboard/docs.json`, `/dashboard/docs/<page>.json` | About and this handbook |
| `DELETE /dashboard/session/<fingerprint>`, `POST /dashboard/kill-all` | End one or every live session |

## See also

[Security](security.md), [Functions](functions.md), [Reference manual](reference.md).
