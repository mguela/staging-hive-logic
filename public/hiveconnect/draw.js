/* public/labs/cowork/lib/draw.js
 * Cowork — professional annotation engine. A vector board with a deep tool set,
 * full style controls (stroke, fill, width, opacity, dash), z-order, per-user
 * undo/redo, and hit-testing. Transport-agnostic + node-testable.
 *
 * Tools: select, pan, pen, marker, line, arrow, darrow, rect, rrect, ellipse,
 *        diamond, triangle, star, text, sticky, callout, stamp, laser.
 * Style: color, fill, width, opacity, dash('solid'|'dashed'|'dotted').
 */
'use strict';

var TOOLS = ['select', 'pan', 'pen', 'marker', 'line', 'arrow', 'darrow', 'rect', 'rrect', 'ellipse', 'diamond', 'triangle', 'star', 'text', 'sticky', 'callout', 'stamp', 'laser'];
var TWO_POINT = { line: 1, arrow: 1, darrow: 1, rect: 1, rrect: 1, ellipse: 1, diamond: 1, triangle: 1, star: 1, callout: 1 };
var FREEHAND = { pen: 1, marker: 1, laser: 1 };
// A refined, professional palette (not primary-bright).
var PALETTE = ['#1f2733', '#c65b4e', '#d08b4c', '#1B7A50', '#2f5d8a', '#748a9e', '#5f6578', '#ffffff'];
var DASHES = { solid: [], dashed: [10, 8], dotted: [2, 6] };

function DrawError(m) { this.name = 'DrawError'; this.message = m; }
DrawError.prototype = Object.create(Error.prototype);

function makeShape(uid, seq, tool, opts) {
  opts = opts || {};
  return {
    id: uid + ':' + seq, uid: uid, tool: tool, z: opts.z || 0,
    color: opts.color || '#1f2733', fill: opts.fill || null,
    width: opts.width == null ? 3 : opts.width, opacity: opts.opacity == null ? 1 : opts.opacity,
    dash: opts.dash || 'solid',
    points: opts.points ? opts.points.slice() : [],
    text: opts.text || '', emoji: opts.emoji || '', fontSize: opts.fontSize || 18, seq: seq
  };
}
function serialize(s) { return JSON.stringify(s); }
function deserialize(str) { var s = JSON.parse(str); if (!s || !s.id || !Array.isArray(s.points)) throw new DrawError('bad shape'); return s; }

function createBoard() {
  var shapes = [], undo = {};
  function nextZ() { return shapes.reduce(function (m, s) { return Math.max(m, s.z || 0); }, 0) + 1; }
  function add(s) { if (!s.z) s.z = nextZ(); shapes.push(s); if (undo[s.uid]) undo[s.uid] = []; return s; }
  function undoOwn(uid) { for (var i = shapes.length - 1; i >= 0; i--) if (shapes[i].uid === uid) { var s = shapes.splice(i, 1)[0]; (undo[uid] = undo[uid] || []).push(s); return s; } return null; }
  function redoOwn(uid) { var st = undo[uid]; if (st && st.length) { var s = st.pop(); shapes.push(s); return s; } return null; }
  function removeById(id) { for (var i = 0; i < shapes.length; i++) if (shapes[i].id === id) return shapes.splice(i, 1)[0]; return null; }
  function bringToFront(id) { var s = removeById(id); if (s) { s.z = nextZ(); shapes.push(s); } return s; }
  function sendToBack(id) { var s = removeById(id); if (s) { var mn = shapes.reduce(function (m, x) { return Math.min(m, x.z || 0); }, 0); s.z = mn - 1; shapes.unshift(s); } return s; }
  function duplicate(id, uid, seq) { var s = shapes.filter(function (x) { return x.id === id; })[0]; if (!s) return null; var c = JSON.parse(JSON.stringify(s)); c.id = uid + ':' + seq; c.uid = uid; c.z = nextZ(); c.points = c.points.map(function (p) { return { x: p.x + 14, y: p.y + 14 }; }); shapes.push(c); return c; }
  function clearAll(ctx) { if (!ctx || !ctx.isPresenter) throw new DrawError('clear-all requires presenter role'); shapes.length = 0; return true; }
  function hitTest(x, y, pad) { pad = pad || 8; var ordered = list(); for (var i = ordered.length - 1; i >= 0; i--) if (bboxHit(ordered[i], x, y, pad)) return ordered[i]; return null; }
  function applyRemote(env) {
    if (!env) return false;
    if (env.t === 'draw:add') { shapes.push(env.payload); return true; }
    if (env.t === 'draw:update') { var ex = shapes.filter(function (s) { return s.id === env.payload.id; })[0]; if (ex) Object.assign(ex, env.payload); return true; }
    if (env.t === 'draw:undo') { removeById(env.payload && env.payload.id); return true; }
    if (env.t === 'draw:redo') { shapes.push(env.payload); return true; }
    if (env.t === 'draw:clear') { shapes.length = 0; return true; }
    return false;
  }
  function list() { return shapes.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }); }
  function count() { return shapes.length; }
  return { add: add, undoOwn: undoOwn, redoOwn: redoOwn, removeById: removeById, duplicate: duplicate, bringToFront: bringToFront, sendToBack: sendToBack, clearAll: clearAll, hitTest: hitTest, applyRemote: applyRemote, list: list, count: count };
}

