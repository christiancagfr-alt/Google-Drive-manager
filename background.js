importScripts('policy.js', 'drive-client.js');

const policy = globalThis.DriveManagerPolicy;
const driveClient = globalThis.DriveManagerDriveClient;
const UPDATE_ALARM = 'drive-manager-update-check';
const UPDATE_STATE_KEY = 'updateState';
const GITHUB_TOKEN_KEY = 'githubReadToken';
const AUTH_MODE_KEY = 'authMode';
const SERVICE_ACCOUNT_KEY = 'serviceAccountKey';
const OAUTH_CLIENT_ID_KEY = 'oauthClientId';
const OAUTH_CLIENT_SECRET_KEY = 'oauthClientSecret';
const OAUTH_REFRESH_KEY = 'oauthRefreshToken';
const USER_EMAIL_KEY = 'userOauthEmail';
const UPDATE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_UPDATE_BYTES = 20 * 1024 * 1024;
const MAX_API_RESPONSE_CHARS = 15 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'drive-manager-api-request') {
    if (!isDriveContent(sender) && !isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    handleApiRequest(message)
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-test-connection') {
    if (!isExtensionPage(sender) || !policy.isAllowedTestUrl(message.url)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    handleApiRequest({ url: message.url, method: 'GET' })
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-test-service-account') {
    if (!isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    testServiceAccount()
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-save-service-account') {
    if (!isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    saveAuthFile(message.jsonText)
      .then((saved) => sendResponse({ ok: true, kind: saved.kind, email: saved.email || '', clientId: saved.clientId || '' }))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-open-authorize') {
    if (!isDriveContent(sender) && !isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    chrome.windows.create({
      url: chrome.runtime.getURL('authorize.html'),
      type: 'popup',
      width: 440,
      height: 560,
      focused: true
    }, () => {
      const error = chrome.runtime.lastError;
      sendResponse(error ? { ok: false, message: '无法打开授权窗口。' } : { ok: true });
    });
    return true;
  }

  if (message.type === 'drive-manager-download-url') {
    if (!isDriveContent(sender) && !isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    startUserDownload(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-capture-region') {
    if (!isDocsContent(sender) || !sender.tab) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    captureRegion(sender.tab, message.region)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-check-update') {
    if (!isDriveContent(sender) && !isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    checkForUpdate({ interactive: true })
      .then((state) => sendResponse({ ok: !state.error, state }))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }

  if (message.type === 'drive-manager-download-update') {
    if (!isDriveContent(sender) && !isExtensionPage(sender)) {
      sendResponse({ ok: false, message: '请求被拒绝。' });
      return;
    }
    downloadUpdate()
      .then((result) => sendResponse({ ok: true, verified: Boolean(result.verified), filename: result.filename }))
      .catch((error) => sendResponse({ ok: false, message: publicError(error) }));
    return true;
  }
});

function ensureUpdateAlarm() {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 12 * 60 });
}

let userTokenCache = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SERVICE_ACCOUNT_KEY] || changes[AUTH_MODE_KEY]) driveClient.clearTokenCache();
  if (changes[OAUTH_REFRESH_KEY] || changes[OAUTH_CLIENT_ID_KEY] || changes[OAUTH_CLIENT_SECRET_KEY]) {
    userTokenCache = null;
  }
});

ensureUpdateAlarm();
chrome.runtime.onInstalled.addListener(() => ensureUpdateAlarm());
chrome.runtime.onStartup.addListener(() => ensureUpdateAlarm());
checkForUpdate({ interactive: false }).catch(() => {});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    checkForUpdate({ interactive: false }).catch(() => {});
  }
});

function isExtensionPage(sender) {
  const url = String(sender?.url || '');
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function isDriveContent(sender) {
  try {
    const url = new URL(String(sender?.url || ''));
    return url.protocol === 'https:' && url.hostname === 'drive.google.com';
  } catch (error) {
    return false;
  }
}

function isDocsContent(sender) {
  try {
    const url = new URL(String(sender?.url || ''));
    if (url.protocol !== 'https:') return false;
    if (url.hostname === 'sheets.google.com') return true;
    if (url.hostname !== 'docs.google.com') return false;
    return url.pathname.startsWith('/spreadsheets/') || url.pathname.startsWith('/document/');
  } catch (error) {
    return false;
  }
}

function publicError(error) {
  const text = String(error?.message || '操作失败。')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/github_pat_\S+|ghp_\S+/gi, '[token]')
    .replace(/-----BEGIN[\s\S]*?-----END [A-Z0-9 ]+-----/g, '[key]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [token]');
  return text.slice(0, 240) || '操作失败。';
}

