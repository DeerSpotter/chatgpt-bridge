import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.bridge-data', 'chatgpt-playwright-profile');
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

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    const wrapped = new Error('Playwright is not installed. Launch START-LOCAL-AGENT.cmd once so it can install the local Playwright runtime.');
    wrapped.code = 'PLAYWRIGHT_NOT_INSTALLED';
    wrapped.cause = error;
    throw wrapped;
  }
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
        const response = await fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store',
        });
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

async function minimizePageWindow(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    const target = await cdp.send('Browser.getWindowForTarget');
    if (Number.isInteger(target?.windowId)) {
      await cdp.send('Browser.setWindowBounds', {
        windowId: target.windowId,
        bounds: { windowState: 'minimized' },
      });
    }
    await cdp.detach();
  } catch {
    // Minimize is cosmetic. Browser automation still works if the platform
    // rejects the window-state command.
  }
}

export class PlaywrightChatgptWorker {
  #playwright = null;
  #context = null;
  #page = null;
  #queue = Promise.resolve();
  #startedAt = 0;
  #lastUsedAt = 0;
  #authenticated = false;
  #minimized = false;

  constructor(options = {}) {
    this.profileDir = ensureDir(path.resolve(
      options.profileDir || process.env.CHATGPT_PLAYWRIGHT_PROFILE || DEFAULT_PROFILE_DIR,
    ));
    this.channel = String(
      options.channel || process.env.CHATGPT_PLAYWRIGHT_CHANNEL || 'chrome',
    ).trim() || 'chrome';
    this.forceVisible = options.minimized === false
      || truthy(process.env.CHATGPT_PLAYWRIGHT_VISIBLE)
      || truthy(process.env.CHATGPT_PLAYWRIGHT_HEADED);
    this.loginTimeoutMs = Math.max(
      60_000,
      Number(options.loginTimeoutMs || process.env.CHATGPT_PLAYWRIGHT_LOGIN_TIMEOUT_MS) || 600_000,
    );
    this.responseTimeoutMs = Math.max(
      30_000,
      Number(options.responseTimeoutMs || process.env.CHATGPT_PLAYWRIGHT_RESPONSE_TIMEOUT_MS) || 600_000,
    );
  }

  status() {
    return {
      mode: 'playwright-installed-browser-persistent-context',
      running: Boolean(this.#context),
      authenticated: this.#authenticated,
      channel: this.channel,
      minimized: this.#minimized,
      profileDir: this.profileDir,
      url: this.#page?.url?.() || '',
      startedAt: this.#startedAt,
      lastUsedAt: this.#lastUsedAt,
    };
  }

  async #launch({ minimized = false } = {}) {
    this.#playwright ||= await importPlaywright();
    const { chromium } = this.#playwright;

    this.#minimized = false;
    try {
      this.#context = await chromium.launchPersistentContext(this.profileDir, {
        channel: this.channel,
        headless: false,
        viewport: { width: 1440, height: 1000 },
        locale: 'en-US',
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
    } catch (error) {
      const wrapped = new Error([
        `Unable to launch Playwright with installed browser channel '${this.channel}'.`,
        this.channel === 'chrome'
          ? 'Google Chrome must be installed. If needed, set CHATGPT_PLAYWRIGHT_CHANNEL=msedge to use Microsoft Edge.'
          : 'Set CHATGPT_PLAYWRIGHT_CHANNEL=chrome or msedge to an installed browser channel.',
        `Original error: ${error?.message || error}`,
      ].join(' '));
      wrapped.code = 'PLAYWRIGHT_BROWSER_CHANNEL_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }

    const pages = this.#context.pages();
    this.#page = pages[0] || await this.#context.newPage();
    this.#startedAt ||= Date.now();
    await this.#page.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    if (minimized && !this.forceVisible) {
      await minimizePageWindow(this.#context, this.#page);
      this.#minimized = true;
    }
  }

  async #closeContext() {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    this.#authenticated = false;
    this.#minimized = false;
    if (context) await context.close().catch(() => {});
  }

  async #launchSavedProfile() {
    await this.#launch({ minimized: !this.forceVisible });
    if (await workerReady(this.#page, 20_000)) {
      this.#authenticated = true;
      return true;
    }
    return false;
  }

  async start() {
    if (this.#context && this.#page && this.#authenticated) return this.status();

    if (await this.#launchSavedProfile()) return this.status();

    await this.#closeContext();
    console.log(`[playwright] ChatGPT login is required in installed ${this.channel}.`);
    console.log('[playwright] A dedicated browser profile will open visibly for one-time sign-in.');
    console.log('[playwright] Complete any Google/OpenAI verification normally. The browser is real installed Chrome/Edge, not Playwright Chromium.');

    await this.#launch({ minimized: false });
    const loginDeadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < loginDeadline) {
      if (await workerReady(this.#page, 1_500)) {
        this.#authenticated = true;
        console.log('[playwright] ChatGPT worker profile is authenticated.');
        break;
      }
      await sleep(500);
    }

    if (!this.#authenticated) {
      await this.#closeContext();
      throw new Error(`Timed out waiting for authenticated ChatGPT login in installed ${this.channel}.`);
    }

    if (!this.forceVisible) {
      await minimizePageWindow(this.#context, this.#page);
      this.#minimized = true;
    }

    return this.status();
  }

  async newConversation() {
    await this.start();
    await this.#page.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!await workerReady(this.#page, 20_000)) {
      throw new Error('Authenticated ChatGPT composer is unavailable in the Playwright worker.');
    }
    if (!this.forceVisible && !this.#minimized) {
      await minimizePageWindow(this.#context, this.#page);
      this.#minimized = true;
    }
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
