/**
 * Shared Apps Script web-app URL helpers.
 * Supports consumer and Google Workspace deployment URLs.
 */
(function (root) {
  // Consumer:  https://script.google.com/macros/s/{ID}/exec
  // Workspace: https://script.google.com/a/macros/{domain}/s/{ID}/exec
  const EXEC_PATH_RE = /https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#\s]+\/s|macros\/s)\/[^/?#\s]+\/(?:exec|dev)/i;

  function normalizeAppsScriptUrl(value) {
    const input = String(value || '').trim();
    if (!input) return '';

    if (/^script\.google\.com\//i.test(input)) {
      return normalizeAppsScriptUrl('https://' + input);
    }

    const match = input.match(EXEC_PATH_RE);
    if (match) return match[0];

    return input;
  }

  function isValidAppsScriptUrl(value) {
    try {
      const normalized = normalizeAppsScriptUrl(value);
      const url = new URL(normalized);
      if (url.protocol !== 'https:') return false;
      if (url.hostname !== 'script.google.com') return false;
      return /\/(?:a\/macros\/[^/]+\/s|macros\/s)\/[^/]+\/(?:exec|dev)$/i.test(url.pathname);
    } catch (error) {
      return false;
    }
  }

  function buildActionUrl(base, action, params) {
    const normalized = normalizeAppsScriptUrl(base);
    if (!normalized) throw new Error('请先在扩展弹窗中配置 Apps Script 网页应用地址。');
    const url = new URL(normalized);
    if (action) url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  root.DriveManagerUrl = {
    normalizeAppsScriptUrl,
    isValidAppsScriptUrl,
    buildActionUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
