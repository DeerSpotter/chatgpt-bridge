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
  return spawn(process.execPath, [path.join(repoRoot, 'src', 'index.js'), '--server'], {
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

function npmNativeCodexNear(directory) {
  if (!directory) return '';
  const packageRoot = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules');
  const candidates = [
    path.join(packageRoot, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(packageRoot, '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  ];
  return candidates.map(existingFile).find(Boolean) || '';
}

function launchFromExplicit(explicit, variableName) {
  const raw = String(explicit || '').trim();
  if (!raw) return null;
  const resolved = existingFile(path.isAbsolute(raw) ? raw : path.resolve(raw)) || existingFile(raw);
  const target = resolved || raw;
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs') {
    return { command: process.execPath, argsPrefix: [target], label: target };
  }
  if (ext === '.cmd' || ext === '.bat') {
    const directory = path.dirname(target);
    const nativeExe = npmNativeCodexNear(directory);
    if (nativeExe) return { command: nativeExe, argsPrefix: [], label: nativeExe };
    const entry = npmCodexEntryNear(directory);
    if (entry) return { command: process.execPath, argsPrefix: [entry], label: entry };
    throw new Error(`${variableName} points to ${ext} shim '${raw}', but its Codex executable/JS entrypoint was not found.`);
  }
  return { command: target, argsPrefix: [], label: target };
}

function resolveWindowsCodexLaunch() {
  const explicit = launchFromExplicit(process.env.CODEX_BIN, 'CODEX_BIN')
    || launchFromExplicit(process.env.CODEX_CLI_PATH, 'CODEX_CLI_PATH');
  if (explicit) return explicit;

  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.replace(/^\"|\"$/g, '').trim())
    .filter(Boolean);

  const directExeCandidates = [
    ...pathDirs.map((directory) => path.join(directory, 'codex.exe')),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    process.env.CODEX_INSTALL_DIR ? path.join(process.env.CODEX_INSTALL_DIR, 'codex.exe') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex', 'packages', 'standalone', 'current', 'codex.exe') : '',
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'packages', 'standalone', 'current', 'codex.exe') : '',
  ].filter(Boolean);

  for (const candidate of directExeCandidates) {
    const exe = existingFile(candidate);
    if (exe) return { command: exe, argsPrefix: [], label: exe };
  }

  const npmRoots = [
    ...pathDirs,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
  ].filter(Boolean);

  for (const directory of [...new Set(npmRoots)]) {
    const nativeExe = npmNativeCodexNear(directory);
    if (nativeExe) return { command: nativeExe, argsPrefix: [], label: nativeExe };
    const entry = npmCodexEntryNear(directory);
    if (entry) return { command: process.execPath, argsPrefix: [entry], label: entry };
  }

  const cmdShim = pathDirs.map((directory) => existingFile(path.join(directory, 'codex.cmd'))).find(Boolean);
  if (cmdShim) {
    throw new Error(`Found Codex command shim at '${cmdShim}', but not its native executable or JS entrypoint. Set CODEX_CLI_PATH/CODEX_BIN to the real codex.exe.`);
  }

  throw new Error([
    'Codex CLI executable was not found.',
    'The Codex desktop app alone may not expose codex.exe on PATH.',
    'Install the Windows CLI with the official installer or set CODEX_CLI_PATH/CODEX_BIN to an existing codex.exe.',
    'Official installer: powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  ].join(' '));
}

function resolveCodexLaunch() {
  if (process.platform === 'win32') return resolveWindowsCodexLaunch();
  const explicit = String(process.env.CODEX_BIN || process.env.CODEX_CLI_PATH || '').trim();
  return { command: explicit || 'codex', argsPrefix: [], label: explicit || 'codex' };
}

function localCodexHome() {
  if (process.env.CHATGPT_BRIDGE_CODEX_HOME) return path.resolve(process.env.CHATGPT_BRIDGE_CODEX_HOME);
  return path.join(os.homedir(), '.bridge-data', 'codex-local');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
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

  const launch = resolveCodexLaunch();
  console.log(`[local] Codex executable: ${launch.label}`);

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_BASE;
  delete env.OPENAI_BASE_URL;
  if (process.env.CHATGPT_BRIDGE_USE_EXISTING_CODEX_HOME !== '1') {
    env.CODEX_HOME = ensureDirectory(localCodexHome());
    console.log(`[local] isolated CODEX_HOME: ${env.CODEX_HOME}`);
  }

  const codexArgs = [...launch.argsPrefix, ...buildCodexArgs(process.argv.slice(2))];
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
