'use strict';

const FS_ERR_MSG = {
  ENOENT: 'Path not found', EACCES: 'Permission denied', EPERM: 'Permission denied',
  EISDIR: 'Path is a directory', ENOTDIR: 'Not a directory', ELOOP: 'Too many symbolic links',
  ENOSPC: 'No space left on device', EMFILE: 'Too many open files', ENFILE: 'Too many open files',
  ENAMETOOLONG: 'Path too long', EROFS: 'Read-only filesystem', EXDEV: 'Cross-device operation not supported',
  EBUSY: 'Resource busy'
};
function redactPaths(msg) {
  // Windows drive paths plus POSIX absolute paths that begin a word (' /, " /,
  // = /, : /). The (?!\/) guard leaves URLs alone, so a message quoting
  // https://host/a/b survives while '/home/you/secret' becomes '<path>'.
  // Segment class is deliberately broad ([^"'`\n\r()\[\]]): ASCII-only \w cut
  // non-ASCII names (документ) and spaces (C:\Program Files) mid-path and
  // leaked the remainder. Tilde-relative (~/x) and bare relative leaks are
  // redacted too.
  let s = String(msg);
  s = s.replace(/https?:\/\/[^/\s"'`]+/g, m => (/[@]/.test(m) ? m.replace(/^(https?:\/\/)[^@]*@/, '$1<redacted>@') : m));
  s = s.replace(/([A-Za-z]:\\[^"'`\n\r]*)/g, '<path>');
  s = s.replace(/(^|[\s"'(=:,])~\/[^"'`\n\r()\[\]]*/g, '$1<path>');
  s = s.replace(/(^|[\s"'(=:,])\/(?!\/)[^"'`\n\r()\[\]]*/g, (m, pre) => {
    const body = m.slice(pre.length).replace(/[\s.,;:!?]+$/, '');
    if (!body || body === '/') return m;
    return pre + '<path>';
  });
  return s;
}
function safeErr(e, fallbackStatus) {
  const raw = (e && e.message) || '';
  const code = (e && e.code) || '';
  let status = (e && e.status) || fallbackStatus || 500;
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  const fsError = Object.prototype.hasOwnProperty.call(FS_ERR_MSG, code);
  // Raw filesystem messages embed absolute paths, so they are replaced by a
  // code-derived sentence. Our own thrown errors keep their text (redacted) —
  // validation feedback like "refusing to kill pid 1" must not be swallowed.
  const msg = fsError ? FS_ERR_MSG[code] : (redactPaths(raw) || 'Operation failed');
  if (status >= 500) {
    try { console.warn('[webtun] error:', status, code || '-', raw.slice(0, 300)); } catch {}
  }
  const body = { error: msg };
  if (code) body.code = code;
  return { status, body };
}
// Sanitized one-line text for batch responses ({ results: [{ error }] }).
function errText(e) { return safeErr(e).body.error; }
// Git CLI stderr is bound for the UI (it is genuinely useful), so it keeps its
// wording, but paths are redacted and the length is bounded. Remote URLs and
// embedded tokens (https://<token>@host) are scrubbed to <redacted>.
function gitErrText(e, fallback, max = 500) {
  return redactPaths((e && e.message) || '').trim().slice(0, max) || fallback;
}
// Timeouts/auth failures must not flatten to 400: callers need to tell
// retryable (504/401/403) from bad-request. Non-git routes keep safeErr.
function gitErrStatus(e, fallback = 400) {
  const m = String((e && e.message) || '').toLowerCase();
  if (/timed out|timeout|timed-out/.test(m)) return 504;
  if (/authentication|permission denied \(publickey\)|could not read from remote|invalid username|password/.test(m)) return 401;
  return fallback;
}
function sendErr(res, e, fallbackStatus) {
  const { status, body } = safeErr(e, fallbackStatus);
  if (res.headersSent) { try { res.end(); } catch {} return; }
  try { res.status(status).json(body); } catch {}
}


module.exports = { safeErr, sendErr, errText, gitErrText, gitErrStatus, redactPaths };
