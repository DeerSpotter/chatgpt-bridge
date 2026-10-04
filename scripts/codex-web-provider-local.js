#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  buildResponsesBridgePrompt,
  extractResponsesTurn,
  makeResponsesCompletedEvent,
  makeResponsesMessageItem,
  makeResponsesUsage,
  parseResponsesToolCall,
} from '../src/responsesPayload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
path.resolve(here, '..');
const bridgeHome = path.resolve(process.env.CHATGPT_BRIDGE_HOME || path.join(os.homedir(), '.bridge-data'));
const providerCheckout = path.resolve(process.env.CHATGPT_WEB_PROVIDER_CHECKOUT || path.join(bridgeHome, 'vendor', 'chatgpt-web-provider'));
const providerHome = path.resolve(process.env.CHATGPT_WEB_PROVIDER_HOME || path.join(bridgeHome, 'chatgpt-web-provider'));
const providerConfigPath = path.join(providerHome, 'config.json');
const providerRepo = 'https://github.com/JonusNattapong/chatgpt-web-provider.git';
const providerCommit = 'b32418369ff2ef6db8addc427fd86d959c26f977';
const bunVersion = '1.4.0';
const adapterPort = Number.parseInt(process.env.CHATGPT_BRIDGE_PROVIDER_PORT || '8181', 10) || 8181;
const adapterRoot = `http://127.0.0.1:${adapterPort}`;
const adapterBaseUrl = `${adapterRoot}/v1`;
const providerId = 'chatgpt_web_provider_local';
const harnessModel = process.env.CHATGPT_BRIDGE_CODEX_MODEL || 'gpt-5.3-codex';
const upstreamModel = process.env.CHATGPT_WEB_MODEL || 'chatgpt-web/medium';
const LOCAL_MODEL_ID = 'chatgpt-web-local-agent';

const bunWindowsAssets = {
  x64: {
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-x64.zip`,
    sha256: 'e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901',
  },
  arm64: {
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-aarch64.zip`,
    sha256: 'f473bfe2df73ee770548c93dd5d380aea7120c218ec2aa1afdd0bbba7bf18c47',
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function existingFile(value) {
  if (!value) return '';
  try { return fs.statSync(value).isFile() ? value : ''; } catch { return ''; }
}

function existingDir(value) {
  if (!value) return '';
  try { return fs.statSync(value).isDirectory() ? value : ''; } catch { return ''; }
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: Number.isInteger(code) ? code : 1, signal, stdout, stderr }));
  });
}

function spawnInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      windowsHide: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${path.basename(command)} exited via signal ${signal}`));
      else if (code !== 0) reject(new Error(`${path.basename(command)} exited with code ${code}`));
      else resolve();
    });
  });
}

async function commandPath(name) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await spawnCapture(locator, [name]).catch(() => null);
  if (!result || result.code !== 0) return '';
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadFile(url, destination, expectedSha256) {
  ensureDir(path.dirname(destination));
  const temp = `${destination}.${process.pid}.tmp`;
  console.log(`[bootstrap] downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const file = fs.createWriteStream(temp, { flags: 'w' });
  try {
    for await (const chunk of response.body) {
      if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
    }
    await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
    const actual = await sha256File(temp);
    if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${path.basename(destination)}: expected ${expectedSha256}, got ${actual}`);
    }
    fs.renameSync(temp, destination);
  } catch (error) {
    try { file.destroy(); } catch {}
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function findFileRecursive(root, wantedName) {
  if (!existingDir(root)) return '';
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === wantedName.toLowerCase()) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return '';
}

async function ensurePortableBun() {
  const explicit = existingFile(String(process.env.CHATGPT_WEB_PROVIDER_BUN || '').trim());
  if (explicit) return explicit;

  const installed = await commandPath(process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (installed) return installed;

  if (process.platform !== 'win32' || !bunWindowsAssets[process.arch]) {
    throw new Error('Bun 1.4+ is required by chatgpt-web-provider. Install Bun or set CHATGPT_WEB_PROVIDER_BUN to its executable.');
  }

  const runtimeRoot = ensureDir(path.join(bridgeHome, 'runtime', `bun-${bunVersion}-${process.arch}`));
  const existing = findFileRecursive(runtimeRoot, 'bun.exe');
  if (existing) return existing;

  const asset = bunWindowsAssets[process.arch];
  const zipPath = path.join(runtimeRoot, 'bun.zip');
  if (!existingFile(zipPath)) await downloadFile(asset.url, zipPath, asset.sha256);
  else {
    const actual = await sha256File(zipPath);
    if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
      fs.rmSync(zipPath, { force: true });
      await downloadFile(asset.url, zipPath, asset.sha256);
    }
  }

  const tar = await commandPath('tar.exe');
  if (!tar) throw new Error('Windows tar.exe is required to unpack the portable Bun runtime.');
  console.log(`[bootstrap] extracting portable Bun ${bunVersion}`);
  const unpack = await spawnCapture(tar, ['-xf', zipPath, '-C', runtimeRoot]);
  if (unpack.code !== 0) throw new Error(`Unable to extract Bun: ${unpack.stderr || unpack.stdout}`);
  const bun = findFileRecursive(runtimeRoot, 'bun.exe');
  if (!bun) throw new Error('Portable Bun archive extracted but bun.exe was not found.');
  return bun;
}

async function ensureProviderCheckout() {
  const git = await commandPath(process.platform === 'win32' ? 'git.exe' : 'git');
  if (!git) throw new Error('git is required to bootstrap chatgpt-web-provider.');

  if (!existingDir(path.join(providerCheckout, '.git'))) {
    ensureDir(path.dirname(providerCheckout));
    console.log(`[bootstrap] cloning chatgpt-web-provider into ${providerCheckout}`);
    const clone = await spawnCapture(git, ['clone', '--filter=blob:none', '--no-checkout', providerRepo, providerCheckout]);
    if (clone.code !== 0) throw new Error(`Unable to clone chatgpt-web-provider: ${clone.stderr || clone.stdout}`);
  }

  const dirty = await spawnCapture(git, ['-C', providerCheckout, 'status', '--porcelain']);
  if (dirty.code !== 0) throw new Error(`Unable to inspect provider checkout: ${dirty.stderr || dirty.stdout}`);
  if (dirty.stdout.trim()) {
    throw new Error(`Provider checkout has local changes at ${providerCheckout}. Preserve or remove them before the launcher updates its pinned backend.`);
  }

  const head = await spawnCapture(git, ['-C', providerCheckout, 'rev-parse', 'HEAD']);
  const current = head.code === 0 ? head.stdout.trim() : '';
  if (current !== providerCommit) {
    console.log(`[bootstrap] pinning chatgpt-web-provider to ${providerCommit.slice(0, 12)}`);
    const fetchResult = await spawnCapture(git, ['-C', providerCheckout, 'fetch', '--depth', '1', 'origin', providerCommit]);
    if (fetchResult.code !== 0) throw new Error(`Unable to fetch pinned provider commit: ${fetchResult.stderr || fetchResult.stdout}`);
    const checkout = await spawnCapture(git, ['-C', providerCheckout, 'checkout', '--detach', providerCommit]);
    if (checkout.code !== 0) throw new Error(`Unable to checkout pinned provider commit: ${checkout.stderr || checkout.stdout}`);
  }
}

function providerEnv() {
  return {
    ...process.env,
    CHATGPT_WEB_PROVIDER_HOME: providerHome,
  };
}

async function ensureProviderDependencies(bun) {
  const markerDir = ensureDir(path.join(providerHome, 'markers'));
  const marker = path.join(markerDir, `deps-${providerCommit}.ok`);
  if (existingFile(marker)) return;
  console.log('[bootstrap] installing chatgpt-web-provider dependencies');
  await spawnInherited(bun, ['install', '--frozen-lockfile'], { cwd: providerCheckout, env: providerEnv() });
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
}

async function runProviderCli(bun, args, { inherited = false } = {}) {
  const commandArgs = ['run', 'src/provider-cli.ts', ...args];
  if (inherited) {
    await spawnInherited(bun, commandArgs, { cwd: providerCheckout, env: providerEnv() });
    return { code: 0, stdout: '', stderr: '' };
  }
  return await spawnCapture(bun, commandArgs, { cwd: providerCheckout, env: providerEnv() });
}

async function ensureProviderConfig(bun) {
  ensureDir(providerHome);
  if (!existingFile(providerConfigPath)) {
    console.log(`[bootstrap] creating private provider configuration under ${providerHome}`);
    await runProviderCli(bun, ['init'], { inherited: true });
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(providerConfigPath, 'utf8')); } catch (error) {
    throw new Error(`Provider config is unreadable at ${providerConfigPath}: ${error.message}`);
  }
  if (!parsed?.apiToken || !parsed?.port || !parsed?.host) {
    throw new Error(`Provider config at ${providerConfigPath} is missing host, port, or apiToken.`);
  }
  if (!['127.0.0.1', 'localhost'].includes(String(parsed.host).toLowerCase())) {
    throw new Error(`Refusing non-loopback chatgpt-web-provider host: ${parsed.host}`);
  }
  return parsed;
}

async function ensureProviderLogin(bun) {
  const doctor = await runProviderCli(bun, ['doctor']);
  if (doctor.code === 0) return;

  const requestedProfile = String(process.env.CHATGPT_WEB_PROVIDER_IMPORT_PROFILE || 'Default').trim();
  const profile = requestedProfile.toLowerCase() === 'none' ? '' : requestedProfile;
  if (profile) {
    console.log(`[bootstrap] trying existing Chrome profile import: ${profile}`);
    console.log('[bootstrap] If Chrome currently has that profile open, the import may fail safely and the launcher will fall back to the provider login flow.');
    const imported = await runProviderCli(bun, ['import-chrome', '--profile', profile]);
    if (imported.code === 0) {
      console.log('[bootstrap] existing Chrome ChatGPT login imported and verified');
      return;
    }
    console.warn('[bootstrap] Chrome-profile import was not usable; falling back to provider login.');
    if (imported.stderr.trim()) console.warn(imported.stderr.trim());
  }

  console.log('[bootstrap] ChatGPT login is not yet verified for the dedicated provider state.');
  console.log('[bootstrap] The provider will open normal installed Chrome. Sign in, confirm the ChatGPT composer is visible, then close that dedicated Chrome window.');
  await runProviderCli(bun, ['login'], { inherited: true });

  const verified = await runProviderCli(bun, ['doctor']);
  if (verified.code !== 0) throw new Error('chatgpt-web-provider login completed but doctor still reports login_verified=false.');
}

async function providerReady(config, timeoutMs = 1_500) {
  const url = `http://${config.host}:${config.port}/readyz`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startProvider(bun, config) {
  if (await providerReady(config)) {
    console.log(`[provider] reusing healthy chatgpt-web-provider on http://${config.host}:${config.port}`);
    return { child: null, owned: false };
  }

  console.log(`[provider] starting chatgpt-web-provider on http://${config.host}:${config.port}`);
  const child = spawn(bun, ['run', 'src/provider-cli.ts', 'serve'], {
    cwd: providerCheckout,
    env: providerEnv(),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let earlyError = null;
  child.once('error', (error) => { earlyError = error; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (earlyError) throw earlyError;
    if (child.exitCode != null) throw new Error(`chatgpt-web-provider exited during startup with code ${child.exitCode}`);
    if (await providerReady(config)) return { child, owned: true };
    await sleep(350);
  }
  throw new Error('Timed out waiting for chatgpt-web-provider readiness.');
}

async function askProvider(config, prompt) {
  const url = `http://${config.host}:${config.port}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: upstreamModel,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(Math.max(30_000, Number(process.env.CHATGPT_WEB_PROVIDER_TURN_TIMEOUT_MS) || 600_000)),
  });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || raw || `${response.status} ${response.statusText}`;
    throw Object.assign(new Error(`chatgpt-web-provider request failed: ${detail}`), { statusCode: 502, code: 'upstream_web_provider_failed' });
  }
  const answer = body?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw Object.assign(new Error('chatgpt-web-provider returned no assistant message content.'), { statusCode: 502, code: 'upstream_web_provider_invalid_response' });
  return answer;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function initSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

async function readJson(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('Request body is too large'), { statusCode: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { statusCode: 400, code: 'invalid_json' });
  }
}

function requestKind(req) {
  const raw = String(req.headers['x-codex-turn-metadata'] || '').trim();
  if (!raw) return 'turn';
  try { return String(JSON.parse(raw)?.request_kind || 'turn'); } catch { return 'turn'; }
}

function translatedOutput(answer, tools) {
  const toolCall = parseResponsesToolCall(answer, tools);
  if (toolCall) return { item: toolCall, toolCall: true };
  return { item: makeResponsesMessageItem(answer), toolCall: false };
}

function nonStreamingResponse(responseId, requestedModel, translated) {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel || LOCAL_MODEL_ID,
    output: [translated.item],
    usage: makeResponsesUsage(),
    metadata: {
      provider: 'chatgpt-web-provider-local-agent',
      backend: 'chatgpt-web-session',
      upstream_model: upstreamModel,
      codex_backend: false,
    },
  };
}

async function handleResponseRequest(req, res, providerConfig) {
  const responseId = `resp_local_${crypto.randomUUID().replaceAll('-', '')}`;
  let streamStarted = false;
  try {
    if (requestKind(req) !== 'turn') {
      throw Object.assign(new Error('Background Codex request kinds are disabled for the ChatGPT web provider adapter.'), { statusCode: 400, code: 'background_request_disabled' });
    }

    const body = await readJson(req);
    const turn = extractResponsesTurn(body);
    const prompt = buildResponsesBridgePrompt(turn);
    if (!prompt) throw Object.assign(new Error('No user message or local tool result was found in the Responses request.'), { statusCode: 400, code: 'missing_input' });

    const answer = await askProvider(providerConfig, prompt);
    const translated = translatedOutput(answer, turn.tools);
    const stream = body.stream !== false;

    if (!stream) {
      json(res, 200, nonStreamingResponse(responseId, turn.requestedModel, translated));
      return;
    }

    initSse(res);
    streamStarted = true;
    writeSse(res, { type: 'response.created', response: {} });
    if (translated.toolCall) {
      writeSse(res, { type: 'response.output_item.done', item: translated.item });
    } else {
      writeSse(res, { type: 'response.output_item.added', item: makeResponsesMessageItem('', translated.item.id) });
      if (answer) writeSse(res, { type: 'response.output_text.delta', delta: answer });
      writeSse(res, { type: 'response.output_item.done', item: translated.item });
    }
    writeSse(res, makeResponsesCompletedEvent(responseId));
    res.end();
  } catch (error) {
    const code = error?.code || 'web_provider_adapter_failed';
    const message = error?.message || String(error);
    if (streamStarted || res.headersSent) {
      writeSse(res, { type: 'response.failed', response: { id: responseId, error: { code, message } } });
      res.end();
      return;
    }
    json(res, Number.isInteger(error?.statusCode) ? error.statusCode : 500, { error: { code, message } });
  }
}

function createAdapterServer(providerConfig) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', adapterRoot);
    if (req.method === 'GET' && url.pathname === '/v1/local-provider/status') {
      json(res, 200, {
        ok: await providerReady(providerConfig),
        provider: 'chatgpt-web-provider-local-agent',
        modelBackend: 'chatgpt-web-session',
        transport: 'JonusNattapong/chatgpt-web-provider',
        upstreamModel,
        upstreamCommit: providerCommit,
        loopbackOnly: true,
        codexBackend: false,
        codexOAuthRequired: false,
        openAiApiKeyRequired: false,
        providerFallback: false,
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: [{ id: LOCAL_MODEL_ID, object: 'model', owned_by: 'local-chatgpt-web' }], models: [] });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      await handleResponseRequest(req, res, providerConfig);
      return;
    }

    if (req.method === 'POST' && ['/v1/responses/compact', '/responses/compact', '/v1/memories/trace_summarize', '/memories/trace_summarize'].includes(url.pathname)) {
      json(res, 400, { error: { code: 'unsupported', message: 'Remote compaction/memory requests are disabled for the local ChatGPT web provider adapter.' } });
      return;
    }

    json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  });
}

function npmCodexEntryNear(directory) {
  if (!directory) return '';
  return [
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.mjs'),
  ].map(existingFile).find(Boolean) || '';
}

function npmNativeCodexNear(directory) {
  if (!directory) return '';
  const packageRoot = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules');
  return [
    path.join(packageRoot, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(packageRoot, '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  ].map(existingFile).find(Boolean) || '';
}

function launchFromExplicit(explicit, variableName) {
  const raw = String(explicit || '').trim();
  if (!raw) return null;
  const resolved = existingFile(path.isAbsolute(raw) ? raw : path.resolve(raw)) || existingFile(raw);
  const target = resolved || raw;
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return { command: process.execPath, argsPrefix: [target], label: target };
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

async function resolveCodexLaunch() {
  const explicit = launchFromExplicit(process.env.CODEX_BIN, 'CODEX_BIN') || launchFromExplicit(process.env.CODEX_CLI_PATH, 'CODEX_CLI_PATH');
  if (explicit) return explicit;
  if (process.platform !== 'win32') return { command: 'codex', argsPrefix: [], label: 'codex' };

  const located = await commandPath('codex.exe');
  if (located) return { command: located, argsPrefix: [], label: located };
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex', 'packages', 'standalone', 'current', 'codex.exe') : '',
  ].map(existingFile).find(Boolean);
  if (candidates) return { command: candidates, argsPrefix: [], label: candidates };
  throw new Error('Codex CLI executable was not found. Install Codex or set CODEX_CLI_PATH/CODEX_BIN.');
}

function buildCodexArgs(userArgs) {
  const overrides = [
    `model_providers.${providerId}.name=\"ChatGPT Web Provider Local\"`,
    `model_providers.${providerId}.base_url=\"${adapterBaseUrl}\"`,
    `model_providers.${providerId}.wire_api=\"responses\"`,
    `model_providers.${providerId}.requires_openai_auth=false`,
    `model_provider=${providerId}`,
    `model=\"${harnessModel}\"`,
    'approval_policy=\"never\"',
    'sandbox_mode=\"workspace-write\"',
    'check_for_update_on_startup=false',
    'features.memories=false',
    'features.chronicle=false',
  ];
  const args = [];
  for (const override of overrides) args.push('-c', override);
  args.push(...userArgs);
  return args;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(adapterPort, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function stopOwnedChild(child, label) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    const taskkill = await commandPath('taskkill.exe');
    if (taskkill) {
      await spawnCapture(taskkill, ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
      console.log(`[local] stopped owned ${label}`);
      return;
    }
  }
  try { child.kill(); } catch {}
  await sleep(250);
  if (child.exitCode == null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  console.log(`[local] stopped owned ${label}`);
}

async function main() {
  ensureDir(bridgeHome);
  const bun = await ensurePortableBun();
  await ensureProviderCheckout();
  await ensureProviderDependencies(bun);
  const providerConfig = await ensureProviderConfig(bun);
  await ensureProviderLogin(bun);
  const providerRuntime = await startProvider(bun, providerConfig);
  const server = createAdapterServer(providerConfig);
  let codexChild = null;

  const cleanup = async () => {
    if (codexChild) await stopOwnedChild(codexChild, 'Codex');
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    if (providerRuntime.owned) await stopOwnedChild(providerRuntime.child, 'chatgpt-web-provider');
  };

  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

  try {
    await listen(server);
    console.log(`[local] adapter: ${adapterBaseUrl}`);
    console.log(`[local] upstream web backend: JonusNattapong/chatgpt-web-provider@${providerCommit.slice(0, 12)}`);
    console.log(`[local] ChatGPT web model: ${upstreamModel}`);
    console.log('[local] model path: Codex CLI -> localhost tool adapter -> chatgpt-web-provider -> ChatGPT web session');
    console.log('[local] Chrome extension: not required for steady-state Codex mode');
    console.log('[local] Codex backend/OAuth model inference: disabled for this provider');
    console.log('[local] OpenAI API key billing: disabled for this provider');

    const codexHome = path.resolve(process.env.CHATGPT_BRIDGE_CODEX_HOME || path.join(bridgeHome, 'codex-local'));
    fs.mkdirSync(codexHome, { recursive: true });
    const env = { ...process.env, CODEX_HOME: codexHome };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_API_BASE;
    delete env.OPENAI_BASE_URL;

    const launch = await resolveCodexLaunch();
    console.log(`[local] Codex executable: ${launch.label}`);
    console.log(`[local] isolated CODEX_HOME: ${codexHome}`);
    console.log(`[local] Codex harness metadata profile: ${harnessModel}`);

    codexChild = spawn(launch.command, [...launch.argsPrefix, ...buildCodexArgs(process.argv.slice(2))], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });

    const exitCode = await new Promise((resolve) => {
      codexChild.once('error', (error) => {
        console.error(`[local] failed to launch Codex: ${error.message}`);
        resolve(127);
      });
      codexChild.once('exit', (code, signal) => {
        if (signal) console.error(`[local] Codex exited via signal ${signal}`);
        resolve(Number.isInteger(code) ? code : 1);
      });
    });
    codexChild = null;
    await cleanup();
    process.exit(exitCode);
  } catch (error) {
    console.error(`[local] ${error.stack || error.message}`);
    await cleanup();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[local] ${error.stack || error.message}`);
  process.exit(1);
});
