/* SQLViz Pro — accounts, saved schemas, and payments (frontend). */
(function () {
  'use strict';

  const API = 'https://ghostwhite-dragonfly-572429.hostingersite.com';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    token: localStorage.getItem('sqlviz_token') || null,
    user: JSON.parse(localStorage.getItem('sqlviz_user') || 'null'),
    methods: { stripe: false, paypal: false }
  };

  function saveAuth(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('sqlviz_token', token);
    localStorage.setItem('sqlviz_user', JSON.stringify(user));
    renderHeader();
  }
  function clearAuth() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('sqlviz_token');
    localStorage.removeItem('sqlviz_user');
    renderHeader();
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(API + path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401) clearAuth();
      const err = new Error((data && data.error) || 'request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---- header --------------------------------------------------------------
  function renderHeader() {
    const area = $('#auth-area');
    if (!area) return;
    if (state.user) {
      const badge = state.user.plan === 'pro'
        ? '<span class="plan-badge pro">PRO</span>'
        : '<span class="plan-badge free">FREE</span>';
      area.innerHTML = badge +
        '<button id="btn-my-schemas" class="btn btn-ghost btn-sm">My schemas</button>' +
        '<button id="btn-signout" class="btn btn-ghost btn-sm">Sign out</button>';
      $('#btn-my-schemas').addEventListener('click', openSchemas);
      $('#btn-signout').addEventListener('click', () => { api('/api/logout', { method: 'POST' }).catch(() => {}); clearAuth(); });
    } else {
      area.innerHTML = '<button id="btn-signin" class="btn btn-sm">Sign in</button>';
      $('#btn-signin').addEventListener('click', () => openAuth('login'));
    }
  }

  // ---- auth modal ----------------------------------------------------------
  function openAuth(mode) {
    $('#auth-mode').textContent = mode === 'login' ? 'Sign in' : 'Create account';
    $('#auth-toggle').textContent = mode === 'login' ? "New here? Create an account" : 'Already have an account? Sign in';
    $('#auth-toggle').dataset.mode = mode === 'login' ? 'register' : 'login';
    $('#auth-error').textContent = '';
    $('#auth-modal').hidden = false;
  }
  function closeAuth() { $('#auth-modal').hidden = true; }

  async function submitAuth(e) {
    e.preventDefault();
    const mode = $('#auth-mode').textContent.startsWith('Sign') ? 'login' : 'register';
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const btn = $('#auth-submit');
    btn.disabled = true;
    $('#auth-error').textContent = '';
    try {
      const path = mode === 'login' ? '/api/login' : '/api/register';
      const data = await api(path, { method: 'POST', body: JSON.stringify({ email, password }) });
      saveAuth(data.token, data.user);
      closeAuth();
      toast('Welcome' + (data.user.plan === 'pro' ? ' (Pro)' : '') + '!');
      if ($('#schemas-modal') && !$('#schemas-modal').hidden) openSchemas();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- save ----------------------------------------------------------------
  function openSave() {
    if (!state.user) { openAuth('register'); return; }
    $('#save-title').value = defaultTitle();
    $('#save-public').checked = false;
    $('#save-modal').hidden = false;
  }
  function closeSave() { $('#save-modal').hidden = true; }

  function defaultTitle() {
    const tables = window.SQLViz && window.SQLViz.getTables ? window.SQLViz.getTables() : [];
    return tables.length ? tables[0].name : 'Untitled';
  }

  async function submitSave(e) {
    e.preventDefault();
    const title = $('#save-title').value.trim() || 'Untitled';
    const sql = document.querySelector('#sql-input').value;
    const isPublic = $('#save-public').checked;
    try {
      const data = await api('/api/schemas', { method: 'POST', body: JSON.stringify({ title, sql, is_public: isPublic }) });
      closeSave();
      toast('Schema saved ✓');
      if (isPublic) {
        const share = 'https://adama2519-cmyk.github.io/sqlviz/?schema=' + data.schema.slug;
        if (navigator.clipboard) navigator.clipboard.writeText(share).then(() => toast('Public link copied: ' + share));
      }
    } catch (err) {
      if (err.status === 402) { closeSave(); openUpgrade(); }
      else toast('Save failed: ' + err.message);
    }
  }

  // ---- my schemas ----------------------------------------------------------
  async function openSchemas() {
    $('#schemas-modal').hidden = false;
    $('#schemas-list').innerHTML = '<div class="muted">Loading…</div>';
    try {
      const data = await api('/api/schemas');
      const rows = data.schemas;
      if (!rows.length) {
        $('#schemas-list').innerHTML = '<div class="muted">No saved schemas yet.</div>';
      } else {
        $('#schemas-list').innerHTML = rows.map(s => {
          const when = new Date(s.updated_at).toLocaleDateString();
          const pub = s.is_public ? '<span class="pub-tag">public</span>' : '<span class="pub-tag priv">private</span>';
          return '<div class="schema-row" data-id="' + s.id + '">' +
            '<div class="schema-info"><div class="schema-title">' + esc(s.title) + '</div>' +
            '<div class="schema-meta">' + when + ' · ' + pub + '</div></div>' +
            '<div class="schema-actions">' +
            '<button class="btn btn-ghost btn-sm act-load">Load</button>' +
            '<button class="btn btn-ghost btn-sm act-del" title="Delete">✕</button>' +
            '</div></div>';
        }).join('');
      }
      $('#schemas-list').querySelectorAll('.schema-row').forEach(row => {
        row.querySelector('.act-load').addEventListener('click', () => loadSchema(row.dataset.id));
        row.querySelector('.act-del').addEventListener('click', () => removeSchema(row.dataset.id));
      });
    } catch (err) {
      $('#schemas-list').innerHTML = '<div class="muted">' + esc(err.message) + '</div>';
    }
  }
  function closeSchemas() { $('#schemas-modal').hidden = true; }

  async function loadSchema(id) {
    try {
      const data = await api('/api/schemas/' + id);
      document.querySelector('#sql-input').value = data.schema.sql;
      window.SQLViz.render();
      closeSchemas();
      toast('Loaded "' + data.schema.title + '"');
    } catch (err) { toast(err.message); }
  }

  async function removeSchema(id) {
    if (!confirm('Delete this schema?')) return;
    try {
      await api('/api/schemas/' + id, { method: 'DELETE' });
      toast('Deleted');
      openSchemas();
    } catch (err) { toast(err.message); }
  }

  // ---- upgrade / payments --------------------------------------------------
  function openUpgrade() {
    $('#upgrade-modal').hidden = false;
    const paypalBtn = $('#btn-pay-paypal');
    paypalBtn.disabled = !state.methods.paypal;
    $('#upgrade-note').textContent = state.methods.paypal
      ? '€5 unlocks unlimited schemas + private sharing. Pay with PayPal or card.'
      : 'Payments are being connected. Check back shortly.';
  }
  function closeUpgrade() { $('#upgrade-modal').hidden = true; }

  async function checkout(method) {
    try {
      const data = await api('/api/checkout/' + method, { method: 'POST', body: '{}' });
      if (method === 'stripe' && data.url) window.location.href = data.url;
      else if (method === 'paypal' && data.approveUrl) window.location.href = data.approveUrl;
    } catch (err) { toast(err.message); }
  }

  // ---- utils ---------------------------------------------------------------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    renderHeader();
    $('#btn-save').addEventListener('click', openSave);
    $('#btn-auth-close').addEventListener('click', closeAuth);
    $('#auth-modal').addEventListener('click', e => { if (e.target === $('#auth-modal')) closeAuth(); });
    $('#auth-toggle').addEventListener('click', () => openAuth($('#auth-toggle').dataset.mode || 'register'));
    $('#auth-form').addEventListener('submit', submitAuth);
    $('#save-close').addEventListener('click', closeSave);
    $('#save-modal').addEventListener('click', e => { if (e.target === $('#save-modal')) closeSave(); });
    $('#save-form').addEventListener('submit', submitSave);
    $('#schemas-close').addEventListener('click', closeSchemas);
    $('#schemas-modal').addEventListener('click', e => { if (e.target === $('#schemas-modal')) closeSchemas(); });
    $('#upgrade-close').addEventListener('click', closeUpgrade);
    $('#upgrade-modal').addEventListener('click', e => { if (e.target === $('#upgrade-modal')) closeUpgrade(); });
    $('#btn-pay-paypal').addEventListener('click', () => checkout('paypal'));
    $('#btn-go-pro').addEventListener('click', () => { closeSchemas(); openUpgrade(); });

    // refresh plan + payment methods on load
    api('/api/payment-methods').then(m => { state.methods = m; }).catch(() => {});
    if (state.token) {
      api('/api/me').then(d => { state.user = d.user; localStorage.setItem('sqlviz_user', JSON.stringify(d.user)); renderHeader(); })
        .catch(() => clearAuth());
    }
    // handle checkout return: PayPal redirects back with ?token=<orderId>, Stripe with ?checkout=success
    const qs = new URLSearchParams(location.search);
    const paypalOrderId = qs.get('token');
    if (paypalOrderId && state.token) {
      api('/api/checkout/paypal/capture', { method: 'POST', body: JSON.stringify({ orderId: paypalOrderId }) })
        .then(() => api('/api/me'))
        .then(d => { saveAuth(state.token, d.user); toast('Payment complete — you are now Pro!'); })
        .catch(e => toast('Payment capture failed: ' + e.message));
    } else if (/[?&]checkout=success/.test(location.search)) {
      if (state.token) api('/api/me').then(d => { saveAuth(state.token, d.user); toast('Thanks! Your plan is now Pro.'); }).catch(() => {});
    }
  }

  window.SQLVizPro = { api, openAuth, openSave, openSchemas, openUpgrade, toast, saveAuth, clearAuth, state };
  document.addEventListener('DOMContentLoaded', wire);
})();