async function localAuth() {
  return chrome.storage.local.get({
    [AUTH_MODE_KEY]: 'appsScript',
    [SERVICE_ACCOUNT_KEY]: null
  });
}

async function saveAuthFile(jsonText) {
  const parsed = driveClient.parseAuthFile(jsonText);
  if (parsed.kind === 'serviceAccount') {
    await chrome.storage.local.set({
      [AUTH_MODE_KEY]: 'serviceAccount',
      [SERVICE_ACCOUNT_KEY]: parsed.key,
      serviceAccountEmail: parsed.key.client_email
    });
    driveClient.clearTokenCache();
    return { kind: 'serviceAccount', email: parsed.key.client_email };
  }
  const update = {
    [AUTH_MODE_KEY]: 'serviceAccount',
    [OAUTH_CLIENT_ID_KEY]: parsed.clientId
  };
  if (parsed.clientSecret) update[OAUTH_CLIENT_SECRET_KEY] = parsed.clientSecret;
  await chrome.storage.local.set(update);
  userTokenCache = null;
  return { kind: 'oauthClient', clientId: parsed.clientId };
}

async function accessTokenForUser(force) {
  const stored = await chrome.storage.local.get({
    [OAUTH_CLIENT_ID_KEY]: '',
    [OAUTH_CLIENT_SECRET_KEY]: '',
    [OAUTH_REFRESH_KEY]: ''
  });
  if (!policy.isOauthClientId(stored[OAUTH_CLIENT_ID_KEY]) || !stored[OAUTH_REFRESH_KEY]) return '';
  const now = Date.now();
  if (!force && userTokenCache && userTokenCache.expMs - 60000 > now) return userTokenCache.token;
  const refreshed = await driveClient.refreshUserAccessToken({
    clientId: stored[OAUTH_CLIENT_ID_KEY],
    clientSecret: stored[OAUTH_CLIENT_SECRET_KEY],
    refreshToken: stored[OAUTH_REFRESH_KEY]
  });
  userTokenCache = {
    token: refreshed.accessToken,
    expMs: Date.now() + refreshed.expiresIn * 1000
  };
  return refreshed.accessToken;
}

async function testServiceAccount() {
  const local = await localAuth();
  const key = driveClient.normalizeStoredKey(local[SERVICE_ACCOUNT_KEY]);
  if (!key) throw new Error('尚未导入服务账号密钥。');
  return driveClient.testConnection(key);
}

