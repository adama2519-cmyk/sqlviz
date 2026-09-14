/* SQLViz — application controller */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const editor = $('#sql-input');
  const svg = $('#diagram');
  const summaryEl = $('#summary');
  const errorsEl = $('#errors');
  const detailEl = $('#detail');
  const detailBody = $('#detail-body');
  const detailClose = $('#detail-close');

  let state = { tables: [], edges: [], dia: null, vb: null, selected: null };

  // ---- edge model ----------------------------------------------------------
  function buildEdges(tables) {
    const byName = {};
    tables.forEach((t, i) => byName[t.fullName.toLowerCase()] = i);
    const edges = [];
    const seen = new Set();
    const push = (e) => {
      const key = e.source + '|' + e.sourceCol + '|' + e.target + '|' + e.targetCol;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(e);
    };
    tables.forEach((t, i) => {
      t.columns.forEach(c => {
        if (c.references) {
          const ti = byName[(c.references.table || '').toLowerCase()];
          if (ti !== undefined && ti !== i) push({ source: i, sourceCol: c.name, target: ti, targetCol: c.references.column || null });
        }
      });
      t.foreignKeys.forEach(fk => {
        const ti = byName[(fk.refTable || '').toLowerCase()];
        if (ti !== undefined) push({ source: i, sourceCol: fk.columns[0] || null, target: ti, targetCol: fk.refColumns[0] || null });
      });
    });
    return edges;
  }

  // ---- helpers -------------------------------------------------------------
  function clientToContent(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const r = pt.matrixTransform(ctm.inverse());
    return { x: r.x, y: r.y };
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), filename);
  }

  // ---- render --------------------------------------------------------------
  function render() {
    const parsed = SQLParser.parseSQL(editor.value);
    state.tables = parsed.tables;
    state.edges = buildEdges(parsed.tables);
    state.selected = null;

    const W = Math.max(1200, svg.clientWidth * 1.4);
    const H = Math.max(900, svg.clientHeight * 1.4);
    const dia = Diagram.buildDiagram(svg, { tables: state.tables, edges: state.edges }, { width: W, height: H });
    state.dia = dia;
    state.vb = Object.assign({}, dia.fit);
    Diagram.setViewBox(svg, state.vb);

    // adjacency for edge updates
    const nodeToEdges = {};
    dia.edgeEls.forEach(e => {
      (nodeToEdges[e.a] = nodeToEdges[e.a] || []).push(e);
      (nodeToEdges[e.b] = nodeToEdges[e.b] || []).push(e);
    });
    state.nodeToEdges = nodeToEdges;

    wireInteractions(dia);

    // summary
    const colCount = state.tables.reduce((s, t) => s + t.columns.length, 0);
    summaryEl.textContent = state.tables.length + ' tables · ' + colCount + ' columns · ' + state.edges.length + ' relationships';
    renderErrors(parsed.errors);
    renderDetail(null);
    updateEmpty();
  }

  function updateEmpty() {
    const empty = $('#empty-hint');
    if (empty) empty.style.display = state.tables.length ? 'none' : 'flex';
  }

  function renderErrors(errors) {
    if (!errors || !errors.length) { errorsEl.innerHTML = ''; errorsEl.style.display = 'none'; return; }
    errorsEl.style.display = 'block';
    errorsEl.innerHTML = '<strong>Parse issues</strong>' +
      errors.map(e => '<div class="err">' + Diagram.esc(e.error) + ' — ' + Diagram.esc(e.stmt) + '</div>').join('');
  }

  // ---- interactions --------------------------------------------------------
  function wireInteractions(dia) {
    let mode = null; // 'node' | 'pan'
    let drag = null;

    svg.onwheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const p = clientToContent(e.clientX, e.clientY);
      state.vb = Diagram.zoomAt(svg, state.vb, factor, p.x, p.y);
    };

    svg.onpointerdown = (e) => {
      const tableG = e.target.closest && e.target.closest('g.sqlviz-table');
      const start = clientToContent(e.clientX, e.clientY);
      if (tableG) {
        const nd = dia.nodes.find(n => n.g === tableG);
        mode = 'node';
        drag = { nd, start, sx: nd.x, sy: nd.y, moved: 0 };
        svg.setPointerCapture(e.pointerId);
      } else {
        mode = 'pan';
        drag = { start, vx: state.vb.x, vy: state.vb.y, moved: 0 };
        svg.setPointerCapture(e.pointerId);
      }
    };

    svg.onpointermove = (e) => {
      if (!drag) return;
      const p = clientToContent(e.clientX, e.clientY);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if (mode === 'node') {
        drag.nd.x = drag.sx + dx;
        drag.nd.y = drag.sy + dy;
        Diagram.applyNodeTransform(drag.nd);
        (state.nodeToEdges[drag.nd] || []).forEach(Diagram.updateEdge);
      } else if (mode === 'pan') {
        state.vb = { x: drag.vx - dx, y: drag.vy - dy, w: state.vb.w, h: state.vb.h };
        Diagram.setViewBox(svg, state.vb);
      }
    };

    svg.onpointerup = (e) => {
      if (!drag) return;
      const wasClick = drag.moved < 5;
      if (mode === 'node' && wasClick) selectTable(drag.nd.table);
      drag = null; mode = null;
    };

    // hover highlighting
    dia.nodes.forEach(nd => {
      nd.g.addEventListener('mouseenter', () => highlight(nd));
      nd.g.addEventListener('mouseleave', clearHighlight);
    });
  }

  function highlight(nd) {
    const rects = nd.g.querySelectorAll('rect');
    [0, 1].forEach(i => { if (rects[i]) rects[i].setAttribute('stroke', Diagram.C.borderHover); });
    (state.nodeToEdges[nd] || []).forEach(e => {
      e.el.setAttribute('stroke', Diagram.C.edgeHover);
      e.el.setAttribute('marker-end', 'url(#sqlviz-arrow-hover)');
    });
  }
  function clearHighlight() {
    if (!state.dia) return;
    state.dia.nodes.forEach(nd => {
      const rects = nd.g.querySelectorAll('rect');
      [0, 1].forEach(i => { if (rects[i]) rects[i].setAttribute('stroke', Diagram.C.border); });
    });
    state.dia.edgeEls.forEach(e => {
      e.el.setAttribute('stroke', Diagram.C.edge);
      e.el.setAttribute('marker-end', 'url(#sqlviz-arrow)');
    });
  }

  // ---- detail panel --------------------------------------------------------
  function selectTable(t) {
    state.selected = t;
    renderDetail(t);
  }
  function renderDetail(t) {
    if (!t) { detailEl.classList.remove('open'); return; }
    detailEl.classList.add('open');
    const rows = t.columns.map(c => {
      const flags = [];
      if (c.pk) flags.push('PK');
      if (c.fk || c.references) flags.push('FK' + (c.references ? ' → ' + c.references.table + '(' + (c.references.column || '?') + ')' : ''));
      if (c.unique) flags.push('UNIQUE');
      if (c.autoIncrement) flags.push('AUTO_INCREMENT');
      if (c.notNull) flags.push('NOT NULL');
      if (c.default != null) flags.push('DEFAULT ' + c.default);
      const flagStr = flags.length ? '<div class="d-flags">' + flags.map(f => '<span>' + Diagram.esc(f) + '</span>').join('') + '</div>' : '';
      return '<div class="d-row"><div class="d-name">' + Diagram.esc(c.name) + '</div>' +
        '<div class="d-type">' + Diagram.esc(c.type) + '</div>' + flagStr + '</div>';
    }).join('');
    detailBody.innerHTML = '<h3>' + Diagram.esc(t.fullName) + '</h3>' + rows;
  }
  detailClose.addEventListener('click', () => renderDetail(null));

  // ---- exports -------------------------------------------------------------
  function serializeSvg(withBg) {
    const clone = svg.cloneNode(true);
    const vb = state.vb;
    clone.setAttribute('width', Math.round(vb.w));
    clone.setAttribute('height', Math.round(vb.h));
    if (withBg) {
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', vb.x); bg.setAttribute('y', vb.y);
      bg.setAttribute('width', vb.w); bg.setAttribute('height', vb.h);
      bg.setAttribute('fill', Diagram.C.bg);
      clone.insertBefore(bg, clone.firstChild);
    }
    return new XMLSerializer().serializeToString(clone);
  }

  function exportSVG() {
    downloadText(serializeSvg(true), 'schema.svg', 'image/svg+xml;charset=utf-8');
  }

  function exportPNG() {
    const vb = state.vb;
    const xml = serializeSvg(true);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vb.w * scale);
      canvas.height = Math.round(vb.h * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, vb.w, vb.h);
      canvas.toBlob(b => downloadBlob(b, 'schema.png'));
    };
    img.onerror = () => alert('PNG export failed in this browser.');
    img.src = url;
  }

  function exportMermaid() {
    const lines = ['erDiagram'];
    for (const t of state.tables) {
      lines.push('  ' + t.name + ' {');
      for (const c of t.columns) {
        let b = '';
        if (c.pk) b += ' PK';
        if (c.fk || c.references) b += ' FK';
        if (c.unique) b += ' UK';
        lines.push('    ' + c.type + ' ' + c.name + b);
      }
      lines.push('  }');
    }
    for (const e of state.edges) {
      const src = state.tables[e.source].name;
      const dst = state.tables[e.target].name;
      lines.push('  ' + src + ' }o--|| ' + dst + ' : "' + (e.sourceCol || 'fk') + '"');
    }
    downloadText(lines.join('\n'), 'schema.mmd', 'text/plain;charset=utf-8');
  }

  function exportSQL() {
    const out = state.tables.map(t => {
      const defs = [];
      for (const c of t.columns) {
        let def = '  ' + c.name + ' ' + c.type;
        if (c.notNull && !c.pk) def += ' NOT NULL';
        if (c.autoIncrement) def += ' AUTO_INCREMENT';
        if (c.default != null) def += ' DEFAULT ' + c.default;
        if (c.pk && t.primaryKey.length === 1) def += ' PRIMARY KEY';
        if (c.unique) def += ' UNIQUE';
        if (c.references) def += ' REFERENCES ' + c.references.table + '(' + (c.references.column || 'id') + ')';
        defs.push(def);
      }
      if (t.primaryKey.length > 1) defs.push('  PRIMARY KEY (' + t.primaryKey.join(', ') + ')');
      for (const fk of t.foreignKeys) {
        let d = '  FOREIGN KEY (' + fk.columns.join(', ') + ') REFERENCES ' + fk.refTable + '(' + fk.refColumns.join(', ') + ')';
        if (fk.onDelete) d += ' ON DELETE ' + fk.onDelete;
        if (fk.onUpdate) d += ' ON UPDATE ' + fk.onUpdate;
        defs.push(d);
      }
      return 'CREATE TABLE ' + t.fullName + ' (\n' + defs.join(',\n') + '\n);';
    }).join('\n\n');
    downloadText(out, 'schema.sql', 'application/sql;charset=utf-8');
  }

  // ---- UI wiring -----------------------------------------------------------
  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  const debouncedRender = debounce(render, 350);

  editor.addEventListener('input', debouncedRender);

  $('#btn-sample').addEventListener('click', () => {
    const sel = $('#sample-select');
    const s = SQLVizSamples.find(x => x.name === sel.value) || SQLVizSamples[0];
    editor.value = s.sql;
    render();
  });

  $('#btn-clear').addEventListener('click', () => { editor.value = ''; render(); });
  $('#btn-format').addEventListener('click', () => {
    const parsed = SQLParser.parseSQL(editor.value);
    if (parsed.tables.length) { editor.value = exportSQL(); render(); }
  });

  $('#btn-zoom-in').addEventListener('click', () => {
    const cx = state.vb.x + state.vb.w / 2, cy = state.vb.y + state.vb.h / 2;
    state.vb = Diagram.zoomAt(svg, state.vb, 1.15, cx, cy);
  });
  $('#btn-zoom-out').addEventListener('click', () => {
    const cx = state.vb.x + state.vb.w / 2, cy = state.vb.y + state.vb.h / 2;
    state.vb = Diagram.zoomAt(svg, state.vb, 1 / 1.15, cx, cy);
  });
  $('#btn-fit').addEventListener('click', () => {
    state.vb = Object.assign({}, state.dia.fit);
    Diagram.setViewBox(svg, state.vb);
  });

  $('#btn-export-svg').addEventListener('click', exportSVG);
  $('#btn-export-png').addEventListener('click', exportPNG);
  $('#btn-export-mermaid').addEventListener('click', exportMermaid);
  $('#btn-export-sql').addEventListener('click', exportSQL);

  // ---- code generators -----------------------------------------------------
  function exportCode(format) {
    if (!state.tables.length) { showToast('No tables to export'); return; }
    const gen = { prisma: SchemaGen.prisma, typescript: SchemaGen.typescript, python: SchemaGen.python }[format];
    const file = { prisma: 'schema.prisma', typescript: 'schema.ts', python: 'models.py' }[format];
    const mime = { prisma: 'text/plain;charset=utf-8', typescript: 'text/typescript;charset=utf-8', python: 'text/x-python;charset=utf-8' }[format];
    if (!gen) return;
    downloadText(gen(state.tables), file, mime);
  }
  $('#btn-code').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#code-menu').hidden = !$('#code-menu').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) $('#code-menu').hidden = true;
  });
  $('#code-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (!item) return;
    exportCode(item.dataset.format);
    $('#code-menu').hidden = true;
  });

  // ---- share link -----------------------------------------------------------
  function encodeShare(sql) {
    const bytes = new TextEncoder().encode(sql);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function showToast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.hidden = true; }, 1800);
  }
  $('#btn-share').addEventListener('click', () => {
    const url = location.origin + location.pathname + '#' + encodeShare(editor.value);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'));
    } else {
      window.prompt('Copy this link:', url);
    }
  });

  // ---- support modal --------------------------------------------------------
  const modal = $('#support-modal');
  const openModal = () => { modal.hidden = false; };
  const closeModal = () => { modal.hidden = true; };
  $('#btn-support').addEventListener('click', openModal);
  $('#support-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  const amountRow = $('#amount-row');
  amountRow.addEventListener('click', (e) => {
    const b = e.target.closest('.amount');
    if (!b) return;
    amountRow.querySelectorAll('.amount').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#support-amount').value = b.dataset.amt;
  });

  // initial render: shared schema from URL hash, else the blog sample
  let initialSql = SQLVizSamples[0].sql;
  if (location.hash && location.hash.length > 1) {
    try { initialSql = decodeShare(location.hash.slice(1)); } catch (e) { /* ignore malformed hash */ }
  }
  editor.value = initialSql;
  render();

  window.SQLViz = { render, exportSQL, exportMermaid, exportSVG, exportPNG, getTables: () => state.tables };
})();
