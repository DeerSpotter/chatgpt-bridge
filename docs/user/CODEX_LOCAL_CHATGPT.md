# Local Codex harness over ChatGPT Web

This mode keeps Codex as the **local project and tool harness** while routing model inference through a user-authenticated ChatGPT Web session.

```text
START-LOCAL-AGENT.cmd
        |
        +-- pinned portable Bun runtime when needed
        +-- pinned chatgpt-web-provider browser backend
        +-- localhost Codex tool adapter
        `-- Codex CLI
              |
              +-- real project working directory
              +-- shell / exec_command / write_stdin
              +-- apply_patch / git
              +-- MCP and advertised function tools
              `-- Codex sandbox / agent machinery
```

Model path:

```text
Codex CLI
    |
    | Responses API, loopback only
    v
127.0.0.1:8181/v1
    |
    | compact local-tool protocol
    v
JonusNattapong/chatgpt-web-provider
    |
    v
installed Chrome + saved ChatGPT Web session
    |
    v
ChatGPT Web model
```

The default path does **not** use an OpenAI API key or Codex OAuth for model inference. It is designed to fail visibly rather than fall back to API or Codex-backend inference.

> ChatGPT Web automation is unofficial and depends on the consumer website. UI/session changes can break it. It does not bypass ChatGPT plan, workspace, rate, or usage limits.

## Why the browser backend is external

The default browser/session layer is pinned to `JonusNattapong/chatgpt-web-provider`, which already implements:

- installed-Chrome browser automation;
- verified ChatGPT login persistence;
- `storage-state.json` session reuse;
- optional import from an existing Chrome profile;
- model/reasoning-mode selection;
- OpenAI-compatible local endpoints;
- ChatGPT UI/session drift checks.

This repository keeps the part that is specific to the local-agent goal: translating Codex's live tool surface into compact browser-model instructions, returning requested tool calls to Codex, and sending actual local tool results into the next browser-model turn.

The upstream provider is pinned to an exact commit by `scripts/codex-web-provider-local.js`; the launcher does not silently track its `main` branch.

## One-command Windows setup

Prerequisites:

- Node.js 20 or newer;
- Git;
- Google Chrome;
- Codex CLI;
- a ChatGPT account that can sign into `chatgpt.com`.

Bun does **not** need to be installed globally on Windows. When Bun is missing, the launcher downloads the pinned Bun 1.4.0 Windows archive into the private bridge runtime directory and verifies its published SHA-256 before extracting it.

From the repository:

```cmd
cd /d C:\chatgpt-bridge
git switch feature/codex-responses-provider
git pull
```

Then run a one-shot smoke test:

```cmd
START-LOCAL-AGENT.cmd exec "Inspect this repository. Run git branch --show-current and git status --short using the local tools, then report the results."
```

Or double-click:

```text
START-LOCAL-AGENT.cmd
```

for an interactive Codex session.

You do **not** need to run `npm start`, start a separate provider terminal, or keep the Chrome extension connected for the default path.

## First launch

The launcher performs the following automatically:

1. Locate Bun or install the pinned portable Bun runtime under `~/.bridge-data/runtime/`.
2. Clone `chatgpt-web-provider` under `~/.bridge-data/vendor/` if it is not already present.
3. Pin that checkout to the exact provider commit expected by this branch.
4. Install the provider's dependencies once.
5. Create its private config under `~/.bridge-data/chatgpt-web-provider/`.
6. Check whether a verified ChatGPT Web session is already saved.
7. If no saved session exists, try importing the Chrome `Default` profile.
8. If profile import cannot be verified, use the provider's normal-Chrome login bootstrap.
9. Start the provider.
10. Start the localhost Codex adapter on port 8181.
11. Launch Codex against that adapter.

### Existing Chrome session import

By default the launcher tries:

```text
Chrome profile: Default
```

Override the profile directory name in CMD:

```cmd
set CHATGPT_WEB_PROVIDER_IMPORT_PROFILE=Profile 1
START-LOCAL-AGENT.cmd
```

Disable import and go directly to the provider login flow:

```cmd
set CHATGPT_WEB_PROVIDER_IMPORT_PROFILE=none
START-LOCAL-AGENT.cmd
```

Chrome 127+ uses App-Bound Encryption for some profile secrets. Because of that, copying/staging an existing Chrome profile may not always produce a usable imported session. The launcher treats import as an optimization, verifies it, and falls back to the provider's dedicated normal-Chrome login flow when necessary.