async function handleApiRequest(message) {
  const local = await localAuth();
  if (local[AUTH_MODE_KEY] === 'serviceAccount' && message?.method !== 'GET') {
    const body = policy.sanitizeApiBody(message?.body);
    const oauth = await chrome.storage.local.get({ [OAUTH_REFRESH_KEY]: '' });
    if (oauth[OAUTH_REFRESH_KEY]) {
      try {
        return await driveClient.executeWithAccessToken(body, await accessTokenForUser(false));
      } catch (error) {
        if (!error || error.status !== 401) throw error;
        userTokenCache = null;
        return driveClient.executeWithAccessToken(body, await accessTokenForUser(true));
      }
    }
    const key = driveClient.normalizeStoredKey(local[SERVICE_ACCOUNT_KEY]);
    if (!key) throw new Error('请先点「授权」，在弹出的 Google 窗口里用你的账号同意访问。');
    return driveClient.execute(body, key);
  }

  const rawUrl = String(message?.url || '');
  const method = message?.method === 'POST' ? 'POST' : 'GET';
  if (method === 'GET') {
    if (!policy.isAllowedApiRequestUrl(rawUrl)) throw new Error('Apps Script 地址不在允许范围内。');
  } else if (!policy.isAppsScriptExecUrl(rawUrl)) {
    throw new Error('Apps Script 地址不在允许范围内。');
  } else {
    const parsed = new URL(rawUrl);
    if (parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('Apps Script 地址不在允许范围内。');
    }
  }

  const init = {
    method,
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'application/json, text/plain, */*' }
  };
  if (method === 'POST') {
    const body = policy.sanitizeApiBody(message.body);
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(rawUrl, init);
  } catch (error) {
    throw new Error('网络请求失败。请检查网络，以及扩展是否有权访问 script.google.com。');
  }

  const finalUrl = response.url || rawUrl;
  if (!policy.isAllowedApiFinalUrl(finalUrl)) {
    throw new Error('请求被重定向到了非 Apps Script 地址，已中止。');
  }

  if (response.status === 404) {
    throw new Error('请求失败：HTTP 404。请到 script.google.com 的「管理部署」复制最新 /exec 地址。变更类操作需要重新部署最新后端。');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('需要授权。请点击「授权云端硬盘」，登录并允许云端硬盘权限。');
  }
  if (response.status === 405) {
    throw new Error('后端还没有 POST 接口。请把最新 apps-script-backend.gs 部署为新版本。');
  }
  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status}。请重新部署网页应用后再试。`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (text.length > MAX_API_RESPONSE_CHARS) throw new Error('后端响应过大，已中止。');
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('后端返回空响应。请重新部署网页应用，并确认「执行身份」为「访问网页应用的用户」。');
  }
  if (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    /accounts\.google\.com/i.test(finalUrl)
  ) {
    throw new Error('Apps Script 需要授权，或后端尚未部署 doPost。请授权云端硬盘，并部署最新 apps-script-backend.gs。');
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error('后端未返回 JSON。请重新部署最新 apps-script-backend.gs 并完成授权。');
  }
}

function sanitizeRegion(region) {
  const dprValue = Number(region?.dpr);
  const dpr = Number.isFinite(dprValue) ? Math.min(Math.max(dprValue, 1), 4) : 1;
  const left = Number(region?.left);
  const top = Number(region?.top);
  const width = Number(region?.width);
  const height = Number(region?.height);
  if (![left, top, width, height].every((value) => Number.isFinite(value))) {
    throw new Error('截图区域无效。');
  }
  if (width < 8 || height < 8 || width > 480 || height > 480) {
    throw new Error('截图区域超出允许范围。');
  }
  if (left < -80 || top < -80 || left > 20000 || top > 20000) {
    throw new Error('截图区域无效。');
  }
  return { left, top, width, height, dpr };
}

async function captureRegion(tab, region) {
  if (tab?.windowId == null) throw new Error('无法截取当前标签页。');
  const box = sanitizeRegion(region);
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message || '截图失败'));
        return;
      }
      resolve(url);
    });
  });

  const left = Math.max(0, Math.round(box.left * box.dpr));
  const top = Math.max(0, Math.round(box.top * box.dpr));
  const width = Math.max(8, Math.round(box.width * box.dpr));
  const height = Math.max(8, Math.round(box.height * box.dpr));

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const safeWidth = Math.min(width, bitmap.width - left);
    const safeHeight = Math.min(height, bitmap.height - top);
    if (safeWidth < 4 || safeHeight < 4) throw new Error('截图区域无效。');

    const canvas = new OffscreenCanvas(
      Math.min(Math.round(safeWidth * 3), 1200),
      Math.min(Math.round(safeHeight * 3), 1200)
    );
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, left, top, safeWidth, safeHeight, 0, 0, canvas.width, canvas.height);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    const cropped = await blobToDataUrl(outBlob);
    if (!policy.isSafePreviewSrc(cropped)) throw new Error('截图结果无效。');
    return cropped;
  } finally {
    bitmap.close?.();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取截图失败'));
    reader.readAsDataURL(blob);
  });
}

async function startUserDownload(message) {
  const filename = policy.sanitizeDownloadFilename(message?.filename);
  const url = String(message?.url || '');
  if (url.startsWith('data:') && url.length > policy.MAX_DATA_URL_CHARS) {
    throw new Error('下载内容过大。请减少文件数量，或在云端硬盘页面直接下载。');
  }
  if (!policy.isSafeDataDownloadUrl(url) && !policy.isSafeDriveHttpsUrl(url)) {
    throw new Error('下载地址不在允许范围内。');
  }
  await chromeDownload(url, filename);
}

function chromeDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: true,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        reject(new Error(chrome.runtime.lastError?.message || '下载未能开始。'));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function storageGet(area, defaults) {
  return new Promise((resolve) => {
    chrome.storage[area].get(defaults, (data) => resolve(data || defaults));
  });
}

async function storageSet(area, values) {
  return new Promise((resolve) => {
    chrome.storage[area].set(values, () => resolve());
  });
}

async function readGithubToken() {
  const data = await storageGet('local', { [GITHUB_TOKEN_KEY]: '' });
  const token = String(data[GITHUB_TOKEN_KEY] || '').trim();
  return policy.isGithubToken(token) ? token : '';
}

async function readUpdateState() {
  const data = await storageGet('local', { [UPDATE_STATE_KEY]: null });
  return data[UPDATE_STATE_KEY] && typeof data[UPDATE_STATE_KEY] === 'object'
    ? data[UPDATE_STATE_KEY]
    : {};
}

async function writeUpdateState(state) {
  const safe = {
    currentVersion: String(state.currentVersion || ''),
    latestVersion: String(state.latestVersion || ''),
    available: Boolean(state.available),
    assetName: String(state.assetName || ''),
    sha256Available: Boolean(state.sha256Available),
    htmlUrl: policy.officialReleasePage(state.latestVersion) || '',
    checkedAt: Number(state.checkedAt) || Date.now(),
    error: String(state.error || '').slice(0, 240)
  };
  await storageSet('local', { [UPDATE_STATE_KEY]: safe });
  if (safe.available) {
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setBadgeText({ text: 'NEW' });
  } else if (!safe.error) {
    await chrome.action.setBadgeText({ text: '' });
  }
  return safe;
}

async function checkForUpdate(options = {}) {
  const currentVersion = chrome.runtime.getManifest().version;
  const previous = await readUpdateState();
  if (!options.interactive && previous.checkedAt && Date.now() - Number(previous.checkedAt) < UPDATE_MIN_INTERVAL_MS) {
    return previous;
  }

  try {
    const release = await fetchLatestRelease();
    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    const comparison = policy.compareVersions(latestVersion, currentVersion);
    if (comparison === null) throw new Error('发布版本号无法识别。');
    const assetName = policy.releaseAssetName(latestVersion);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const zip = assets.find((asset) => asset && asset.name === assetName);
    const sha = assets.find((asset) => asset && asset.name === `${assetName}.sha256`);
    return await writeUpdateState({
      currentVersion,
      latestVersion,
      available: comparison > 0 && Boolean(zip),
      assetName: zip ? assetName : '',
      sha256Available: Boolean(sha),
      checkedAt: Date.now(),
      error: comparison > 0 && !zip ? '新版本没有官方 zip 资源。' : ''
    });
  } catch (error) {
    return await writeUpdateState({
      ...previous,
      currentVersion,
      checkedAt: Date.now(),
      error: publicError(error)
    });
  }
}

async function fetchLatestRelease() {
  const token = await readGithubToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'google-drive-manager-extension',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!policy.isAllowedUpdateFetchUrl(policy.UPDATE_API)) throw new Error('更新地址无效。');

  const response = await fetch(policy.UPDATE_API, {
    method: 'GET',
    headers,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store'
  });
  if (response.status === 404) {
    throw new Error('找不到公开发布。私有仓库请在弹窗保存只读 GitHub 令牌，或把发布改为公开。');
  }
  if (response.status === 401) {
    throw new Error('GitHub 令牌无效或已过期。请到 GitHub 作废后重新生成，并在弹窗更新。');
  }
  if (response.status === 403) {
    throw new Error('GitHub 暂时拒绝检查更新。请稍后再试。');
  }
  if (!response.ok) throw new Error(`检查更新失败：HTTP ${response.status}。`);

  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('更新信息过大，已中止。');
  const release = JSON.parse(text);
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('更新信息无效。');
  if (release.draft || release.prerelease) throw new Error('最新发布还不是正式版。');
  if (!policy.parseVersion(release.tag_name)) throw new Error('发布版本号无法识别。');
  return release;
}

async function downloadUpdate() {
  const release = await fetchLatestRelease();
  const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
  const currentVersion = chrome.runtime.getManifest().version;
  const comparison = policy.compareVersions(latestVersion, currentVersion);
  if (comparison === null) throw new Error('发布版本号无法识别。');
  if (comparison <= 0) throw new Error(`当前已是 ${currentVersion}，没有更新的正式版。`);

  const assetName = policy.releaseAssetName(latestVersion);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zip = assets.find((asset) => asset && asset.name === assetName);
  const shaAsset = assets.find((asset) => asset && asset.name === `${assetName}.sha256`);
  if (!zip) throw new Error('发布包缺少官方 zip。');
  assertReleaseAsset(zip, latestVersion, assetName);

  const token = await readGithubToken();
  if (shaAsset) {
    assertReleaseAsset(shaAsset, latestVersion, `${assetName}.sha256`);
    const [expected, bytes] = await Promise.all([
      fetchAssetText(shaAsset, token),
      fetchAssetBytes(zip, token)
    ]);
    const actual = await sha256Hex(bytes);
    if (!expected || expected !== actual) throw new Error('更新包校验失败，已拒绝保存。');
    await saveVerifiedBlob(bytes, assetName);
    return { verified: true, filename: assetName };
  }

  if (token) {
    const bytes = await fetchAssetBytes(zip, token);
    await saveVerifiedBlob(bytes, assetName);
    return { verified: false, filename: assetName };
  }

  const official = policy.officialAssetUrl(latestVersion, assetName);
  await chromeDownload(official, assetName);
  return { verified: false, filename: assetName };
}

function assertReleaseAsset(asset, version, filename) {
  const official = policy.officialAssetUrl(version, filename);
  const apiUrl = policy.officialAssetApiUrl(asset.id);
  if (!official || asset.browser_download_url !== official || !apiUrl || asset.url !== apiUrl || asset.name !== filename) {
    throw new Error('发布包地址与官方仓库不一致，已拒绝下载。');
  }
}

async function fetchAssetText(asset, token) {
  const bytes = await fetchAssetBytes(asset, token, 512);
  const text = new TextDecoder().decode(bytes);
  const checksum = policy.normalizeSha256(text);
  if (!checksum) throw new Error('校验文件无效，已拒绝下载。');
  return checksum;
}

async function fetchAssetBytes(asset, token, maxBytes = MAX_UPDATE_BYTES) {
  const official = String(asset.browser_download_url || '');
  const apiUrl = String(asset.url || '');
  if (token) {
    if (!policy.isAllowedUpdateFetchUrl(apiUrl)) throw new Error('发布资源地址无效。');
    return readLimitedBody(apiUrl, {
      headers: githubHeaders(token, 'application/octet-stream'),
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store'
    }, maxBytes, 0, true);
  }
  if (!policy.isAllowedUpdateFetchUrl(official)) throw new Error('发布资源地址无效。');
  return readLimitedBody(official, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'google-drive-manager-extension' },
    credentials: 'omit',
    redirect: 'manual',
    cache: 'no-store'
  }, maxBytes, 0, false);
}

function githubHeaders(token, accept) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'google-drive-manager-extension',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function readLimitedBody(url, init, maxBytes, redirects, allowAuthorizedRedirect) {
  if (!policy.isAllowedUpdateFetchUrl(url)) throw new Error('更新下载地址不在允许范围内。');
  const response = await fetch(url, init);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 3) throw new Error('更新下载重定向过多，已中止。');
    const location = response.headers.get('location');
    if (!location) throw new Error('更新下载重定向无效。');
    const next = new URL(location, url).toString();
    if (!policy.isAllowedUpdateFetchUrl(next)) throw new Error('更新下载被重定向到了非官方地址，已中止。');
    // The GitHub token stays on api.github.com. Redirect targets get a temporary URL of their own.
    const headers = { Accept: 'application/octet-stream', 'User-Agent': 'google-drive-manager-extension' };
    if (allowAuthorizedRedirect && new URL(next).hostname === 'api.github.com' && init.headers?.Authorization) {
      headers.Authorization = init.headers.Authorization;
    }
    return readLimitedBody(next, {
      headers,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store'
    }, maxBytes, redirects + 1, allowAuthorizedRedirect);
  }
  if (!response.ok) throw new Error(`下载更新包失败：HTTP ${response.status}。`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error('更新包过大，已中止。');
  if (!response.body || !response.body.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('更新包过大，已中止。');
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    if (received > maxBytes) throw new Error('更新包过大，已中止。');
    chunks.push(step.value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function saveVerifiedBlob(bytes, filename) {
  const safeName = policy.sanitizeDownloadFilename(filename);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  try {
    await chromeDownload(url, safeName);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
