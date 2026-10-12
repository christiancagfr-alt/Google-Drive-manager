var BACKEND_VERSION = '2.4.0';
var MAX_FILES = 50;
var MAX_FOLDER_NAMES = 50;
var MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
var DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;

function doGet(e) {
  try {
    var action = String((e && e.parameter && e.parameter.action) || '');
    if (action === 'ping' || action === 'health') {
      return jsonResponse({
        ok: true,
        message: 'pong',
        version: BACKEND_VERSION,
        time: new Date().toISOString()
      });
    }
    if (!action || action === 'auth') return jsonResponse(authorizeUser());
    if (isMutation(action)) {
      return jsonResponse({
        ok: false,
        message: '此操作已改为 POST。请更新扩展，并把最新 apps-script-backend.gs 部署为新版本。'
      });
    }
    return jsonResponse({ ok: false, message: '未知操作。' });
  } catch (error) {
    return jsonResponse({ ok: false, message: safeErrorMessage(error) });
  }
}

function doPost(e) {
  try {
    var body = parseJsonBody(e);
    if (!body) return jsonResponse({ ok: false, message: '需要 application/json 请求体。' });
    var action = String(body.action || '');
    if (!isMutation(action)) return jsonResponse({ ok: false, message: '未知操作。' });
    assertToken(body.token);
    if (action === 'list') return jsonResponse(listFolder(body.folderId));
    if (action === 'move') return jsonResponse(moveFiles(body.fileIds, body.destinationFolderId));
    if (action === 'download') return jsonResponse(downloadFiles(body.fileIds));
    if (action === 'createFolders') return jsonResponse(createFolders(body.parentFolderId || body.folderId, body.names));
    if (action === 'autoClassify') return jsonResponse(autoClassifyFiles(body.folderId || body.parentFolderId, body.minGroupSize));
    if (action === 'delete') return jsonResponse(trashFiles(body.fileIds));
    return jsonResponse({ ok: false, message: '未知操作。' });
  } catch (error) {
    return jsonResponse({ ok: false, message: safeErrorMessage(error) });
  }
}

function isMutation(action) {
  return action === 'list' || action === 'move' || action === 'download' ||
    action === 'createFolders' || action === 'autoClassify' || action === 'delete';
}

function parseJsonBody(e) {
  var post = e && e.postData;
  if (!post || !post.contents) return null;
  var type = String(post.type || '').toLowerCase();
  if (type.indexOf('application/json') !== 0) return null;
  if (String(post.contents).length > 20000) throw new Error('请求过大。');
  var data = JSON.parse(post.contents);
  if (!data || typeof data !== 'object') return null;
  return data;
}

function assertToken(provided) {
  var expected = '';
  try {
    expected = String(PropertiesService.getScriptProperties().getProperty('DRIVE_MANAGER_TOKEN') || '');
  } catch (error) {
    expected = '';
  }
  expected = expected.replace(/^\s+|\s+$/g, '');
  if (!expected) return;
  if (!constantTimeEqual(String(provided || ''), expected)) {
    throw new Error('访问口令不正确。请在扩展弹窗填写与脚本属性 DRIVE_MANAGER_TOKEN 相同的口令。');
  }
}

