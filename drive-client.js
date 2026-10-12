/**
 * Google Drive API client for a service-account JSON key.
 * The private key stays in the service worker. Token URL and scope are fixed
 * so a pasted key cannot redirect the signed JWT or request another scope.
 * Domain-wide delegation (JWT "sub") is intentionally unsupported.
 */
(function (root) {
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
  const DRIVE_ORIGIN = 'https://www.googleapis.com';
  const MAX_KEY_JSON_CHARS = 20000;
  const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
  const MAX_LIST_ITEMS = 1000;
  const MAX_LIST_PAGES = 8;
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const EXPORTS = {
    'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
    'application/vnd.google-apps.spreadsheet': {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ext: '.xlsx'
    },
    'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
    'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' }
  };

  let cachedToken = null;

  function policy() {
    const value = root.DriveManagerPolicy;
    if (!value || typeof value.isValidDriveId !== 'function' || typeof value.isServiceAccountEmail !== 'function') {
      throw new Error('扩展组件未加载完整，请在扩展管理页重新加载。');
    }
    return value;
  }

  function clearTokenCache() {
    cachedToken = null;
  }

  function keyFingerprint(pem) {
    let hash = 2166136261;
    const text = String(pem || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function cleanProjectId(value) {
    const id = String(value || '').trim();
    if (!id || !/^[a-z][a-z0-9-]{4,61}$/.test(id)) return '';
    return id;
  }

  function normalizePem(value) {
    let text = String(value || '').trim();
    if (text.includes('\\n')) text = text.replace(/\\n/g, '\n');
    text = text.replace(/\r\n/g, '\n');
    if (text.includes('BEGIN RSA PRIVATE KEY') || text.includes('BEGIN ENCRYPTED PRIVATE KEY')) {
      throw new Error('私钥须为 PKCS8（BEGIN PRIVATE KEY）。请使用 Google Cloud 下载的 JSON 密钥。');
    }
    const match = text.match(/^-----BEGIN PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PRIVATE KEY-----\s*$/);
    if (!match) throw new Error('私钥 PEM 格式无效。');
    const body = match[1].replace(/\n/g, '');
    if (body.length < 600 || body.length > 8000 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
      throw new Error('私钥 PEM 格式无效。');
    }
    const lines = body.match(/.{1,64}/g) || [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  }

  function storedKey(email, pem, projectId) {
    const key = {
      client_email: email,
      private_key: pem
    };
    if (projectId) key.project_id = projectId;
    return key;
  }

  function parseServiceAccountJson(text) {
    const raw = String(text || '');
    if (raw.length > MAX_KEY_JSON_CHARS) throw new Error('服务账号 JSON 过大。');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error('服务账号 JSON 无法解析。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('服务账号 JSON 无法解析。');
    }
    if (data.type !== 'service_account') {
      throw new Error('这不是服务账号密钥。请在 Google Cloud 创建服务账号并下载 JSON。');
    }
    if (data.subject || data.sub || data.delegation_subject) {
      throw new Error('此扩展不支持域范围委派，也不会模拟其他用户。请把文件夹共享给服务账号邮箱。');
    }
    const email = String(data.client_email || '').trim();
    if (!policy().isServiceAccountEmail(email)) throw new Error('服务账号邮箱无效。');
    const pem = normalizePem(data.private_key);
    return storedKey(email, pem, cleanProjectId(data.project_id));
  }

  function normalizeStoredKey(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('已保存的服务账号密钥无效，请重新导入。');
    }
    const extra = Object.keys(value).filter((key) => key !== 'client_email' && key !== 'private_key' && key !== 'project_id');
    if (extra.length) throw new Error('已保存的服务账号密钥无效，请重新导入。');
    const email = String(value.client_email || '').trim();
    if (!policy().isServiceAccountEmail(email)) throw new Error('已保存的服务账号密钥无效，请重新导入。');
    const pem = normalizePem(value.private_key);
    return storedKey(email, pem, cleanProjectId(value.project_id));
  }

  function pemToArrayBuffer(pem) {
    const b64 = String(pem).replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function base64urlBytes(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64urlJson(value) {
    return base64urlBytes(new TextEncoder().encode(JSON.stringify(value)));
  }

  async function createSignedJwt(key, nowMs) {
    const normalized = normalizeStoredKey(key);
    if (!normalized) throw new Error('服务账号密钥无效。');
    const issued = Math.floor((Number(nowMs) || Date.now()) / 1000) - 30;
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: normalized.client_email,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: issued,
      exp: issued + 3600
    };
    const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    let cryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        'pkcs8',
        pemToArrayBuffer(normalized.private_key),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );
    } catch (error) {
      throw new Error('私钥无法用于签名。请使用 Google Cloud 下载的服务账号 JSON。');
    }
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsigned)
    );
    return `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`;
  }

  function assertTokenUrl(value) {
    if (value !== TOKEN_URL) throw new Error('令牌地址无效。');
  }

  function assertApiUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      throw new Error('内部地址无效。');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('内部地址无效。');
    }
    if (url.origin !== DRIVE_ORIGIN || !url.pathname.startsWith('/drive/v3/')) {
      throw new Error('内部地址无效。');
    }
    return url;
  }

  function isAllowedMediaRedirect(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
      const host = url.hostname.toLowerCase();
      if (host === 'www.googleapis.com') {
        return url.pathname.startsWith('/drive/') || url.pathname.startsWith('/download/');
      }
      return host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
    } catch (error) {
      return false;
    }
  }

  function mapStatus(status, reason) {
    if (status === 401) return '服务账号密钥无效、已过期或已被作废。请在 Google Cloud 删除该密钥并重新导入。';
    if (status === 403) {
      if (reason === 'storageQuotaExceeded') return '服务账号的云端硬盘空间已满。';
      if (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded' || reason === 'sharingRateLimitExceeded') {
        return '请求过于频繁，请稍后再试。';
      }
      if (reason === 'dailyLimitExceeded') return '今日云端硬盘接口配额已用完。';
      return '没有权限。请把目标文件夹共享给服务账号邮箱，权限选「编辑者」。未共享的个人云端硬盘，服务账号看不到。';
    }
    if (status === 404) return '找不到该文件或文件夹，或服务账号无权看到它。';
    return `云端硬盘请求失败（HTTP ${status}）。`;
  }

  async function toDriveError(response) {
    let reason = '';
    try {
      const text = await response.text();
      if (text && text.length < 4000) {
        const payload = JSON.parse(text);
        const raw = String(payload?.error?.errors?.[0]?.reason || payload?.error?.status || '');
        if (/^[A-Za-z0-9]{1,60}$/.test(raw)) reason = raw;
      }
    } catch (error) {
      reason = '';
    }
    const failure = new Error(mapStatus(response.status, reason));
    failure.status = response.status;
    return failure;
  }

  async function driveJson(url, token, options) {
    assertApiUrl(url);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options?.body != null) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(url, {
        method: options?.method || 'GET',
        headers,
        body: options?.body,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      if (/redirect/i.test(String(error?.message || ''))) throw new Error('云端硬盘接口返回了跳转，已中止。');
      throw new Error('无法连接 Google Drive API。请检查网络，并在扩展管理页重新加载扩展。');
    }
    if (!response.ok) throw await toDriveError(response);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('云端硬盘响应过大。');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error('云端硬盘没有返回 JSON。');
    }
  }

  async function readLimitedBytes(response) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new Error('文件超过 30MB，请在云端硬盘页面直接下载。');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('文件超过 30MB，请在云端硬盘页面直接下载。');
    }
    return new Uint8Array(buffer);
  }

  async function driveBytes(url, token) {
    assertApiUrl(url);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error('无法下载文件。请检查网络后重试。');
    }
    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new Error('无法确认下载跳转的目标，已中止。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location') || '';
      if (!isAllowedMediaRedirect(location)) throw new Error('下载跳转到了不允许的地址，已中止。');
      let next;
      try {
        next = await fetch(location, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store'
        });
      } catch (error) {
        throw new Error('下载跳转失败，已中止。');
      }
      if (!next.ok) {
        if (next.status === 403 || next.status === 404) throw await toDriveError(next);
        throw new Error('下载文件失败。');
      }
      return readLimitedBytes(next);
    }
    if (!response.ok) throw await toDriveError(response);
    return readLimitedBytes(response);
  }

  function endpoint(pathname, params) {
    const url = new URL(DRIVE_ORIGIN + pathname);
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  function driveFilesEndpoint(params) {
    return endpoint('/drive/v3/files', params);
  }

  function driveFileEndpoint(id, params) {
    if (id !== 'root' && !policy().isValidDriveId(id)) throw new Error('文件 ID 无效。');
    return endpoint(`/drive/v3/files/${encodeURIComponent(id)}`, params);
  }

  async function getAccessToken(key, force) {
    const now = Date.now();
    const fingerprint = keyFingerprint(key.private_key);
    if (!force && cachedToken && cachedToken.email === key.client_email && cachedToken.fingerprint === fingerprint && cachedToken.expMs - 60000 > now) {
      return cachedToken.token;
    }
    assertTokenUrl(TOKEN_URL);
    const assertion = await createSignedJwt(key, now);
    const body = new URLSearchParams();
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    body.set('assertion', assertion);
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      clearTokenCache();
      if (/redirect/i.test(String(error?.message || ''))) throw new Error('令牌接口返回了跳转，已中止。');
      throw new Error('无法连接 Google 令牌接口。请检查网络。');
    }
    if (!response.ok) {
      clearTokenCache();
      throw new Error('服务账号密钥无效、本机时钟偏差过大，或该密钥已被作废。请在 Google Cloud 检查密钥。');
    }
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch (error) {
      throw new Error('令牌接口没有返回 JSON。');
    }
    const accessToken = data && typeof data.access_token === 'string' ? data.access_token : '';
    if (accessToken.length < 20 || accessToken.length > 4096 || !/^[\x21-\x7e]+$/.test(accessToken)) {
      throw new Error('令牌接口没有返回可用的访问令牌。');
    }
    const expiresIn = Number(data.expires_in);
    const seconds = Number.isFinite(expiresIn) ? Math.min(Math.max(expiresIn, 60), 3600) : 3600;
    cachedToken = {
      email: key.client_email,
      fingerprint,
      token: accessToken,
      expMs: Date.now() + seconds * 1000
    };
    return accessToken;
  }

  async function callWithToken(key, fn) {
    try {
      return await fn(await getAccessToken(key, false));
    } catch (error) {
      if (!error || error.status !== 401) throw error;
      clearTokenCache();
      return fn(await getAccessToken(key, true));
    }
  }

  function safePageToken(value) {
    const token = String(value || '');
    if (!token) return '';
    if (token.length > 2048 || !/^[-A-Za-z0-9._~+/=]+$/.test(token)) throw new Error('分页数据异常。');
    return token;
  }

  function safeHttps(value) {
    const text = String(value || '').trim();
    return policy().isSafeDriveHttpsUrl(text) ? text : '';
  }

  function displayName(name, id) {
    const text = String(name || id || 'file').split(/[/\\]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
    return (text || id || 'file').slice(0, 180);
  }

  async function listChildren(folderId, token, mimeClause) {
    const collected = [];
    let pageToken = '';
    let truncated = false;
    const query = [`'${folderId}' in parents`, 'trashed = false'];
    if (mimeClause) query.push(mimeClause);
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const data = await driveJson(driveFilesEndpoint({
        q: query.join(' and '),
        fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,thumbnailLink,parents)',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        pageToken
      }), token);
      const batch = Array.isArray(data.files) ? data.files : [];
      for (let i = 0; i < batch.length; i += 1) {
        if (collected.length >= MAX_LIST_ITEMS) {
          truncated = true;
          break;
        }
        collected.push(batch[i]);
      }
      const next = safePageToken(data.nextPageToken);
      if (truncated || !next) {
        if (next) truncated = true;
        pageToken = '';
        break;
      }
      pageToken = next;
    }
    if (pageToken) truncated = true;
    return { files: collected, truncated };
  }

  async function resolveFolder(folderId, token) {
    const id = folderId ? String(folderId) : 'root';
    if (id !== 'root' && !policy().isValidDriveId(id)) throw new Error('文件夹 ID 无效。');
    const folder = await driveJson(driveFileEndpoint(id, {
      fields: 'id,name,mimeType',
      supportsAllDrives: 'true'
    }), token);
    if (folder.mimeType && folder.mimeType !== FOLDER_MIME) throw new Error('这不是文件夹。');
    if (!policy().isValidDriveId(folder.id)) throw new Error('文件夹 ID 无效。');
    return {
      id: folder.id,
      name: displayName(folder.name, folder.id)
    };
  }

  function mapFile(file) {
    const id = String(file?.id || '');
    if (!policy().isValidDriveId(id)) return null;
    const mimeType = String(file.mimeType || '');
    const name = displayName(file.name, id);
    if (mimeType === FOLDER_MIME) return { kind: 'folder', id, name };
    const isImage = mimeType.startsWith('image/');
    const isVideo = mimeType.startsWith('video/');
    const thumb = (isImage || isVideo) ? safeHttps(file.thumbnailLink) : '';
    const link = safeHttps(file.webViewLink) || `https://drive.google.com/file/d/${id}/view`;
    return {
      kind: 'file',
      id,
      name,
      mimeType,
      isImage,
      isVideo,
      size: Number(file.size || 0) || 0,
      webViewLink: link,
      thumbnailUrl: thumb,
      previewUrl: thumb
    };
  }

  async function listFolder(folderId, token) {
    const folder = await resolveFolder(folderId || '', token);
    const listed = await listChildren(folder.id, token, '');
    const files = [];
    const folders = [];
    listed.files.forEach((item) => {
      const mapped = mapFile(item);
      if (!mapped) return;
      if (mapped.kind === 'folder') folders.push({ id: mapped.id, name: mapped.name });
      else files.push(mapped);
    });
    folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return {
      ok: true,
      folder,
      files,
      folders,
      truncated: listed.truncated
    };
  }

  function parseIds(fileIds) {
    const parts = String(fileIds || '').split(',');
    if (parts.length > policy().MAX_FILES) throw new Error('一次最多处理 50 个文件。');
    const ids = [];
    const seen = new Set();
    parts.forEach((part) => {
      const id = String(part || '').trim();
      if (!id || seen.has(id)) return;
      if (!policy().isValidDriveId(id)) throw new Error('文件 ID 无效。');
      seen.add(id);
      ids.push(id);
    });
    if (!ids.length) throw new Error('未选择文件。');
    if (ids.length > policy().MAX_FILES) throw new Error('一次最多处理 50 个文件。');
    return ids;
  }

  function parseNames(namesValue) {
    const parts = String(namesValue || '').split(/[\n,;]+/);
    if (parts.length > 50) throw new Error('一次最多创建 50 个文件夹。');
    const names = [];
    const seen = new Set();
    parts.forEach((part) => {
      const name = String(part || '').trim();
      if (!name || seen.has(name)) return;
      if (name.length > 120) throw new Error('文件夹名称过长。');
      if (/[\u0000-\u001f\\/]/.test(name)) throw new Error('文件夹名称包含不可用字符。');
      seen.add(name);
      names.push(name);
    });
    if (!names.length) throw new Error('未提供文件夹名称。');
    if (names.length > 50) throw new Error('一次最多创建 50 个文件夹。');
    return names;
  }

  async function moveOne(id, destinationId, token, knownParents) {
    let parents = Array.isArray(knownParents)
      ? knownParents.filter((item) => policy().isValidDriveId(item) && item !== destinationId)
      : null;
    if (!parents) {
      const meta = await driveJson(driveFileEndpoint(id, {
        fields: 'id,parents',
        supportsAllDrives: 'true'
      }), token);
      parents = Array.isArray(meta.parents)
        ? meta.parents.filter((item) => policy().isValidDriveId(item) && item !== destinationId)
        : [];
    }
    await driveJson(driveFileEndpoint(id, {
      addParents: destinationId,
      removeParents: parents.length ? parents.join(',') : '',
      supportsAllDrives: 'true',
      fields: 'id'
    }), token, { method: 'PATCH', body: '{}' });
  }

  async function moveFiles(fileIds, destinationFolderId, token) {
    const ids = parseIds(fileIds);
    if (!policy().isValidDriveId(destinationFolderId)) throw new Error('缺少目标文件夹 ID。');
    const destination = await resolveFolder(destinationFolderId, token);
    for (let i = 0; i < ids.length; i += 1) {
      await moveOne(ids[i], destination.id, token, null);
    }
    return { ok: true, moved: ids.length, folderName: destination.name };
  }

  async function trashFiles(fileIds, token) {
    const ids = parseIds(fileIds);
    let trashed = 0;
    const failed = [];
    for (let i = 0; i < ids.length; i += 1) {
      try {
        await driveJson(driveFileEndpoint(ids[i], { supportsAllDrives: 'true' }), token, {
          method: 'PATCH',
          body: JSON.stringify({ trashed: true })
        });
        trashed += 1;
      } catch (error) {
        if (error && error.status === 401) throw error;
        failed.push(ids[i]);
      }
    }
    if (!trashed) {
      return {
        ok: false,
        message: '没有文件被移入回收站。请确认这些文件还未删除，并且服务账号对该文件夹有编辑权限。',
        trashed: 0,
        failed: failed.length
      };
    }
    return {
      ok: true,
      trashed,
      failed: failed.length,
      failures: failed.slice(0, 10)
    };
  }

  async function createFolders(parentFolderId, namesValue, token) {
    const names = parseNames(namesValue);
    const parent = await resolveFolder(parentFolderId || '', token);
    const folders = [];
    for (let i = 0; i < names.length; i += 1) {
      const created = await driveJson(driveFilesEndpoint({
        supportsAllDrives: 'true',
        fields: 'id,name,webViewLink'
      }), token, {
        method: 'POST',
        body: JSON.stringify({
          name: names[i],
          mimeType: FOLDER_MIME,
          parents: [parent.id]
        })
      });
      if (!policy().isValidDriveId(created.id)) throw new Error('新建文件夹的 ID 无效。');
      const item = { id: created.id, name: displayName(created.name, created.id) };
      const url = safeHttps(created.webViewLink);
      if (url) item.url = url;
      folders.push(item);
    }
    return {
      ok: true,
      created: folders.length,
      parentFolder: parent,
      folders
    };
  }

  function getCategoryName(fileName) {
    const baseName = String(fileName || '')
      .replace(/\.[^.]+$/, '')
      .replace(/^\s*\d{1,8}\s*[-_. ]+\s*/, '')
      .trim();
    if (!baseName) return '';
    const parts = baseName
      .split(/\s*[-_]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
    if (parts.length === 1) return parts[0];
    return '';
  }

  function cleanFolderName(name) {
    return String(name || '').replace(/[\u0000-\u001f\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function clampMinGroup(value) {
    const parsed = Number(value || 2);
    if (!Number.isFinite(parsed)) return 2;
    return Math.max(2, Math.min(1000, Math.floor(parsed)));
  }

  async function autoClassify(folderId, minGroupSize, token) {
    const folder = await resolveFolder(folderId || '', token);
    const minimum = clampMinGroup(minGroupSize);
    const listedFiles = await listChildren(folder.id, token, `mimeType != '${FOLDER_MIME}'`);
    const listedFolders = await listChildren(folder.id, token, `mimeType = '${FOLDER_MIME}'`);
    if (listedFiles.truncated || listedFolders.truncated) {
      throw new Error('文件夹内项目超过 1000 个，已停止自动分类。请分成更小的文件夹后再试。');
    }
    const groups = new Map();
    let seen = 0;
    listedFiles.files.forEach((file) => {
      const mapped = mapFile(file);
      if (!mapped || mapped.kind === 'folder') return;
      seen += 1;
      const category = cleanFolderName(getCategoryName(mapped.name));
      if (!category) return;
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push({
        id: mapped.id,
        parents: Array.isArray(file.parents) ? file.parents : null
      });
    });
    const existing = new Map();
    listedFolders.files.forEach((item) => {
      const mapped = mapFile(item);
      if (!mapped || mapped.kind !== 'folder' || existing.has(mapped.name)) return;
      existing.set(mapped.name, mapped.id);
    });
    const results = [];
    let moved = 0;
    let createdFolders = 0;
    const categories = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'zh'));
    for (let i = 0; i < categories.length; i += 1) {
      const category = categories[i];
      const items = groups.get(category);
      if (!items || items.length < minimum) continue;
      let targetId = existing.get(category) || '';
      let created = false;
      if (!targetId) {
        const createdFolder = await driveJson(driveFilesEndpoint({
          supportsAllDrives: 'true',
          fields: 'id,name'
        }), token, {
          method: 'POST',
          body: JSON.stringify({
            name: category,
            mimeType: FOLDER_MIME,
            parents: [folder.id]
          })
        });
        if (!policy().isValidDriveId(createdFolder.id)) throw new Error('新建分类文件夹的 ID 无效。');
        targetId = createdFolder.id;
        existing.set(category, targetId);
        created = true;
        createdFolders += 1;
      }
      for (let n = 0; n < items.length; n += 1) {
        await moveOne(items[n].id, targetId, token, items[n].parents);
        moved += 1;
      }
      results.push({
        category,
        folderId: targetId,
        folderName: category,
        created,
        moved: items.length
      });
    }
    return {
      ok: true,
      folder,
      groups: results.length,
      createdFolders,
      moved,
      skipped: seen - moved,
      results
    };
  }

  async function downloadOne(id, token) {
    const meta = await driveJson(driveFileEndpoint(id, {
      fields: 'id,name,mimeType,size',
      supportsAllDrives: 'true'
    }), token);
    const mimeType = String(meta.mimeType || '');
    const name = displayName(meta.name, id);
    if (mimeType === FOLDER_MIME) throw new Error('文件夹不能下载。');
    const declared = Number(meta.size || 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件超过 30MB，请在云端硬盘页面直接下载：${name.slice(0, 80)}`);
    }
    const exported = EXPORTS[mimeType];
    if (!exported && mimeType.startsWith('application/vnd.google-apps.')) {
      throw new Error('此 Google 在线文件不能直接下载。');
    }
    let bytes;
    let outMime;
    let outName;
    if (exported) {
      bytes = await driveBytes(endpoint(`/drive/v3/files/${encodeURIComponent(id)}/export`, {
        mimeType: exported.mime,
        supportsAllDrives: 'true'
      }), token);
      outMime = exported.mime;
      outName = name.toLowerCase().endsWith(exported.ext) ? name : `${name}${exported.ext}`.slice(0, 180);
    } else {
      bytes = await driveBytes(driveFileEndpoint(id, {
        alt: 'media',
        supportsAllDrives: 'true'
      }), token);
      outMime = mimeType || 'application/octet-stream';
      outName = name;
    }
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(outMime)) {
      outMime = 'application/octet-stream';
    }
    return { id, name: outName, mimeType: outMime, bytes };
  }

  function safeZipEntryName(name, id) {
    let base = String(name || id || 'file').split(/[/\\]/).pop() || '';
    base = base.replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '').trim();
    if (!base) base = String(id || 'file');
    return base.slice(0, 180);
  }

  function uniqueZipName(name, id, used) {
    let base = safeZipEntryName(name, id);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const suffix = `-${String(id || 'dup').replace(/[^\w-]/g, '').slice(0, 12) || 'dup'}`;
    const dot = base.lastIndexOf('.');
    let next = (dot > 0 ? base.slice(0, dot) + suffix + base.slice(dot) : base + suffix).slice(0, 180);
    if (used.has(next)) next = `${base.slice(0, 40)}${suffix}-${used.size}`.slice(0, 180);
    used.add(next);
    return next;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    let year = d.getFullYear();
    if (year < 1980) year = 1980;
    if (year > 2107) year = 2107;
    return {
      time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
      date: ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
    };
  }

  function pushU16(parts, value) {
    parts.push(value & 0xff, (value >>> 8) & 0xff);
  }

  function pushU32(parts, value) {
    const n = value >>> 0;
    parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  function concatParts(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  function buildStoredZip(entries, nowDate) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('没有可打包的文件。');
    if (entries.length > policy().MAX_FILES) throw new Error('一次最多处理 50 个文件。');
    const dos = dosDateTime(nowDate);
    const used = new Set();
    const chunks = [];
    const central = [];
    let offset = 0;
    entries.forEach((entry) => {
      const name = uniqueZipName(entry.name, entry.id, used);
      const nameBytes = new TextEncoder().encode(name);
      if (nameBytes.length > 200) throw new Error('压缩条目名过长。');
      const data = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes || []);
      if (data.length > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 30MB，请在云端硬盘页面直接下载。');
      const crc = crc32(data);
      const local = [];
      pushU32(local, 0x04034b50);
      pushU16(local, 20);
      pushU16(local, 0x0800);
      pushU16(local, 0);
      pushU16(local, dos.time);
      pushU16(local, dos.date);
      pushU32(local, crc);
      pushU32(local, data.length);
      pushU32(local, data.length);
      pushU16(local, nameBytes.length);
      pushU16(local, 0);
      const localBytes = new Uint8Array(local.length + nameBytes.length + data.length);
      localBytes.set(local, 0);
      localBytes.set(nameBytes, local.length);
      localBytes.set(data, local.length + nameBytes.length);
      const centralBytes = [];
      pushU32(centralBytes, 0x02014b50);
      pushU16(centralBytes, 20);
      pushU16(centralBytes, 20);
      pushU16(centralBytes, 0x0800);
      pushU16(centralBytes, 0);
      pushU16(centralBytes, dos.time);
      pushU16(centralBytes, dos.date);
      pushU32(centralBytes, crc);
      pushU32(centralBytes, data.length);
      pushU32(centralBytes, data.length);
      pushU16(centralBytes, nameBytes.length);
      pushU16(centralBytes, 0);
      pushU16(centralBytes, 0);
      pushU16(centralBytes, 0);
      pushU16(centralBytes, 0);
      pushU32(centralBytes, 0);
      pushU32(centralBytes, offset);
      const centralPart = new Uint8Array(centralBytes.length + nameBytes.length);
      centralPart.set(centralBytes, 0);
      centralPart.set(nameBytes, centralBytes.length);
      chunks.push(localBytes);
      central.push(centralPart);
      offset += localBytes.length;
    });
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const eocd = [];
    pushU32(eocd, 0x06054b50);
    pushU16(eocd, 0);
    pushU16(eocd, 0);
    pushU16(eocd, entries.length);
    pushU16(eocd, entries.length);
    pushU32(eocd, centralSize);
    pushU32(eocd, offset);
    pushU16(eocd, 0);
    return concatParts(chunks.concat(central, [new Uint8Array(eocd)]));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function formatStamp(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  async function downloadFiles(fileIds, token) {
    const ids = parseIds(fileIds);
    const parts = [];
    let total = 0;
    for (let i = 0; i < ids.length; i += 1) {
      const part = await downloadOne(ids[i], token);
      total += part.bytes.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error('所选文件合计超过 30MB。请减少数量，或在云端硬盘页面直接下载。');
      }
      parts.push(part);
    }
    if (parts.length === 1) {
      return {
        ok: true,
        name: parts[0].name,
        mimeType: parts[0].mimeType,
        data: bytesToBase64(parts[0].bytes)
      };
    }
    const zipped = buildStoredZip(parts.map((part) => ({
      name: part.name,
      id: part.id,
      bytes: part.bytes
    })));
    return {
      ok: true,
      name: `drive-files-${formatStamp(new Date())}.zip`,
      mimeType: 'application/zip',
      data: bytesToBase64(zipped)
    };
  }

  async function testConnection(key) {
    const normalized = normalizeStoredKey(key);
    if (!normalized) throw new Error('尚未导入服务账号密钥。');
    return callWithToken(normalized, async (token) => {
      const about = await driveJson(endpoint('/drive/v3/about', {
        fields: 'user(emailAddress,displayName)'
      }), token);
      const reported = String(about?.user?.emailAddress || '');
      const email = policy().isServiceAccountEmail(reported) ? reported : normalized.client_email;
      return {
        ok: true,
        email,
        message: `服务账号可用：${email}。请把要管理的文件夹共享给这个邮箱，权限选「编辑者」。`
      };
    });
  }

  async function runAction(body, token) {
    const action = String(body?.action || '');
    if (action === 'list') return listFolder(body.folderId || '', token);
    if (action === 'move') return moveFiles(body.fileIds, body.destinationFolderId, token);
    if (action === 'download') return downloadFiles(body.fileIds, token);
    if (action === 'createFolders') return createFolders(body.parentFolderId || body.folderId || '', body.names, token);
    if (action === 'autoClassify') return autoClassify(body.folderId || body.parentFolderId || '', body.minGroupSize, token);
    if (action === 'delete') return trashFiles(body.fileIds, token);
    throw new Error('不支持的操作。');
  }

  async function execute(body, key) {
    const normalized = normalizeStoredKey(key);
    if (!normalized) throw new Error('尚未导入服务账号密钥。请在扩展弹窗导入 JSON 密钥。');
    return callWithToken(normalized, (token) => runAction(body, token));
  }

  async function executeWithAccessToken(body, accessToken) {
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096 || !/^[\x21-\x7e]+$/.test(accessToken)) {
      throw new Error('尚未完成 Google 授权。请在扩展弹窗点「授权」。');
    }
    return runAction(body, accessToken);
  }

  const USER_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

  function parseAuthFile(text) {
    const raw = String(text || '');
    if (raw.length > MAX_KEY_JSON_CHARS) throw new Error('授权文件过大。');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error('授权文件无法解析。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('授权文件无法解析。');
    if (data.type === 'service_account') {
      return { kind: 'serviceAccount', key: parseServiceAccountJson(raw) };
    }
    const block = data.installed || data.web;
    if (block && typeof block === 'object') {
      const clientId = String(block.client_id || '').trim();
      if (!policy().isOauthClientId(clientId)) throw new Error('OAuth 客户端 ID 无效。');
      const clientSecret = String(block.client_secret || '').trim();
      if (clientSecret && (clientSecret.length > 200 || !/^[\x21-\x7e]+$/.test(clientSecret))) {
        throw new Error('OAuth 客户端密钥无效。');
      }
      return { kind: 'oauthClient', clientId, clientSecret };
    }
    throw new Error('请选择服务账号 JSON，或 Google Cloud 下载的 OAuth 客户端 JSON。');
  }

  async function createPkce() {
    const verifier = base64urlBytes(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return {
      verifier,
      challenge: base64urlBytes(new Uint8Array(digest)),
      state: base64urlBytes(crypto.getRandomValues(new Uint8Array(24)))
    };
  }

  function buildUserAuthUrl(options) {
    const clientId = String(options?.clientId || '').trim();
    const redirectUri = String(options?.redirectUri || '');
    const state = String(options?.state || '');
    const codeChallenge = String(options?.codeChallenge || '');
    if (!policy().isOauthClientId(clientId)) throw new Error('OAuth 客户端 ID 无效。');
    if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(redirectUri)) throw new Error('授权回调地址无效。');
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(state) || !/^[A-Za-z0-9_-]{20,200}$/.test(codeChallenge)) {
      throw new Error('授权参数无效。');
    }
    const url = new URL(USER_AUTH_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', DRIVE_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    if (`${url.origin}${url.pathname}` !== USER_AUTH_URL) throw new Error('授权地址无效。');
    return url.toString();
  }

  function readAuthCode(responseUrl, expectedState, redirectUri) {
    let url;
    try {
      url = new URL(String(responseUrl || ''));
    } catch (error) {
      throw new Error('授权回调无效，已中止。');
    }
    const expected = new URL(redirectUri);
    if (url.protocol !== 'https:' || url.hostname !== expected.hostname || url.username || url.password) {
      throw new Error('授权回调地址不匹配，已中止。');
    }
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const errorCode = url.searchParams.get('error') || hash.get('error') || '';
    if (errorCode === 'access_denied') throw new Error('你取消了 Google 授权。');
    if (errorCode) throw new Error('Google 授权没有完成。');
    const state = url.searchParams.get('state') || hash.get('state') || '';
    if (!state || state !== expectedState) throw new Error('授权校验失败，请再点一次「授权」。');
    const code = url.searchParams.get('code') || hash.get('code') || '';
    if (!/^[\x21-\x7e]{8,512}$/.test(code)) throw new Error('授权没有返回可用的代码。');
    return code;
  }

  async function postToken(fields) {
    assertTokenUrl(TOKEN_URL);
    const body = new URLSearchParams();
    Object.keys(fields).forEach((key) => {
      if (fields[key]) body.set(key, String(fields[key]));
    });
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      if (/redirect/i.test(String(error?.message || ''))) throw new Error('令牌接口返回了跳转，已中止。');
      throw new Error('无法连接 Google 授权接口。');
    }
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch (error) {
      throw new Error('授权接口没有返回 JSON。');
    }
    if (!response.ok) {
      const code = String(data?.error || '');
      if (code === 'redirect_uri_mismatch') {
        throw new Error('授权回调未登记。请在 Google Cloud 使用「网页应用」客户端，并把授权窗口里的回调地址原样加到已获授权的重定向 URI。');
      }
      if (code === 'invalid_client') throw new Error('OAuth 客户端 ID 无效。');
      throw new Error('Google 授权失败。请再点一次「授权」。');
    }
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    if (accessToken.length < 20 || accessToken.length > 4096 || !/^[\x21-\x7e]+$/.test(accessToken)) {
      throw new Error('授权没有返回可用的访问令牌。');
    }
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
    if (refreshToken && (refreshToken.length > 512 || !/^[\x21-\x7e]+$/.test(refreshToken))) {
      throw new Error('授权没有返回可用的刷新令牌。');
    }
    const expiresIn = Number(data.expires_in);
    return {
      accessToken,
      refreshToken,
      expiresIn: Number.isFinite(expiresIn) ? Math.min(Math.max(expiresIn, 60), 3600) : 3600
    };
  }

  function assertOauthClient(clientId, redirectUri) {
    if (!policy().isOauthClientId(clientId)) throw new Error('OAuth 客户端 ID 无效。');
    if (redirectUri && !/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(redirectUri)) {
      throw new Error('授权回调地址无效。');
    }
  }

  async function exchangeUserAuthCode(options) {
    assertOauthClient(options.clientId, options.redirectUri);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(options.codeVerifier || ''))) throw new Error('授权参数无效。');
    if (!/^[\x21-\x7e]{8,512}$/.test(String(options.code || ''))) throw new Error('授权代码无效。');
    return postToken({
      client_id: options.clientId,
      client_secret: options.clientSecret || '',
      code: options.code,
      code_verifier: options.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: options.redirectUri
    });
  }

  async function refreshUserAccessToken(options) {
    assertOauthClient(options.clientId, '');
    if (!/^[\x21-\x7e]{8,512}$/.test(String(options.refreshToken || ''))) {
      throw new Error('Google 授权已失效，请再点一次「授权」。');
    }
    return postToken({
      client_id: options.clientId,
      client_secret: options.clientSecret || '',
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken
    });
  }

  async function aboutWithToken(token) {
    const about = await driveJson(endpoint('/drive/v3/about', {
      fields: 'user(emailAddress)'
    }), token);
    const email = String(about?.user?.emailAddress || '').trim();
    if (!/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(email) || email.includes('..')) return '';
    return email;
  }

  const api = {
    DRIVE_SCOPE,
    TOKEN_URL,
    aboutWithToken,
    buildStoredZip,
    buildUserAuthUrl,
    clearTokenCache,
    createPkce,
    createSignedJwt,
    exchangeUserAuthCode,
    execute,
    executeWithAccessToken,
    getCategoryName,
    normalizeStoredKey,
    parseAuthFile,
    parseServiceAccountJson,
    readAuthCode,
    refreshUserAccessToken,
    safeZipEntryName,
    testConnection
  };

  root.DriveManagerDriveClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
