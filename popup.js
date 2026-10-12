document.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'appsScriptUrl';
  const ACCESS_TOKEN_KEY = 'driveManagerAccessToken';
  const GITHUB_TOKEN_KEY = 'githubReadToken';
  const AUTH_MODE_KEY = 'authMode';
  const SERVICE_EMAIL_KEY = 'serviceAccountEmail';
  const USER_EMAIL_KEY = 'userOauthEmail';
  const authModeSelect = document.getElementById('authMode');
  const modeHint = document.getElementById('modeHint');
  const appsScriptFields = document.getElementById('appsScriptFields');
  const serviceAccountFields = document.getElementById('serviceAccountFields');
  const appUrlInput = document.getElementById('appUrl');
  const accessTokenInput = document.getElementById('accessToken');
  const githubTokenInput = document.getElementById('githubToken');
  const saFileInput = document.getElementById('saFile');
  const saJsonInput = document.getElementById('saJson');
  const saEmail = document.getElementById('saEmail');
  const saveBtn = document.getElementById('saveBtn');
  const clearSecretsBtn = document.getElementById('clearSecretsBtn');
  const clearSaBtn = document.getElementById('clearSaBtn');
  const clearUserBtn = document.getElementById('clearUserBtn');
  const copyEmailBtn = document.getElementById('copyEmailBtn');
  const authBtn = document.getElementById('authBtn');
  const testBtn = document.getElementById('testBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const checkUpdateBtn = document.getElementById('checkUpdateBtn');
  const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
  const status = document.getElementById('status');
  const urlHelpers = (typeof DriveManagerUrl !== 'undefined' && DriveManagerUrl) || null;
  const policy = globalThis.DriveManagerPolicy;
  const currentVersion = chrome.runtime.getManifest().version;
  let updateState = null;
  let pendingJson = '';

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.style.color = isError ? '#c2410c' : '#1f6feb';
  }

  function currentMode() {
    return authModeSelect.value === 'serviceAccount' ? 'serviceAccount' : 'appsScript';
  }

  function getUrl() {
    return normalizeAppsScriptUrl(appUrlInput.value);
  }

  function normalizeAppsScriptUrl(value) {
    if (urlHelpers?.normalizeAppsScriptUrl) {
      return urlHelpers.normalizeAppsScriptUrl(value);
    }
    const input = String(value || '').trim();
    if (!input) return '';
    const match = input.match(/https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#\s]+\/s|macros\/s)\/[^/?#\s]+\/(?:exec|dev)/i);
    if (match) return match[0];
    return input;
  }

  function isValidAppsScriptUrl(value) {
    if (urlHelpers?.isValidAppsScriptUrl) {
      return urlHelpers.isValidAppsScriptUrl(value);
    }
    return policy.isAppsScriptExecUrl(value);
  }

  let userEmail = '';
  let userReady = false;

  function showEmail(email) {
    const safe = policy.isServiceAccountEmail(email) ? email : '';
    saEmail.dataset.email = safe;
    renderAccountLine();
  }

  function renderAccountLine() {
    if (userEmail) {
      saEmail.textContent = `已用 ${userEmail} 授权。`;
      return;
    }
    if (userReady) {
      saEmail.textContent = '已完成 Google 授权。';
      return;
    }
    const safe = savedEmail();
    saEmail.textContent = safe ? `已保存服务账号：${safe}` : '尚未授权。';
  }

  function savedEmail() {
    return policy.isServiceAccountEmail(saEmail.dataset.email) ? saEmail.dataset.email : '';
  }

  function applyModeUi() {
    const service = currentMode() === 'serviceAccount';
    appsScriptFields.hidden = service;
    serviceAccountFields.hidden = !service;
    modeHint.textContent = service
      ? '选择授权文件后点「授权」。会弹出 Google 登录，用你自己的账号同意访问，不用把邮箱贴到共享里。'
      : 'Apps Script 模式：粘贴以 /exec 结尾的网页应用地址，再点「授权」。';
    authBtn.textContent = '授权';
  }

  function forgetPendingKey() {
    pendingJson = '';
    saJsonInput.value = '';
    saFileInput.value = '';
  }

  function notifyActiveTab(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, message, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  function notifyConfig() {
    notifyActiveTab({
      type: 'drive-manager-config-updated',
      appsScriptUrl: getUrl(),
      authMode: currentMode(),
      serviceAccountEmail: savedEmail(),
      userOauthEmail: userEmail,
      userOauthReady: userReady || Boolean(userEmail)
    });
  }

  function renderUpdate(state) {
    updateState = state || null;
    const available = Boolean(state?.available && state.latestVersion);
    downloadUpdateBtn.disabled = !available;
    if (state?.error) {
      setStatus(`当前版本 ${currentVersion}。${state.error}`, true);
      return;
    }
    if (available) {
      setStatus(`当前版本 ${currentVersion}，发现 ${state.latestVersion}。下载后请解压覆盖并重新加载扩展。`);
      return;
    }
    if (state?.latestVersion) {
      setStatus(`当前版本 ${currentVersion}，已是最新正式版。`);
    }
  }

  function storageGet(area, defaults) {
    return new Promise((resolve) => chrome.storage[area].get(defaults, resolve));
  }

  function storageSet(area, values) {
    return new Promise((resolve) => chrome.storage[area].set(values, resolve));
  }

  authModeSelect.addEventListener('change', () => {
    if (currentMode() !== 'serviceAccount') forgetPendingKey();
    applyModeUi();
  });

  applyModeUi();

  saFileInput.addEventListener('change', () => {
    const file = saFileInput.files && saFileInput.files[0];
    saFileInput.value = '';
    pendingJson = '';
    if (!file) return;
    if (file.size > 20000) {
      setStatus('授权文件过大。请选择服务账号或 OAuth 客户端 JSON。', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingJson = String(reader.result || '');
      setStatus('已读取授权文件。点「授权」会弹出 Google 登录。');
    };
    reader.onerror = () => {
      pendingJson = '';
      setStatus('读取密钥文件失败。', true);
    };
    reader.readAsText(file);
  });

  storageGet('sync', { [STORAGE_KEY]: '' }).then((data) => {
    appUrlInput.value = normalizeAppsScriptUrl(data[STORAGE_KEY] || '');
    return storageGet('local', {
      [ACCESS_TOKEN_KEY]: '',
      [GITHUB_TOKEN_KEY]: '',
      [AUTH_MODE_KEY]: 'appsScript',
      [SERVICE_EMAIL_KEY]: '',
      [USER_EMAIL_KEY]: '',
      updateState: null
    });
  }).then((local) => {
    authModeSelect.value = local[AUTH_MODE_KEY] === 'serviceAccount' ? 'serviceAccount' : 'appsScript';
    userEmail = /^[^\s@]+@[^\s@]+$/.test(String(local[USER_EMAIL_KEY] || '')) ? local[USER_EMAIL_KEY] : '';
    userReady = local.userOauthReady === true;
    showEmail(local[SERVICE_EMAIL_KEY]);
    applyModeUi();
    const accessSet = policy.isAccessToken(local[ACCESS_TOKEN_KEY]);
    const githubSet = policy.isGithubToken(local[GITHUB_TOKEN_KEY]);
    const secretNote = [
      currentMode() === 'serviceAccount'
        ? (userEmail ? `已授权 ${userEmail}` : (userReady ? '已完成 Google 授权' : (savedEmail() ? '服务账号已保存，点「授权」用自己的账号登录' : '尚未授权')))
        : (accessSet ? '访问口令已在本机' : '未设置访问口令'),
      githubSet ? 'GitHub 令牌已在本机' : '未设置 GitHub 令牌'
    ].join('，');
    updateState = local.updateState || null;
    downloadUpdateBtn.disabled = !(updateState?.available && updateState.latestVersion);
    const updateNote = updateState?.available && updateState.latestVersion
      ? ` 发现 ${updateState.latestVersion}，可在「更多」里下载。`
      : '';
    setStatus(`当前版本 ${currentVersion}。${secretNote}${updateNote}`);
  });

  async function storeGithubToken(githubToken) {
    if (!githubToken) return true;
    if (!policy.isGithubToken(githubToken)) {
      setStatus('GitHub 令牌格式无效。请使用 github_pat_ 或 ghp_ 只读令牌。', true);
      return false;
    }
    await storageSet('local', { [GITHUB_TOKEN_KEY]: githubToken });
    githubTokenInput.value = '';
    return true;
  }

  saveBtn.addEventListener('click', async () => {
    const mode = currentMode();
    const githubToken = githubTokenInput.value.trim();
    if (githubToken && !policy.isGithubToken(githubToken)) {
      setStatus('GitHub 令牌格式无效。请使用 github_pat_ 或 ghp_ 只读令牌。', true);
      return;
    }

    if (mode === 'serviceAccount') {
      let jsonText = saJsonInput.value.trim() || pendingJson;
      forgetPendingKey();
      if (!(await storeGithubToken(githubToken))) return;
      if (jsonText) {
        setStatus('正在保存服务账号密钥...');
        let response;
        try {
          response = await chrome.runtime.sendMessage({
            type: 'drive-manager-save-service-account',
            jsonText
          });
        } catch (error) {
          jsonText = '';
          setStatus(error.message || '保存服务账号失败。', true);
          return;
        }
        jsonText = '';
        if (!response?.ok) {
          setStatus(response?.message || '授权文件无效。输入内容已从弹窗清除，请重新选择文件。', true);
          return;
        }
        if (response.kind === 'oauthClient') {
          notifyConfig();
          setStatus('OAuth 客户端已保存。点「授权」会弹出 Google 登录。');
          return;
        }
        if (!policy.isServiceAccountEmail(response.email)) {
          setStatus(response?.message || '授权文件无效。输入内容已从弹窗清除，请重新选择文件。', true);
          return;
        }
        showEmail(response.email);
        notifyConfig();
        setStatus(`服务账号已保存：${response.email}。点「授权」可用你自己的 Google 账号登录。`);
        return;
      }
      if (!savedEmail()) {
        setStatus('请先选择或粘贴服务账号 JSON，再点保存。', true);
        return;
      }
      await storageSet('local', { [AUTH_MODE_KEY]: 'serviceAccount' });
      notifyConfig();
      setStatus(`已切换到服务账号 ${savedEmail()}。请确认文件夹已共享给该邮箱。`);
      return;
    }

    forgetPendingKey();
    const value = getUrl();
    if (value && !isValidAppsScriptUrl(value)) {
      setStatus('地址无效。请粘贴 Apps Script 网页应用的 /exec 地址（支持 Workspace 域名路径）。', true);
      return;
    }
    const accessToken = accessTokenInput.value.trim();
    if (accessToken && !policy.isAccessToken(accessToken)) {
      setStatus('访问口令需为 8 到 200 位字母、数字、下划线或连字符。', true);
      return;
    }
    if (!(await storeGithubToken(githubToken))) return;
    await storageSet('sync', { [STORAGE_KEY]: value });
    const localUpdate = { [AUTH_MODE_KEY]: 'appsScript' };
    if (accessToken) localUpdate[ACCESS_TOKEN_KEY] = accessToken;
    await storageSet('local', localUpdate);
    accessTokenInput.value = '';
    appUrlInput.value = value;
    notifyConfig();
    const devWarning = /\/dev$/i.test(value) ? ' 当前是 /dev 地址，只适合调试。' : '';
    setStatus((value ? '配置已保存。' : '地址已清空。') + devWarning + '口令留空不会覆盖已保存的本机口令。');
  });

  clearSecretsBtn.addEventListener('click', async () => {
    await new Promise((resolve) => {
      chrome.storage.local.remove([ACCESS_TOKEN_KEY, GITHUB_TOKEN_KEY], resolve);
    });
    accessTokenInput.value = '';
    githubTokenInput.value = '';
    setStatus('已清除本机访问口令和 GitHub 令牌。服务账号密钥仍保留在本机。若 GitHub 令牌曾经泄露，请到 GitHub 作废并重新生成。');
  });

  clearSaBtn.addEventListener('click', async () => {
    forgetPendingKey();
    await new Promise((resolve) => {
      chrome.storage.local.remove(['serviceAccountKey', SERVICE_EMAIL_KEY], resolve);
    });
    showEmail('');
    notifyConfig();
    setStatus('已清除本机服务账号密钥。若该密钥曾经泄露，请到 Google Cloud 的服务账号密钥页删除它。');
  });

  clearUserBtn.addEventListener('click', async () => {
    userEmail = '';
    userReady = false;
    await new Promise((resolve) => {
      chrome.storage.local.remove([
        'oauthRefreshToken',
        'oauthClientSecret',
        USER_EMAIL_KEY,
        'userOauthReady'
      ], resolve);
    });
    renderAccountLine();
    notifyConfig();
    setStatus('已退出 Google 授权。OAuth 客户端 ID 和服务账号密钥仍留在本机。点「授权」可重新登录。');
  });

  copyEmailBtn.addEventListener('click', async () => {
    const email = savedEmail();
    if (!email) {
      setStatus('还没有可复制的服务账号邮箱。请先导入并保存 JSON。', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(email);
      setStatus(`已复制 ${email}。到云端硬盘文件夹的共享设置里添加这个邮箱，权限选「编辑者」。`);
    } catch (error) {
      setStatus('复制失败。请手动选择上方邮箱。', true);
    }
  });

  async function openAuthorizeWindow() {
    const local = await storageGet('local', { oauthClientId: '' });
    const response = await chrome.runtime.sendMessage({ type: 'drive-manager-open-authorize' });
    if (!response?.ok) {
      setStatus(response?.message || '无法打开授权窗口。', true);
      return;
    }
    if (policy.isOauthClientId(local.oauthClientId)) {
      setStatus('已打开授权窗口。请在 Google 登录里选择你的账号并点允许。');
      return;
    }
    setStatus('已打开授权窗口。插件 ID 会自动核对。若还没写客户端 ID，按窗口提示改一次 oauth-config.js。');
  }

  authBtn.addEventListener('click', async () => {
    if (currentMode() === 'serviceAccount') {
      let jsonText = saJsonInput.value.trim() || pendingJson;
      forgetPendingKey();
      if (jsonText) {
        setStatus('正在保存授权文件...');
        let saved;
        try {
          saved = await chrome.runtime.sendMessage({
            type: 'drive-manager-save-service-account',
            jsonText
          });
        } catch (error) {
          jsonText = '';
          setStatus(error.message || '授权文件无效。', true);
          return;
        }
        jsonText = '';
        if (!saved?.ok) {
          setStatus(saved?.message || '授权文件无效。', true);
          return;
        }
        if (saved.kind === 'serviceAccount' && policy.isServiceAccountEmail(saved.email)) showEmail(saved.email);
      }
      await storageSet('local', { [AUTH_MODE_KEY]: 'serviceAccount' });
      notifyConfig();
      await openAuthorizeWindow();
      return;
    }
    const value = getUrl();
    if (!value) {
      setStatus('请先粘贴 Apps Script 网页应用地址。', true);
      return;
    }
    if (!isValidAppsScriptUrl(value)) {
      setStatus('地址无效。请粘贴 Apps Script 网页应用的 /exec 地址。', true);
      return;
    }
    const accessToken = accessTokenInput.value.trim();
    if (accessToken && !policy.isAccessToken(accessToken)) {
      setStatus('访问口令需为 8 到 200 位字母、数字、下划线或连字符。', true);
      return;
    }
    await storageSet('sync', { [STORAGE_KEY]: value });
    const localUpdate = { [AUTH_MODE_KEY]: 'appsScript' };
    if (accessToken) localUpdate[ACCESS_TOKEN_KEY] = accessToken;
    await storageSet('local', localUpdate);
    accessTokenInput.value = '';
    appUrlInput.value = value;
    notifyConfig();
    const authUrl = new URL(value);
    authUrl.searchParams.set('action', 'auth');
    chrome.tabs.create({ url: authUrl.toString() });
    setStatus('已打开授权页面。请授权云端硬盘权限，然后刷新云端硬盘页面。');
  });

  testBtn.addEventListener('click', async () => {
    if (currentMode() === 'serviceAccount') {
      if (!savedEmail() && !saJsonInput.value.trim() && !pendingJson) {
        setStatus('请先导入服务账号 JSON 并保存。', true);
        return;
      }
      if (saJsonInput.value.trim() || pendingJson) {
        setStatus('请先点「保存配置」，再测试服务账号。', true);
        return;
      }
      setStatus('正在测试服务账号...');
      try {
        const data = await chrome.runtime.sendMessage({ type: 'drive-manager-test-service-account' });
        if (!data) {
          setStatus('测试失败：后台无响应。请重新加载扩展后重试。', true);
          return;
        }
        if (!data.ok) {
          setStatus(data.message || '服务账号测试失败。', true);
          return;
        }
        if (policy.isServiceAccountEmail(data.email)) showEmail(data.email);
        setStatus(data.message || '服务账号可用。');
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
      return;
    }

    const value = getUrl();
    if (!value) {
      setStatus('请先粘贴 Apps Script 地址。', true);
      return;
    }
    if (!isValidAppsScriptUrl(value)) {
      setStatus('地址无效。请粘贴完整 /exec 地址。', true);
      return;
    }

    await storageSet('sync', { [STORAGE_KEY]: value });
    appUrlInput.value = value;
    notifyActiveTab({ type: 'drive-manager-config-updated', appsScriptUrl: value });
    setStatus('正在测试连接...');

    async function requestAction(action) {
      const url = new URL(value);
      url.searchParams.set('action', action);
      return chrome.runtime.sendMessage({
        type: 'drive-manager-test-connection',
        url: url.toString()
      });
    }

    try {
      let data = await requestAction('ping');
      if (!data) {
        setStatus('测试失败：后台无响应。请重新加载扩展后重试。', true);
        return;
      }
      if (!data.ok && /未知操作|unknown/i.test(data.message || '')) {
        setStatus('旧版后端无 ping，改用授权探测...');
        data = await requestAction('auth');
      }
      if (!data) {
        setStatus('测试失败：后台无响应。', true);
        return;
      }
      if (!data.ok) {
        setStatus(data.message || '测试失败。', true);
        return;
      }
      if (data.message === 'pong' || data.version) {
        setStatus(`连接成功（后端 ${data.version || '已响应'}）。变更类操作需要后端 2.4.0 或更新的 POST 接口。`);
        return;
      }
      if (data.message && /授权|就绪/.test(data.message)) {
        setStatus('连接成功。建议重新部署最新 apps-script-backend.gs。');
        return;
      }
      setStatus('连接成功。');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });

  refreshBtn.addEventListener('click', () => {
    notifyActiveTab({ type: 'drive-manager-refresh' });
    setStatus('已请求刷新当前云端硬盘页面。');
  });

  checkUpdateBtn.addEventListener('click', async () => {
    setStatus('正在检查官方发布...');
    const response = await chrome.runtime.sendMessage({ type: 'drive-manager-check-update' });
    if (!response) {
      setStatus('检查更新失败：后台无响应。', true);
      return;
    }
    if (response.state) renderUpdate(response.state);
    else setStatus(response.message || '检查更新失败。', true);
  });

  downloadUpdateBtn.addEventListener('click', async () => {
    if (!updateState?.available) {
      setStatus('没有可下载的新版本。', true);
      return;
    }
    const confirmed = window.confirm('将下载官方更新包。扩展不会自动覆盖安装。解压覆盖当前目录后，请在扩展管理页重新加载。');
    if (!confirmed) return;
    setStatus('正在下载更新包...');
    const response = await chrome.runtime.sendMessage({ type: 'drive-manager-download-update' });
    if (!response?.ok) {
      setStatus(response?.message || '下载更新失败。', true);
      return;
    }
    setStatus(response.verified
      ? `已开始下载 ${response.filename}，校验通过。`
      : `已开始下载 ${response.filename}。此发布没有校验文件。`);
  });
});
