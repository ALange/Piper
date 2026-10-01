# Troubleshooting

Symptom, most likely cause, how to confirm it, and the fix. Start with `./piper.sh doctor` and the dashboard's red
strip: between them they name most problems. The log is `journalctl -u piper` (systemd) or `gw.log`.

## Chats will not start

| Symptom | Cause and confirmation | Fix |
|---|---|---|
| `503 the chat's container failed to start`, reason in the message | Read the reason. Usually Docker is not running or the gateway's user cannot reach its socket (`docker ps` as that user), or the image is not built (`docker images piper-agent`) | Start Docker / add the user to the `docker` group; `./piper.sh image` |
| `503 the network policy "internet" cannot be enforced` | `iptables` is missing, or the gateway's user may not change the firewall (`which iptables`; `iptables -S` as that user). **Fails closed on purpose** | Install `iptables` and run as root or with `CAP_NET_ADMIN`; or set the policy to `none` or `open` (rootless Docker needs one of these) |
| Same, right after installing the service, with `spawn iptables ENOENT` in the log | The service's `PATH` lacks `/usr/sbin` | Units from `deploy.sh` include it; a hand-written unit needs `/usr/sbin` in `Environment=PATH=` |
| Warning: the image has Pi X but the gateway runs Pi Y | Pi was updated after the image was built | Rebuild the image (Containers → Images, or `./piper.sh image`), then restart |
| `the image "…" does not exist` for one key | The key's own image setting names an image that is gone | Build it (`./piper.sh image <env>`) or clear the key's image on the Profiles page |
| A key's chats fail only for that key | Its container settings (mounts, network, image) are wrong or refused | Profiles → the key → Container; saving shows the exact refusal |
| `429 session_limit_exceeded` / `spend_limit_exceeded` | The key's session cap with every session busy, or its daily cap | Raise it on API Management, or wait (the spend cap resets at local midnight) |

## Containers misbehave

| Symptom | Cause and confirmation | Fix |
|---|---|---|
| `apt` and `pip` hang in a container | Its DNS is unreachable. Inside: `cat /etc/resolv.conf`; `getent hosts deb.debian.org`. Usually a private DNS server that the firewall does not allow | The gateway allows the resolvers in the host's `/etc/resolv.conf`; add any other as `host:53` in `CONTAINER_ALLOW` |
| An agent changed DNS and it was lost, or `sed -i /etc/resolv.conf` fails with "Device or resource busy" | `/etc/resolv.conf`, `hosts`, `hostname` are files mounted into the container; they persist but cannot be replaced | Edit in place: `echo 'nameserver 1.1.1.1' > /etc/resolv.conf`, `tee`, or an editor's save. `sed -i` and `mv` cannot work on a mounted file |
| A model at a private address is unreachable | Direct models must be allowed through the firewall | Add it under *Pi config for containers* (its endpoint is then allowed automatically), or to `CONTAINER_ALLOW` |
| A key on `none` gets `[model error: … Connection error]` | The model is one configured for containers, which Pi calls directly | Use a model the gateway serves, or another network for that key |
| A tool works on the host but not for agents | It is not in the image | Add it to `docker/Dockerfile` and rebuild, or share its folder with `CONTAINER_MOUNTS` |
| An agent's `apt install` is gone after a change | The container was recreated (image, mounts, limits or network changed) and it is not persistent, or it was reset | Make the key persistent (keeps installs through rebuilds) or bake the tool into the image |
| A container was killed | `docker inspect <name> --format '{{.State.OOMKilled}}'`; the Containers page events list it and the chat's next reply says so | Raise the memory limit for that key |
| A container's disk keeps growing | Containers page → disk column | Recreate or reset it; look at what the agent is downloading |
| Files in a workspace have an odd owner | Container root is mapped (rootless Docker or `userns-remap`) | Expected |
| Pi in a container is red on the Containers page | It is older than the gateway's | **update** that container (or **update all**) |
| Pi in a container is amber | It is newer than the gateway's; the protocol may differ | Update the host's Pi, restart the gateway, then update containers |
| An **update** fails on the Pi step with "no network" | The container's policy is `none` | Expected; update Pi by hand or change the policy |
| An **update** says a profile is "frozen or over its limit" | The profile is locked or over `PROFILE_MAX_BYTES`, so `/profile` is a throwaway copy and an extension update would be lost | Unlock or shrink the profile |

## Terminal and files

