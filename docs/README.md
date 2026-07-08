# Tyrekick documentation

Tyrekick is the feedback loop for AI-built prototypes: reviewers pin comments
directly on the live page — no account, no training — and your coding agent
pulls them back over MCP with the exact element, its visible text, the section
heading, and any page errors attached.

| Guide | What it covers |
| --- | --- |
| [Quickstart](QUICKSTART.md) | From idea to feedback loop — the one-sentence path, plus the manual stops |
| [Getting started](getting-started.md) | Both install paths, verifying, and choosing a destination for where your prototype is hosted |
| [Configuration](configuration.md) | Every config field and `data-*` attribute, with defaults and guidance |
| [The reviewer experience](reviewing.md) | What reviewers see and can do: pins, threads, the drawer, keyboard and touch |
| [Destinations](destinations.md) | Discord webhook vs. your own Cloudflare Worker, the worker's REST API, and protecting a public deployment |
| [The agent loop (MCP)](agent-loop.md) | Setting up `tyrekick-mcp`, the five tools, review modes, and the passive/active operating patterns |
| [Payload reference](payload.md) | Schema v2 field by field, plus the Discord message format |
| [Troubleshooting & FAQ](troubleshooting.md) | Common problems, storage keys, privacy guarantees, SPA notes |

Other entry points:

- **Agents installing Tyrekick into a project** → [`AGENTS.md`](../AGENTS.md) (exact steps, one question to ask the human)
- **The 60-second version** → the [main README](../README.md)
- **Live walkthrough script** → [`DEMO.md`](DEMO.md) — the five-beat, ~4-minute end-to-end demo (pin → agent fixes → resolved)
- **The demo GIF builder** → [`../scripts/README.md`](../scripts/README.md) re-renders the README film in one command (the film is scripted in `scripts/record-demo.mjs`)
- **Roadmap context** → [`lifecycle/`](lifecycle/) holds Excalidraw diagrams of the feedback lifecycle today and at each planned milestone
