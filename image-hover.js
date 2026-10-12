/**
 * Hover preview for Google Sheets & Google Docs only.
 * - Does NOT run on Drive folders (avoids interfering with file management).
 * - Images: high-res Drive thumbnail / canvas magnifier (snappy hide)
 * - Videos: Drive preview iframe with autoplay; soft-pinned so it stays
 *   when the mouse leaves the cell (Esc / × / click outside to close)
 */
(() => {
  // Strict page gate: only Spreadsheets and Documents.
  const path = location.pathname || '';
  const isSheets =
    (/docs\.google\.com$/i.test(location.hostname) && /\/spreadsheets\//i.test(path)) ||
    /sheets\.google\.com$/i.test(location.hostname);
  const isDocument =
    /docs\.google\.com$/i.test(location.hostname) && /\/document\//i.test(path);

  if (!isSheets && !isDocument) {
    return;
  }

  const PREVIEW_ID = 'dim-global-image-hover-preview';
  const HOVER_DELAY_MS = 70;
  const SWITCH_DELAY_MS = 35;
  const HIDE_DELAY_MS = 25;           // images / magnifier
  const VIDEO_HIDE_DELAY_MS = 900;    // only used if soft-pin temporarily off
  const STICKY_RADIUS_PX = 34;
  const VIDEO_STICKY_RADIUS_PX = 80;
  const MIN_IMG_SIZE = 12;
  const MAGNIFY_PAD = 8;
  const MAGNIFY_GRID = 44;

  const DRIVE_HOST_RE = /(?:^|\.)(?:drive\.google\.com|docs\.google\.com|lh[0-9-]*\.googleusercontent\.com|googleusercontent\.com)$/i;
  const FILE_ID_PATTERNS = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/i,
    /[?&]id=([a-zA-Z0-9_-]{10,})/i,
    /\/d\/([a-zA-Z0-9_-]{10,})(?:\/|$|\?)/i,
    /\/thumbnail(?:\/|.*?[?&]id=)([a-zA-Z0-9_-]{10,})/i,
    /googleusercontent\.com\/d\/([a-zA-Z0-9_-]{10,})/i,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]{10,})/i
  ];
  const DRIVE_URL_IN_TEXT_RE = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s"'<>\\]+/gi;
  const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:$|[?#])/i;
  const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|avi|mkv|mpeg|mpg|3gp|wmv|flv)(?:$|[?#])/i;

  let showTimer = null;
  let hideTimer = null;
  let currentKey = '';
  let currentKind = '';
  let pinned = false;
  // Video previews stay open after mouse leaves the cell until closed explicitly
  // or replaced by another hover target.
  let softPinned = false;
  let lastPointer = { x: 0, y: 0 };
  let captureInFlight = false;
  let activeAnchor = null;
  let evaluateSeq = 0;
  let activeCandidate = null;

  function extractFileId(url) {
    if (!url) return '';
    const text = String(url);
    for (const re of FILE_ID_PATTERNS) {
      const m = text.match(re);
      if (m && m[1] && m[1].length >= 10) return m[1];
    }
    return '';
  }

  function isDriveRelatedUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      if (DRIVE_HOST_RE.test(u.hostname)) return true;
      if (u.hostname === 'www.google.com' && u.pathname.startsWith('/url')) {
        const nested = u.searchParams.get('q') || u.searchParams.get('url') || '';
        return isDriveRelatedUrl(nested);
      }
      return false;
    } catch (error) {
      return /drive\.google\.com|googleusercontent\.com|docs\.google\.com/i.test(String(url));
    }
  }

  function looksLikeImageUrl(url) {
    if (!url) return false;
    const s = String(url);
    if (IMAGE_EXT_RE.test(s)) return true;
    if (/thumbnail|googleusercontent|\/uc\?|export=view|sz=w\d+/i.test(s)) return true;
    if (/drive\.google\.com\/(?:thumbnail|uc)/i.test(s)) return true;
    return false;
  }

  function looksLikeVideo(url, label) {
    const text = `${url || ''} ${label || ''}`;
    if (VIDEO_EXT_RE.test(text)) return true;
    if (/(?:^|[\s_\-./])(?:video|视频|影片|movie|clip)(?:$|[\s_\-./])/i.test(text)) return true;
    return false;
  }

  function resolveHighResUrl(sourceUrl, fileId) {
    if (fileId) {
      return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w2000`;
    }
    if (!sourceUrl) return '';
    try {
      const u = new URL(sourceUrl, location.href);
      if (u.searchParams.has('sz')) {
        u.searchParams.set('sz', 'w2000');
        return u.toString();
      }
      if (/googleusercontent\.com/i.test(u.hostname)) {
        return u.href
          .replace(/=s\d+(-[a-z]+)?$/i, '=s2000')
          .replace(/=w\d+-h\d+[^?#]*/i, '=w2000')
          .replace(/\/s\d+\//i, '/s2000/');
      }
      return u.toString();
    } catch (error) {
      return sourceUrl;
    }
  }

  function drivePreviewUrl(fileId, { autoplay = true } = {}) {
    // autoplay=1 helps when the Drive player allows it; browsers often require mute.
    const params = autoplay ? '?autoplay=1&mute=1' : '';
    return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview${params}`;
  }

  function isOurUi(el) {
    return Boolean(el && el.closest && el.closest(`#${PREVIEW_ID}`));
  }

  function getBackgroundImageUrl(el) {
    try {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/i);
      return m ? m[1] : '';
    } catch (error) {
      return '';
    }
  }

  function rectContains(rect, x, y, pad = 0) {
    return x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad;
  }

  function findImgNearPoint(x, y) {
    const imgs = document.querySelectorAll('img');
    let best = null;
    let bestArea = Infinity;

    for (const img of imgs) {
      if (isOurUi(img)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < MIN_IMG_SIZE || rect.height < MIN_IMG_SIZE) continue;
      if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.95) continue;
      if (!rectContains(rect, x, y, 10)) continue;

      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:image/svg')) continue;

      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return best;
  }

  function findDriveUrlNearPoint(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (isOurUi(el)) continue;
      const a = el.closest?.('a[href]');
      if (a?.href && isDriveRelatedUrl(a.href)) {
        return { url: a.href, label: (a.textContent || a.title || '').trim() };
      }
      const href = el.getAttribute?.('href') || el.getAttribute?.('data-url') || '';
      if (href && isDriveRelatedUrl(href)) {
        return { url: href, label: (el.textContent || el.getAttribute('aria-label') || '').trim() };
      }
      const label = el.getAttribute?.('aria-label') || el.getAttribute?.('data-tooltip') || '';
      const fromLabel = (label.match(DRIVE_URL_IN_TEXT_RE) || [])[0];
      if (fromLabel) return { url: fromLabel, label };
    }

    let best = null;
    let bestDist = 100;
    document.querySelectorAll('a[href*="drive.google.com"], a[href*="docs.google.com"]').forEach((a) => {
      const rect = a.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      const dist = Math.hypot(x - cx, y - cy);
      const sameRowNear = y >= rect.top - 18 && y <= rect.bottom + 18 &&
        x >= rect.left - 24 && x <= rect.right + 140;
      if (isDriveRelatedUrl(a.href) && (dist < bestDist || sameRowNear)) {
        if (dist < bestDist || (sameRowNear && !best)) {
          bestDist = Math.min(dist, bestDist);
          best = { url: a.href, label: (a.textContent || '').trim() };
        }
      }
    });
    if (best) return best;

    const bubbleText = [];
    document.querySelectorAll(
      '.docs-bubble, .docs-linkbubble-bubble, #docs-linkbubble, [class*="link-bubble"], [class*="linkbubble"], [role="tooltip"]'
    ).forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      if (!rectContains(rect, x, y, 40)) return;
      if (el.href) bubbleText.push({ url: el.href, label: el.textContent || '' });
      const m = String(el.textContent || '').match(DRIVE_URL_IN_TEXT_RE);
      if (m && m[0]) bubbleText.push({ url: m[0], label: el.textContent || '' });
    });
    return bubbleText[0] || null;
  }

  function candidateFromImg(img) {
    if (!img) return null;
    const src = img.currentSrc || img.src || img.getAttribute('src') ||
      img.getAttribute('data-src') || img.getAttribute('data-thumbnail') || '';
    if (!src) return null;
    const parentHref = img.closest('a')?.href || '';
    const parentLabel = (img.closest('a')?.textContent || img.alt || img.title || '').trim();
    const fileId = extractFileId(src) || extractFileId(parentHref);
    const driveRelated = isDriveRelatedUrl(src) || Boolean(fileId) || isDriveRelatedUrl(parentHref);
    // Only enlarge Drive-related or obvious image assets in Sheets/Docs.
    if (!driveRelated && !looksLikeImageUrl(src) && !fileId) return null;

    const rect = img.getBoundingClientRect();
    const isVideo = looksLikeVideo(src, parentLabel) || looksLikeVideo(parentHref, parentLabel);

    if (isVideo && fileId) {
      return {
        key: `video:${fileId}`,
        kind: 'video',
        fileId,
        element: img,
        rect,
        label: parentLabel || img.alt || `视频 ${fileId.slice(0, 8)}…`,
        previewUrl: drivePreviewUrl(fileId, { autoplay: false }),
        fallbackUrl: resolveHighResUrl(src, fileId)
      };
    }

    return {
      key: `img:${fileId || src}:${Math.round(rect.left)}:${Math.round(rect.top)}`,
      kind: 'img',
      fileId,
      element: img,
      rect,
      previewUrl: resolveHighResUrl(src, fileId),
      fallbackUrl: src,
      label: img.alt || img.title || fileId || '图片预览'
    };
  }

  function candidateFromDriveLink(info, x, y) {
    if (!info?.url) return null;
    const fileId = extractFileId(info.url);
    if (!fileId && !looksLikeImageUrl(info.url) && !looksLikeVideo(info.url, info.label)) return null;

    const isVideo = looksLikeVideo(info.url, info.label);
    // Drive file links without extension: treat as media preview.
    // Prefer video player when label/url suggests video; otherwise image thumbnail.
    if (isVideo && fileId) {
      return {
        key: `video:${fileId}`,
        kind: 'video',
        fileId,
        element: null,
        rect: { left: x - 20, top: y - 20, width: 40, height: 40, right: x + 20, bottom: y + 20 },
        label: info.label || `视频 ${fileId.slice(0, 8)}…`,
        previewUrl: drivePreviewUrl(fileId, { autoplay: false }),
        fallbackUrl: resolveHighResUrl(info.url, fileId),
        anchorX: x,
        anchorY: y
      };
    }

    if (fileId || looksLikeImageUrl(info.url)) {
      return {
        key: `drive:${fileId || info.url}`,
        kind: 'drive',
        fileId,
        element: null,
        rect: { left: x - 20, top: y - 20, width: 40, height: 40, right: x + 20, bottom: y + 20 },
        previewUrl: resolveHighResUrl(info.url, fileId),
        fallbackUrl: resolveHighResUrl(info.url, fileId),
        label: info.label || (fileId ? `云端文件 ${fileId.slice(0, 8)}…` : '云端链接预览'),
        // Unknown type: allow fallback to video player if thumbnail fails.
        allowVideoFallback: Boolean(fileId),
        anchorX: x,
        anchorY: y
      };
    }
    return null;
  }

  function candidateFromBackground(el) {
    if (!el || el.nodeType !== 1) return null;
    const bgUrl = getBackgroundImageUrl(el);
    if (!bgUrl) return null;
    if (!isDriveRelatedUrl(bgUrl) && !looksLikeImageUrl(bgUrl)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_IMG_SIZE || rect.height < MIN_IMG_SIZE) return null;
    const fileId = extractFileId(bgUrl);
    return {
      key: `bg:${bgUrl}`,
      kind: 'bg',
      element: el,
      rect,
      previewUrl: resolveHighResUrl(bgUrl, fileId),
      fallbackUrl: bgUrl,
      label: el.getAttribute('aria-label') || el.title || '图片预览'
    };
  }

  function isOverSpreadsheetGrid(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (isOurUi(el)) continue;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'canvas') return true;
      const cls = String(el.className || '');
      if (/waffle|grid-container|sheet-canvas|docs-texteventtarget/i.test(cls)) return true;
      if (el.id && /waffle|sheets-canvas/i.test(el.id)) return true;
    }
    return isSheets;
  }

  function estimateThumbRect(x, y) {
    let size = isSheets ? 64 : 56;
    const img = findImgNearPoint(x, y);
    if (img) {
      const r = img.getBoundingClientRect();
      return {
        left: r.left - MAGNIFY_PAD,
        top: r.top - MAGNIFY_PAD,
        width: r.width + MAGNIFY_PAD * 2,
        height: r.height + MAGNIFY_PAD * 2
      };
    }
    return {
      left: x - size / 2,
      top: y - size / 2,
      width: size,
      height: size
    };
  }

  async function captureMagnifier(x, y) {
    if (captureInFlight) return null;
    if (!chrome?.runtime?.sendMessage) return null;

    const region = estimateThumbRect(x, y);
    captureInFlight = true;
    try {
      const preview = document.getElementById(PREVIEW_ID);
      const wasVisible = preview?.classList.contains('visible');
      if (preview) preview.classList.remove('visible');

      const response = await chrome.runtime.sendMessage({
        type: 'drive-manager-capture-region',
        region: {
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height,
          dpr: window.devicePixelRatio || 1
        }
      });

      if (wasVisible && preview && pinned) preview.classList.add('visible');
      const dataUrl = String(response?.dataUrl || '');
      if (!response?.ok || !/^data:image\/png;base64,[a-z0-9+/=\r\n]+$/i.test(dataUrl) || dataUrl.length > 6 * 1024 * 1024) {
        return null;
      }

      const gx = Math.floor(x / MAGNIFY_GRID);
      const gy = Math.floor(y / MAGNIFY_GRID);
      return {
        key: `mag:${gx}:${gy}`,
        kind: 'magnifier',
        element: null,
        rect: region,
        previewUrl: dataUrl,
        fallbackUrl: dataUrl,
        label: '单元格放大预览',
        anchorX: x,
        anchorY: y
      };
    } catch (error) {
      return null;
    } finally {
      captureInFlight = false;
    }
  }

  async function resolveCandidate(x, y, target) {
    // 1) Real image under pointer.
    const img = findImgNearPoint(x, y);
    if (img) {
      const c = candidateFromImg(img);
      if (c) return c;
    }

    // 2) Ancestry walk.
    let node = target;
    let depth = 0;
    while (node && node !== document.documentElement && depth < 8) {
      if (node.tagName === 'IMG') {
        const c = candidateFromImg(node);
        if (c) return c;
      }
      const bg = candidateFromBackground(node);
      if (bg) return bg;
      node = node.parentElement;
      depth += 1;
    }

    // 3) Drive URL near pointer (primary for link columns in Sheets).
    const driveInfo = findDriveUrlNearPoint(x, y);
    if (driveInfo) {
      const c = candidateFromDriveLink(driveInfo, x, y);
      if (c) return c;
    }

    // 4) Canvas magnifier only in Sheets when hovering grid content with nearby media.
    // Skip pure empty cells: require drive link nearby or small image region.
    if (isSheets && isOverSpreadsheetGrid(x, y) && y > 90 && x > 40) {
      // If there is a drive link on the same row within a reasonable distance, magnify.
      if (driveInfo || findImgNearPoint(x, y)) {
        return captureMagnifier(x, y);
      }
      // Soft: still magnify if cursor is over canvas (user scanning thumbs).
      // Limit to avoid random zooms on empty space — only if near previous anchor or img density.
      const nearbyImg = findImgNearPoint(x, y);
      if (nearbyImg) return captureMagnifier(x, y);
    }

    return null;
  }

  function ensurePreviewEl() {
    let el = document.getElementById(PREVIEW_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PREVIEW_ID;
    el.innerHTML = `
      <button type="button" class="dim-hover-close" title="关闭" aria-label="关闭">×</button>
      <div class="dim-hover-media"></div>
      <div class="dim-hover-label"></div>
      <div class="dim-hover-hint">视频会自动尝试播放并保持显示 · Esc / × 关闭 · 移到窗口上可继续操作</div>
    `;
    document.documentElement.appendChild(el);
    el.querySelector('.dim-hover-close').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      pinned = false;
      softPinned = false;
      hidePreview(true);
    });
    // Keep video open while pointer is over the preview panel.
    el.addEventListener('pointerenter', () => {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
    });
    el.addEventListener('pointerleave', (event) => {
      if (pinned || softPinned) return;
      if (event.relatedTarget && isNearActiveAnchor(lastPointer.x, lastPointer.y)) return;
      scheduleHide();
    });
    return el;
  }

  function positionPreview(preview, candidate, clientX, clientY) {
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isVideo = candidate?.kind === 'video';
    const estW = Math.min(vw * 0.55, isVideo ? 640 : candidate?.kind === 'magnifier' ? 360 : 520);
    const estH = Math.min(vh * 0.7, isVideo ? 420 : 520);

    let anchorX = clientX;
    let anchorY = clientY;
    const r = candidate?.rect;
    if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) {
      anchorX = r.right != null ? r.right : (r.left + (r.width || 0));
      anchorY = r.top + (r.height || 0) / 2;
    }

    let left = anchorX + 14;
    let top = anchorY - 40;

    if (left + estW + margin > vw) {
      const sourceLeft = r && Number.isFinite(r.left) ? r.left : clientX;
      left = Math.max(margin, sourceLeft - estW - 14);
    }
    if (top + estH + margin > vh) {
      top = Math.max(margin, vh - estH - margin);
    }
    if (top < margin) top = margin;

    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(top)}px`;
  }

  function setActiveAnchor(candidate, clientX, clientY) {
    const r = candidate?.rect || null;
    activeAnchor = {
      x: candidate?.anchorX ?? clientX,
      y: candidate?.anchorY ?? clientY,
      key: candidate?.key || '',
      rect: r
        ? {
            left: r.left,
            top: r.top,
            right: r.right != null ? r.right : r.left + (r.width || 0),
            bottom: r.bottom != null ? r.bottom : r.top + (r.height || 0),
            width: r.width || 0,
            height: r.height || 0
          }
        : null
    };
  }

  function isNearActiveAnchor(x, y) {
    if (!activeAnchor) return false;
    const radius = currentKind === 'video' ? VIDEO_STICKY_RADIUS_PX : STICKY_RADIUS_PX;
    if (activeAnchor.rect && rectContains(activeAnchor.rect, x, y, currentKind === 'video' ? 28 : 18)) {
      return true;
    }
    return Math.hypot(x - activeAnchor.x, y - activeAnchor.y) <= radius;
  }

  function isPointerOverPreview(x, y) {
    const preview = document.getElementById(PREVIEW_ID);
    if (!preview || !preview.classList.contains('visible')) return false;
    return rectContains(preview.getBoundingClientRect(), x, y, 4);
  }

  function isSafeHoverSrc(value) {
    const text = String(value || '');
    if (/^data:image\/(?:png|jpeg);base64,[a-z0-9+/=\r\n]+$/i.test(text)) {
      return text.length < 6 * 1024 * 1024;
    }
    try {
      const url = new URL(text, location.href);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch (error) {
      return false;
    }
  }

  function renderMedia(container, candidate, { autoplay = true } = {}) {
    container.innerHTML = '';
    if (candidate.kind === 'video' && candidate.fileId) {
      const iframe = document.createElement('iframe');
      // Always request autoplay for video hover / pin.
      iframe.src = drivePreviewUrl(candidate.fileId, { autoplay: true });
      iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.setAttribute('title', candidate.label || '视频预览');
      // Allow interaction so user can click play if browser blocks autoplay.
      iframe.style.pointerEvents = 'auto';
      container.appendChild(iframe);

      // Some Drive players only start after the frame loads; nudge once.
      iframe.addEventListener('load', () => {
        try {
          // Re-assigning with autoplay can re-trigger play in some builds.
          if (autoplay && iframe.dataset.nudged !== '1') {
            iframe.dataset.nudged = '1';
            const src = drivePreviewUrl(candidate.fileId, { autoplay: true });
            if (iframe.src !== src) iframe.src = src;
          }
        } catch (error) {
          // ignore
        }
      }, { once: true });

      return { type: 'video', el: iframe };
    }

    const img = document.createElement('img');
    img.alt = candidate.label || '预览';
    img.draggable = false;
    const src = candidate.previewUrl || candidate.fallbackUrl || '';
    if (!isSafeHoverSrc(src)) return null;
    img.src = src;
    container.appendChild(img);
    return { type: 'img', el: img };
  }

  function showPreview(candidate, clientX, clientY, options = {}) {
    if (!candidate?.previewUrl && !candidate?.fallbackUrl && !candidate?.fileId) return;
    const preview = ensurePreviewEl();
    const media = preview.querySelector('.dim-hover-media');
    const label = preview.querySelector('.dim-hover-label');
    const hint = preview.querySelector('.dim-hover-hint');
    label.textContent = candidate.label || '';

    const isVideo = candidate.kind === 'video';
    preview.classList.toggle('video-preview', isVideo);
    preview.classList.toggle('magnifier', candidate.kind === 'magnifier');
    preview.classList.toggle('pinned', Boolean(pinned || options.pinned || isVideo));

    // Videos soft-pin automatically so leaving the cell does not dismiss playback.
    if (isVideo) {
      softPinned = true;
      if (hint) {
        hint.textContent = '视频保持显示并尝试自动播放 · 移到窗口上可点击播放 · Esc / × 关闭';
      }
    } else {
      softPinned = false;
      if (hint) {
        hint.textContent = '悬停放大 · Alt+点击固定 · Esc 关闭';
      }
    }

    if (options.pinned) pinned = true;

    const rendered = renderMedia(media, candidate, { autoplay: isVideo || options.autoplay });
    if (!rendered) {
      hidePreview(true);
      return;
    }

    if (rendered.type === 'img') {
      const img = rendered.el;
      const primary = candidate.previewUrl || candidate.fallbackUrl;
      const fallback = candidate.fallbackUrl;

      img.onload = () => {
        preview.classList.add('visible');
        positionPreview(preview, candidate, clientX, clientY);
      };
      img.onerror = () => {
        if (fallback && img.src !== fallback && primary !== fallback) {
          img.src = fallback;
          return;
        }
        // Thumbnail failed — open as video/Drive preview with autoplay.
        if ((candidate.allowVideoFallback || candidate.fileId) && candidate.fileId && !candidate._triedVideo) {
          candidate._triedVideo = true;
          const videoCandidate = {
            ...candidate,
            kind: 'video',
            key: `video:${candidate.fileId}`,
            previewUrl: drivePreviewUrl(candidate.fileId, { autoplay: true }),
            label: candidate.label || `云端预览 ${candidate.fileId.slice(0, 8)}…`
          };
          showPreview(videoCandidate, clientX, clientY, options);
          return;
        }
        if (candidate.kind === 'drive' && isSheets && !candidate._triedMag) {
          candidate._triedMag = true;
          captureMagnifier(clientX, clientY).then((mag) => {
            if (mag) showPreview(mag, clientX, clientY);
            else hidePreview(true);
          });
          return;
        }
        hidePreview(true);
      };
    } else {
      preview.classList.add('visible');
    }

    preview.classList.add('visible');
    positionPreview(preview, candidate, clientX, clientY);
    currentKey = candidate.key || '';
    currentKind = candidate.kind || '';
    activeCandidate = candidate;
    setActiveAnchor(candidate, clientX, clientY);
  }

  function hidePreview(force) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if ((pinned || softPinned) && !force) return;
    const preview = document.getElementById(PREVIEW_ID);
    if (!preview) return;
    preview.classList.remove('visible', 'pinned', 'magnifier', 'video-preview');
    const media = preview.querySelector('.dim-hover-media');
    if (media) media.innerHTML = '';
    currentKey = '';
    currentKind = '';
    activeCandidate = null;
    activeAnchor = null;
    pinned = false;
    softPinned = false;
  }

  function scheduleHide() {
    // Soft-pinned / hard-pinned videos stay until explicit close or replaced.
    if (pinned || softPinned) return;
    clearTimeout(hideTimer);
    const delay = currentKind === 'video' ? VIDEO_HIDE_DELAY_MS : HIDE_DELAY_MS;
    hideTimer = setTimeout(() => hidePreview(false), delay);
  }

  async function evaluatePointer(clientX, clientY, target) {
    const seq = ++evaluateSeq;
    const candidate = await resolveCandidate(clientX, clientY, target);
    if (seq !== evaluateSeq) return;

    if (!candidate) {
      // Keep soft-pinned video; only hide non-video previews.
      if (softPinned || pinned) return;
      scheduleHide();
      return;
    }

    clearTimeout(hideTimer);

    if (candidate.key && candidate.key === currentKey) return;

    if (
      currentKey &&
      candidate.kind === 'magnifier' &&
      String(currentKey).startsWith('mag:') &&
      isNearActiveAnchor(clientX, clientY)
    ) {
      return;
    }

    showPreview(candidate, clientX, clientY);
  }

  function onPointerMove(event) {
    lastPointer = { x: event.clientX, y: event.clientY };

    // Over the floating preview (video controls / close) — keep it.
    if (isOurUi(event.target) || isPointerOverPreview(event.clientX, event.clientY)) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      return;
    }

    if (pinned) return;

    const { clientX, clientY, target } = event;

    if (currentKey && isNearActiveAnchor(clientX, clientY)) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      return;
    }

    clearTimeout(showTimer);

    // Soft-pinned video: do not dismiss on leave; only switch if a new target appears.
    if (softPinned && currentKind === 'video') {
      showTimer = setTimeout(() => {
        evaluatePointer(clientX, clientY, target);
      }, SWITCH_DELAY_MS + 40);
      return;
    }

    if (currentKey) scheduleHide();

    const delay = currentKey ? SWITCH_DELAY_MS : HOVER_DELAY_MS;
    showTimer = setTimeout(() => {
      evaluatePointer(clientX, clientY, target);
    }, delay);
  }

  function onPointerOut(event) {
    if (pinned || softPinned) return;
    if (!event.relatedTarget) {
      clearTimeout(showTimer);
      scheduleHide();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') hidePreview(true);
  }

  function onPointerDown(event) {
    // Click outside closes soft-pinned / pinned video.
    if (!pinned && !softPinned) return;
    if (isOurUi(event.target) || isPointerOverPreview(event.clientX, event.clientY)) return;
    // Allow normal sheet interaction without always closing: only close if
    // click is clearly away from the source anchor as well.
    if (isNearActiveAnchor(event.clientX, event.clientY)) return;
    hidePreview(true);
  }

  async function onClick(event) {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const candidate = await resolveCandidate(event.clientX, event.clientY, event.target);
    if (!candidate) return;
    pinned = true;
    softPinned = true;
    if (candidate.fileId && (candidate.kind === 'video' || candidate.allowVideoFallback || candidate.kind === 'drive')) {
      const asVideo = looksLikeVideo(candidate.previewUrl || '', candidate.label) ||
        candidate.kind === 'video' ||
        VIDEO_EXT_RE.test(candidate.label || '');
      if (asVideo || candidate.kind === 'video') {
        showPreview({
          ...candidate,
          kind: 'video',
          key: `video:${candidate.fileId}`,
          previewUrl: drivePreviewUrl(candidate.fileId, { autoplay: true })
        }, event.clientX, event.clientY, { pinned: true, autoplay: true });
        return;
      }
    }
    showPreview(candidate, event.clientX, event.clientY, { pinned: true });
  }

  function init() {
    document.addEventListener('mousemove', onPointerMove, true);
    document.addEventListener('mouseout', onPointerOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