function constantTimeEqual(left, right) {
  var a = String(left);
  var b = String(right);
  var max = Math.max(a.length, b.length);
  var diff = a.length === b.length ? 0 : 1;
  for (var i = 0; i < max; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function authorizeUser() {
  // Touch Drive so the user gets the consent screen. Do not return folder ids.
  DriveApp.getRootFolder().getId();
  return {
    ok: true,
    message: '云端硬盘授权已就绪。',
    version: BACKEND_VERSION
  };
}

function listFolder(folderId) {
  var folder = openFolder(folderId, true);
  var files = [];
  var fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) {
    var file = fileIterator.next();
    var id = file.getId();
    var mimeType = file.getMimeType();
    var isImage = mimeType.indexOf('image/') === 0;
    var isVideo = mimeType.indexOf('video/') === 0;
    var hasPreview = isImage || isVideo;
    files.push({
      id: id,
      name: file.getName(),
      mimeType: mimeType,
      isImage: isImage,
      isVideo: isVideo,
      size: file.getSize(),
      webViewLink: file.getUrl(),
      thumbnailUrl: hasPreview ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w500' : '',
      previewUrl: hasPreview ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600' : ''
    });
  }

  var folders = [];
  var folderIterator = folder.getFolders();
  while (folderIterator.hasNext()) {
    var child = folderIterator.next();
    folders.push({
      id: child.getId(),
      name: child.getName()
    });
  }

  return {
    ok: true,
    folder: { id: folder.getId(), name: folder.getName() },
    files: files,
    folders: folders
  };
}

function createFolders(parentFolderId, namesValue) {
  var names = parseNames(namesValue);
  if (!names.length) throw new Error('未提供文件夹名称。');
  var parent = openFolder(parentFolderId, true);
  var folders = names.map(function (name) {
    var folder = parent.createFolder(name);
    return {
      id: folder.getId(),
      name: folder.getName(),
      url: folder.getUrl()
    };
  });
  return {
    ok: true,
    created: folders.length,
    parentFolder: { id: parent.getId(), name: parent.getName() },
    folders: folders
  };
}

function autoClassifyFiles(folderId, minGroupSizeValue) {
  var folder = openFolder(folderId, true);
  var parsed = Number(minGroupSizeValue || 2);
  if (!isFinite(parsed)) parsed = 2;
  var minGroupSize = Math.max(2, Math.min(1000, Math.floor(parsed)));
  var groups = {};
  var files = [];
  var fileIterator = folder.getFiles();

  while (fileIterator.hasNext()) {
    var file = fileIterator.next();
    var category = getCategoryName(file.getName());
    var item = { id: file.getId(), name: file.getName(), file: file, category: category };
    files.push(item);
    if (!category) continue;
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  }

  var existingFolders = getChildFolderMap(folder);
  var results = [];
  var moved = 0;
  var createdFolders = 0;

  Object.keys(groups).sort().forEach(function (category) {
    var items = groups[category];
    if (items.length < minGroupSize) return;

    var target = existingFolders[category];
    var created = false;
    if (!target) {
      target = folder.createFolder(category);
      existingFolders[category] = target;
      created = true;
      createdFolders += 1;
    }

    items.forEach(function (item) {
      item.file.moveTo(target);
      moved += 1;
    });

    results.push({
      category: category,
      folderId: target.getId(),
      folderName: target.getName(),
      created: created,
      moved: items.length
    });
  });

  return {
    ok: true,
    folder: { id: folder.getId(), name: folder.getName() },
    groups: results.length,
    createdFolders: createdFolders,
    moved: moved,
    skipped: files.length - moved,
    results: results
  };
}

function getCategoryName(fileName) {
  var baseName = String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\s*\d{1,8}\s*[-_. ]+\s*/, '')
    .trim();
  if (!baseName) return '';

  var parts = baseName
    .split(/\s*[-_]\s*/)
    .map(function (part) { return part.trim(); })
    .filter(Boolean);

  if (parts.length >= 2) return parts[0] + '-' + parts[1];
  if (parts.length === 1) return parts[0];
  return '';
}

function getChildFolderMap(parent) {
  var map = {};
  var folderIterator = parent.getFolders();
  while (folderIterator.hasNext()) {
    var child = folderIterator.next();
    var name = child.getName();
    if (!map[name]) map[name] = child;
  }
  return map;
}

function moveFiles(fileIds, destinationFolderId) {
  var ids = parseIds(fileIds);
  if (!ids.length) throw new Error('未选择文件。');
  var destination = openFolder(destinationFolderId, false);
  ids.forEach(function (id) {
    DriveApp.getFileById(id).moveTo(destination);
  });
  return {
    ok: true,
    moved: ids.length,
    folderName: destination.getName()
  };
}

