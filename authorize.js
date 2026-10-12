const CLIENT_ID_KEY = 'oauthClientId';
const CLIENT_SECRET_KEY = 'oauthClientSecret';
const REFRESH_KEY = 'oauthRefreshToken';
const USER_EMAIL_KEY = 'userOauthEmail';
const client = globalThis.DriveManagerDriveClient;
const policy = globalThis.DriveManagerPolicy;
const bundled = globalThis.DriveManagerOAuthConfig || {};
const statusEl = document.getElementById('status');
const setupEl = document.getElementById('setup');
const clientIdInput = document.getElementById('clientId');
const redirectUriInput = document.getElementById('redirectUri');
const goBtn = document.getElementById('goBtn');

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#c2410c' : '#1f6feb';
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

redirectUriInput.value = `https://${bundled.extensionId || chrome.runtime.id}.chromiumapp.org/`;

document.getElementById('copyRedirectBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(redirectUriInput.value);
    setStatus('已复制回调地址。在 Google Cloud 的网页应用客户端里，加到「已获授权的重定向 URI」。');
  } catch (error) {
    setStatus('复制失败，请手动选择回调地址。', true);
  }
});

function bundledClientId() {
  const value = String(bundled.clientId || '').trim();
  return policy.isOauthClientId(value) ? value : '';
}

function assertThisInstall() {
  const expected = String(bundled.extensionId || '');
  if (!/^[a-p]{32}$/.test(expected)) throw new Error('配置文件里的插件 ID 无效。');
  if (chrome.runtime.id !== expected) {
    throw new Error('插件 ID 和配置文件不一致。请使用带固定密钥的这一份扩展。');
  }
  const callback = redirectUri();
  if (callback !== `https://${expected}.chromiumapp.org/`) {
    throw new Error('回调地址和固定插件 ID 不一致。');
  }
  return callback;
}

async function savedClient() {
  const local = await storageGet({
    [CLIENT_ID_KEY]: '',
    [CLIENT_SECRET_KEY]: '',
    [REFRESH_KEY]: ''
  });
  const typed = clientIdInput.value.trim();
  const fromFile = bundledClientId();
  const clientId = policy.isOauthClientId(typed) ? typed : (fromFile || (policy.isOauthClientId(local[CLIENT_ID_KEY]) ? local[CLIENT_ID_KEY] : ''));
  return {
    clientId,
    clientSecret: local[CLIENT_SECRET_KEY] || '',
    refreshToken: local[REFRESH_KEY] || ''
  };
}

function redirectUri() {
  let url;
  try {
    url = new URL(chrome.identity.getRedirectURL());
  } catch (error) {
    throw new Error('授权回调地址无效。');
  }
  if (url.protocol !== 'https:' || !/^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname)) {
    throw new Error('授权回调地址无效。');
  }
  return `https://${url.hostname}/`;
}

async function start() {
  const current = await savedClient();
  if (!current.clientId) {
    setStatus('配置文件 oauth-config.js 里还没有客户端 ID。把上面的回调地址加进 Google Cloud 后，把客户端 ID 写进这个文件，其他用户就不用再填。', true);
    return;
  }
  if (policy.isOauthClientId(clientIdInput.value.trim())) {
    await storageSet({ [CLIENT_ID_KEY]: current.clientId, authMode: 'serviceAccount' });
  }
  goBtn.disabled = true;
  setStatus('正在核对插件 ID 并打开 Google 登录窗口…');
  let pkce;
  try {
    const callback = assertThisInstall();
    pkce = await client.createPkce();
    const url = client.buildUserAuthUrl({
      clientId: current.clientId,
      redirectUri: callback,
      state: pkce.state,
      codeChallenge: pkce.challenge
    });
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url, interactive: true }, (value) => {
        if (chrome.runtime.lastError || !value) {
          reject(new Error('Google 授权窗口已关闭。'));
          return;
        }
        resolve(value);
      });
    });
    const code = client.readAuthCode(responseUrl, pkce.state, callback);
    const tokens = await client.exchangeUserAuthCode({
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: callback
    });
    const refreshToken = tokens.refreshToken || current.refreshToken;
    if (!refreshToken) throw new Error('Google 没有返回可保持登录的令牌。请在授权窗口点允许。');
    let email = '';
    try {
      email = await client.aboutWithToken(tokens.accessToken);
    } catch (error) {
      email = '';
    }
    await storageSet({
      authMode: 'serviceAccount',
      [CLIENT_ID_KEY]: current.clientId,
      [REFRESH_KEY]: refreshToken,
      [USER_EMAIL_KEY]: email,
      userOauthReady: true
    });
    setStatus(email ? `已用 ${email} 授权。可以关闭这个窗口，回到云端硬盘点「加载」。` : '授权完成。可以关闭这个窗口，回到云端硬盘点「加载」。');
    setTimeout(() => window.close(), 1200);
  } catch (error) {
    setStatus(error.message || '授权没有完成。', true);
    goBtn.disabled = false;
    setupEl.hidden = false;
  } finally {
    pkce = null;
  }
}

goBtn.addEventListener('click', () => {
  start();
});

storageGet({ [CLIENT_ID_KEY]: '' }).then((local) => {
  const fromFile = bundledClientId();
  if (fromFile) {
    clientIdInput.value = fromFile;
    setupEl.hidden = true;
    start();
    return;
  }
  if (policy.isOauthClientId(local[CLIENT_ID_KEY])) {
    clientIdInput.value = local[CLIENT_ID_KEY];
  }
});
