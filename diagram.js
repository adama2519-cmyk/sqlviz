/* SQLViz — SVG ER diagram renderer
 * Force-directed auto-layout, draggable tables, zoom/pan (viewBox-based), and
 * export helpers. All SVG styling is inline so output exports cleanly to SVG/PNG.
 */
(function (global) {
  'use strict';

  const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
  const SANS = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  const C = {
    bg: '#0b0f17',
    headerFill: '#171e2b',
    bodyFill: '#121826',
    border: '#263041',
    borderHover: '#4b6bd8',
    title: '#e7edf6',
    colName: '#d6deea',
    colType: '#7d8ba1',
    edge: '#3c4a5f',
    edgeHover: '#4b6bd8',
    pk: '#e8b54a',
    fk: '#59a7f7',
    uq: '#4cc38a',
    ai: '#9aa6ba'
  };

  const ROW_H = 21;
  const HEADER_H = 34;
  const PAD_X = 12;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 8;
  const MIN_W = 148;

  let measureCtx = null;
  function measure(text, px, weight) {
    if (!measureCtx) {
      const cv = document.createElement('canvas');
      measureCtx = cv.getContext('2d');
    }
    measureCtx.font = (weight || '400') + ' ' + px + 'px ' + MONO;
    return measureCtx.measureText(text || '').width;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  function colBadges(c) {
    const b = [];
    if (c.pk) b.push(['PK', C.pk]);
    if (c.fk || c.references) b.push(['FK', C.fk]);
    if (c.unique) b.push(['UQ', C.uq]);
    if (c.autoIncrement) b.push(['AI', C.ai]);
    return b;
  }

  function estimateSize(t) {
    let w = measure(t.name, 13, '600') + 46;
    for (const c of t.columns) {
      const bw = colBadges(c);
      let rowW = 20;
      for (const b of bw) rowW += measure(b[0], 10, '700') + 8;
      rowW += measure(c.name, 12, '500') + 8 + measure(c.type, 11, '400') + PAD_X;
      if (rowW > w) w = rowW;
    }
    w = Math.max(MIN_W, Math.ceil(w) + PAD_X);
    const h = HEADER_H + PAD_TOP + t.columns.length * ROW_H + PAD_BOTTOM;
    return { w, h };
  }

  function layout(nodes, edges, W, H) {
    const n = nodes.length;
    if (n === 0) return;
    if (n === 1) { nodes[0].x = W / 2; nodes[0].y = H / 2; return; }
    const pos = nodes.map(() => ({
      x: (Math.random() - 0.5) * Math.min(600, W) + W / 2,
      y: (Math.random() - 0.5) * Math.min(600, H) + H / 2
    }));
    const k = Math.sqrt((W * H) / n) * 1.1;
    const ITER = 320;
    for (let it = 0; it < ITER; it++) {
      const t = 1 - it / ITER;
      const temp = Math.max(0.5, t * Math.max(W, H) * 0.12);
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          let dx = pos[a].x - pos[b].x;
          let dy = pos[a].y - pos[b].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const f = Math.min((k * k) / d, temp);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          pos[a].x += fx; pos[a].y += fy;
          pos[b].x -= fx; pos[b].y -= fy;
        }
      }
      for (const e of edges) {
        const a = e.source, b = e.target;
        let dx = pos[a].x - pos[b].x;
        let dy = pos[a].y - pos[b].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = Math.min((d * d) / k, temp);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        pos[a].x -= fx; pos[a].y -= fy;
        pos[b].x += fx; pos[b].y += fy;
      }
      for (let a = 0; a < n; a++) {
        pos[a].x += (W / 2 - pos[a].x) * 0.025;
        pos[a].y += (H / 2 - pos[a].y) * 0.025;
      }
    }
    nodes.forEach((nd, i) => { nd.x = pos[i].x; nd.y = pos[i].y; });
  }

  function columnY(nd, colName) {
    const idx = nd.table.columns.findIndex(c => c.name === colName);
    const i = idx >= 0 ? idx : 0;
    return nd.y - nd.h / 2 + HEADER_H + PAD_TOP + i * ROW_H + ROW_H / 2;
  }

  function anchorPoint(from, to, colName) {
    const cx = from.x, cy = from.y;
    const hw = from.w / 2, hh = from.h / 2;
    const cyRow = colName != null ? columnY(from, colName) : cy;
    const dx = to.x - cx, dy = to.y - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx > 0 ? cx + hw : cx - hw, y: cyRow };
    }
    return { x: cx, y: dy > 0 ? cy + hh : cy - hh };
  }

  function edgePath(e) {
    const p1 = anchorPoint(e.a, e.b, e.sourceCol);
    const p2 = anchorPoint(e.b, e.a, e.targetCol);
    return 'M ' + p1.x + ' ' + p1.y + ' L ' + p2.x + ' ' + p2.y;
  }

  function renderNode(nd) {
    const g = svgEl('g', { class: 'sqlviz-table', 'data-table': nd.table.fullName });
    const w = nd.w, h = nd.h;

    svgEl('rect', {
      x: 0, y: 0, width: w, height: HEADER_H, rx: 8, ry: 8,
      fill: C.headerFill, stroke: C.border, 'stroke-width': 1
    }, g);

    svgEl('text', {
      x: PAD_X, y: HEADER_H / 2 + 4.5,
      'font-family': SANS, 'font-size': 13, 'font-weight': 700, fill: C.title
    }, g).textContent = nd.table.name;

    const bodyY = HEADER_H;
    const bodyH = h - HEADER_H;
    svgEl('rect', {
      x: 0, y: bodyY, width: w, height: bodyH,
      fill: C.bodyFill, stroke: C.border, 'stroke-width': 1
    }, g);
    svgEl('rect', { x: 1, y: bodyY - 4, width: w - 2, height: 5, fill: C.headerFill, stroke: 'none' }, g);

    nd.table.columns.forEach((c, i) => {
      const ry = bodyY + PAD_TOP + i * ROW_H + ROW_H / 2;
      let tx = PAD_X;
      for (const [label, color] of colBadges(c)) {
        const bw = measure(label, 10, '700');
        svgEl('rect', { x: tx - 2, y: ry - 6, width: bw + 4, height: 13, rx: 3, ry: 3, fill: 'none', stroke: color, 'stroke-width': 0.8, opacity: 0.9 }, g);
        svgEl('text', { x: tx, y: ry + 3.5, 'font-family': MONO, 'font-size': 10, 'font-weight': 700, fill: color }, g).textContent = label;
        tx += bw + 10;
      }
      svgEl('text', {
        x: tx, y: ry + 3.5, 'font-family': MONO, 'font-size': 12,
        'font-weight': c.notNull ? '700' : '400', fill: C.colName
      }, g).textContent = c.name;
      if (c.type) {
        svgEl('text', {
          x: w - PAD_X, y: ry + 3.5, 'text-anchor': 'end',
          'font-family': MONO, 'font-size': 11, 'font-weight': '400', fill: C.colType
        }, g).textContent = c.type;
      }
    });

    nd.g = g;
    return g;
  }

  function applyNodeTransform(nd) {
    nd.g.setAttribute('transform', 'translate(' + (nd.x - nd.w / 2) + ' ' + (nd.y - nd.h / 2) + ')');
  }

  function buildDiagram(svg, model, opts) {
    opts = opts || {};
    const tables = model.tables || [];
    const edges = model.edges || [];
    svg.innerHTML = '';
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const nodes = tables.map(t => {
      const s = estimateSize(t);
      return { table: t, x: 0, y: 0, w: s.w, h: s.h, g: null };
    });

    const W = opts.width || 1400;
    const H = opts.height || 1000;
    layout(nodes, edges, W, H);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(nd => {
      minX = Math.min(minX, nd.x - nd.w / 2);
      minY = Math.min(minY, nd.y - nd.h / 2);
      maxX = Math.max(maxX, nd.x + nd.w / 2);
      maxY = Math.max(maxY, nd.y + nd.h / 2);
    });
    const MARGIN = 60;
    const fit = { x: minX - MARGIN, y: minY - MARGIN, w: (maxX - minX) + MARGIN * 2, h: (maxY - minY) + MARGIN * 2 };
    svg.setAttribute('viewBox', fit.x + ' ' + fit.y + ' ' + fit.w + ' ' + fit.h);

    const defs = svgEl('defs', {}, svg);
    const mk = svgEl('marker', { id: 'sqlviz-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: C.edge }, mk);
    const mkH = svgEl('marker', { id: 'sqlviz-arrow-hover', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: C.edgeHover }, mkH);

    const root = svgEl('g', { id: 'sqlviz-viewport' }, svg);

    const edgeLayer = svgEl('g', {}, root);
    const edgeEls = edges.map(e => {
      const a = nodes[e.source], b = nodes[e.target];
      if (!a || !b) return null;
      const path = svgEl('path', {
        d: edgePath({ a, b, sourceCol: e.sourceCol, targetCol: e.targetCol }),
        fill: 'none', stroke: C.edge, 'stroke-width': 1.4,
        'marker-end': 'url(#sqlviz-arrow)'
      }, edgeLayer);
      return { el: path, edge: e, a, b };
    }).filter(Boolean);

    const nodeLayer = svgEl('g', {}, root);
    nodes.forEach(nd => {
      const g = renderNode(nd);
      nodeLayer.appendChild(g);
      applyNodeTransform(nd);
    });

    return { svg, root, edgeLayer, nodeLayer, nodes, edgeEls, fit };
  }

  function updateEdge(e) {
    e.el.setAttribute('d', edgePath(e));
  }

  function setViewBox(svg, vb) {
    svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
  }

  function zoomAt(svg, vb, factor, cx, cy) {
    const nw = vb.w / factor;
    const nh = vb.h / factor;
    const fx = (cx - vb.x) / vb.w;
    const fy = (cy - vb.y) / vb.h;
    const nx = cx - fx * nw;
    const ny = cy - fy * nh;
    const nvb = { x: nx, y: ny, w: nw, h: nh };
    setViewBox(svg, nvb);
    return nvb;
  }

  const API = {
    buildDiagram, layout, estimateSize, measure, esc, colBadges,
    applyNodeTransform, updateEdge, setViewBox, zoomAt, anchorPoint, C, MONO, SANS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Diagram = API;
})(typeof window !== 'undefined' ? window : globalThis);
