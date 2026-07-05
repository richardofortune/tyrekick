# Publishing tyrekick-mcp to the MCP registries

Discovery checklist — each needs the owner's account, so these are runbooks,
not automation. `server.json` in this directory is the manifest they consume.

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Backed by Anthropic/GitHub/Microsoft; feeds VS Code's `@mcp` gallery.

```bash
brew install mcp-publisher            # or: go install / release binary
cd mcp
mcp-publisher login github            # proves ownership of io.github.richardofortune/*
mcp-publisher publish                 # reads ./server.json
```

Re-publish after every tyrekick-mcp version bump (update both `version`
fields in server.json first).

## 2. GitHub MCP Registry

Listed via the official registry once the `io.github.*` namespace is
verified — no separate submission. Check it appears at
github.com/mcp after step 1 propagates.

## 3. Smithery (smithery.ai)

Sign in with GitHub → "Add server" → point at the repo. Smithery reads the
package from npm; the stdio command is `npx tyrekick-mcp` with the two env
vars from server.json.

## 4. mcp.so / glama.ai / awesome-mcp-servers

- mcp.so: submit form (or GitHub issue on their repo) with the repo URL.
- glama.ai/mcp: auto-indexes npm + GitHub; verify the listing, claim it.
- punkpeye/awesome-mcp-servers: PR adding tyrekick-mcp under
  "Developer Tools", one line + link.

## Positioning line (reuse everywhere)

> Tyrekick closes the outer loop of agentic development: reviewers pin
> comments on the live prototype (no accounts), agents pull them back over
> MCP — element, heading, route, build SHA, and page errors attached — fix
> what was flagged, and resolve with a note that turns the reviewer's pin
> green.
