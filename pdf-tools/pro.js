/* SQLViz PDF Tools — Pro unlock: accounts + PayPal payments (shared SQLViz backend). */
(function () {
  'use strict';

  const API = 'https://ghostwhite-dragonfly-572429.hostingersite.com';
  const $ = (s) => document.querySelector(s);

  // Tools that require Pro. The rest stay free for everyone.
  const PREMIUM = { img2pdf: 1, pdf2jpg: 1, rotate: 1, remove: 1, numbers: 1 };

  const state = {
    token: localStorage.getItem('sqlviz_token') || null,
    user: JSON.parse(localStorage.getItem('sqlviz_user') || 'null'),
    methods: { paypal: false },
    authMode: 'login',
    trialUsed: false,
  };

  function isPro() { return !!(state.user && state.user.plan === 'pro'); }
  function isLocked(toolId) { return !!PREMIUM[toolId] && !isPro(); }

  function saveAuth(token, user) {
    state.token = token; state.user = user;
    localStorage.setItem('sqlviz_token', token);
    localStorage.setItem('sqlviz_user', JSON.stringify(user));
    renderAuth();
  }
  function clearAuth() {
    state.token = null; state.user = null;
    localStorage.removeItem('sqlviz_token');
    localStorage.removeItem('sqlviz_user');
    renderAuth();
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
      const err = new Error((data && data.error) || 'Request failed');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  // ---- header + lock badges ----------------------------------------------
  function renderAuth() {
    const area = $('#pro-area');
    if (!area) return;
    if (state.user) {
      area.innerHTML = (isPro() ? '<span class="plan-badge pro">PRO</span>' : '<span class="plan-badge free">FREE</span>') +
        '<button id="pro-signout" class="btn btn-ghost btn-sm">Sign out</button>';
      $('#pro-signout').addEventListener('click', () => {
        api('/api/logout', { method: 'POST' }).catch(() => {});
        clearAuth();
      });
    } else {
      area.innerHTML = '<button id="pro-signin" class="btn btn-sm">Sign in</button>';
      $('#pro-signin').addEventListener('click', () => openUpgrade(null));
    }
    renderLocks();
  }

  function renderLocks() {
    const unlocked = isPro();
    document.querySelectorAll('.tool-card').forEach((card) => {
      const prem = !!PREMIUM[card.dataset.tool];
      let badge = card.querySelector('.tc-lock');
      if (prem && !unlocked) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tc-lock';
          badge.textContent = 'PRO';
          card.appendChild(badge);
        }
        card.classList.add('locked');
      } else {
        if (badge) badge.remove();
        card.classList.remove('locked');
      }
    });
  }

  // ---- modals --------------------------------------------------------------
  function openUpgrade(toolName, trialUsed) {
    $('#upgrade-tool').textContent = toolName || 'every PDF tool';
    state.trialUsed = !!trialUsed;
    refreshUpgradeView();
    $('#upgrade-modal').hidden = false;
  }
  function closeUpgrade() { $('#upgrade-modal').hidden = true; }

  // A few free uses of the paid tools, counted per IP on the server so the same
  // visitor cannot just keep coming back for free.
  async function requestAccess(toolId, toolName, onGranted) {
    if (isPro()) { onGranted(); return; }
    try {
      const r = await api('/api/pdf/trial', { method: 'POST', body: JSON.stringify({ tool: toolId }) });
      if (r.allowed) {
        toast('Free trial: ' + r.remaining + ' of ' + r.limit + ' uses left after this one');
        onGranted();
        return;
      }
      openUpgrade(toolName, true);
    } catch (e) {
      openUpgrade(toolName, true);
    }
  }

  function refreshUpgradeView() {
    const signedIn = !!state.user;
    $('#upgrade-auth').hidden = signedIn;
    $('#upgrade-pay').hidden = !signedIn;
    if (!signedIn) {
      const trialNote = state.trialUsed ? 'Your free trial uses are finished. ' : '';
      $('#upgrade-text').textContent = trialNote + 'This tool is part of PDF Pro. Sign in or create a free account, then subscribe for €5.90/month.';
      $('#up-auth-heading').textContent = state.authMode === 'login' ? 'Sign in' : 'Create account';
      $('#up-auth-toggle').textContent = state.authMode === 'login' ? 'New here? Create a free account' : 'Already have an account? Sign in';
    } else {
      const trialNote = state.trialUsed ? 'Your free trial uses are finished. ' : '';
      $('#upgrade-text').textContent = trialNote + 'Unlock every PDF tool and unlimited saved schemas for €5.90/month — cancel anytime.';
      const btn = $('#up-paypal');
      btn.disabled = !state.methods.paypal;
      btn.textContent = state.methods.paypal ? (isPro() ? 'You already have Pro' : 'Subscribe — €5.90/month') : 'Payments unavailable right now';
    }
  }

  async function submitAuth(e) {
    e.preventDefault();
    const mode = state.authMode;
    const email = $('#up-email').value.trim();
    const password = $('#up-password').value;
    const btn = $('#up-submit');
    btn.disabled = true;
    $('#up-error').textContent = '';
    try {
      const data = await api(mode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      if (mode === 'register') {
        state.authMode = 'login';
        $('#up-error').textContent = 'Account created — check your email to verify, then sign in.';
        refreshUpgradeView();
      } else {
        saveAuth(data.token, data.user);
        refreshUpgradeView();
        toast(isPro() ? 'Welcome back — you already have Pro.' : 'Signed in. Finish the upgrade below.');
      }
    } catch (err) {
      if (err.status === 403 && err.data && err.data.verify) {
        $('#up-error').innerHTML = 'Please verify your email first. <a href="#" id="up-resend">Resend email</a>';
        const l = $('#up-resend');
        if (l) l.addEventListener('click', async (ev) => {
          ev.preventDefault();
          try { await api('/api/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }); toast('Verification email sent'); }
          catch (e2) { toast(e2.message, true); }
        });
      } else {
        $('#up-error').textContent = err.message;
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function checkout() {
    try {
      const data = await api('/api/checkout/paypal/subscribe', { method: 'POST', body: JSON.stringify({ returnPath: '/pdf-tools/' }) });
      if (data.subscriptionId) localStorage.setItem('sqlviz_sub_id', data.subscriptionId);
      if (data.approveUrl) window.location.href = data.approveUrl;
      else toast('Could not start checkout.', true);
    } catch (err) { toast(err.message, true); }
  }

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 4200);
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    renderAuth();
    api('/api/payment-methods').then((m) => { state.methods = m; refreshUpgradeView(); }).catch(() => {});

    const qs = new URLSearchParams(location.search);
    const subId = qs.get('subscription_id') || qs.get('token') || localStorage.getItem('sqlviz_sub_id');
    if (qs.get('checkout') === 'success' && subId && state.token) {
      // PayPal sends the buyer back with ?subscription_id=... — confirm it server-side.
      api('/api/subscription/refresh', { method: 'POST', body: JSON.stringify({ subscriptionId: subId }) })
        .then((d) => api('/api/me').then((m) => ({ d, m })))
        .then(({ d, m }) => {
          localStorage.removeItem('sqlviz_sub_id');
          saveAuth(state.token, m.user);
          history.replaceState({}, '', location.pathname);
          toast(d.plan === 'pro' ? 'Subscription active — PDF Pro unlocked!' : 'Subscription status: ' + (d.status || 'pending'));
        })
        .catch((e) => toast('Could not confirm the subscription: ' + e.message, true));
    } else if (qs.get('checkout') === 'success' && state.token) {
      api('/api/subscription/refresh', { method: 'POST', body: '{}' })
        .then(() => api('/api/me'))
        .then((m) => { saveAuth(state.token, m.user); history.replaceState({}, '', location.pathname); toast('Thanks — your Pro status was refreshed.'); })
        .catch(() => {});
    } else if (qs.get('checkout') === 'cancel') {
      toast('Checkout cancelled.');
      history.replaceState({}, '', location.pathname);
    }
    if (state.token) {
      api('/api/me').then((d) => { state.user = d.user; localStorage.setItem('sqlviz_user', JSON.stringify(d.user)); renderAuth(); }).catch(() => clearAuth());
    }
    // Email CTA links land here with ?upgrade=1 → open the upgrade modal.
    if (qs.get('upgrade')) {
      setTimeout(() => { if (!isPro()) openUpgrade(null, true); }, 600);
    }

    $('#upgrade-close').addEventListener('click', closeUpgrade);
    $('#upgrade-modal').addEventListener('click', (e) => { if (e.target === $('#upgrade-modal')) closeUpgrade(); });
    $('#up-auth-form').addEventListener('submit', submitAuth);
    $('#up-auth-toggle').addEventListener('click', () => {
      state.authMode = state.authMode === 'login' ? 'register' : 'login';
      refreshUpgradeView();
    });
    $('#up-paypal').addEventListener('click', checkout);
    $('#up-signout').addEventListener('click', () => {
      api('/api/logout', { method: 'POST' }).catch(() => {});
      clearAuth();
      refreshUpgradeView();
    });
  }

  window.PDFPro = { isPro: isPro, isLocked: isLocked, openUpgrade: openUpgrade, requestAccess: requestAccess, renderLocks: renderLocks, state: state, toast: toast };
  document.addEventListener('DOMContentLoaded', wire);
})();