function bbox(s) { if (!s.points.length) return { x: 0, y: 0, w: 0, h: 0 }; var xs = s.points.map(function (p) { return p.x; }), ys = s.points.map(function (p) { return p.y; }); var a = Math.min.apply(null, xs), b = Math.min.apply(null, ys); return { x: a, y: b, w: Math.max.apply(null, xs) - a, h: Math.max.apply(null, ys) - b }; }
function bboxHit(s, x, y, pad) { var r = bbox(s); return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad; }

function polyPath(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath(); }
function starPts(cx, cy, rO, rI) { var out = []; for (var i = 0; i < 10; i++) { var a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? rI : rO; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } return out; }
function roundRect(ctx, x, y, w, h, r) { r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function head(ctx, from, to, size) { var a = Math.atan2(to.y - from.y, to.x - from.x); size = size || 13; ctx.beginPath(); ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - size * Math.cos(a - Math.PI / 7), to.y - size * Math.sin(a - Math.PI / 7)); ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - size * Math.cos(a + Math.PI / 7), to.y - size * Math.sin(a + Math.PI / 7)); ctx.stroke(); }

function renderShape(ctx, s) {
  var p = s.points; if (!p.length) return;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.globalAlpha = s.tool === 'marker' ? 0.3 * (s.opacity == null ? 1 : s.opacity) : (s.opacity == null ? 1 : s.opacity);
  ctx.strokeStyle = s.color; ctx.fillStyle = s.fill || s.color;
  ctx.lineWidth = s.tool === 'marker' ? s.width * 5 : s.width;
  ctx.setLineDash(DASHES[s.dash] || []);
  var r = bbox(s), cx = r.x + r.w / 2, cy = r.y + r.h / 2, t = s.tool;
  function fillStroke(hasFill) { if (hasFill && s.fill) { ctx.fill(); } ctx.setLineDash(DASHES[s.dash] || []); ctx.stroke(); }
  if (t === 'pen' || t === 'marker' || t === 'laser') { ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); for (var j = 1; j < p.length; j++) ctx.lineTo(p[j].x, p[j].y); ctx.stroke(); }
  else if (t === 'line') { ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y); ctx.stroke(); }
  else if (t === 'arrow') { var a = p[0], b = p[p.length - 1]; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]); head(ctx, a, b, s.width * 3 + 7); }
  else if (t === 'darrow') { var a2 = p[0], b2 = p[p.length - 1]; ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.stroke(); ctx.setLineDash([]); head(ctx, a2, b2, s.width * 3 + 7); head(ctx, b2, a2, s.width * 3 + 7); }
  else if (t === 'rect') { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); fillStroke(true); }
  else if (t === 'rrect' || t === 'sticky' || t === 'callout') { roundRect(ctx, r.x, r.y, r.w, r.h, t === 'sticky' ? 6 : 12); if (t === 'sticky') { ctx.fillStyle = s.fill || '#ffe9a8'; ctx.fill(); } else fillStroke(true); if (s.text) { ctx.setLineDash([]); ctx.globalAlpha = s.opacity == null ? 1 : s.opacity; ctx.fillStyle = t === 'sticky' ? '#3a2f12' : s.color; ctx.font = '600 ' + s.fontSize + 'px Montserrat,sans-serif'; ctx.textBaseline = 'top'; wrapText(ctx, s.text, r.x + 8, r.y + 8, r.w - 16, s.fontSize * 1.3); } }
  else if (t === 'ellipse') { ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, 2 * Math.PI); fillStroke(true); }
  else if (t === 'diamond') { polyPath(ctx, [{ x: cx, y: r.y }, { x: r.x + r.w, y: cy }, { x: cx, y: r.y + r.h }, { x: r.x, y: cy }]); fillStroke(true); }
  else if (t === 'triangle') { polyPath(ctx, [{ x: cx, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]); fillStroke(true); }
  else if (t === 'star') { polyPath(ctx, starPts(cx, cy, Math.max(Math.abs(r.w), Math.abs(r.h)) / 2, Math.max(Math.abs(r.w), Math.abs(r.h)) / 4.4)); fillStroke(true); }
  else if (t === 'text') { ctx.globalAlpha = s.opacity == null ? 1 : s.opacity; ctx.font = '600 ' + s.fontSize + 'px Montserrat,sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = s.color; ctx.fillText(s.text || '', p[0].x, p[0].y); }
  else if (t === 'stamp') { ctx.globalAlpha = 1; ctx.font = (s.fontSize * 1.9) + 'px serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(s.emoji || '⭐', p[0].x, p[0].y); }
  ctx.restore();
}
function wrapText(ctx, text, x, y, maxW, lh) { var words = String(text).split(/\s+/), line = '', yy = y; for (var i = 0; i < words.length; i++) { var test = line ? line + ' ' + words[i] : words[i]; if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = words[i]; yy += lh; } else line = test; } if (line) ctx.fillText(line, x, yy); }
function render(ctx, shapes) { for (var i = 0; i < shapes.length; i++) renderShape(ctx, shapes[i]); return shapes.length; }

var Draw = {
  TOOLS: TOOLS, TWO_POINT: TWO_POINT, FREEHAND: FREEHAND, PALETTE: PALETTE, DASHES: DASHES, DrawError: DrawError,
  makeShape: makeShape, serialize: serialize, deserialize: deserialize, createBoard: createBoard, render: render, renderShape: renderShape, bbox: bbox
};
if (typeof module !== 'undefined' && module.exports) { module.exports = Draw; }
if (typeof window !== 'undefined') { window.CoworkDraw = Draw; }
