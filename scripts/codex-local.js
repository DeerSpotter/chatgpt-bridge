#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const port = Number.parseInt(process.env.PORT || '8080', 10) || 8080;
const rootUrl = process.env.CHATGPT_BRIDGE_LOCAL_URL || `http://127.0.0.1:${port}`;
const providerBaseUrl = `${rootUrl.replace(/\/$/, '')}/v1`;
const providerId = 'chatgpt_web_local';
const harnessModel = process.env.CHATGPT_BRIDGE_CODEX_MODEL || 'gpt-5.1';

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

if (!isLoopbackUrl(rootUrl)) {
  console.error(`Refusing non-loopback provider URL: ${rootUrl}`);
  console.error('This launcher is intentionally local-only. Set CHATGPT_BRIDGE_LOCAL_URL to localhost/127.0.0.1.');
  process.exit(2);
}

async function providerStatus() {
  try {
    const response = await fetch(`${rootUrl.replace(/\/$/, '')}/v1/local-provider/status`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForProvider(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await providerStatus();
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function startBridge() {
  const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.js'), '--server'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_BASE_URL: rootUrl,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
  return child;
}

function existingFile(value) {
  if (!value) return '';
  try {
    return fs.statSync(value).isFile() ? value : '';
  } catch {
    return '';
  }
}

function npmCodexEntryNear(directory) {
  if (!directory) return '';
  const candidates = [
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.mjs'),
  ];
  return candidates.map(existingFile).find(Boolean) || '';
}

function resolveWindowsCodexLaunch() {
  const explicit = String(process.env.CODEX_BIN || '').trim();
  if (explicit) {
    const absolute = path.isAbsolute(explicit) ? explicit : existingFile(path.resolve(explicit));
    const resolved = absolute || existingFile(explicit);
    const ext = path.extname(resolved || explicit).toLowerCase();
    if (ext === '.js' || ext === '.mjs') {
      return { command: process.execPath, argsPrefix: [resolved || explicit], label: resolved || explicit };
    }
    if (ext === '.cmd' || ext === '.bat') {
      const entry = npmCodexEntryNear(path.dirname(resolved || explicit));
      if (entry) return { command: process.execPath, argsPrefix: [entry], label: entry };
      throw new Error(`CODEX_BIN points to ${ext} shim '${explicit}', but its npm Codex entrypoint was not found. Point CODEX_BIN at codex.exe or @openai/codex/bin/codex.js.`);
    }
    return { command: resolved || explicit, argsPrefix: [], label: resolved || explicit };
  }

  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, '').trim())
    .filter(Boolean);

  for (const directory of pathDirs) {
    const exe = existingFile(path.join(directory, 'codex.exe'));
    if (exe) return { command: exe, argsPrefix: [], label: exe };
  }

  const npmRoots = [
    ...pathDirs,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
  ].filter(Boolean);
  for (const directory of [...new Set(npmRoots)]) {
    const entry = npmCodexEntryNear(directory);
    if (entry) return { command: process.execPath, argsPrefix: [entry], label: entry };
  }

  const cmdShim = pathDirs.map((directory) => existingFile(path.join(directory, 'codex.cmd'))).find(Boolean);
  if (cmdShim) {
    throw new Error(`Found Codex command shim at '${cmdShim}', but not a directly executable codex.exe or npm JS entrypoint. Set CODEX_BIN to the real codex.exe or @openai/codex/bin/codex.js path.`);
  }

  throw new Error('Codex executable was not found on PATH. Install Codex or set CODEX_BIN to codex.exe / @openai/codex/bin/codex.js.');
}

function resolveCodexLaunch() {
  if (process.platform === 'win32') return resolveWindowsCodexLaunch();
  const explicit = String(process.env.CODEX_BIN || '').trim();
  return { command: explicit || 'codex', argsPrefix: [], label: explicit || 'codex' };
}

function localCodexHome() {
  if (process.env.CHATGPT_BRIDGE_CODEX_HOME) return path.resolve(process.env.CHATGPT_BRIDGE_CODEX_HOME);
  return path.join(os.homedir(), '.bridge-data', 'codex-local');
}

function buildCodexArgs(userArgs) {
  const overrides = [
    `model_providers.${providerId}.name=\"ChatGPT Web Local\"`,
    `model_providers.${providerId}.base_url=\"${providerBaseUrl}\"`,
    `model_providers.${providerId}.wire_api=\"responses\"`,
    `model_providers.${providerId}.requires_openai_auth=false`,
    `model_provider=${providerId}`,
    `model=\"${harnessModel}\"`,
    'check_for_update_on_startup=false',
    'features.memories=false',
    'features.chronicle=false',
  ];

  const args = [];
  for (const override of overrides) args.push('-c', override);
  args.push(...userArgs);
  return args;
}

async function main() {
  let status = await providerStatus();
  let bridgeChild = null;

  if (!status) {
    console.log(`[local] starting ChatGPT Browser Bridge on ${rootUrl}`);
    bridgeChild = startBridge();
    status = await waitForProvider();
    if (!status) {
      bridgeChild.kill();
      console.error('[local] bridge did not become ready');
      process.exit(1);
    }
  }

  if (!status.browserConnected) {
    if (bridgeChild) bridgeChild.kill();
    console.error('[local] bridge is running, but no logged-in ChatGPT tab is connected.');
    console.error(`[local] open ${rootUrl}/setup, connect the extension, then run this command again.`);
    process.exit(3);
  }

  console.log('[local] model path: Codex CLI -> localhost -> logged-in ChatGPT web tab');
  console.log('[local] Codex backend/OAuth model inference: disabled for this provider');
  console.log('[local] OpenAI API key billing: disabled for this provider');
  console.log(`[local] Codex harness metadata profile: ${harnessModel} (the actual web model is selected in ChatGPT)`);

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_BASE;
  delete env.OPENAI_BASE_URL;
  // Use an isolated Codex home by default so this launch does not inherit a
  // ChatGPT Codex login or API credentials. Set CHATGPT_BRIDGE_USE_EXISTING_CODEX_HOME=1
  // only when debugging a Codex build that refuses custom providers without its
  // normal home; the provider still remains pinned to localhost.
  if (process.env.CHATGPT_BRIDGE_USE_EXISTING_CODEX_HOME !== '1') {
    env.CODEX_HOME = localCodexHome();
  }

  const launch = resolveCodexLaunch();
  const codexArgs = [...launch.argsPrefix, ...buildCodexArgs(process.argv.slice(2))];
  console.log(`[local] Codex executable: ${launch.label}`);

  const child = spawn(launch.command, codexArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  });

  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`[local] failed to launch Codex: ${error.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      if (signal) console.error(`[local] Codex exited via signal ${signal}`);
      resolve(Number.isInteger(code) ? code : 1);
    });
  });

  if (bridgeChild) bridgeChild.kill();
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`[local] ${error.stack || error.message}`);
  process.exit(1);
});
