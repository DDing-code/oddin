// ODDIN host helpers for Premiere Pro and After Effects (ExtendScript).
// Keep this file ASCII only: Premiere loads it without UTF-8 and one non-ASCII
// character (even in a comment) breaks every command.
// Commands from ODDIN arrive as ODDIN.run(function () { ...agent script... }).

var ODDIN = (typeof ODDIN === 'object' && ODDIN) ? ODDIN : {};
ODDIN.version = '1.0.0';

ODDIN.quote = function (s) {
  var out = '"', i, c, code, hex;
  s = String(s);
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i); code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32 || code > 126) { hex = code.toString(16); while (hex.length < 4) hex = '0' + hex; out += '\\u' + hex; }
    else out += c;
  }
  return out + '"';
};

ODDIN.json = function (v, depth) {
  var t, parts, k, i;
  depth = depth || 0;
  if (depth > 12) return 'null';
  if (v === null || v === undefined) return 'null';
  t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return ODDIN.quote(v);
  if (t === 'function') return 'null';
  if (v instanceof Date) return ODDIN.quote(v.toString());
  if (v instanceof File || v instanceof Folder) return ODDIN.quote(v.fsName);
  if (v instanceof Array) {
    parts = [];
    for (i = 0; i < v.length; i++) parts.push(ODDIN.json(v[i], depth + 1));
    return '[' + parts.join(',') + ']';
  }
  parts = [];
  try {
    for (k in v) {
      try {
        if (v.hasOwnProperty && !v.hasOwnProperty(k)) continue;
        if (typeof v[k] === 'function') continue;
        parts.push(ODDIN.quote(k) + ':' + ODDIN.json(v[k], depth + 1));
      } catch (e1) {}
    }
  } catch (e2) { return ODDIN.quote(String(v)); }
  return '{' + parts.join(',') + '}';
};

ODDIN.run = function (fn) {
  var r;
  try {
    r = fn();
    return ODDIN.json({ ok: true, result: (r === undefined ? null : r) });
  } catch (e) {
    return ODDIN.json({ ok: false, error: String((e && e.message) || e), line: (e && e.line) || null });
  }
};

// Short description of what is open right now (used for the status line).
ODDIN.info = function () {
  var o = { app: BridgeTalk.appName, version: String(app.version), project: '', item: '' };
  try {
    if (BridgeTalk.appName === 'premierepro') {
      o.project = (app.project && app.project.path) ? String(app.project.path) : '';
      o.item = (app.project && app.project.activeSequence) ? String(app.project.activeSequence.name) : '';
    } else {
      o.project = (app.project && app.project.file) ? String(app.project.file.fsName) : '';
      o.item = (app.project && app.project.activeItem && app.project.activeItem instanceof CompItem) ? String(app.project.activeItem.name) : '';
    }
  } catch (e) {}
  return o;
};
