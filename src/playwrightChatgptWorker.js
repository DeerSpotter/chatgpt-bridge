import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.bridge-data', 'chatgpt-playwright-profile');
const DEFAULT_BROWSER_DIR = path.join(repoRoot, '.bridge-data', 'playwright-browsers');
const CHATGPT_URL = 'https://chatgpt.com/';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'textarea[placeholder*="Message"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
];
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
];
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function existingFile(value) {
  if (!value) return '';
  try {
    return fs.statSync(value).isFile() ? value : '';
  } catch {
    return '';
  }
}

function systemLoginBrowser() {
  const explicit = existingFile(String(process.env.CHATGPT_LOGIN_BROWSER || '').trim());
  if (explicit) return explicit;

  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    ];
    return candidates.map(existingFile).find(Boolean) || '';
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].map(existingFile).find(Boolean) || '';
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].map(existingFile).find(Boolean) || '';
}

async function bootstrapLoginWithSystemBrowser(profileDir) {
  const browser = systemLoginBrowser();
  if (!browser) {
    throw new Error([
      'ChatGPT authentication is required, but no normal Chrome/Edge browser was found for the one-time login bootstrap.',
      'Install Chrome/Edge or set CHATGPT_LOGIN_BROWSER to the full path of a supported browser executable.',
    ].join(' '));
  }

  console.log(`[login] opening normal browser for one-time ChatGPT authentication: ${browser}`);
  console.log('[login] Sign into ChatGPT in that dedicated window, confirm the normal ChatGPT composer is visible, then CLOSE THE ENTIRE DEDICATED BROWSER WINDOW.');
  console.log('[login] Google sign-in happens in the normal browser without Playwright controlling the page.');

  const args = [
    `--user-data-dir=${profileDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    CHATGPT_URL,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(browser, args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`The login browser exited via signal ${signal}`));
        return;
      }
      if (Number.isInteger(code) && code !== 0) {
        reject(new Error(`The login browser exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function playwrightCliPath() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
    path.join(repoRoot, 'node_modules', 'playwright', 'lib', 'program.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    const wrapped = new Error('Playwright is not installed. Run npm install once, or launch START-LOCAL-AGENT.cmd which installs missing dependencies automatically.');
    wrapped.code = 'PLAYWRIGHT_NOT_INSTALLED';
    wrapped.cause = error;
    throw wrapped;
  }
}

async function runPlaywrightInstall(browserDir) {
  const cli = playwrightCliPath();
  if (!cli) throw new Error('Playwright CLI was not found under node_modules. Run npm install first.');
  console.log(`[playwright] installing Chromium into ${browserDir}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      cwd: repoRoot,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir },
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Playwright Chromium install exited with code ${code}`)));
  });
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 300 })) return locator;
    } catch {}
  }
  return null;
}

async function sessionAuthenticated(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return false;
        const session = await response.json();
        return Boolean(session?.user && (session.user.id || session.user.email || session.user.name));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function workerReady(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [composer, authenticated] = await Promise.all([
      firstVisible(page, COMPOSER_SELECTORS),
      sessionAuthenticated(page),
    ]);
    if (composer && authenticated) return true;
    await sleep(350);
  }
  return false;
}

export class PlaywrightChatgptWorker {
  #playwright = null;
  #context = null;
  #page = null;
  #queue = Promise.resolve();
  #startedAt = 0;
  #lastUsedAt = 0;
  #authenticated = false;
  #headless = true;
  #installAttempted = false;

  constructor(options = {}) {
    this.profileDir = ensureDir(path.resolve(options.profileDir || process.env.CHATGPT_PLAYWRIGHT_PROFILE || DEFAULT_PROFILE_DIR));
    this.browserDir = ensureDir(path.resolve(options.browserDir || process.env.PLAYWRIGHT_BROWSERS_PATH || DEFAULT_BROWSER_DIR));
    this.forceHeaded = options.headless === false || truthy(process.env.CHATGPT_PLAYWRIGHT_HEADED);
    this.loginTimeoutMs = Math.max(60_000, Number(options.loginTimeoutMs || process.env.CHATGPT_PLAYWRIGHT_LOGIN_TIMEOUT_MS) || 600_000);
    this.responseTimeoutMs = Math.max(30_000, Number(options.responseTimeoutMs || process.env.CHATGPT_PLAYWRIGHT_RESPONSE_TIMEOUT_MS) || 600_000);
  }

