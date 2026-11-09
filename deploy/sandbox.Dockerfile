# Base image for coding-agent sandboxes (BSD-53): one container per run, project folder at /workspace/<project>.
# Build:  docker build -f deploy/sandbox.Dockerfile -t based-sandbox:latest deploy
# No secrets in this image. Agent logins are mounted read-only at run time (see deploy/README.md, "Sandbox").
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential tini \
    && rm -rf /var/lib/apt/lists/*
# Agent CLIs + their ACP adapters (pin versions here when updating the image).
RUN npm install -g @anthropic-ai/claude-code @zed-industries/claude-code-acp @openai/codex @zed-industries/codex-acp \
    @google/gemini-cli opencode-ai && npm cache clean --force
WORKDIR /workspace
CMD ["sleep", "infinity"]
