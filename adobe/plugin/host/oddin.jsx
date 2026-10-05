// ODDIN host helpers for Premiere Pro and After Effects (ExtendScript).
// Keep this file ASCII only: Premiere loads it without UTF-8 and one non-ASCII
// character (even in a comment) breaks every command.
// Commands from ODDIN arrive as ODDIN.run(function () { ...agent script... }).

var ODDIN = (typeof ODDIN === 'object' && ODDIN) ? ODDIN : {};
ODDIN.version = '1.1.0';

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

// ---------------------------------------------------------------------------
// Named commands (ODDIN.pr.* for Premiere, ODDIN.ae.* for After Effects).
// Agents call them through scripts/adobe.mjs op <app> <name> '<json args>'.
// Outputs never overwrite an existing file unless args.overwrite is true.
// ---------------------------------------------------------------------------
ODDIN.must = function (v, msg) { if (!v) throw new Error(msg); return v; };
ODDIN.outFile = function (p, overwrite) {
  var f = new File(p);
  ODDIN.must(f.parent && f.parent.exists, 'Output folder missing: ' + p);
  if (f.exists) { ODDIN.must(overwrite, 'File already exists (pass overwrite:true to replace): ' + p); f.remove(); }
  return f;
};
ODDIN.secs = function (t) { try { return t ? Number(t.seconds) : 0; } catch (e) { return 0; } };

ODDIN.pr = {
  // Project, sequences and the active sequence in one call.
  status: function () {
    var p = app.project, out = { project: p ? String(p.path) : '', sequences: [], active: null };
    if (!p) return out;
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      out.sequences.push({ id: String(s.sequenceID), name: String(s.name), seconds: ODDIN.secs(s.end) - ODDIN.secs(s.zeroPoint), video: s.videoTracks.numTracks, audio: s.audioTracks.numTracks });
    }
    if (p.activeSequence) out.active = String(p.activeSequence.sequenceID);
    return out;
  },
  sequence: function (a) {
    var p = app.project; a = a || {};
    if (!a.id && !a.name) return ODDIN.must(p.activeSequence, 'No active sequence');
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      if ((a.id && String(s.sequenceID) === String(a.id)) || (a.name && String(s.name) === String(a.name))) return s;
    }
    throw new Error('Sequence not found');
  },
  open: function (a) { ODDIN.must(new File(a.path).exists, 'Project file missing: ' + a.path); app.openDocument(a.path, true, true, true, true); return { project: String(app.project.path) }; },
  save: function () { app.project.save(); return { saved: String(app.project.path) }; },
  saveAs: function (a) { var f = ODDIN.outFile(a.path, a.overwrite); app.project.saveAs(f.fsName); return { saved: f.fsName }; },
  // Find a project item by its media path, importing it if it is not in the project yet.
  item: function (path) {
    function find(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === 2) { var f = find(it); if (f) return f; }
        else { try { if (new File(it.getMediaPath()).fsName === new File(path).fsName) return it; } catch (e) {} }
      }
      return null;
    }
    var found = find(app.project.rootItem);
    if (!found) { ODDIN.must(app.project.importFiles([path], true, app.project.rootItem, false), 'Import failed: ' + path); found = find(app.project.rootItem); }
    return ODDIN.must(found, 'Media not found after import: ' + path);
  },
  importFiles: function (a) { var names = []; for (var i = 0; i < a.paths.length; i++) names.push(String(ODDIN.pr.item(a.paths[i]).name)); return { imported: names }; },
  newSequence: function (a) {
    var s = app.project.createNewSequenceFromClips(a.name, [ODDIN.pr.item(a.fromClip)], app.project.rootItem);
    ODDIN.must(s, 'Sequence was not created');
    return { id: String(s.sequenceID), name: String(s.name) };
  },
  setActive: function (a) { var s = ODDIN.pr.sequence(a); app.project.openSequence(s.sequenceID); return { active: String(s.sequenceID) }; },
  clips: function (a) {
    a = a || {}; var s = ODDIN.pr.sequence(a), out = [];
    var groups = [['video', s.videoTracks], ['audio', s.audioTracks]];
    for (var g = 0; g < groups.length; g++) {
      var tracks = groups[g][1];
      for (var t = 0; t < tracks.numTracks; t++) {
        var tr = tracks[t];
        for (var c = 0; c < tr.clips.numItems; c++) {
          var cl = tr.clips[c], media = '';
          try { media = String(cl.projectItem.getMediaPath()); } catch (e) {}
          out.push({ kind: groups[g][0], track: t, name: String(cl.name), start: ODDIN.secs(cl.start), end: ODDIN.secs(cl.end), media: media });
        }
      }
    }
    return out;
  },
  // Overwrite (default) or insert a media file on a track at a time in seconds.
  place: function (a) {
    var s = ODDIN.pr.sequence(a), item = ODDIN.pr.item(a.path), tracks = a.audio ? s.audioTracks : s.videoTracks, i = a.track || 0;
    ODDIN.must(i < tracks.numTracks, 'Track missing: ' + i);
    if (a.insert) tracks[i].insertClip(item, a.at || 0); else tracks[i].overwriteClip(item, a.at || 0);
    return { placed: String(item.name), track: i, at: a.at || 0 };
  },
  marker: function (a) {
    var s = ODDIN.pr.sequence(a), m = s.markers.createMarker(a.at || 0);
    if (a.name) m.name = a.name;
    if (a.comment) m.comments = a.comment;
    return { at: a.at || 0 };
  },
  // Render the sequence directly with an .epr preset (blocks until done).
  exportMedia: function (a) {
    var s = ODDIN.pr.sequence(a), f = ODDIN.outFile(a.out, a.overwrite);
    ODDIN.must(new File(a.preset).exists, 'Preset (.epr) missing: ' + a.preset);
    var code = s.exportAsMediaDirect(f.fsName, a.preset, a.workArea ? 1 : 0);
    ODDIN.must((Number(code) === 0 || String(code) === 'No Error') && f.exists && f.length > 0, 'Export failed: ' + code);
    return { out: f.fsName, bytes: f.length };
  }
};

