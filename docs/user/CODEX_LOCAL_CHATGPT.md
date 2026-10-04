# Local Codex harness over a ChatGPT web session

This mode keeps the coding harness and tool execution local while sending model turns through a normal logged-in `chatgpt.com` browser tab.

```text
Codex CLI (local harness)
        |
        | Responses API to loopback only
        v
127.0.0.1:8080/v1/responses
        |
        v
ChatGPT Browser Bridge
        |
        v
Chrome extension -> logged-in chatgpt.com tab
        |
        v
normal ChatGPT plan usage
```

The local provider does **not** use an OpenAI API key, Codex OAuth for model inference, or the Codex model backend. It fails closed when the browser tab is unavailable instead of falling back to another provider.

> Browser automation of the consumer ChatGPT web app is not an official OpenAI API integration and can be fragile or unsupported. It does not bypass ChatGPT plan limits. Use only with your own account and review current service terms before relying on it.

## What works in this first implementation

- `/v1/responses` loopback provider for Codex-style Responses traffic.
- Normal assistant text returned to Codex.
- `exec_command` tool translation through a small `run` fence protocol.
- `apply_patch` freeform tool translation through a `patch` fence protocol when Codex offers that tool.
- Tool results are sent back into the same ChatGPT browser conversation so the web model can continue the agent loop.
- `/v1/models` probe support.
- Memory and remote-compaction endpoints fail closed instead of making hidden background model calls.
- The launcher strips API-key environment variables and uses an isolated Codex home by default.

Not yet translated: `write_stdin`, subagents, tool search, hosted web-search tools, and arbitrary MCP function schemas.

## Windows setup

### 1. Install the branch

```powershell
git clone -b feature/codex-responses-provider https://github.com/DeerSpotter/chatgpt-bridge.git
cd chatgpt-bridge
npm install
```

If you already cloned the repository:

```powershell
git fetch origin
git switch feature/codex-responses-provider
npm install
```

### 2. Install/connect the browser extension

```powershell
npm run extension:install
npm start
```

Open:

```text
http://127.0.0.1:8080/setup
```

Follow the setup page to load the unpacked Chrome extension and connect a normal logged-in ChatGPT conversation. Select the ChatGPT model you want to use in that browser tab.

Stop `npm start` after setup if you want the launcher to own the bridge process; `codex:local` will start it automatically when needed.

### 3. Verify the non-Codex provider path

With the bridge running and the browser tab connected:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/v1/local-provider/status
```

Expected fields include:

```text
modelBackend       chatgpt-web-session
transport          loopback-browser-extension
codexBackend       False
codexOAuthRequired False
openAiApiKeyRequired False
providerFallback   False
browserConnected   True
```

### 4. Start Codex through the local provider

```powershell
npm run codex:local --
```

Or run a one-shot task:

```powershell
npm run codex:local -- exec "inspect this repository and report git status"
```

The launcher injects a temporary provider configuration equivalent to:

```toml
model = "gpt-5.1"                 # local Codex harness metadata only
model_provider = "chatgpt_web_local"
check_for_update_on_startup = false

[model_providers.chatgpt_web_local]
name = "ChatGPT Web Local"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
requires_openai_auth = false
```

It also disables Codex memories/chronicle for this launch. The `gpt-5.1` value is used only to select a mature local Codex agent/tool profile. The **actual model response comes from the model selected in the connected ChatGPT web tab**.

Change the local harness metadata profile if needed:

```powershell
$env:CHATGPT_BRIDGE_CODEX_MODEL = "gpt-5.2"
npm run codex:local --
```

## Fail-closed behavior

The launcher and provider intentionally refuse several fallback paths:

- non-loopback provider URLs are rejected;
- `OPENAI_API_KEY`, `OPENAI_API_BASE`, and `OPENAI_BASE_URL` are removed from the Codex child process;
- the custom provider has `requires_openai_auth=false`;
- the provider does not proxy requests to `api.openai.com` or a Codex backend;
- if no ChatGPT browser tab is connected, `/v1/responses` returns an error;
- background memory requests are rejected;
- remote compaction is rejected;
- no provider fallback is implemented by the bridge.

This means a broken web session should produce a visible failure instead of silently consuming API or Codex quota.

## Isolated Codex home

By default the launcher sets:

```text
CODEX_HOME=~/.bridge-data/codex-local
```

That prevents this local-web launch from inheriting a normal Codex login or API credentials from your regular Codex configuration.

If a particular Codex build refuses to initialize a custom provider from a clean home, you can temporarily test with your existing Codex home:

```powershell
$env:CHATGPT_BRIDGE_USE_EXISTING_CODEX_HOME = "1"
npm run codex:local --
```

The provider is still pinned to localhost, but the isolated-home mode is preferred because it provides the clearest separation from ordinary Codex authentication.

## How local tool calls work

For a shell action, the browser model is instructed to emit:

````text
```run
git status --short
```
````

The bridge converts that to the `exec_command` function call offered by the local Codex harness. Codex executes it on the local machine and returns the tool output in the next Responses turn. The bridge forwards that result to the same ChatGPT web conversation.

For patches, when `apply_patch` is offered:

````text
```patch
*** Begin Patch
...
*** End Patch
```
````

The bridge converts that into a Codex `custom_tool_call` for `apply_patch`.