For the login fallback, a normal installed Chrome window opens. Sign into ChatGPT, wait until the normal ChatGPT composer is visible, then close that dedicated Chrome window. The provider verifies and saves browser state for subsequent launches.

## Subsequent launches

Once the provider has verified browser state, normal startup is approximately:

```text
START-LOCAL-AGENT.cmd
        |
        +-- verify pinned provider/runtime
        +-- verify saved ChatGPT state
        +-- start provider
        +-- start localhost adapter
        `-- start Codex
```

No Google sign-in should be required until the ChatGPT Web session itself expires.

## Actual ChatGPT model vs Codex harness profile

The browser model defaults to:

```text
chatgpt-web/medium
```

Set a different model exposed by the provider/account in CMD, for example:

```cmd
set CHATGPT_WEB_MODEL=chatgpt-web/high
START-LOCAL-AGENT.cmd
```

The Codex model name shown in its TUI is a **local harness metadata profile**, not the model performing inference. Its default is currently:

```text
gpt-5.3-codex
```

Override that metadata profile separately if needed:

```cmd
set CHATGPT_BRIDGE_CODEX_MODEL=gpt-5.3-codex
START-LOCAL-AGENT.cmd
```

The important routing distinction is:

```text
Codex profile -> determines local harness/tool behavior
ChatGPT_WEB_MODEL -> determines browser-backed model/effort
```

## Local tool loop

Codex sends its current advertised tool definitions with each Responses request. The adapter gives the browser model a compact version of that live tool catalog.

A browser-model function request is represented as:

```text
LOCAL_TOOL_CALL: {"name":"exec_command","arguments":{"cmd":"git status --short"}}
```

A freeform custom tool can be represented as:

```text
LOCAL_CUSTOM_TOOL_CALL: {"name":"apply_patch","input":"*** Begin Patch\n...\n*** End Patch"}
```

The adapter accepts only tool names that Codex actually advertised for that turn. It converts the request into a real Codex function/custom-tool call. Codex executes it locally and sends the result back through the adapter.

Each upstream browser request is intentionally self-contained. Tool-result rounds therefore carry both:

- the original user task;
- the actual local tool result.

This prevents a stateless browser turn from losing the purpose of a multi-step Codex task.

## Compact tool catalog

The browser-model tool catalog is deliberately compact and bounded. Descriptions and JSON schemas are stripped of redundant documentation fields, core Codex tools are prioritized, and the total advertised catalog is capped well below the previous 48 KB prototype limit.

This avoids flooding a consumer-web model with tens of kilobytes of system/tool metadata while still leaving Codex itself as the authority over the full real tool registry.

## Status

While the launcher is running, the thin adapter exposes:

```text
http://127.0.0.1:8181/v1/local-provider/status
```

Expected fields include:

```text
provider                chatgpt-web-provider-local-agent
modelBackend            chatgpt-web-session
transport               JonusNattapong/chatgpt-web-provider
loopbackOnly            true
codexBackend            false
codexOAuthRequired      false
openAiApiKeyRequired    false
providerFallback        false
```

The status also reports the pinned upstream provider commit and selected web model.

## Private state locations

By default:

```text
~/.bridge-data/
  codex-local/                     isolated CODEX_HOME
  runtime/                         portable runtime files
  vendor/chatgpt-web-provider/     pinned immutable provider checkout
  chatgpt-web-provider/            private provider config/browser state/markers
```

The provider bearer token and ChatGPT browser state stay in the private provider home. They are not stored in this Git repository.

## Fail-closed boundaries

The launcher and adapter intentionally enforce these boundaries:

- adapter listens only on `127.0.0.1`;
- provider config must resolve to loopback;
- Codex custom provider has `requires_openai_auth=false`;
- `OPENAI_API_KEY`, `OPENAI_API_BASE`, and `OPENAI_BASE_URL` are removed from the Codex child environment;
- Codex uses an isolated `CODEX_HOME`;
- memory/chronicle features are disabled for this launch;
- remote compaction and memory-summary routes are rejected;
- no API/Codex provider fallback is implemented;
- the external browser backend is pinned to an exact source commit;
- a dirty pinned provider checkout causes startup to fail instead of silently replacing local modifications.

If the ChatGPT Web session or browser backend is unavailable, the desired behavior is a visible local error.

## Legacy/fallback paths

The earlier extension-backed implementation remains available for diagnostics:

```cmd
npm run codex:extension --
```

The experimental in-repository Playwright worker remains available separately:

```cmd
npm run codex:playwright --
```

Neither is the default `START-LOCAL-AGENT.cmd` path.
