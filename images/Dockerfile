# Build with: docker build -f images/Dockerfile -t sbox-runtime:local .
# Opt in to harnesses with explicit versions, for example:
#   --build-arg CODEX_VERSION=0.130.0
ARG NODE_VERSION=22
ARG BUN_VERSION=1.3.0
FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm-slim

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git openssh-client python3 python3-pip python3-venv \
       build-essential pkg-config ripgrep sudo unzip zip tar procps less jq tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && userdel node \
    && useradd --create-home --uid 1000 --shell /bin/bash sandbox \
    && mkdir -p /vercel/sandbox /home/sandbox/.local/bin /home/sandbox/.npm-global \
    && chown -R sandbox:sandbox /vercel /home/sandbox \
    && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
    && chmod 0440 /etc/sudoers.d/sandbox

ARG CODEX_VERSION=""
ARG CLAUDE_CODE_VERSION=""
ARG OPENCODE_VERSION=""
RUN if [ -n "$CODEX_VERSION" ]; then npm install --global "@openai/codex@$CODEX_VERSION"; fi \
    && if [ -n "$CLAUDE_CODE_VERSION" ]; then npm install --global "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; fi \
    && if [ -n "$OPENCODE_VERSION" ]; then npm install --global "opencode-ai@$OPENCODE_VERSION"; fi \
    && npm cache clean --force

ENV HOME=/home/sandbox \
    PATH=/home/sandbox/.bun/bin:/home/sandbox/.local/bin:/home/sandbox/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/sandbox/.npm-global \
    PYTHONUNBUFFERED=1 \
    TERM=xterm-256color
USER sandbox
WORKDIR /vercel/sandbox
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
