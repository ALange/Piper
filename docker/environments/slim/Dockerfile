# The `slim` environment: Pi and the everyday tools, without the compilers, Java, Rust and bun of the
# full image. A smaller image to build, to start and to keep, for keys that do not need the rest.
#
#   ./piper.sh image slim          (or Build on the dashboard's Containers page)
#
# Built as piper-agent-slim. A key uses it by naming it in its container settings on the Profiles page.
# Same base and same layout as the full image (docker/Dockerfile), so a chat behaves the same in it.
FROM node:22-trixie-slim

ARG PI_VERSION

LABEL piper.image="1" \
      piper.pi-version="${PI_VERSION}"

RUN test -n "${PI_VERSION}" || (echo "PI_VERSION is required; build with ./piper.sh image slim" >&2; exit 1)

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep curl jq unzip zip file less procps \
       python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Pi itself, at the gateway's version.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
  && pi --version

RUN mkdir -p /workspace /profile /shared /piper /opt/piper
WORKDIR /workspace

# The main process only keeps the container alive; Pi is started in it with `docker exec`.
CMD ["sleep", "infinity"]