  status() {
    return {
      mode: 'playwright-persistent-context',
      running: Boolean(this.#context),
      authenticated: this.#authenticated,
      headless: this.#headless,
      profileDir: this.profileDir,
      browserDir: this.browserDir,
      url: this.#page?.url?.() || '',
      startedAt: this.#startedAt,
      lastUsedAt: this.#lastUsedAt,
    };
  }

  async #launch(headless) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = this.browserDir;
    this.#playwright ||= await importPlaywright();
    const { chromium } = this.#playwright;

    const executablePath = chromium.executablePath();
    if (!fs.existsSync(executablePath)) {
      if (this.#installAttempted) throw new Error(`Playwright Chromium is still missing after installation attempt: ${executablePath}`);
      this.#installAttempted = true;
      await runPlaywrightInstall(this.browserDir);
    }

    this.#headless = headless;
    this.#context = await chromium.launchPersistentContext(this.profileDir, {
      headless,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    const pages = this.#context.pages();
    this.#page = pages[0] || await this.#context.newPage();
    this.#startedAt ||= Date.now();
    await this.#page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  async #closeContext() {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    this.#authenticated = false;
    if (context) await context.close().catch(() => {});
  }

  async #launchAuthenticatedWorker() {
    await this.#launch(this.forceHeaded ? false : true);
    if (await workerReady(this.#page, 20_000)) {
      this.#authenticated = true;
      return true;
    }

    if (this.#headless && !this.forceHeaded) {
      console.log('[playwright] authenticated profile did not become ready headless; retrying in headed worker mode.');
      await this.#closeContext();
      await this.#launch(false);
      if (await workerReady(this.#page, 20_000)) {
        this.#authenticated = true;
        return true;
      }
    }

    return false;
  }

  async start() {
    if (this.#context && this.#page && this.#authenticated) return this.status();

    if (await this.#launchAuthenticatedWorker()) return this.status();

    console.log('[playwright] authenticated ChatGPT session is not present in the dedicated worker profile.');
    await this.#closeContext();

    // Do not perform Google/OAuth sign-in through an automation-controlled page.
    // Seed the dedicated profile with a normal browser first, then hand the
    // authenticated profile back to Playwright for subsequent automation.
    await bootstrapLoginWithSystemBrowser(this.profileDir);

    console.log('[playwright] normal-browser login window closed; validating the saved ChatGPT session.');
    if (!await this.#launchAuthenticatedWorker()) {
      await this.#closeContext();
      throw new Error([
        'The dedicated browser profile is still not authenticated with ChatGPT.',
        'Run the launcher again, sign into ChatGPT in the normal Chrome/Edge window, wait until the ChatGPT composer is visible, then close the entire dedicated window.',
      ].join(' '));
    }

    console.log('[playwright] ChatGPT worker profile is authenticated and ready.');
    return this.status();
  }

  async newConversation() {
    await this.start();
    await this.#page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!await workerReady(this.#page, 20_000)) throw new Error('Authenticated ChatGPT composer is unavailable in the Playwright worker.');
  }

  async #sendInternal(prompt) {
    await this.start();
    const page = this.#page;
    if (!await sessionAuthenticated(page)) {
      this.#authenticated = false;
      throw new Error('ChatGPT worker session is no longer authenticated. Restart the launcher to sign in again.');
    }

    const composer = await firstVisible(page, COMPOSER_SELECTORS);
    if (!composer) throw new Error('ChatGPT composer disappeared from the Playwright worker.');

    const beforeCount = await page.locator(ASSISTANT_SELECTOR).count();
    await composer.fill(String(prompt || ''));

    const sendButton = await firstVisible(page, SEND_SELECTORS);
    if (sendButton) await sendButton.click();
    else await composer.press('Enter');

    const deadline = Date.now() + this.responseTimeoutMs;
    let lastText = '';
    let stableSince = 0;
    let seenAssistant = false;

    while (Date.now() < deadline) {
      const assistant = page.locator(ASSISTANT_SELECTOR);
      const count = await assistant.count();
      if (count > beforeCount) seenAssistant = true;

      if (seenAssistant && count > 0) {
        const text = String(await assistant.nth(count - 1).innerText().catch(() => '')).trim();
        if (text && text === lastText) {
          if (!stableSince) stableSince = Date.now();
        } else {
          lastText = text;
          stableSince = text ? Date.now() : 0;
        }

        const stopButton = await firstVisible(page, STOP_SELECTORS);
        if (lastText && !stopButton && stableSince && Date.now() - stableSince >= 1_500) {
          this.#lastUsedAt = Date.now();
          return lastText;
        }
      }

      await sleep(350);
    }

    throw new Error(`Timed out waiting for ChatGPT response after ${this.responseTimeoutMs}ms`);
  }

  async send(prompt) {
    const run = this.#queue.then(() => this.#sendInternal(prompt));
    this.#queue = run.catch(() => {});
    return await run;
  }

  async close() {
    await this.#closeContext();
  }
}
