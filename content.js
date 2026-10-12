(() => {
  const PANEL_ID = 'drive-image-manager-panel';
  const STORAGE_KEY = 'appsScriptUrl';
  const COPY_WITH_NAME_KEY = 'copyLinksWithName';
  const PANEL_POS_KEY = 'panelPosition';
  const IMAGE_MIME_PREFIX = 'image/';
  const VIDEO_MIME_PREFIX = 'video/';
  const urlHelpers = (typeof DriveManagerUrl !== 'undefined' && DriveManagerUrl) || null;

  const state = {
    appsScriptUrl: '',
    accessToken: '',
    authMode: 'appsScript',
    serviceAccountEmail: '',
    userOauthEmail: '',
    userOauthReady: false,
    folderId: '',
    folderName: '',
    files: [],
    folders: [],
    selectedIds: new Set(),
    loading: false,
    copyLinksWithName: false,
    panelPosition: null
  };

  function policy() {
    if (!globalThis.DriveManagerPolicy) {
      throw new Error('扩展组件未加载完整，请在扩展管理页重新加载。');
    }
    return globalThis.DriveManagerPolicy;
  }

  function readAccessToken(value) {
    const token = String(value || '').trim();
    return policy().isAccessToken(token) ? token : '';
  }

  function readAuthMode(value) {
    return value === 'serviceAccount' ? 'serviceAccount' : 'appsScript';
  }

  function readServiceEmail(value) {
    const email = String(value || '').trim();
    return policy().isServiceAccountEmail(email) ? email : '';
  }

  function readUserEmail(value) {
    const email = String(value || '').trim();
    if (!/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(email) || email.includes('..')) return '';
    return email;
  }

  function usingServiceAccount() {
    return state.authMode === 'serviceAccount';
  }

  function userAuthorized() {
    return state.userOauthReady === true || Boolean(state.userOauthEmail);
  }

  function directDriveReady() {
    return userAuthorized() || Boolean(state.serviceAccountEmail);
  }

  let previewPinned = false;

  function init() {
    chrome.storage.sync.get({
      [STORAGE_KEY]: '',
      [COPY_WITH_NAME_KEY]: false,
      [PANEL_POS_KEY]: null
    }, (data) => {
      chrome.storage.local.get({
        driveManagerAccessToken: '',
        updateState: null,
        authMode: 'appsScript',
        serviceAccountEmail: '',
        userOauthEmail: '',
        userOauthReady: false
      }, (local) => {
        state.appsScriptUrl = normalizeAppsScriptUrl(data[STORAGE_KEY] || '');
        state.accessToken = readAccessToken(local.driveManagerAccessToken);
        state.authMode = readAuthMode(local.authMode);
        state.serviceAccountEmail = readServiceEmail(local.serviceAccountEmail);
        state.userOauthEmail = readUserEmail(local.userOauthEmail);
        state.userOauthReady = local.userOauthReady === true;
        state.copyLinksWithName = Boolean(data[COPY_WITH_NAME_KEY]);
        state.panelPosition = normalizePanelPosition(data[PANEL_POS_KEY]);
        mountPanel();
        renderUpdateBanner(local.updateState);
        if (usingServiceAccount()) {
          if (!directDriveReady()) {
            setStatus('请先点击扩展图标，选择授权文件后点「授权」。', true);
            render();
            return;
          }
          loadCurrentFolder();
          return;
        }
        if (!state.appsScriptUrl) {
          setStatus('请先点击扩展图标，粘贴并保存 Apps Script 网页应用 /exec 地址。', true);
          render();
          return;
        }
        loadCurrentFolder();
      });
    });
  }

  function normalizePanelPosition(value) {
    if (!value || typeof value !== 'object') return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function clampPanelPosition(left, top, panel) {
    const margin = 6;
    const width = panel.offsetWidth || 365;
    const height = panel.offsetHeight || 80;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function applyPanelPosition(panel, position) {
    if (!panel) return;
    if (!position) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '10px';
      panel.classList.remove('dim-positioned');
      return;
    }
    const clamped = clampPanelPosition(position.left, position.top, panel);
    panel.style.right = 'auto';
    panel.style.left = `${Math.round(clamped.left)}px`;
    panel.style.top = `${Math.round(clamped.top)}px`;
    panel.classList.add('dim-positioned');
    state.panelPosition = clamped;
  }

  function savePanelPosition(position) {
    state.panelPosition = position;
    chrome.storage.sync.set({ [PANEL_POS_KEY]: position || null });
  }

  function enablePanelDrag(panel) {
    const header = panel.querySelector('.dim-header');
    if (!header) return;

    header.title = '按住拖动面板位置；双击标题栏复位到右上角';
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      const next = clampPanelPosition(originLeft + dx, originTop + dy, panel);
      applyPanelPosition(panel, next);
    };

    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dim-dragging');
      header.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      if (moved && state.panelPosition) {
        savePanelPosition(state.panelPosition);
      }
    };

    header.addEventListener('pointerdown', (event) => {
      // Only primary button; ignore interactive controls in header.
      if (event.button !== 0) return;
      if (event.target.closest('button, a, input, select, textarea, label')) return;

      const rect = panel.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      panel.classList.add('dim-dragging');
      // Switch from right-anchored default to left/top coordinates while dragging.
      applyPanelPosition(panel, { left: originLeft, top: originTop });
      header.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerUp, true);
      event.preventDefault();
    });

    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, a, input, select, textarea, label')) return;
      applyPanelPosition(panel, null);
      savePanelPosition(null);
      setStatus('面板位置已复位到右上角。');
    });

    window.addEventListener('resize', () => {
      if (!state.panelPosition) return;
      applyPanelPosition(panel, state.panelPosition);
      savePanelPosition(state.panelPosition);
    });
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header class="dim-header">
        <div class="dim-title">
          <img class="dim-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" width="28" height="28">
          <div>
            <strong>云端硬盘管理</strong>
            <span id="dim-folder-name">当前文件夹</span>
          </div>
        </div>
        <button id="dim-collapse" title="收起/展开">−</button>
      </header>

      <section class="dim-body">
        <div class="dim-toolbar">
          <div class="dim-row">
            <input id="dim-folder-id" placeholder="源文件夹 ID，留空使用当前 Drive 文件夹">
            <button id="dim-load">加载</button>
          </div>

          <div class="dim-actions">
            <button id="dim-select-all">全选</button>
            <button id="dim-clear">清空</button>
            <button id="dim-download">下载所选</button>
            <button id="dim-copy-links">复制链接</button>
          </div>

          <label class="dim-copy-option" title="关闭：只复制链接；开启：复制「文件名 + 链接」两列">
            <input id="dim-copy-with-name" type="checkbox" ${state.copyLinksWithName ? 'checked' : ''}>
            <span>复制时包含文件名</span>
          </label>

          <div class="dim-row">
            <input id="dim-destination-id" list="dim-destination-options" placeholder="目标文件夹 ID，或选择子文件夹">
            <datalist id="dim-destination-options"></datalist>
            <button id="dim-move">移动</button>
          </div>

          <button id="dim-delete" class="dim-wide-action dim-danger-action">删除所选（移入回收站）</button>
          <div id="dim-update" class="dim-update" hidden></div>

          <div class="dim-create-row">
            <textarea id="dim-folder-names" rows="2" placeholder="批量创建文件夹：每行一个名称"></textarea>
            <button id="dim-create-folders">创建文件夹</button>
          </div>

          <button id="dim-authorize" class="dim-wide-action dim-authorize-action">授权云端硬盘</button>
          <button id="dim-auto-classify" class="dim-wide-action">按文件名自动分类</button>

          <div id="dim-status" class="dim-status">正在初始化...</div>
          <div id="dim-count" class="dim-count">已选 0 项</div>
        </div>
        <div id="dim-grid" class="dim-grid"></div>
      </section>
    `;
    document.body.appendChild(panel);
    applyPanelPosition(panel, state.panelPosition);
    enablePanelDrag(panel);

    document.getElementById('dim-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      // Keep panel fully on-screen after collapse/expand height change.
      if (state.panelPosition) {
        applyPanelPosition(panel, state.panelPosition);
      }
    });
    document.getElementById('dim-load').addEventListener('click', loadCurrentFolder);
    document.getElementById('dim-select-all').addEventListener('click', selectAll);
    document.getElementById('dim-clear').addEventListener('click', clearSelection);
    document.getElementById('dim-download').addEventListener('click', downloadSelected);
    document.getElementById('dim-copy-links').addEventListener('click', copySelectedLinks);
    document.getElementById('dim-copy-with-name').addEventListener('change', (event) => {
      state.copyLinksWithName = Boolean(event.target.checked);
      chrome.storage.sync.set({ [COPY_WITH_NAME_KEY]: state.copyLinksWithName });
      setStatus(state.copyLinksWithName
        ? '已开启：复制「文件名 + 链接」，可粘贴为两列。'
        : '已关闭：只复制链接，每行一个。');
    });
    document.getElementById('dim-move').addEventListener('click', moveSelected);
    document.getElementById('dim-delete').addEventListener('click', deleteSelected);
    document.getElementById('dim-create-folders').addEventListener('click', createFolders);
    document.getElementById('dim-authorize').addEventListener('click', openAuthorizationPage);
    document.getElementById('dim-auto-classify').addEventListener('click', autoClassifyFiles);
  }

  function setStatus(message, isError = false) {
    const status = document.getElementById('dim-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function getCurrentFolderIdFromUrl() {
    const folderMatch = location.href.match(/\/folders\/([^/?#]+)/);
    const query = new URL(location.href).searchParams;
    const candidate = folderMatch ? folderMatch[1] : (query.get('folderId') || query.get('id') || '');
    return policy().isValidDriveId(candidate) ? candidate : '';
  }

  function normalizeAppsScriptUrl(value) {
    if (urlHelpers?.normalizeAppsScriptUrl) {
      return urlHelpers.normalizeAppsScriptUrl(value);
    }
    const input = String(value || '').trim();
    if (!input) return '';
    // Consumer + Workspace deployment URLs.
    const match = input.match(/https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#\s]+\/s|macros\/s)\/[^/?#\s]+\/(?:exec|dev)/i);
    if (match) return match[0];
    return input;
  }

  function isValidAppsScriptUrl(value) {
    if (urlHelpers?.isValidAppsScriptUrl) {
      return urlHelpers.isValidAppsScriptUrl(value);
    }
    try {
      const url = new URL(normalizeAppsScriptUrl(value));
      return url.protocol === 'https:' &&
        url.hostname === 'script.google.com' &&
        /\/(?:a\/macros\/[^/]+\/s|macros\/s)\/[^/]+\/(?:exec|dev)$/i.test(url.pathname);
    } catch (error) {
      return false;
    }
  }

  function openAuthorizationPage() {
    if (usingServiceAccount()) {
      chrome.runtime.sendMessage({ type: 'drive-manager-open-authorize' }, (response) => {
        void chrome.runtime.lastError;
        if (!response?.ok) {
          setStatus(response?.message || '无法打开授权窗口。', true);
          return;
        }
        setStatus('已打开授权窗口。请在 Google 登录里选择你的账号并点允许。');
      });
      return;
    }
    const url = normalizeAppsScriptUrl(state.appsScriptUrl);
    if (!url) {
      setStatus('请先在扩展弹窗中配置 Apps Script 网页应用地址。', true);
      return;
    }
    if (!isValidAppsScriptUrl(url)) {
      setStatus('授权地址无效。请在扩展弹窗中填写 Apps Script 的 /exec 网页应用地址。', true);
      return;
    }
    const authUrl = new URL(url);
    authUrl.searchParams.set('action', 'auth');
    window.open(authUrl.toString(), '_blank', 'noopener');
    setStatus('已打开授权页面。登录并授权云端硬盘后，回到此页面点击“加载”。');
  }

  async function apiRequest(action, params) {
    const body = { action, ...(params || {}) };
    const message = {
      type: 'drive-manager-api-request',
      method: 'POST',
      body
    };
    if (usingServiceAccount()) {
      if (!directDriveReady()) {
        throw new Error('请先点「授权」，在弹出的 Google 窗口里用你的账号同意访问。');
      }
    } else {
      const base = normalizeAppsScriptUrl(state.appsScriptUrl);
      if (!policy().isAppsScriptExecUrl(base)) {
        throw new Error('请先在扩展弹窗中配置 Apps Script 网页应用 /exec 地址。');
      }
      if (state.accessToken) body.token = state.accessToken;
      message.url = base;
    }
    const data = await chrome.runtime.sendMessage(message);
    if (!data) throw new Error('后台脚本没有返回数据。');
    if (!data.ok) throw new Error(data.message || '后端返回失败。');
    return data;
  }

  async function loadCurrentFolder() {
    const folderInput = document.getElementById('dim-folder-id');
    const typed = (folderInput?.value || '').trim();
    if (typed && !policy().isValidDriveId(typed)) {
      setStatus('文件夹 ID 无效。', true);
      return;
    }
    const folderId = typed || getCurrentFolderIdFromUrl();
    state.folderId = folderId;
    state.selectedIds.clear();
    state.loading = true;
    render();
    setStatus('正在加载文件夹...');

    try {
      const data = await apiRequest('list', { folderId });
      state.folderName = data.folder?.name || '当前文件夹';
      state.files = data.files || [];
      state.folders = data.folders || [];
      const truncated = data.truncated ? ' 列表超过 1000 项，已截断。' : '';
      let who = '';
      if (usingServiceAccount() && state.userOauthEmail) {
        who = ` 当前使用 ${state.userOauthEmail}。`;
      } else if (usingServiceAccount() && state.userOauthReady) {
        who = ' 当前使用已授权的 Google 账号。';
      } else if (usingServiceAccount() && state.serviceAccountEmail) {
        who = ` 服务账号 ${state.serviceAccountEmail} 只能看到已共享给它的内容。`;
      }
      setStatus(`已加载 ${state.files.length} 个文件，${state.folders.length} 个子文件夹。${truncated}${who}`);
    } catch (error) {
      state.files = [];
      state.folders = [];
      const message = error.message || '加载失败。';
      if (!usingServiceAccount() && message.includes('404')) {
        setStatus(
          '请求失败：HTTP 404。地址无效或部署已失效。请到 script.google.com → 部署 → 管理部署，复制最新网页应用 /exec 地址，粘贴到扩展弹窗保存；然后可先点「测试连接」。',
          true
        );
      } else if (message.toLowerCase().includes('authorization') || message.includes('需要授权')) {
        setStatus('需要授权。请点击“授权云端硬盘”，登录并允许云端硬盘权限。', true);
      } else {
        setStatus(message, true);
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  function render() {
    renderHeader();
    renderDestinationFolders();
    renderGrid();
    renderCount();
  }

  function renderHeader() {
    const folderName = document.getElementById('dim-folder-name');
    if (folderName) folderName.textContent = state.folderName || '当前文件夹';
    const authButton = document.getElementById('dim-authorize');
    if (authButton) authButton.textContent = usingServiceAccount() ? '授权' : '授权云端硬盘';
  }

  function renderDestinationFolders() {
    const input = document.getElementById('dim-destination-id');
    const datalist = document.getElementById('dim-destination-options');
    if (!input || !datalist) return;

    const previousValue = input.value;
    if (!state.folders.length) {
      datalist.innerHTML = '';
      input.placeholder = '目标文件夹 ID';
      input.value = previousValue;
      return;
    }

    input.placeholder = '目标文件夹 ID，或选择子文件夹';
    datalist.innerHTML = state.folders
      .map((folder) => `<option value="${escapeHtml(folder.id)}" label="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</option>`)
      .join('');
    input.value = previousValue;
  }

  function renderGrid() {
    const grid = document.getElementById('dim-grid');
    if (!grid) return;
    if (state.loading) {
      grid.innerHTML = '<div class="dim-empty">加载中...</div>';
      return;
    }
    if (!state.files.length) {
      grid.innerHTML = '<div class="dim-empty">这个文件夹里没有可显示的文件。</div>';
      return;
    }

    grid.innerHTML = state.files.map(renderFileCard).join('');
    grid.querySelectorAll('.dim-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', (event) => {
        if (event.target.closest('input,button,a')) return;
        const item = state.files.find((file) => file.id === id);
        if (item?.isVideo || isVideoItem(item)) {
          showPreview(item, { pinned: true, autoplay: true });
          return;
        }
        toggleSelection(id);
      });
      card.addEventListener('mouseenter', () => {
        const item = state.files.find((file) => file.id === id);
        if (item?.isImage || item?.isVideo || isVideoItem(item)) showPreview(item);
      });
      card.addEventListener('mouseleave', () => hidePreview());
    });
    grid.querySelectorAll('.dim-select').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        setSelected(checkbox.value, checkbox.checked);
      });
    });
    grid.querySelectorAll('.dim-open').forEach((button) => {
      button.addEventListener('click', () => {
        openExternal(button.dataset.url, button.dataset.fileId);
      });
    });
  }

  function renderFileCard(item) {
    const selected = state.selectedIds.has(item.id);
    const isImage = item.isImage || (item.mimeType || '').startsWith(IMAGE_MIME_PREFIX);
    const isVideo = item.isVideo || isVideoItem(item);
    const rawThumb = item.thumbnailUrl || item.previewUrl || '';
    const thumb = policy().isSafePreviewSrc(rawThumb) ? rawThumb : '';
    const imageHtml = (isImage || isVideo) && thumb
      ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(item.name)}" loading="lazy">`
      : `<div class="dim-file-icon">${escapeHtml(fileLabel(item.mimeType))}</div>`;
    const badgeHtml = isVideo ? '<span class="dim-video-badge">视频</span>' : '';

    return `
      <article class="dim-card ${selected ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
        <label class="dim-check" title="选择文件">
          <input class="dim-select" type="checkbox" value="${escapeHtml(item.id)}" ${selected ? 'checked' : ''}>
        </label>
        <div class="dim-thumb">${imageHtml}${badgeHtml}</div>
        <div class="dim-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="dim-meta">${escapeHtml(formatSize(item.size))}</div>
        <button class="dim-open" data-url="${escapeHtml(item.webViewLink || '')}" data-file-id="${escapeHtml(item.id)}">打开</button>
      </article>
    `;
  }

  function fileLabel(mimeType) {
    if (!mimeType) return '文件';
    if (mimeType.includes('pdf')) return 'PDF';
    if (mimeType.includes('video')) return '视频';
    if (mimeType.includes('zip')) return 'ZIP';
    return '文件';
  }

  function isVideoItem(item) {
    return Boolean(item && (item.mimeType || '').startsWith(VIDEO_MIME_PREFIX));
  }

  function formatSize(size) {
    const value = Number(size || 0);
    if (!value) return '未知大小';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function renderCount() {
    const count = document.getElementById('dim-count');
    if (!count) return;
    count.textContent = `已选 ${state.selectedIds.size} 项`;
  }

  function setSelected(id, checked) {
    if (checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    renderGrid();
    renderCount();
  }

  function toggleSelection(id) {
    setSelected(id, !state.selectedIds.has(id));
  }

  function selectAll() {
    state.files.forEach((file) => state.selectedIds.add(file.id));
    render();
  }

  function clearSelection() {
    state.selectedIds.clear();
    render();
  }

  function getParentFolderId() {
    const typed = (document.getElementById('dim-folder-id')?.value || '').trim();
    if (typed) return policy().isValidDriveId(typed) ? typed : null;
    if (policy().isValidDriveId(state.folderId)) return state.folderId;
    return getCurrentFolderIdFromUrl();
  }

  async function createFolders() {
    const input = document.getElementById('dim-folder-names');
    const names = parseFolderNames(input?.value || '');
    const parentFolderId = getParentFolderId();
    if (parentFolderId === null) {
      setStatus('文件夹 ID 无效。', true);
      return;
    }

    if (!names.length) {
      setStatus('请输入要创建的文件夹名称。', true);
      return;
    }

    setStatus('正在创建文件夹...');
    try {
      const data = await apiRequest('createFolders', {
        parentFolderId,
        names: names.join('\n')
      });
      if (input) input.value = '';
      setStatus(`已创建 ${data.created || names.length} 个文件夹。`);
      await loadCurrentFolder();
    } catch (error) {
      setStatus(error.message || '创建文件夹失败。', true);
    }
  }

  async function autoClassifyFiles() {
    const folderId = getParentFolderId();
    if (folderId === null) {
      setStatus('文件夹 ID 无效。', true);
      return;
    }

    const confirmed = window.confirm(folderId
      ? '将按文件名创建分类文件夹并移动当前文件夹中的文件。确定继续？'
      : '没有文件夹 ID，将对「我的云端硬盘」根目录执行自动分类并移动文件。确定继续？');
    if (!confirmed) {
      setStatus('已取消自动分类。');
      return;
    }

    setStatus('正在按文件名自动分类并移动文件...');
    try {
      const data = await apiRequest('autoClassify', {
        folderId,
        minGroupSize: 2
      });
      setStatus(`自动分类完成：${data.groups || 0} 类，创建 ${data.createdFolders || 0} 个文件夹，移动 ${data.moved || 0} 个文件，跳过 ${data.skipped || 0} 个。`);
      await loadCurrentFolder();
    } catch (error) {
      setStatus(error.message || '自动分类失败。', true);
    }
  }

  function parseFolderNames(value) {
    const seen = new Set();
    return String(value)
      .split(/[\n,;，；]+/)
      .map((name) => name.trim())
      .filter((name) => {
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
  }

  function selectedDriveIds() {
    return Array.from(state.selectedIds).filter((id) => policy().isValidDriveId(id));
  }

  async function deleteSelected() {
    const ids = selectedDriveIds();
    if (!ids.length) {
      setStatus('请先选择要删除的文件。', true);
      return;
    }
    if (ids.length > policy().MAX_FILES) {
      setStatus('一次最多处理 50 个文件。', true);
      return;
    }
    const confirmed = window.confirm(
      `确定将选中的 ${ids.length} 个文件移入云端硬盘回收站吗？\n文件不会被永久删除，可在回收站中恢复。`
    );
    if (!confirmed) {
      setStatus('已取消删除。');
      return;
    }

    setStatus('正在移入回收站...');
    try {
      const data = await apiRequest('delete', { fileIds: ids.join(',') });
      const failed = Number(data.failed || 0);
      setStatus(failed
        ? `已移入回收站 ${data.trashed || 0} 个，失败 ${failed} 个。`
        : `已将 ${data.trashed || ids.length} 个文件移入回收站。`);
      await loadCurrentFolder();
    } catch (error) {
      setStatus(error.message || '删除失败。', true);
    }
  }

  async function moveSelected() {
    const destination = document.getElementById('dim-destination-id')?.value.trim() || '';
    const ids = selectedDriveIds();
    if (!ids.length) {
      setStatus('请先选择要移动的文件。', true);
      return;
    }
    if (ids.length > policy().MAX_FILES) {
      setStatus('一次最多处理 50 个文件。', true);
      return;
    }
    if (!policy().isValidDriveId(destination)) {
      setStatus('请选择或输入有效的目标文件夹 ID。', true);
      return;
    }

    setStatus('正在移动所选文件...');
    try {
      const data = await apiRequest('move', {
        fileIds: ids.join(','),
        destinationFolderId: destination
      });
      setStatus(`已移动 ${data.moved || state.selectedIds.size} 个文件。`);
      await loadCurrentFolder();
    } catch (error) {
      setStatus(error.message || '移动失败。', true);
    }
  }

  async function downloadSelected() {
    const ids = selectedDriveIds();
    if (!ids.length) {
      setStatus('请先选择要下载的文件。', true);
      return;
    }
    if (ids.length > policy().MAX_FILES) {
      setStatus('一次最多处理 50 个文件。', true);
      return;
    }

    setStatus('正在生成下载包...');
    try {
      const data = await apiRequest('download', { fileIds: ids.join(',') });
      const fileName = policy().sanitizeDownloadFilename(data.name || 'drive-files.zip');
      let url = '';
      if (data.data) {
        const mime = String(data.mimeType || 'application/octet-stream');
        if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mime)) {
          throw new Error('后端返回的文件类型无效。');
        }
        const b64 = String(data.data).replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('下载内容无效。');
        url = `data:${mime};base64,${b64}`;
      } else if (policy().isSafeDriveHttpsUrl(data.url)) {
        url = String(data.url);
      } else {
        throw new Error('后端没有返回可下载内容。');
      }
      const response = await chrome.runtime.sendMessage({
        type: 'drive-manager-download-url',
        url,
        filename: fileName
      });
      if (!response?.ok) throw new Error(response?.message || '下载未能开始。');
      setStatus('下载已开始。');
    } catch (error) {
      setStatus(error.message || '下载失败。', true);
    }
  }

  function getFileLink(item) {
    if (!item) return '';
    if (policy().isSafeDriveHttpsUrl(item.webViewLink)) return String(item.webViewLink).trim();
    if (policy().isSafeDriveHttpsUrl(item.downloadUrl)) return String(item.downloadUrl).trim();
    if (policy().isValidDriveId(item.id)) return `https://drive.google.com/file/d/${item.id}/view`;
    return '';
  }

  async function copySelectedLinks() {
    if (!state.selectedIds.size) {
      setStatus('请先勾选或全选要复制链接的文件。', true);
      return;
    }

    const withName = Boolean(document.getElementById('dim-copy-with-name')?.checked);
    state.copyLinksWithName = withName;

    const selectedFiles = state.files.filter((file) => state.selectedIds.has(file.id));
    const rows = selectedFiles
      .map((file) => {
        const link = getFileLink(file);
        if (!link) return '';
        // With name: tab-separated for Excel/Sheets two columns; otherwise one URL per line.
        return withName ? `${file.name || file.id}\t${link}` : link;
      })
      .filter(Boolean);

    if (!rows.length) {
      setStatus('所选文件没有可用链接。', true);
      return;
    }

    const text = rows.join('\n');
    try {
      await writeClipboardText(text);
      setStatus(withName
        ? `已复制 ${rows.length} 条（文件名 + 链接），可直接粘贴到表格。`
        : `已复制 ${rows.length} 条链接，可直接粘贴到表格。`);
    } catch (error) {
      setStatus(error.message || '复制链接失败。', true);
    }
  }

  async function writeClipboardText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Fall through to legacy copy for restricted clipboard permissions.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.padding = '0';
    textarea.style.border = '0';
    textarea.style.outline = '0';
    textarea.style.boxShadow = 'none';
    textarea.style.background = 'transparent';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      textarea.remove();
    }

    if (!ok) {
      throw new Error('浏览器拒绝访问剪贴板，请检查页面权限后重试。');
    }
  }

  function openExternal(url, fileId) {
    let target = '';
    if (policy().isSafeDriveHttpsUrl(url)) target = url;
    else if (policy().isValidDriveId(fileId)) target = `https://drive.google.com/file/d/${fileId}/view`;
    if (!target) {
      setStatus('链接无效，已取消打开。', true);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  }

  function showPreview(item, options = {}) {
    hidePreview({ force: true });
    previewPinned = Boolean(options.pinned);
    const isVideo = item.isVideo || isVideoItem(item);
    if (isVideo && !policy().isValidDriveId(item.id)) return;
    const previewSrc = policy().isSafePreviewSrc(item.previewUrl) ? item.previewUrl
      : (policy().isSafePreviewSrc(item.thumbnailUrl) ? item.thumbnailUrl : '');
    if (!isVideo && !previewSrc) return;
    const preview = document.createElement('div');
    preview.id = 'drive-image-manager-preview';
    preview.dataset.pinned = previewPinned ? '1' : '0';
    if (isVideo) {
      preview.className = 'video-preview';
      const autoplay = options.autoplay ? '?autoplay=1' : '';
      preview.innerHTML = `
        ${previewPinned ? '<button class="dim-preview-close" title="关闭预览">×</button>' : ''}
        <iframe src="https://drive.google.com/file/d/${encodeURIComponent(item.id)}/preview${autoplay}" allow="autoplay; fullscreen" allowfullscreen></iframe>
        <div>${escapeHtml(item.name)}</div>
      `;
    } else {
      preview.innerHTML = `
        <img src="${escapeHtml(previewSrc)}" alt="${escapeHtml(item.name)}">
        <div>${escapeHtml(item.name)}</div>
      `;
    }
    document.body.appendChild(preview);
    preview.querySelector('.dim-preview-close')?.addEventListener('click', () => {
      previewPinned = false;
      hidePreview({ force: true });
    });
  }

  function hidePreview(options = {}) {
    const preview = document.getElementById('drive-image-manager-preview');
    if (!preview) return;
    if (!options.force && previewPinned && preview.dataset.pinned === '1') return;
    preview.remove();
    previewPinned = false;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderUpdateBanner(updateState) {
    const el = document.getElementById('dim-update');
    if (!el) return;
    const version = String(updateState?.latestVersion || '');
    if (!updateState?.available || !/^\d+\.\d+\.\d+$/.test(version)) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    el.replaceChildren();
    const text = document.createElement('div');
    text.textContent = `发现新版本 ${version}。下载后请解压覆盖此扩展目录，并在扩展管理页重新加载。若仍使用 Apps Script，后端有变更时还需重新部署。`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '下载更新包';
    button.addEventListener('click', downloadUpdatePackage);
    el.append(text, button);
  }

  async function downloadUpdatePackage() {
    const confirmed = window.confirm('将从 GitHub 仓库 christiancagfr-alt/Google-Drive-manager 下载官方更新包。扩展不会自动覆盖安装。');
    if (!confirmed) return;
    setStatus('正在下载更新包...');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'drive-manager-download-update' });
      if (!response?.ok) throw new Error(response?.message || '下载更新失败。');
      setStatus(response.verified
        ? `已开始下载 ${response.filename || '更新包'}，校验通过。请解压覆盖后重新加载扩展。`
        : `已开始下载 ${response.filename || '更新包'}。此版本没有校验文件。请解压覆盖后重新加载扩展。`);
    } catch (error) {
      setStatus(error.message || '下载更新失败。', true);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'drive-manager-config-updated') {
      if (typeof message.appsScriptUrl === 'string') {
        const next = normalizeAppsScriptUrl(message.appsScriptUrl || '');
        if (!next || isValidAppsScriptUrl(next)) state.appsScriptUrl = next;
      }
      if (message.authMode === 'serviceAccount' || message.authMode === 'appsScript') {
        state.authMode = message.authMode;
      }
      if (typeof message.serviceAccountEmail === 'string') {
        state.serviceAccountEmail = readServiceEmail(message.serviceAccountEmail);
      }
      if (typeof message.userOauthEmail === 'string') {
        state.userOauthEmail = readUserEmail(message.userOauthEmail);
      }
      if (typeof message.userOauthReady === 'boolean') {
        state.userOauthReady = message.userOauthReady;
      }
      const ready = usingServiceAccount() ? directDriveReady() : Boolean(state.appsScriptUrl);
      setStatus(ready ? '配置已更新。请点击「加载」。' : '配置已更新。请先完成授权设置。');
      render();
    }
    if (message.type === 'drive-manager-refresh') {
      loadCurrentFolder();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.driveManagerAccessToken) {
      state.accessToken = readAccessToken(changes.driveManagerAccessToken.newValue);
    }
    if (area === 'local' && changes.authMode) {
      state.authMode = readAuthMode(changes.authMode.newValue);
      render();
    }
    if (area === 'local' && changes.serviceAccountEmail) {
      state.serviceAccountEmail = readServiceEmail(changes.serviceAccountEmail.newValue);
      render();
    }
    if (area === 'local' && changes.userOauthEmail) {
      state.userOauthEmail = readUserEmail(changes.userOauthEmail.newValue);
      render();
    }
    if (area === 'local' && changes.userOauthReady) {
      state.userOauthReady = changes.userOauthReady.newValue === true;
      if (state.userOauthReady) setStatus('Google 授权已完成。请点击「加载」。');
      render();
    }
    if (area === 'local' && changes.updateState) {
      renderUpdateBanner(changes.updateState.newValue);
    }
    if (area === 'sync' && changes[STORAGE_KEY]) {
      const next = normalizeAppsScriptUrl(changes[STORAGE_KEY].newValue || '');
      if (!next || isValidAppsScriptUrl(next)) state.appsScriptUrl = next;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