function trashFiles(fileIds) {
  var ids = parseIds(fileIds);
  if (!ids.length) throw new Error('未选择文件。');
  var trashed = 0;
  var failed = [];
  ids.forEach(function (id) {
    try {
      DriveApp.getFileById(id).setTrashed(true);
      trashed += 1;
    } catch (error) {
      failed.push(id);
    }
  });
  if (!trashed) {
    return {
      ok: false,
      message: '没有文件被移入回收站。请确认这些文件还未删除，并且你有编辑权限。',
      trashed: 0,
      failed: failed.length
    };
  }
  return {
    ok: true,
    trashed: trashed,
    failed: failed.length,
    failures: failed.slice(0, 10)
  };
}

function downloadFiles(fileIds) {
  var ids = parseIds(fileIds);
  if (!ids.length) throw new Error('未选择文件。');

  if (ids.length === 1) {
    var file = DriveApp.getFileById(ids[0]);
    assertDownloadSize(file.getSize(), file.getName());
    return {
      ok: true,
      name: file.getName(),
      mimeType: file.getMimeType() || 'application/octet-stream',
      data: Utilities.base64Encode(file.getBlob().getBytes())
    };
  }

  var total = 0;
  var blobs = ids.map(function (id) {
    var file = DriveApp.getFileById(id);
    var size = file.getSize();
    assertDownloadSize(size, file.getName());
    total += size;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error('所选文件合计超过 30MB。请减少数量，或在云端硬盘页面直接下载。');
    }
    return file.getBlob().setName(safeZipEntryName(file.getName(), id));
  });
  var zip = Utilities.zip(blobs, 'drive-files-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.zip');
  return {
    ok: true,
    name: zip.getName(),
    mimeType: 'application/zip',
    data: Utilities.base64Encode(zip.getBytes())
  };
}

function assertDownloadSize(size, name) {
  if (Number(size) > MAX_DOWNLOAD_BYTES) {
    throw new Error('文件超过 30MB，请在云端硬盘页面直接下载：' + String(name || '').slice(0, 80));
  }
}

function safeZipEntryName(name, id) {
  var base = String(name || id || 'file').split(/[\\/]/).pop();
  base = base.replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '');
  if (!base) base = id || 'file';
  return base.slice(0, 180);
}

function openFolder(folderId, allowRoot) {
  var id = String(folderId || '').replace(/^\s+|\s+$/g, '');
  if (!id) {
    if (allowRoot) return DriveApp.getRootFolder();
    throw new Error('缺少文件夹 ID。');
  }
  if (!DRIVE_ID_RE.test(id)) throw new Error('文件夹 ID 无效。');
  return DriveApp.getFolderById(id);
}

function parseIds(fileIds) {
  var parts = String(fileIds || '').split(',');
  if (parts.length > MAX_FILES) throw new Error('一次最多处理 50 个文件。');
  var ids = [];
  var seen = {};
  parts.forEach(function (part) {
    var id = String(part || '').replace(/^\s+|\s+$/g, '');
    if (!id || seen[id]) return;
    if (!DRIVE_ID_RE.test(id)) throw new Error('文件 ID 无效。');
    seen[id] = true;
    ids.push(id);
  });
  if (ids.length > MAX_FILES) throw new Error('一次最多处理 50 个文件。');
  return ids;
}

function parseNames(namesValue) {
  var parts = String(namesValue || '').split(/[\n,;]+/);
  if (parts.length > MAX_FOLDER_NAMES) throw new Error('一次最多创建 50 个文件夹。');
  var seen = {};
  var names = [];
  parts.forEach(function (part) {
    var name = String(part || '').replace(/^\s+|\s+$/g, '');
    if (!name || seen[name]) return;
    if (name.length > 120) throw new Error('文件夹名称过长。');
    if (/[\u0000-\u001f]/.test(name)) throw new Error('文件夹名称包含不可见字符。');
    seen[name] = true;
    names.push(name);
  });
  if (names.length > MAX_FOLDER_NAMES) throw new Error('一次最多创建 50 个文件夹。');
  return names;
}

function safeErrorMessage(error) {
  var text = String((error && error.message) || error || '操作失败。');
  text = text.replace(/https?:\/\/\S+/g, '[url]');
  if (text.length > 180) text = text.slice(0, 180);
  return text;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