ODDIN.ae = {
  comp: function (id) {
    for (var i = 1; i <= app.project.numItems; i++) { var c = app.project.item(i); if (c instanceof CompItem && (c.id === Number(id) || c.name === String(id))) return c; }
    throw new Error('Composition not found: ' + id);
  },
  status: function () {
    var out = { project: app.project.file ? app.project.file.fsName : '', comps: [], active: null, rendering: app.project.renderQueue.rendering };
    for (var i = 1; i <= app.project.numItems; i++) {
      var c = app.project.item(i);
      if (c instanceof CompItem) out.comps.push({ id: c.id, name: String(c.name), width: c.width, height: c.height, seconds: c.duration, fps: c.frameRate, layers: c.numLayers });
    }
    if (app.project.activeItem && app.project.activeItem instanceof CompItem) out.active = app.project.activeItem.id;
    return out;
  },
  open: function (a) { var f = new File(a.path); ODDIN.must(f.exists, 'Project file missing: ' + a.path); app.open(f); return { project: app.project.file.fsName }; },
  save: function (a) {
    if (a && a.path) { var f = ODDIN.outFile(a.path, a.overwrite); app.project.save(f); return { saved: f.fsName }; }
    ODDIN.must(app.project.file, 'Project has never been saved (pass path)');
    app.project.save();
    return { saved: app.project.file.fsName };
  },
  newComp: function (a) {
    var c = app.project.items.addComp(a.name || 'ODDIN', a.width || 1920, a.height || 1080, a.pixelAspect || 1, a.seconds || 10, a.fps || 30);
    return { id: c.id, name: String(c.name) };
  },
  importFile: function (a) { var item = app.project.importFile(new ImportOptions(new File(a.path))); return { id: item.id, name: String(item.name) }; },
  layers: function (a) {
    var c = ODDIN.ae.comp(a.comp), out = [];
    for (var i = 1; i <= c.numLayers; i++) { var l = c.layer(i); out.push({ index: i, name: String(l.name), inPoint: l.inPoint, outPoint: l.outPoint, enabled: l.enabled }); }
    return out;
  },
  addLayer: function (a) {
    var c = ODDIN.ae.comp(a.comp), item = null;
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).id === Number(a.item)) item = app.project.item(i); }
    ODDIN.must(item, 'Item not found: ' + a.item);
    var l = c.layers.add(item);
    if (a.at) l.startTime = a.at;
    return { index: l.index, name: String(l.name) };
  },
  addText: function (a) {
    var c = ODDIN.ae.comp(a.comp), l = c.layers.addText(a.text || '');
    if (a.position) l.property('ADBE Transform Group').property('ADBE Position').setValue(a.position);
    return { index: l.index };
  },
  // PNG of one frame.
  frame: function (a) { var c = ODDIN.ae.comp(a.comp), f = ODDIN.outFile(a.out, a.overwrite); c.saveFrameToPng(a.at || 0, f); return { out: f.fsName }; },
  // Add the comp to the render queue and render it (blocks until done).
  render: function (a) {
    var c = ODDIN.ae.comp(a.comp), f = ODDIN.outFile(a.out, a.overwrite), q = app.project.renderQueue;
    var item = q.items.add(c);
    if (a.template) item.outputModule(1).applyTemplate(a.template);
    item.outputModule(1).file = f;
    q.render();
    return { out: f.fsName, exists: f.exists };
  }
};
