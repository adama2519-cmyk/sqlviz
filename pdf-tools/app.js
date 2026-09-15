/* SQLViz PDF-työkalut — 100 % selaimessa (pdf-lib + pdf.js + JSZip) */
(function () {
  'use strict';

  if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  const $ = (s) => document.querySelector(s);

  // ---------- helpers ----------
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
    return (n / (1024 * 1024)).toFixed(2).replace('.', ',') + ' MB';
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  // "1, 3, 5-7" -> Set(1-based page numbers)
  function parsePageSet(str, max) {
    const set = new Set();
    (str || '').split(',').forEach((part) => {
      part = part.trim();
      if (!part) return;
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { const t = a; a = b; b = t; }
        for (let i = a; i <= b; i++) if (i >= 1 && i <= max) set.add(i);
      } else if (/^\d+$/.test(part)) {
        const v = parseInt(part, 10);
        if (v >= 1 && v <= max) set.add(v);
      }
    });
    return set;
  }

  // "1-3, 5, 7-9" -> [[1,2,3],[5],[7,8,9]]
  function parseRanges(str, max) {
    const out = [];
    (str || '').split(',').forEach((part) => {
      part = part.trim();
      if (!part) return;
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { const t = a; a = b; b = t; }
        const arr = [];
        for (let i = a; i <= b; i++) if (i >= 1 && i <= max) arr.push(i);
        if (arr.length) out.push(arr);
      } else if (/^\d+$/.test(part)) {
        const v = parseInt(part, 10);
        if (v >= 1 && v <= max) out.push([v]);
      }
    });
    return out;
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Kuvan luonti epäonnistui'))), 'image/jpeg', quality);
    });
  }

  async function packOrSingle(entries, zipName) {
    if (entries.length === 1) return { blob: entries[0].blob, filename: entries[0].name };
    const zip = new JSZip();
    entries.forEach((e) => zip.file(e.name, e.blob));
    const blob = await zip.generateAsync({ type: 'blob' });
    return { blob, filename: zipName };
  }

  async function renderPdfPages(arrayBuffer, scale, onPage, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const total = pdf.numPages;
    const results = [];
    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      results.push(await onPage(page, canvas, i, vp));
      if (onProgress) onProgress(Math.round((i / total) * 100));
      page.cleanup();
    }
    return results;
  }

  // ---------- tool definitions ----------
  const TOOLS = {
    merge: {
      name: 'Yhdistä PDF', icon: '🧩', action: 'Yhdistä PDF:t',
      accept: '.pdf,application/pdf', multiple: true,
      hint: 'Valitse vähintään kaksi PDF-tiedostoa. Muuta järjestystä nuolilla.',
      options: () => '',
      run: async (files) => {
        if (files.length < 2) throw new Error('Valitse vähintään kaksi PDF-tiedostoa.');
        const out = await PDFLib.PDFDocument.create();
        for (const f of files) {
          const src = await PDFLib.PDFDocument.load(await f.arrayBuffer());
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        }
        const bytes = await out.save();
        return { blob: new Blob([bytes], { type: 'application/pdf' }), filename: 'yhdistetty.pdf' };
      },
    },

    split: {
      name: 'Jaa PDF', icon: '✂️', action: 'Jaa PDF',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-split-mode">Jakotapa</label>
          <select id="opt-split-mode" class="opt-select">
            <option value="all">Joka sivu erilliseksi PDF:ksi</option>
            <option value="ranges">Sivualueet (esim. 1-3, 4-6)</option>
          </select>
        </div>
        <div class="opt-group" id="split-ranges-wrap" hidden>
          <label class="opt-label" for="opt-split-ranges">Sivualueet</label>
          <input id="opt-split-ranges" class="opt-input" placeholder="esim. 1-3, 4-6, 10" />
          <span class="opt-help">Pilkuilla erotetut alueet. Jokainen alue tulee omaksi PDF:ksi.</span>
        </div>`,
      afterRender: () => {
        const sel = $('#opt-split-mode');
        if (sel) sel.addEventListener('change', () => {
          $('#split-ranges-wrap').hidden = sel.value !== 'ranges';
        });
      },
      run: async (files) => {
        const src = await PDFLib.PDFDocument.load(await files[0].arrayBuffer());
        const n = src.getPageCount();
        const mode = $('#opt-split-mode').value;
        const groups = [];
        if (mode === 'all') {
          for (let i = 1; i <= n; i++) groups.push([i]);
        } else {
          const parsed = parseRanges($('#opt-split-ranges').value, n);
          if (!parsed.length) throw new Error('Anna vähintään yksi sivualue, esim. 1-3.');
          parsed.forEach((g) => groups.push(g));
        }
        const entries = [];
        for (const g of groups) {
          const d = await PDFLib.PDFDocument.create();
          const pages = await d.copyPages(src, g.map((x) => x - 1));
          pages.forEach((p) => d.addPage(p));
          const bytes = await d.save();
          const label = g.length === 1 ? `sivu-${g[0]}` : `sivut-${g[0]}-${g[g.length - 1]}`;
          entries.push({ name: baseName(files[0].name) + '-' + label + '.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) });
        }
        return await packOrSingle(entries, baseName(files[0].name) + '-jaettu.zip');
      },
    },

    img2pdf: {
      name: 'Kuvat → PDF', icon: '🖼️', action: 'Muunna PDF:ksi',
      accept: 'image/jpeg,image/png,.jpg,.jpeg,.png', multiple: true,
      hint: 'Valitse JPG- tai PNG-kuvia. Järjestystä voi muuttaa nuolilla.',
      options: () => `
        <div class="opt-row">
          <div class="opt-group">
            <label class="opt-label" for="opt-page-size">Sivun koko</label>
            <select id="opt-page-size" class="opt-select">
              <option value="fit">Kuvan koko</option>
              <option value="a4">A4 (pysty)</option>
            </select>
          </div>
          <div class="opt-group">
            <label class="opt-label" for="opt-margin">Marginaali</label>
            <select id="opt-margin" class="opt-select">
              <option value="0">Ei marginaalia</option>
              <option value="24" selected>Pieni (24 pt)</option>
              <option value="48">Keskikoko (48 pt)</option>
            </select>
          </div>
        </div>
        <span class="opt-help">Tuettu: JPG ja PNG. Läpinäkyvyys muunnetaan valkoiseksi.</span>`,
      run: async (files) => {
        if (!files.length) throw new Error('Valitse vähintään yksi kuva.');
        const doc = await PDFLib.PDFDocument.create();
        const size = $('#opt-page-size').value;
        const margin = parseFloat($('#opt-margin').value) || 0;
        const A4 = [595.28, 841.89];
        for (const f of files) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);
          const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          let pw, ph;
          if (size === 'a4') { pw = A4[0]; ph = A4[1]; }
          else { pw = img.width + margin * 2; ph = img.height + margin * 2; }
          const page = doc.addPage([pw, ph]);
          const availW = pw - margin * 2, availH = ph - margin * 2;
          const scale = Math.min(availW / img.width, availH / img.height, size === 'fit' ? Infinity : 1);
          const w = img.width * scale, h = img.height * scale;
          page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
        const out = await doc.save();
        return { blob: new Blob([out], { type: 'application/pdf' }), filename: 'kuvat.pdf' };
      },
    },

    pdf2jpg: {
      name: 'PDF → JPG', icon: '🏞️', action: 'Muunna JPG:ksi',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-dpi">Tarkkuus</label>
          <select id="opt-dpi" class="opt-select">
            <option value="96">96 DPI — pieni (nopea)</option>
            <option value="150" selected>150 DPI — normaali</option>
            <option value="200">200 DPI — tarkka</option>
            <option value="300">300 DPI — tulostuslaatu</option>
          </select>
        </div>
        <span class="opt-help">Jokainen sivu tallennetaan JPG-kuvana. Useampi sivu pakataan ZIP-tiedostoon.</span>`,
      run: async (files, onProgress) => {
        const dpi = parseInt($('#opt-dpi').value, 10) || 150;
        const scale = dpi / 72;
        const f = files[0];
        const entries = await renderPdfPages(await f.arrayBuffer(), scale, async (page, canvas, i) => {
          const blob = await canvasToJpeg(canvas, 0.92);
          return { name: baseName(f.name) + '-sivu-' + i + '.jpg', blob: blob };
        }, onProgress);
        return await packOrSingle(entries, baseName(f.name) + '-kuvat.zip');
      },
    },

    rotate: {
      name: 'Kierrä PDF', icon: '🔄', action: 'Kierrä sivut',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-angle">Kiertokulma</label>
          <select id="opt-angle" class="opt-select">
            <option value="90" selected>90° myötäpäivään</option>
            <option value="180">180°</option>
            <option value="270">270° (90° vastapäivään)</option>
          </select>
        </div>`,
      run: async (files) => {
        const ang = parseInt($('#opt-angle').value, 10) || 90;
        const doc = await PDFLib.PDFDocument.load(await files[0].arrayBuffer());
        doc.getPages().forEach((p) => {
          const cur = p.getRotation().angle || 0;
          p.setRotation(PDFLib.degrees((((cur + ang) % 360) + 360) % 360));
        });
        const out = await doc.save();
        return { blob: new Blob([out], { type: 'application/pdf' }), filename: baseName(files[0].name) + '-kierretty.pdf' };
      },
    },

    remove: {
      name: 'Poista sivuja', icon: '🗑️', action: 'Poista sivut',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-remove-pages">Poistettavat sivut</label>
          <input id="opt-remove-pages" class="opt-input" placeholder="esim. 1, 3, 5-7" />
          <span class="opt-help">Erota pilkuilla, käytä väliviivaa alueille.</span>
        </div>`,
      run: async (files) => {
        const doc = await PDFLib.PDFDocument.load(await files[0].arrayBuffer());
        const n = doc.getPageCount();
        const rm = parsePageSet($('#opt-remove-pages').value, n);
        if (!rm.size) throw new Error('Anna vähintään yksi poistettava sivu, esim. 1, 3.');
        const keep = [];
        for (let i = 1; i <= n; i++) if (!rm.has(i)) keep.push(i - 1);
        if (!keep.length) throw new Error('Kaikkia sivuja ei voi poistaa.');
        const out = await PDFLib.PDFDocument.create();
        const pages = await out.copyPages(doc, keep);
        pages.forEach((p) => out.addPage(p));
        const bytes = await out.save();
        return { blob: new Blob([bytes], { type: 'application/pdf' }), filename: baseName(files[0].name) + '-siivottu.pdf' };
      },
    },

    numbers: {
      name: 'Sivunumerot', icon: '🔢', action: 'Lisää sivunumerot',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-pos">Sijainti</label>
          <select id="opt-pos" class="opt-select">
            <option value="bottom-center" selected>Alareuna — keskellä</option>
            <option value="bottom-right">Alareuna — oikealla</option>
            <option value="bottom-left">Alareuna — vasemmalla</option>
            <option value="top-center">Yläreuna — keskellä</option>
            <option value="top-right">Yläreuna — oikealla</option>
            <option value="top-left">Yläreuna — vasemmalla</option>
          </select>
        </div>
        <div class="opt-row">
          <div class="opt-group">
            <label class="opt-label" for="opt-start">Aloitusnumero</label>
            <input id="opt-start" class="opt-input" type="number" value="1" min="0" />
          </div>
          <div class="opt-group">
            <label class="opt-label" for="opt-fsize">Fonttikoko</label>
            <input id="opt-fsize" class="opt-input" type="number" value="11" min="6" max="48" />
          </div>
        </div>`,
      run: async (files) => {
        const doc = await PDFLib.PDFDocument.load(await files[0].arrayBuffer());
        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const pos = $('#opt-pos').value;
        const start = parseInt($('#opt-start').value, 10) || 1;
        const size = parseInt($('#opt-fsize').value, 10) || 11;
        const m = 26;
        doc.getPages().forEach((p, i) => {
          const { width, height } = p.getSize();
          const text = String(start + i);
          const tw = font.widthOfTextAtSize(text, size);
          let x, y;
          if (pos.indexOf('bottom') === 0) y = m; else y = height - m - size;
          if (/-left$/.test(pos)) x = m;
          else if (/-right$/.test(pos)) x = width - m - tw;
          else x = (width - tw) / 2;
          p.drawText(text, { x, y, size, font, color: PDFLib.rgb(0.25, 0.25, 0.3) });
        });
        const out = await doc.save();
        return { blob: new Blob([out], { type: 'application/pdf' }), filename: baseName(files[0].name) + '-numerot.pdf' };
      },
    },

    compress: {
      name: 'Pakkaa PDF', icon: '🗜️', action: 'Pakkaa PDF',
      accept: '.pdf,application/pdf', multiple: false,
      hint: 'Valitse yksi PDF-tiedosto.',
      options: () => `
        <div class="opt-group">
          <label class="opt-label" for="opt-quality">Laatu</label>
          <select id="opt-quality" class="opt-select">
            <option value="small">Pienin koko (heikoin laatu)</option>
            <option value="medium" selected>Hyvä tasapaino</option>
            <option value="high">Korkein laatu</option>
          </select>
          <span class="opt-help">Sivut renderöidään kuvina, joten valittava teksti muuttuu kuvaksi. Sopii skannauksille ja esitteille.</span>
        </div>`,
      run: async (files, onProgress) => {
        const q = $('#opt-quality').value;
        const preset = q === 'small' ? { scale: 1.0, quality: 0.5 }
          : q === 'high' ? { scale: 2.0, quality: 0.85 }
          : { scale: 1.4, quality: 0.68 };
        const f = files[0];
        const out = await PDFLib.PDFDocument.create();
        await renderPdfPages(await f.arrayBuffer(), preset.scale, async (page, canvas) => {
          const blob = await canvasToJpeg(canvas, preset.quality);
          const buf = await blob.arrayBuffer();
          const img = await out.embedJpg(buf);
          const base = page.getViewport({ scale: 1 });
          const pg = out.addPage([base.width, base.height]);
          pg.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
          return true;
        }, onProgress);
        const bytes = await out.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        if (blob.size >= f.size) {
          return { blob: f, filename: f.name, origSize: f.size, noGain: true };
        }
        return { blob, filename: baseName(f.name) + '-pakattu.pdf', origSize: f.size };
      },
    },
  };

  // ---------- UI state ----------
  const state = { tool: null, files: [], running: false };

  function setProgress(pct) {
    const wrap = $('#progress'), bar = $('#progress-bar');
    if (pct == null) { wrap.hidden = true; bar.style.width = '0'; return; }
    wrap.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function currentHint() {
    const t = TOOLS[state.tool];
    if (t.multiple) return 'Voit valita useita tiedostoja';
    return 'Valitse yksi tiedosto';
  }

  function renderFileList() {
    const list = $('#file-list');
    if (!state.files.length) { list.hidden = true; list.innerHTML = ''; return; }
    list.hidden = false;
    const t = TOOLS[state.tool];
    list.innerHTML = state.files.map((f, i) => `
      <div class="file-row">
        ${t.multiple ? `<span class="file-idx">${i + 1}</span>` : ''}
        <span class="file-name" title="${f.name.replace(/"/g, '&quot;')}">${f.name}</span>
        <span class="file-size">${formatBytes(f.size)}</span>
        <div class="file-actions">
          ${t.multiple ? `<button type="button" class="file-btn" data-move="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Siirrä ylös">↑</button>
          <button type="button" class="file-btn" data-move="down" data-i="${i}" ${i === state.files.length - 1 ? 'disabled' : ''} title="Siirrä alas">↓</button>` : ''}
          <button type="button" class="file-btn" data-remove="${i}" title="Poista">✕</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      state.files.splice(parseInt(b.dataset.remove, 10), 1);
      afterFilesChanged();
    }));
    list.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const i = parseInt(b.dataset.i, 10);
      const j = b.dataset.move === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= state.files.length) return;
      const tmp = state.files[i]; state.files[i] = state.files[j]; state.files[j] = tmp;
      afterFilesChanged();
    }));
  }

  function afterFilesChanged() {
    renderFileList();
    const t = TOOLS[state.tool];
    const enough = state.files.length > 0 && !(state.tool === 'merge' && state.files.length < 2);
    $('#btn-run').disabled = !enough || state.running;
    $('#dropzone').style.display = state.files.length ? 'none' : '';
  }

  function selectTool(id) {
    state.tool = id;
    state.files = [];
    const t = TOOLS[id];
    $('#panel-icon').textContent = t.icon;
    $('#panel-name').textContent = t.name;
    $('#btn-run').textContent = t.action;
    $('#dz-hint').textContent = currentHint();
    const input = $('#file-input');
    input.accept = t.accept;
    input.multiple = !!t.multiple;
    $('#options').innerHTML = t.options();
    if (t.afterRender) t.afterRender();
    $('#result').hidden = true;
    $('#result').innerHTML = '';
    setProgress(null);
    renderFileList();
    afterFilesChanged();
    $('#tool-grid').hidden = true;
    $('#tool-panel').hidden = false;
    window.scrollTo({ top: $('#tools').offsetTop - 70, behavior: 'smooth' });
  }

  function backToGrid() {
    $('#tool-panel').hidden = true;
    $('#tool-grid').hidden = false;
    state.tool = null;
    state.files = [];
    setProgress(null);
  }

  function addFiles(fileList) {
    if (!state.tool) return;
    const t = TOOLS[state.tool];
    const incoming = Array.from(fileList || []);
    const accepted = incoming.filter((f) => {
      if (/pdf/i.test(t.accept)) return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      if (/image/i.test(t.accept)) return /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
      return true;
    });
    if (!accepted.length) { toast('Valitse tuettu tiedostotyyppi.', true); return; }
    if (t.multiple) state.files = state.files.concat(accepted);
    else state.files = accepted.slice(0, 1);
    $('#result').hidden = true;
    afterFilesChanged();
  }

  async function runTool() {
    if (state.running) return;
    const t = TOOLS[state.tool];
    if (!state.files.length) return;
    state.running = true;
    $('#btn-run').disabled = true;
    $('#result').hidden = true;
    setProgress(4);
    const startedAction = $('#btn-run').textContent;
    $('#btn-run').textContent = 'Käsitellään…';
    try {
      const res = await t.run(state.files, (p) => setProgress(p));
      setProgress(100);
      const extra = res.noGain
        ? formatBytes(res.origSize) + ' — alkuperäinen oli jo kevyt, tiedosto palautettiin muuttumattomana'
        : res.origSize
          ? `${formatBytes(res.origSize)} → <strong style="color:var(--ok)">${formatBytes(res.blob.size)}</strong> (${Math.max(0, Math.round((1 - res.blob.size / res.origSize) * 100))} % pienempi)`
          : formatBytes(res.blob.size);
      const el = $('#result');
      el.className = 'result';
      el.innerHTML = `
        <div class="result-info">
          <span class="result-name">${res.filename}</span>
          <span class="result-meta">${extra}</span>
        </div>
        <button type="button" class="btn btn-primary" id="btn-dl">⬇ Lataa</button>`;
      el.hidden = false;
      $('#btn-dl').addEventListener('click', () => download(res.blob, res.filename));
      download(res.blob, res.filename);
      toast('Valmis — ' + res.filename);
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'Käsittely epäonnistui.', true);
    } finally {
      setProgress(null);
      state.running = false;
      $('#btn-run').textContent = startedAction;
      afterFilesChanged();
    }
  }

  // ---------- wiring ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tool-card').forEach((card) => {
      card.addEventListener('click', () => selectTool(card.dataset.tool));
    });
    $('#btn-back').addEventListener('click', backToGrid);
    $('#btn-run').addEventListener('click', runTool);
    $('#btn-clear').addEventListener('click', () => {
      state.files = [];
      $('#result').hidden = true;
      afterFilesChanged();
    });

    const dz = $('#dropzone'), input = $('#file-input');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    // support modal
    const modal = $('#support-modal');
    $('#btn-support').addEventListener('click', () => { modal.hidden = false; });
    $('#support-close').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
    document.querySelectorAll('#amount-row .amount').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#amount-row .amount').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('#support-amount').value = b.dataset.amt;
    }));
  });
})();