| Symptom | Cause | Fix |
|---|---|---|
| The terminal button is greyed or the connection is refused with 403 | No dashboard password, or terminals are off | Set a password (Settings → Access); `TERMINAL_ENABLED` under Settings → Containers |
| 409 "the container is not running" | A chat's container runs only while the chat is | Send the chat a message, or use a persistent container |
| 429 | `TERMINAL_MAX_SESSIONS` terminals are open | Close one, or raise the limit |
| It connects and then closes at once, "the shell could not start" | The container has no `python3` (the terminal's helper needs it; every Piper image has it) | Use a Piper image, or install python3 in that container |
| The terminal closes after a quiet while | `TERMINAL_IDLE_MS` | Raise it, or 0 for never |
| Behind a proxy it never connects | The proxy does not pass WebSocket upgrades, or rewrites `Host` without `X-Forwarded-Host` | nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 1h;` and pass `Host` or `X-Forwarded-Host` |
| A background job vanished when the terminal closed | Jobs belong to the shell's session and end with it | Start it with `setsid` (or `nohup setsid cmd &`) |
| File save says "conflict: the file changed" | An agent (or another tab) wrote it after you opened it | **reload from disk**, or **overwrite anyway** |
| File writes say "frozen" or "locked" | The workspace is over `WORKSPACE_MAX_BYTES` (delete something), or the profile is locked (Profiles → unlock) | As said |
| A file in the browser shows as a link and cannot be opened | An agent made a symlink; links are never followed | Delete or replace it |

## Agent endpoints

| Symptom | Cause and confirmation | Fix |
|---|---|---|
| State `port-lost` | The agent is enabled but its port could not be opened (taken, or `HOST` changed) | **new port** on its row; check `AGENT_PORT_RANGE` has free ports |
| A client's address stopped working | The stored port was taken at start and the agent moved (an audit row and an alert say so) | Give clients the new URL |
| `401` on an agent's port | The key is not the one that owns the agent, or it is revoked or expired. The settings key never works there | Use the owning key |
| `404` on an agent's port | The path is not one it serves, or the agent is disabled or deleted | Only `/v1/chat/completions`, `/v1/models`, the profile and files API and `/health` are served |

## The dashboard and access

| Symptom | Cause | Fix |
|---|---|---|
| Anyone can open the dashboard | No password is set | Settings → Access |
| Forgot the dashboard password | | Set `DASHBOARD_PASSWORD` and restart; it replaces the stored one; sign in; unset it |
| The command box or *Pi on this host → update* is greyed or returns 403 | No dashboard password | Set one; both refuse until then by design |
| Sign-in says "too many attempts" | The per-address throttle after wrong passwords | Wait the time shown |
| The dashboard session cookie is not kept behind a proxy | It is `Secure` only when `X-Forwarded-Proto: https` arrives, and `SameSite=Strict` | Have the proxy send the header, use the same host name throughout |
| Streaming replies arrive all at once | A proxy is buffering | nginx: `proxy_buffering off; proxy_read_timeout 1h;` |
| Uploads to the file API fail through a proxy | The proxy's body limit | Raise `client_max_body_size`, `proxy_request_buffering off;` |

## Running the gateway

| Symptom | Cause | Fix |
|---|---|---|
| `piper.sh` says it acts on "the systemd unit" | A unit named `piper` runs this folder's gateway | Use `systemctl` or `piper.sh`, not a hand-started `node server.mjs` |
| `Address already in use` | Another process holds `PORT` | `ss -ltnp \| grep 8787`; stop it or change `PORT` (a fresh database takes it from the environment; otherwise Settings → Server, then restart) |
| A second gateway cannot be started | Both use the same `GATEWAY_DB` | Give the test copy its own `GATEWAY_DB`; it then gets its own containers and firewall rules |
| Red banner: disk nearly full | Less than `DISK_FREE_WARN_MB` free where Docker keeps its data | Prune images and build cache (`docker builder prune -f`), recreate containers with big disks, delete old archives, move Docker's data |
| `/health` answers but `docker` is `false` | Docker is unreachable or the readiness check failed | `docker info` as the gateway's user; Settings → Containers → *Container health* |
| The watchdog never alerts | No webhook set, or the timer is not enabled | Set `ALERT_WEBHOOK_URL`, `systemctl list-timers piper-watchdog.timer` |
| Tests fail on a new host | An environment difference | `node test.mjs` needs no Docker; it skips the Pi comparison when Pi is not found. Send the first failing line |

## Pi and models

| Symptom | Cause | Fix |
|---|---|---|
| `[model error: …]` in replies | The provider call failed. Bridged models: Pi's login for the gateway's user; direct models: the endpoint or key in *Pi config for containers* | `pi` then `/login` as the gateway's user; fix the endpoint |
| *Pi on this host* says it cannot be updated from here | Pi is not where the gateway's own npm installs it (a custom `PI_AGENT_PACKAGE`, another node, a read-only folder) | Update it the way it was installed; the reason is shown |
| After updating the host's Pi the containers still show red | The gateway runs the old Pi until restarted; images and containers follow the *running* version | Restart the gateway, rebuild the image, update the containers |
| A model is missing from `/v1/models` | It is outside the key's allow-list, or the catalogue is stale | Check the key's allowed models; Models → reload |

## When in doubt

```bash
./piper.sh doctor                                    # Docker, image, network policy
docker ps -a --filter label=piper.managed=1          # every container Piper made
docker logs <container>                              # the container's main process (only a keep-alive)
sudo iptables -S DOCKER-USER | grep piper            # the firewall rules Piper installed
curl -s localhost:8787/health                        # is it answering
```

The Audit page shows what was done and when; the Containers page lists kills and deaths. If you ask someone for help,
send the first failing line of the log and the output of `./piper.sh doctor`; never send `container-pi/models.json`
or `~/.pi/agent/auth.json`.

## See also

[Operations](operations.md), [Security](security.md), [Deployment guide](deployment.md).
