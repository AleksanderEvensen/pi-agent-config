# Personal Pi Config

<p align="center">
  <img src="assets/pi-config.png" alt="Pi config screenshot">
</p>

This is my personal [Pi](https://pi.dev) configuration. It contains my agent preferences, settings, themes, extensions, and other local setup bits.

## Installation

If you for some strange reason want it:

```sh
git clone <this-repo-url> ~/.pi/agent
cd ~/.pi/agent
pnpm install
```

## Sub-agents

The `subagent` extension delegates work to isolated Pi processes. Agent definitions live in [`agents/`](agents/) and use Markdown frontmatter for their system prompt, model, and tool allowlist. Add personal definitions to `~/.pi/agent/agents/`; trusted projects may add `.pi/agents/`, which are discovered automatically.
