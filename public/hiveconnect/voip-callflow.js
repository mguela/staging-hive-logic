// public/hiveconnect/voip-callflow.js
// Visual drag-and-drop Call Flow editor for HiveConnect VoIP inbound routing.
// Wired live: reads and writes the active call flow graph via /api/voice?resource=call_flow.
// Reuses VOIP_UI / voipEscapeHtml / voipApi / voipNotify from voip-panel.js.

(function () {
  'use strict';

  // Defensive: read the shared palette off window rather than the sibling
  // const directly. If voip-panel.js hasn't defined it yet (load-order or a
  // stale-cache mismatch after deploy), fall back to a copy so this IIFE can
  // NEVER throw at load — which would leave window.voipOpenCallFlowModal
  // undefined and make the "Open Call Flow Editor" button silently dead.
  var VOIP_UI = (typeof window !== 'undefined' && window.VOIP_UI) ? window.VOIP_UI : {
    green: '#1B7A50', greenBg: '#e6f2ec', greenBorder: '#bfe3d1',
    red: '#c65b4e', redBg: '#faeeec', redBorder: '#f0cec7',
    amber: '#b8791f', amberBg: '#fdf3e2', amberBorder: '#f2ddac',
    blue: '#3b6fd6', blueBg: '#eaf0fd', blueBorder: '#c9d9f7',
    gold: '#c9862e', goldDark: '#a86e22',
    gray: '#8b92a8', grayBg: '#f0f1f6', grayBorder: '#dadde8',
    ink: '#161e2e', sub: '#5d657b', line: '#e3e5ec',
    cardShadow: '0 14px 32px rgba(22,30,46,.09),0 4px 12px rgba(22,30,46,.06)',
    cardRadius: '16px',
  };

  var CF_NODE_TYPES = {
    call_in: {
      label: 'Call In',
      color: VOIP_UI.green, bg: VOIP_UI.greenBg, border: VOIP_UI.greenBorder,
      deletable: false,
      hint: 'Entry point. Every inbound call starts here.'
    },
    dispatch_active: {
      label: 'Ring Active Dispatch',
      color: VOIP_UI.blue, bg: VOIP_UI.blueBg, border: VOIP_UI.blueBorder,
      deletable: true,
      hint: 'Rings every extension currently marked as an active operator, all at once. First to answer gets the call.'
    },
    greeting_ivr: {
      label: 'Greeting + Extensions',
      color: VOIP_UI.gold, bg: VOIP_UI.amberBg, border: VOIP_UI.amberBorder,
      deletable: true,
      hint: 'Plays the open or closed greeting and lets the caller dial an extension.'
    },
    queue: {
      label: 'Call Queue',
      color: VOIP_UI.green, bg: VOIP_UI.greenBg, border: VOIP_UI.greenBorder,
      deletable: true,
      hint: 'Holds the caller in the General queue with hold music until an agent answers. On timeout the queue’s own overflow (callback / voicemail) takes over.'
    },
    voicemail: {
      label: 'Voicemail',
      color: VOIP_UI.gray, bg: VOIP_UI.grayBg, border: VOIP_UI.grayBorder,
      deletable: true,
      hint: 'Sends the caller to leave a voicemail. End of this path.'
    },
    hangup: {
      label: 'Hang Up',
      color: VOIP_UI.red, bg: VOIP_UI.redBg, border: VOIP_UI.redBorder,
      deletable: true,
      hint: 'Ends the call immediately. End of this path.'
    }
  };

  var CF_NODE_W = 220;
  var CF_NODE_H = 92;

  var cf = {
    root: null,
    canvas: null,
    svg: null,
    sidePanel: null,
    graph: null,
    selectedId: null,
    dirty: false,
    drag: null,
    connect: null,
    flowId: null,
    saving: false
  };

  function cfDefaultGraph() {
    return {
      nodes: [
        { id: 'start', type: 'call_in', x: 40, y: 160, label: 'Call In' }
      ],
      edges: []
    };
  }

  function cfNewId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }

  function cfFindNode(id) {
    return (cf.graph.nodes || []).find(function (n) { return n.id === id; }) || null;
  }

  function cfOutgoingEdge(fromId) {
    return (cf.graph.edges || []).find(function (e) { return e.from === fromId; }) || null;
  }

  function cfSetDirty(v) {
    cf.dirty = v;
    var saveBtn = cf.root && cf.root.querySelector('[data-cf-save]');
    if (saveBtn) {
      saveBtn.textContent = v ? 'Save changes' : 'Saved';
      saveBtn.disabled = !v || cf.saving;
    }
  }

  // ---------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------

  async function voipOpenCallFlowModal() {
    if (document.getElementById('cfModalBackdrop')) return;

    var backdrop = document.createElement('div');
    backdrop.id = 'cfModalBackdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(22,30,46,.55);z-index:9000;display:flex;align-items:stretch;justify-content:stretch;';
    backdrop.innerHTML = ''
      + '<div style="display:flex;flex-direction:column;width:100%;height:100%;background:#f7f8fb;">'
      + '  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#fff;border-bottom:1px solid ' + VOIP_UI.line + ';box-shadow:' + VOIP_UI.cardShadow + ';z-index:2;">'
      + '    <div>'
      + '      <div style="font-weight:700;font-size:17px;color:' + VOIP_UI.ink + ';">Call Flow Editor</div>'
      + '      <div style="font-size:12.5px;color:' + VOIP_UI.sub + ';">Drag nodes to arrange. Drag from the dot on the right edge of a node to connect it to what happens next.</div>'
      + '    </div>'
      + '    <div style="display:flex;gap:8px;align-items:center;">'
      + '      <button data-cf-save disabled style="padding:9px 16px;border-radius:10px;border:none;background:' + VOIP_UI.green + ';color:#fff;font-weight:600;font-size:13.5px;cursor:pointer;opacity:.55;">Saved</button>'
      + '      <button data-cf-close style="padding:9px 16px;border-radius:10px;border:1px solid ' + VOIP_UI.grayBorder + ';background:#fff;color:' + VOIP_UI.ink + ';font-weight:600;font-size:13.5px;cursor:pointer;">Close</button>'
      + '    </div>'
      + '  </div>'
      + '  <div style="flex:1;display:flex;min-height:0;">'
      + '    <div data-cf-palette style="width:200px;flex:none;background:#fff;border-right:1px solid ' + VOIP_UI.line + ';padding:14px;overflow-y:auto;"></div>'
      + '    <div data-cf-canvas-wrap style="flex:1;position:relative;overflow:auto;background:'
      +        'radial-gradient(circle, ' + VOIP_UI.grayBorder + ' 1px, transparent 1px) 0 0/18px 18px, #f7f8fb;">'
      + '      <div data-cf-canvas style="position:relative;width:1800px;height:1100px;"></div>'
      + '    </div>'
      + '    <div data-cf-side style="width:280px;flex:none;background:#fff;border-left:1px solid ' + VOIP_UI.line + ';padding:16px;overflow-y:auto;"></div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(backdrop);
    cf.root = backdrop;
    cf.canvas = backdrop.querySelector('[data-cf-canvas]');
    cf.sidePanel = backdrop.querySelector('[data-cf-side]');

    var svgNS = 'http://www.w3.org/2000/svg';
    cf.svg = document.createElementNS(svgNS, 'svg');
    cf.svg.setAttribute('width', '1800');
    cf.svg.setAttribute('height', '1100');
    cf.svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
    var marker = document.createElementNS(svgNS, 'defs');
    marker.innerHTML = '<marker id="cfArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + VOIP_UI.sub + '"></path></marker>';
    cf.svg.appendChild(marker);
    cf.canvas.appendChild(cf.svg);

    backdrop.querySelector('[data-cf-close]').addEventListener('click', voipCloseCallFlowModal);
    backdrop.querySelector('[data-cf-save]').addEventListener('click', cfSaveFlow);

    backdrop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') voipCloseCallFlowModal();
    });

    cfRenderPalette();
    cfRenderSidePanelEmpty();

    var res = await voipApi('?resource=call_flow', 'GET');
    var flow = res.ok && res.data && res.data.flow;
    if (flow && flow.graph && Array.isArray(flow.graph.nodes)) {
      cf.graph = flow.graph;
      cf.flowId = flow.id;
    } else {
      cf.graph = cfDefaultGraph();
      cf.flowId = null;
    }
    cfSetDirty(false);
    cfRenderNodes();
  }

  function voipCloseCallFlowModal() {
    if (cf.dirty) {
      var ok = window.confirm('You have unsaved changes to the call flow. Close without saving?');
      if (!ok) return;
    }
    var el = document.getElementById('cfModalBackdrop');
    if (el) el.remove();
    cf.root = null; cf.canvas = null; cf.svg = null; cf.sidePanel = null;
    cf.graph = null; cf.selectedId = null; cf.drag = null; cf.connect = null;
  }

  // ---------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------

  function cfRenderPalette() {
    var wrap = cf.root.querySelector('[data-cf-palette]');
    var html = '<div style="font-weight:700;font-size:12.5px;color:' + VOIP_UI.sub + ';text-transform:uppercase;letter-spacing:.03em;margin-bottom:10px;">Add a step</div>';
    Object.keys(CF_NODE_TYPES).forEach(function (type) {
      if (type === 'call_in') return;
      var def = CF_NODE_TYPES[type];
      html += '<button data-cf-add="' + type + '" style="display:block;width:100%;text-align:left;margin-bottom:8px;padding:10px 12px;border-radius:10px;border:1px solid ' + def.border + ';background:' + def.bg + ';color:' + VOIP_UI.ink + ';font-weight:600;font-size:13px;cursor:pointer;">'
        + voipEscapeHtml(def.label) + '</button>';
    });
    html += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid ' + VOIP_UI.line + ';font-size:12px;color:' + VOIP_UI.sub + ';line-height:1.5;">Click a step to add it to the canvas, then drag it into place and connect it.</div>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-cf-add]').forEach(function (btn) {
      btn.addEventListener('click', function () { cfAddNode(btn.getAttribute('data-cf-add')); });
    });
  }

  function cfAddNode(type) {
    var id = cfNewId(type);
    var count = cf.graph.nodes.length;
    var node = {
      id: id,
      type: type,
      x: 380 + (count % 4) * 40,
      y: 60 + Math.floor(count / 4) * 40 + (count % 3) * 60,
      label: CF_NODE_TYPES[type].label
    };
    if (type === 'dispatch_active') node.config = { ringSeconds: 20 };
    cf.graph.nodes.push(node);
    cfSetDirty(true);
    cfRenderNodes();
    cfSelectNode(id);
  }

  // ---------------------------------------------------------------------
  // Node rendering
  // ---------------------------------------------------------------------

  function cfRenderNodes() {
    Array.prototype.slice.call(cf.canvas.querySelectorAll('[data-cf-node]')).forEach(function (el) { el.remove(); });
    cf.graph.nodes.forEach(function (node) { cfRenderNode(node); });
    cfRedrawEdges();
  }

  function cfRenderNode(node) {
    var def = CF_NODE_TYPES[node.type] || CF_NODE_TYPES.hangup;
    var el = document.createElement('div');
    el.setAttribute('data-cf-node', node.id);
    el.style.cssText = 'position:absolute;left:' + node.x + 'px;top:' + node.y + 'px;width:' + CF_NODE_W + 'px;min-height:' + CF_NODE_H + 'px;'
      + 'background:' + def.bg + ';border:2px solid ' + def.border + ';border-radius:' + VOIP_UI.cardRadius + ';box-shadow:' + VOIP_UI.cardShadow + ';'
      + 'padding:12px 14px;cursor:grab;user-select:none;touch-action:none;';
    el.innerHTML = ''
      + '<div style="font-size:10.5px;font-weight:700;color:' + def.color + ';text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">' + voipEscapeHtml(def.label) + '</div>'
      + '<div data-cf-node-label style="font-size:14px;font-weight:700;color:' + VOIP_UI.ink + ';line-height:1.25;">' + voipEscapeHtml(node.label || def.label) + '</div>'
      + (node.type === 'dispatch_active' ? '<div style="font-size:11.5px;color:' + VOIP_UI.sub + ';margin-top:4px;">Rings ' + (node.config && node.config.ringSeconds || 20) + 's</div>' : '');

    // connector handle (every node can START a connection, including call_in)
    var connector = document.createElement('div');
    connector.setAttribute('data-cf-connector', node.id);
    connector.title = 'Drag to connect to the next step';
    connector.style.cssText = 'position:absolute;right:-9px;top:50%;transform:translateY(-50%);width:18px;height:18px;border-radius:50%;'
      + 'background:' + def.color + ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:crosshair;';
    el.appendChild(connector);

    cf.canvas.appendChild(el);

    el.addEventListener('pointerdown', function (e) {
      if (e.target === connector) return;
      cfStartDrag(e, node, el);
    });
    connector.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      cfStartConnect(e, node);
    });
    el.addEventListener('click', function (e) {
      if (cf.drag && cf.drag.moved) return;
      cfSelectNode(node.id);
    });
  }

  function cfNodeEl(id) {
    return cf.canvas.querySelector('[data-cf-node="' + id + '"]');
  }

  // ---------------------------------------------------------------------
  // Dragging nodes
  // ---------------------------------------------------------------------

  function cfStartDrag(e, node, el) {
    e.preventDefault();
    var wrap = cf.root.querySelector('[data-cf-canvas-wrap]');
    var startX = e.clientX, startY = e.clientY;
    var origX = node.x, origY = node.y;
    cf.drag = { node: node, el: el, moved: false };
    el.style.cursor = 'grabbing';
    el.style.zIndex = '5';

    function onMove(ev) {
      var dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cf.drag.moved = true;
      node.x = Math.max(0, origX + dx);
      node.y = Math.max(0, origY + dy);
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      cfRedrawEdges();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      el.style.cursor = 'grab';
      el.style.zIndex = '';
      if (cf.drag && cf.drag.moved) cfSetDirty(true);
      cf.drag = null;
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ---------------------------------------------------------------------
  // Connecting nodes (drag from connector dot to another node)
  // ---------------------------------------------------------------------

  function cfStartConnect(e, fromNode) {
    e.preventDefault();
    var svgNS = 'http://www.w3.org/2000/svg';
    var line = document.createElementNS(svgNS, 'line');
    line.setAttribute('stroke', VOIP_UI.blue);
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-dasharray', '5,4');
    cf.svg.appendChild(line);
    cf.connect = { from: fromNode, line: line };

    var canvasRect = cf.canvas.getBoundingClientRect();

    function pt(clientX, clientY) {
      return { x: clientX - canvasRect.left, y: clientY - canvasRect.top };
    }

    function onMove(ev) {
      var start = cfPortPoint(fromNode, 'out');
      var p = pt(ev.clientX, ev.clientY);
      line.setAttribute('x1', start.x); line.setAttribute('y1', start.y);
      line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);
      var hoverEl = document.elementFromPoint(ev.clientX, ev.clientY);
      var hoverNodeEl = hoverEl && hoverEl.closest && hoverEl.closest('[data-cf-node]');
      Array.prototype.slice.call(cf.canvas.querySelectorAll('[data-cf-node]')).forEach(function (n) { n.style.outline = ''; });
      if (hoverNodeEl && hoverNodeEl.getAttribute('data-cf-node') !== fromNode.id) {
        hoverNodeEl.style.outline = '3px solid ' + VOIP_UI.blue;
      }
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      Array.prototype.slice.call(cf.canvas.querySelectorAll('[data-cf-node]')).forEach(function (n) { n.style.outline = ''; });
      line.remove();
      cf.connect = null;
      var dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
      var targetEl = dropEl && dropEl.closest && dropEl.closest('[data-cf-node]');
      if (targetEl) {
        var toId = targetEl.getAttribute('data-cf-node');
        if (toId !== fromNode.id) {
          cfConnect(fromNode.id, toId);
        }
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function cfConnect(fromId, toId) {
    cf.graph.edges = (cf.graph.edges || []).filter(function (e) { return e.from !== fromId; });
    cf.graph.edges.push({ id: cfNewId('e'), from: fromId, to: toId });
    cfSetDirty(true);
    cfRedrawEdges();
  }

  function cfPortPoint(node, side) {
    var x = side === 'out' ? node.x + CF_NODE_W : node.x;
    var y = node.y + CF_NODE_H / 2;
    return { x: x, y: y };
  }

  function cfRedrawEdges() {
    Array.prototype.slice.call(cf.svg.querySelectorAll('[data-cf-edge]')).forEach(function (el) { el.remove(); });
    var svgNS = 'http://www.w3.org/2000/svg';
    (cf.graph.edges || []).forEach(function (edge) {
      var from = cfFindNode(edge.from), to = cfFindNode(edge.to);
      if (!from || !to) return;
      var p1 = cfPortPoint(from, 'out');
      var p2 = cfPortPoint(to, 'in');
      var midX = (p1.x + p2.x) / 2;
      var d = 'M ' + p1.x + ' ' + p1.y + ' C ' + midX + ' ' + p1.y + ', ' + midX + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('data-cf-edge', edge.id);
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', VOIP_UI.sub);
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('marker-end', 'url(#cfArrow)');
      cf.svg.appendChild(path);
    });
  }

  // ---------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------

  function cfRenderSidePanelEmpty() {
    cf.sidePanel.innerHTML = '<div style="font-size:13px;color:' + VOIP_UI.sub + ';line-height:1.5;">Select a step to edit it, or add a new step from the left panel.</div>';
  }

  function cfSelectNode(id) {
    cf.selectedId = id;
    var node = cfFindNode(id);
    if (!node) { cfRenderSidePanelEmpty(); return; }
    var def = CF_NODE_TYPES[node.type] || CF_NODE_TYPES.hangup;

    var html = '<div style="font-size:11px;font-weight:700;color:' + def.color + ';text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px;">' + voipEscapeHtml(def.label) + '</div>'
      + '<div style="font-size:12.5px;color:' + VOIP_UI.sub + ';margin-bottom:16px;line-height:1.5;">' + voipEscapeHtml(def.hint) + '</div>'
      + '<label style="display:block;font-size:12px;font-weight:600;color:' + VOIP_UI.ink + ';margin-bottom:6px;">Label</label>'
      + '<input data-cf-label value="' + voipEscapeHtml(node.label || '') + '" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid ' + VOIP_UI.grayBorder + ';font-size:13.5px;margin-bottom:16px;box-sizing:border-box;">';

    if (node.type === 'dispatch_active') {
      html += '<label style="display:block;font-size:12px;font-weight:600;color:' + VOIP_UI.ink + ';margin-bottom:6px;">Ring time before falling through (seconds)</label>'
        + '<input data-cf-ring type="number" min="5" max="60" value="' + ((node.config && node.config.ringSeconds) || 20) + '" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid ' + VOIP_UI.grayBorder + ';font-size:13.5px;margin-bottom:8px;box-sizing:border-box;">'
        + '<div style="font-size:11.5px;color:' + VOIP_UI.sub + ';margin-bottom:16px;line-height:1.5;">"Active" means an extension currently flagged as an operator and active in Settings. There is no separate on-duty toggle yet.</div>';
    }
    if (node.type === 'call_in') {
      html += '<div style="font-size:11.5px;color:' + VOIP_UI.sub + ';margin-bottom:16px;line-height:1.5;">This is the fixed starting point. It cannot be moved off the canvas or deleted.</div>';
    }

    var outgoing = cfOutgoingEdge(node.id);
    var outNode = outgoing ? cfFindNode(outgoing.to) : null;
    html += '<div style="font-size:12px;font-weight:600;color:' + VOIP_UI.ink + ';margin-bottom:6px;">Then goes to</div>'
      + '<div style="font-size:13px;color:' + (outNode ? VOIP_UI.ink : VOIP_UI.sub) + ';margin-bottom:16px;padding:9px 10px;border-radius:8px;background:' + VOIP_UI.grayBg + ';">'
      + (outNode ? voipEscapeHtml(outNode.label || CF_NODE_TYPES[outNode.type].label) : 'Nothing connected yet - drag from the dot on this node to connect it.')
      + '</div>';

    if (def.deletable) {
      html += '<button data-cf-delete style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid ' + VOIP_UI.redBorder + ';background:' + VOIP_UI.redBg + ';color:' + VOIP_UI.red + ';font-weight:600;font-size:13px;cursor:pointer;margin-top:8px;">Delete this step</button>';
    }

    cf.sidePanel.innerHTML = html;

    var labelInput = cf.sidePanel.querySelector('[data-cf-label]');
    labelInput.addEventListener('input', function () {
      node.label = labelInput.value;
      var el = cfNodeEl(node.id);
      if (el) {
        var labelEl = el.querySelector('[data-cf-node-label]');
        if (labelEl) labelEl.textContent = node.label || def.label;
      }
      cfSetDirty(true);
    });

    var ringInput = cf.sidePanel.querySelector('[data-cf-ring]');
    if (ringInput) {
      ringInput.addEventListener('input', function () {
        node.config = node.config || {};
        node.config.ringSeconds = Math.max(5, Math.min(60, parseInt(ringInput.value, 10) || 20));
        cfRenderNodes();
        cfSelectNode(node.id);
        cfSetDirty(true);
      });
    }

    var deleteBtn = cf.sidePanel.querySelector('[data-cf-delete]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () { cfDeleteNode(node.id); });
    }
  }

  function cfDeleteNode(id) {
    var node = cfFindNode(id);
    if (!node || !CF_NODE_TYPES[node.type].deletable) return;
    cf.graph.nodes = cf.graph.nodes.filter(function (n) { return n.id !== id; });
    cf.graph.edges = (cf.graph.edges || []).filter(function (e) { return e.from !== id && e.to !== id; });
    cf.selectedId = null;
    cfSetDirty(true);
    cfRenderNodes();
    cfRenderSidePanelEmpty();
  }

  // ---------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------

  function cfValidate() {
    var callIns = cf.graph.nodes.filter(function (n) { return n.type === 'call_in'; });
    if (callIns.length !== 1) return 'There must be exactly one Call In step.';
    var ids = {};
    for (var i = 0; i < cf.graph.nodes.length; i++) {
      var n = cf.graph.nodes[i];
      if (ids[n.id]) return 'Duplicate step id found. Try refreshing the editor.';
      ids[n.id] = true;
    }
    return null;
  }

  async function cfSaveFlow() {
    var err = cfValidate();
    if (err) { voipNotify(err); return; }
    if (cf.saving) return;
    cf.saving = true;
    var btn = cf.root.querySelector('[data-cf-save]');
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
    var res = await voipApi('?resource=call_flow', 'POST', { name: 'Main Inbound Flow', graph: { nodes: cf.graph.nodes, edges: cf.graph.edges } });
    cf.saving = false;
    if (res.ok) {
      cf.flowId = res.data && res.data.id;
      cfSetDirty(false);
      voipNotify('Call flow saved. It is now live for new calls.');
    } else {
      voipNotify('Could not save: ' + ((res.data && res.data.error) || 'unknown error'));
      if (btn) { btn.textContent = 'Save changes'; btn.disabled = false; }
    }
  }

  window.voipOpenCallFlowModal = voipOpenCallFlowModal;
  window.voipCloseCallFlowModal = voipCloseCallFlowModal;

  // Backup: a single delegated listener so the "Open Call Flow Editor" button
  // works even if its per-render addEventListener wiring in voip-panel.js was
  // skipped (e.g. an earlier wire threw). Guarded so it never double-fires.
  try {
    document.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('.voip-callflow-open-btn') : null;
      if (!btn) return;
      e.preventDefault();
      if (typeof window.voipOpenCallFlowModal === 'function') window.voipOpenCallFlowModal();
    });
  } catch (e) {}
})();
