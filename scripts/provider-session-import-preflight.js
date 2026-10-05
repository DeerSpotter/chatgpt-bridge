#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerHome() {
  const bridgeHome = path.resolve(process.env.CHATGPT_BRIDGE_HOME || path.join(os.homedir(), '.bridge-data'));
  return path.resolve(process.env.CHATGPT_WEB_PROVIDER_HOME || path.join(bridgeHome, 'chatgpt-web-provider'));
}

function verifiedStateExists() {
  const statePath = path.join(providerHome(), 'browser', 'storage-state.json');
  return fs.existsSync(statePath) && fs.existsSync(`${statePath}.verified.json`);
}

function chromeProcessRunning() {
  try {
    const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return false;
    const output = String(result.stdout || '').toLowerCase();
    return output.includes('"chrome.exe"');
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'win32') return;

  const requestedProfile = String(process.env.CHATGPT_WEB_PROVIDER_IMPORT_PROFILE || 'Default').trim();
  if (!requestedProfile || requestedProfile.toLowerCase() === 'none') return;
  if (verifiedStateExists()) return;
  if (!chromeProcessRunning()) return;

  console.log('[bootstrap] Existing ChatGPT session import needs Chrome to release its profile files.');
  console.log('[bootstrap] Close every Google Chrome window now. The launcher will continue automatically when Chrome is fully stopped.');

  const started = Date.now();
  const deadline = started + 10 * 60_000;
  let backgroundHintShown = false;

  while (Date.now() < deadline) {
    if (!chromeProcessRunning()) {
      console.log('[bootstrap] Chrome is fully closed; continuing with existing-session import.');
      await sleep(2000);
      return;
    }

    if (!backgroundHintShown && Date.now() - started >= 20_000) {
      backgroundHintShown = true;
      console.log('[bootstrap] Chrome is still running in the background. If all windows are closed, exit Chrome from the system tray or end remaining chrome.exe processes in Task Manager.');
    }
    await sleep(1000);
  }

  console.error('[bootstrap] ERROR: Timed out waiting for Chrome to close.');
  console.error('[bootstrap] Close Chrome completely and run START-LOCAL-AGENT.cmd again.');
  process.exitCode = 1;
}

await main();
