/**
 * Pure allowlists for the extension service worker, popup, and Drive panel.
 * No I/O. Keep this file free of chrome.* so it can be tested in Node.
 */
(function (root) {
  const DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;
  const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
  const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;
  const GITHUB_TOKEN_RE = /^(?:github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{20,255})$/;
  const UPDATE_OWNER = 'christiancagfr-alt';
  const UPDATE_REPO = 'Google-Drive-manager';
  const UPDATE_API = 'https://api.github.com/repos/christiancagfr-alt/Google-Drive-manager/releases/latest';
  const MAX_DATA_URL_CHARS = 48 * 1024 * 1024;
  const MAX_FILES = 50;
  const CDN_HOSTS = {
    'release-assets.githubusercontent.com': true,
    'objects.githubusercontent.com': true,
    'github-releases.githubusercontent.com': true
  };
  const MUTATIONS = {
    list: ['folderId', 'token'],
    move: ['fileIds', 'destinationFolderId', 'token'],
    download: ['fileIds', 'token'],
    createFolders: ['parentFolderId', 'folderId', 'names', 'token'],
    autoClassify: ['folderId', 'parentFolderId', 'minGroupSize', 'token'],
    delete: ['fileIds', 'token']
  };

  function isValidDriveId(value) {
    return DRIVE_ID_RE.test(String(value || '').trim());
  }

  function isAccessToken(value) {
    return ACCESS_TOKEN_RE.test(String(value || '').trim());
  }

  function isGithubToken(value) {
    return GITHUB_TOKEN_RE.test(String(value || '').trim());
  }

  function isServiceAccountEmail(value) {
    const email = String(value || '').trim();
    if (email.length < 8 || email.length > 200) return false;
    if (!/^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9][a-z0-9.-]{0,180}\.gserviceaccount\.com$/i.test(email)) return false;
    return !email.includes('..') && !email.includes('.@') && !email.includes('@.') && !email.includes('-.');
  }

  function isOauthClientId(value) {
    return /^[0-9]{6,30}-[a-z0-9_-]{6,80}\.apps\.googleusercontent\.com$/i.test(String(value || '').trim());
  }

  function parseVersion(value) {
    const match = VERSION_RE.exec(String(value || '').trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
  }

  function bareAppsScriptUrl(value) {
    const url = new URL(String(value || '').trim());
    url.search = '';
    url.hash = '';
    return url;
  }

  function isAppsScriptExecUrl(value) {
    try {
      const url = bareAppsScriptUrl(value);
      if (url.protocol !== 'https:') return false;
      if (url.username || url.password) return false;
      if (url.hostname !== 'script.google.com') return false;
      return /^\/(?:a\/macros\/[^/]+\/s|macros\/s)\/[^/]+\/(?:exec|dev)$/i.test(url.pathname);
    } catch (error) {
      return false;
    }
  }

  function isAllowedApiRequestUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (!isAppsScriptExecUrl(url.origin + url.pathname)) return false;
      if (url.username || url.password || url.hash) return false;
      for (const key of url.searchParams.keys()) {
        if (key !== 'action') return false;
      }
      const action = url.searchParams.get('action');
      return !action || action === 'ping' || action === 'health' || action === 'auth';
    } catch (error) {
      return false;
    }
  }

  function isAllowedTestUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (!isAllowedApiRequestUrl(url.toString())) return false;
      const action = url.searchParams.get('action');
      return action === 'ping' || action === 'health' || action === 'auth';
    } catch (error) {
      return false;
    }
  }

  function isAllowedApiFinalUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:') return false;
      if (url.username || url.password) return false;
      return url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com';
    } catch (error) {
      return false;
    }
  }

  function isSafeDriveHttpsUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:') return false;
      if (url.username || url.password) return false;
      const host = url.hostname.toLowerCase();
      if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'sheets.google.com') return true;
      return host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
    } catch (error) {
      return false;
    }
  }

  function isSafePreviewSrc(value) {
    const text = String(value || '');
    if (!text) return false;
    if (isSafeDriveHttpsUrl(text)) return true;
    if (text.length > 8 * 1024 * 1024) return false;
    return /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=\r\n]+$/i.test(text);
  }

  function sanitizeDownloadFilename(name) {
    const base = String(name || 'drive-files.zip').split(/[/\\]/).pop() || 'drive-files.zip';
    const cleaned = base
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[^\w.\- ()\u4e00-\u9fff]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 180);
    return cleaned || 'drive-files.zip';
  }

  function isSafeDataDownloadUrl(value) {
    if (typeof value !== 'string' || value.length < 16 || value.length > MAX_DATA_URL_CHARS) return false;
    return /^data:[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*;base64,[a-z0-9+/]+=*$/i.test(value);
  }

  function sanitizeApiBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('请求无效。');
    }
    const action = String(body.action || '');
    const fields = MUTATIONS[action];
    if (!fields) throw new Error('不支持的操作。');

    const out = { action };
    fields.forEach((key) => {
      if (body[key] === undefined || body[key] === null || body[key] === '') return;
      const text = String(body[key]);
      const max = key === 'names' ? 8000 : key === 'token' ? 200 : 4000;
      if (text.length > max) throw new Error('请求过大。');
      if (key === 'token' && !isAccessToken(text)) throw new Error('访问口令无效。');
      out[key] = text;
    });

    if (out.fileIds) {
      const ids = out.fileIds.split(',').map((id) => id.trim()).filter(Boolean);
      if (!ids.length) throw new Error('未选择文件。');
      if (ids.length > MAX_FILES) throw new Error('一次最多处理 50 个文件。');
      ids.forEach((id) => {
        if (!isValidDriveId(id)) throw new Error('文件 ID 无效。');
      });
      out.fileIds = ids.join(',');
    }

    ['folderId', 'destinationFolderId', 'parentFolderId'].forEach((key) => {
      if (!out[key]) return;
      const id = out[key].trim();
      if (!isValidDriveId(id)) throw new Error('文件夹 ID 无效。');
      out[key] = id;
    });

    if (out.minGroupSize && !/^\d{1,4}$/.test(out.minGroupSize.trim())) {
      throw new Error('分类参数无效。');
    }

    return out;
  }

  function releaseAssetName(version) {
    const parsed = parseVersion(version);
    if (!parsed) return '';
    return `google-drive-manager-v${parsed.join('.')}.zip`;
  }

  function officialAssetUrl(version, filename) {
    const parsed = parseVersion(version);
    const name = String(filename || '');
    if (!parsed) return '';
    const cleanVersion = parsed.join('.');
    const expectedName = `google-drive-manager-v${cleanVersion}.zip`;
    if (name !== expectedName && name !== `${expectedName}.sha256`) return '';
    return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v${cleanVersion}/${name}`;
  }

  function isOfficialAssetUrl(value, version, filename) {
    const expected = officialAssetUrl(version, filename);
    return Boolean(expected) && String(value || '') === expected;
  }

  function officialAssetApiUrl(assetId) {
    const id = String(assetId || '');
    if (!/^[0-9]{1,18}$/.test(id)) return '';
    return `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/assets/${id}`;
  }

  function isAllowedUpdateFetchUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      if (url.origin + url.pathname === UPDATE_API) {
        return !url.search && !url.hash;
      }
      if (url.hostname === 'github.com') {
        return url.pathname.startsWith(`/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/`)
          || url.pathname.startsWith(`/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/`);
      }
      if (url.hostname === 'api.github.com') {
        return new RegExp(`^/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/assets/[0-9]{1,18}$`).test(url.pathname);
      }
      return Boolean(CDN_HOSTS[url.hostname]);
    } catch (error) {
      return false;
    }
  }

  function officialReleasePage(version) {
    const parsed = parseVersion(version);
    if (!parsed) return '';
    return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/v${parsed.join('.')}`;
  }

  function normalizeSha256(text) {
    const field = String(text || '').trim().split(/\s+/)[0] || '';
    return /^[a-f0-9]{64}$/i.test(field) ? field.toLowerCase() : '';
  }

  const api = {
    CDN_HOSTS,
    MAX_DATA_URL_CHARS,
    MAX_FILES,
    UPDATE_API,
    UPDATE_OWNER,
    UPDATE_REPO,
    compareVersions,
    isAccessToken,
    isAllowedApiFinalUrl,
    isAllowedApiRequestUrl,
    isAllowedTestUrl,
    isAllowedUpdateFetchUrl,
    isAppsScriptExecUrl,
    isGithubToken,
    isOauthClientId,
    isOfficialAssetUrl,
    isSafeDataDownloadUrl,
    isSafeDriveHttpsUrl,
    isSafePreviewSrc,
    isServiceAccountEmail,
    isValidDriveId,
    normalizeSha256,
    officialAssetApiUrl,
    officialAssetUrl,
    officialReleasePage,
    parseVersion,
    releaseAssetName,
    sanitizeApiBody,
    sanitizeDownloadFilename
  };

  root.DriveManagerPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
