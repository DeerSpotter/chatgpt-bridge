function createTab(options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create(options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function updateTab(tabId, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeChatUrl(value = '') {
  const parsed = new URL(String(value || 'https://chatgpt.com/'));
  if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(parsed.origin.toLowerCase()) || parsed.username || parsed.password) {
    throw new Error(`Refusing to open non-ChatGPT URL: ${parsed.toString()}`);
  }
  return parsed.toString();
}

export function createTabController({
  connections,
  safeBridgeServerUrl,
  rememberLaunchedTab,
  readLaunchedTab,
  forgetLaunchedTab,
  isStableLaunchToken,
} = {}) {
  if (!connections || typeof connections.get !== 'function') throw new TypeError('Tab controller requires connections');
  if (typeof safeBridgeServerUrl !== 'function') throw new TypeError('Tab controller requires safeBridgeServerUrl');
  if (typeof rememberLaunchedTab !== 'function' || typeof readLaunchedTab !== 'function' || typeof forgetLaunchedTab !== 'function') {
    throw new TypeError('Tab controller requires launched-tab storage adapters');
  }
  if (typeof isStableLaunchToken !== 'function') throw new TypeError('Tab controller requires launch-token validation');

  function hasConnectedTab(tabId) {
    for (const connection of connections.values()) {
      if (connection?.tabId === tabId && !connection?.closed) return true;
    }
    return false;
  }

  async function waitForConnectedTab(tabId, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hasConnectedTab(tabId)) return true;
      await sleep(150);
    }
    return hasConnectedTab(tabId);
  }

  async function openBridgeTab(port, options = {}) {
    const requestedUrl = safeChatUrl(options.url || 'https://chatgpt.com/');
    const launchToken = String(options.launchToken || `bridge-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const connectionServerUrl = connections.get(port)?.serverUrl || '';
    const bridgeServerUrl = safeBridgeServerUrl(options.bridgeServerUrl || connectionServerUrl);
    const requestedActive = options.active !== false;
    const openerTabId = port?.sender?.tab?.id ?? null;

    // Chrome can defer enough page work in a newly-created inactive ChatGPT tab
    // that the content runtime never finishes bootstrapping until the user
    // manually selects it. For an "inactive" bridge worker, warm it as the
    // active tab only until its extension connection is established, then
    // automatically restore the user's original tab. This preserves the same
    // authenticated Chrome profile without requiring a second login/session.
    const warmThenRestore = !requestedActive && Number.isInteger(openerTabId);
    const tab = await createTab({ url: 'about:blank', active: warmThenRestore ? true : requestedActive });
    if (!Number.isInteger(tab?.id)) throw new Error('Chrome did not return a tab id for the new ChatGPT tab');
    try {
      // Persist ownership before navigation so a fast content connection cannot
      // announce without its one-time launch identity.
      await rememberLaunchedTab(tab.id, { launchToken, requestedUrl, createdAt: Date.now(), serverUrl: bridgeServerUrl });
      await updateTab(tab.id, { url: requestedUrl, active: warmThenRestore ? true : requestedActive });

      let connected = false;
      if (warmThenRestore) {
        connected = await waitForConnectedTab(tab.id);
        await updateTab(openerTabId, { active: true }).catch(() => {});
      }

      return {
        tabId: tab.id,
        launchToken,
        requestedUrl,
        bridgeServerUrl,
        active: requestedActive,
        openerTabId,
        warmed: warmThenRestore,
        connectedDuringWarmup: connected,
      };
    } catch (error) {
      if (warmThenRestore) await updateTab(openerTabId, { active: true }).catch(() => {});
      await forgetLaunchedTab(tab.id);
      await removeTab(tab.id).catch(() => {});
      throw error;
    }
  }

  async function closeOwnBridgeTab(port, options = {}) {
    const tabId = port?.sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
    const launch = await readLaunchedTab(tabId);
    const expectedLaunchToken = String(options.expectedLaunchToken || '');
    if (expectedLaunchToken && launch?.launchToken !== expectedLaunchToken) {
      throw new Error('Refusing to close tab because its launch token does not match');
    }
    setTimeout(() => { void removeTab(tabId).catch(() => {}); }, 150);
    return { tabId, closing: true, launchToken: launch?.launchToken || '' };
  }

  async function closeOwnedBridgeTab(_port, options = {}) {
    const tabId = Number(options.tabId);
    const expectedLaunchToken = String(options.expectedLaunchToken || '');
    if (!Number.isInteger(tabId)) throw new Error('A numeric owned tab id is required');
    if (!isStableLaunchToken(expectedLaunchToken)) {
      throw new Error('A stable expected launch token is required to close another owned tab');
    }
    const launch = await readLaunchedTab(tabId);
    if (!launch || launch.launchToken !== expectedLaunchToken) {
      throw new Error('Refusing to close owned tab because its launch token does not match');
    }
    setTimeout(() => { void removeTab(tabId).catch(() => {}); }, 150);
    return { tabId, closing: true, launchToken: launch.launchToken };
  }

  async function navigateTab(tabId, url) {
    if (!Number.isInteger(tabId)) throw new Error('A numeric tab id is required');
    const targetUrl = String(url || '');
    if (!targetUrl) throw new Error('A target URL is required');
    await updateTab(tabId, { url: targetUrl });
    return { tabId, url: targetUrl };
  }

  async function reloadTab(tabId) {
    if (!Number.isInteger(tabId)) throw new Error('A numeric tab id is required');
    await chrome.tabs.reload(tabId);
    return { tabId, reloading: true };
  }

  async function reloadOwnBridgeTab(port, options = {}) {
    const tabId = port?.sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
    setTimeout(() => { void chrome.tabs.reload(tabId).catch(() => {}); }, 150);
    return { tabId, reloading: true, reason: String(options.reason || '') };
  }

  return Object.freeze({ openBridgeTab, closeOwnBridgeTab, closeOwnedBridgeTab, navigateTab, reloadTab, reloadOwnBridgeTab });
}
