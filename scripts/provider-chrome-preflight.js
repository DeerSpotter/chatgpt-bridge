#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function existingFile(value) {
  if (!value) return '';
  try { return fs.statSync(value).isFile() ? path.resolve(value) : ''; } catch { return ''; }
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function whereChrome() {
  try {
    const result = spawnSync('where.exe', ['chrome.exe'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return '';
    return existingFile(firstLine(result.stdout));
  } catch {
    return '';
  }
}

function registryChrome() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of keys) {
    try {
      const result = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) continue;
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const match = line.match(/REG_SZ\s+(.+)$/i);
        const found = existingFile(match?.[1]?.trim());
        if (found) return found;
      }
    } catch {}
  }
  return '';
}

function discoverChrome() {
  const explicit = existingFile(String(process.env.CHATGPT_WEB_PROVIDER_CHROME || '').trim());
  if (explicit) return explicit;

  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome SxS', 'Application', 'chrome.exe') : '',
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ];

  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found) return found;
  }
  return registryChrome() || whereChrome();
}

function providerPaths() {
  const bridgeHome = path.resolve(process.env.CHATGPT_BRIDGE_HOME || path.join(os.homedir(), '.bridge-data'));
  const providerHome = path.resolve(process.env.CHATGPT_WEB_PROVIDER_HOME || path.join(bridgeHome, 'chatgpt-web-provider'));
  return { providerHome, configPath: path.join(providerHome, 'config.json') };
}

function defaultProviderConfig(chromeExecutablePath) {
  return {
    version: 1,
    host: '127.0.0.1',
    port: 17842,
    apiToken: crypto.randomBytes(32).toString('base64url'),
    chromeExecutablePath,
    headed: true,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
  };
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, configPath);
}

function main() {
  if (process.platform !== 'win32') return;

  const chrome = discoverChrome();
  if (!chrome) {
    console.error('[bootstrap] ERROR: Google Chrome could not be located.');
    console.error('[bootstrap] Checked the per-user install, Program Files, Program Files (x86), registry App Paths, and PATH.');
    console.error('[bootstrap] Set CHATGPT_WEB_PROVIDER_CHROME to the full path of chrome.exe and rerun the launcher.');
    process.exitCode = 1;
    return;
  }

  const { providerHome, configPath } = providerPaths();
  let config;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.error(`[bootstrap] ERROR: provider config is not valid JSON: ${configPath}`);
      console.error(`[bootstrap] ${error.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    config = defaultProviderConfig(chrome);
  }

  if (config.chromeExecutablePath !== chrome || !existingFile(config.chromeExecutablePath)) {
    config.chromeExecutablePath = chrome;
    writeConfig(configPath, config);
    console.log(`[bootstrap] provider Chrome path updated: ${chrome}`);
  } else {
    console.log(`[bootstrap] Chrome executable: ${chrome}`);
  }

  console.log(`[bootstrap] provider state: ${providerHome}`);
}

main();
