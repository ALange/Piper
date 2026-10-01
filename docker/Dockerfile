# The image every Piper chat runs in: `docker build` it with ./piper.sh image, which pins PI_VERSION
# to the Pi the gateway itself runs so the bridge and the RPC protocol match.
#
# The container is the sandbox, so Pi runs as root with a writable filesystem and whatever tools
# are here; what the container can reach is decided by the gateway (mounts, network, limits). No
# credential is ever put in the image or the container: model calls go over a mounted socket to
# the gateway.
#
# Same Debian release as the host this was written on, so a host folder mounted read-only with
# CONTAINER_MOUNTS runs against a compatible libc.
FROM node:22-trixie-slim

ARG PI_VERSION
ARG JADX_VERSION=1.5.5
# Heavy toolchains can be left out: docker build --build-arg WITH_RUST=0 --build-arg WITH_JAVA_TOOLS=0 ...
ARG WITH_RUST=1
ARG WITH_BUN=1
ARG WITH_JAVA_TOOLS=1

LABEL piper.image="1" \
      piper.pi-version="${PI_VERSION}"

RUN test -n "${PI_VERSION}" || (echo "PI_VERSION is required; build with ./piper.sh image" >&2; exit 1)

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep curl wget jq unzip zip xz-utils file xxd less procps psmisc \
       vim-tiny nano sudo openssh-client rsync \
       python3 python3-pip python3-venv pipx \
       build-essential pkg-config libssl-dev \
       binwalk \
  && if [ "${WITH_JAVA_TOOLS}" = "1" ]; then apt-get install -y --no-install-recommends openjdk-21-jre-headless; fi \
  && rm -rf /var/lib/apt/lists/*

# jadx, for the reverse-engineering skills.
RUN if [ "${WITH_JAVA_TOOLS}" = "1" ]; then \
      curl -fsSL "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" -o /tmp/jadx.zip \
      && mkdir -p /opt/jadx && unzip -q /tmp/jadx.zip -d /opt/jadx && rm /tmp/jadx.zip && chmod +x /opt/jadx/bin/* \
      && ln -s /opt/jadx/bin/jadx /usr/local/bin/jadx && ln -s /opt/jadx/bin/jadx-gui /usr/local/bin/jadx-gui; \
    fi

# A minimal Rust toolchain, installed system-wide so every user of the container finds it.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:${PATH}
RUN if [ "${WITH_RUST}" = "1" ]; then \
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path; \
    fi

RUN if [ "${WITH_BUN}" = "1" ]; then npm install -g bun; fi

# Pi itself, at the gateway's version. --ignore-scripts: nothing in it needs an install step.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
  && pi --version

# Where the gateway mounts things (see lib/engine.mjs): the shared workspace, the key's profile,
# operator bundles, and this chat's own state (Pi's session files and the bridge socket).
RUN mkdir -p /workspace /profile /shared /piper /opt/piper
WORKDIR /workspace

# The container's main process only keeps it alive. Pi is started inside it with `docker exec`, so a
# chat can stop and resume Pi without losing what was installed here.
CMD ["sleep", "infinity"]
