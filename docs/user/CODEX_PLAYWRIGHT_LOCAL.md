# Local Codex harness backed by ChatGPT web through Playwright

This mode keeps the Codex CLI as the local project/tool harness while routing model turns through a dedicated logged-in ChatGPT web session controlled by Playwright.

## Architecture

```text
Codex CLI (project directory + local tools)
        |
        | OpenAI Responses-compatible localhost HTTP
        v
127.0.0.1:8181
        |
        v
Playwright persistent Chromium worker
        |
        v
logged-in chatgpt.com session
```

The Chrome extension is **not required** for this mode. The older extension-backed path remains available as `npm run codex:extension` for troubleshooting and other bridge features.

## Windows: one launcher

From Explorer, double-click:

```text
START-LOCAL-AGENT.cmd
```

Or from CMD:

```cmd
cd /d C:\chatgpt-bridge
START-LOCAL-AGENT.cmd
```

The launcher does the following automatically:

1. Verifies Node.js exists.
2. Installs Playwright 1.63.0 locally if it is missing without changing `package.json` or `package-lock.json`.
3. Downloads Playwright Chromium into `.bridge-data\playwright-browsers` if needed.
4. Starts a dedicated persistent ChatGPT worker profile.
5. On first use only, opens that worker browser visibly so you can sign into ChatGPT.
6. Saves the authenticated browser profile under `%USERPROFILE%\.bridge-data\chatgpt-playwright-profile`.
7. Restarts the worker headless when possible.
8. Starts the localhost Responses provider on `127.0.0.1:8181`.
9. Starts Codex with that localhost provider, an isolated `CODEX_HOME`, workspace-write sandbox, and no OpenAI API key.
10. Shuts the worker/provider down when Codex exits.

No separate `npm start`, extension connection, browser tab selection, or bridge token entry is required for this mode.

## First run

The first launch may download Chromium. If the saved worker profile is not authenticated, a Chromium window opens. Sign into the ChatGPT account you want the local harness to use. The launcher waits for an authenticated ChatGPT session, then normally restarts the worker headless.

If headless startup does not work with ChatGPT on the machine, the launcher automatically falls back to a headed worker. To force headed mode for diagnostics:

```cmd
set CHATGPT_PLAYWRIGHT_HEADED=1
START-LOCAL-AGENT.cmd
```

## Run one non-interactive task

You can pass ordinary Codex arguments through the launcher:

```cmd
START-LOCAL-AGENT.cmd exec "Inspect this repository, run git status, and report the result."
```

Or use npm directly after Playwright is already installed:

```cmd
npm run codex:local -- exec "Inspect this repository, run git status, and report the result."
```

## Tool behavior

Codex still owns the local execution environment. The browser model is given the live function/custom tool catalog that Codex advertises for the turn. It can request tools such as `exec_command`, `write_stdin`, `apply_patch`, `update_plan`, image-related tools, agent tools, MCP-related functions, and future advertised function/custom tools. Codex executes them locally under its sandbox/tool rules and returns the result to the same Playwright ChatGPT conversation.

The bridge accepts a render-safe tool envelope because Playwright observes rendered ChatGPT text:

```text
LOCAL_TOOL_CALL: {"name":"exec_command","arguments":{"cmd":"git status --short"}}
```

and for freeform/custom tools:

```text
LOCAL_CUSTOM_TOOL_CALL: {"name":"apply_patch","input":"*** Begin Patch\n...\n*** End Patch"}
```

Legacy fenced `run`, `patch`, `tool`, and `custom_tool` forms are still accepted for compatibility.

## Quota and authentication boundary

This mode is designed so Codex is the local harness rather than the inference backend. The custom Codex provider points only at loopback. The launcher removes `OPENAI_API_KEY`, `OPENAI_API_BASE`, and `OPENAI_BASE_URL` from the Codex child environment and uses an isolated `CODEX_HOME`.

The model turn still runs on OpenAI through the logged-in ChatGPT web session; this is not offline inference and does not bypass ChatGPT plan limits. Browser automation of the consumer ChatGPT web interface is unofficial and can require selector/session maintenance if the site changes.
