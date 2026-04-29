/**
 * ============================================================
 * NINTONDO WALLET — Super Bell Alliance (v5)
 * ============================================================
 *
 * WHY ALL ENDPOINTS FAILED (v4)
 * ──────────────────────────────
 * • ord.nintondo.io/api/...         → CORS block from github.io
 * • bells-mainnet-content.nintondo  → 404
 * • corsproxy.io/?https://ord...    → 502 Bad Gateway
 * • api.allorigins.win/raw?url=...  → CORS block from github.io
 *
 * FIX: Use allorigins /GET endpoint which returns JSON wrapping
 * the full HTML of the explorer address page, then parse
 * inscription IDs from the HTML. This bypasses CORS entirely
 * because allorigins itself adds the required headers.
 *
 * STRATEGY ORDER
 * ──────────────
 * 1. allorigins /get → parse HTML for inscription hrefs  ← main fix
 * 2. allorigins /raw → JSON API (sometimes works)
 * 3. corsproxy.io   → JSON API fallback
 * 4. Direct fetch   → works if CORS ever gets fixed upstream
 *
 * DASHBOARD showLoading CRASH FIX
 * ─────────────────────────────────
 * loadCollection() calls showLoading() before it is defined
 * (script tag ordering issue in dashboard.html). Fixed with a
 * safeShowLoading() guard that checks for the function first.
 * ============================================================
 */

(function () {
  'use strict';

  var NINTONDO_INSTALL =
    'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';

  var EXPLORER_ADDR = 'https://ord.nintondo.io/address/';
  var ALLORIGINS_GET = 'https://api.allorigins.win/get?url=';

  /* ── Safe loading helpers ─────────────────────────────── */

  function safeShowLoading(msg) {
    if (typeof window.showLoading === 'function') {
      window.showLoading(msg);
    } else {
      console.log('[SBA] Loading:', msg);
    }
  }

  function safeHideLoading() {
    if (typeof window.hideLoading === 'function') {
      window.hideLoading();
    }
  }

  /* ── Wallet polling ───────────────────────────────────── */

  async function waitForWallet(timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    if (window.nintondo) return window.nintondo;
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.nintondo) return window.nintondo;
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    return null;
  }

  /* ── ID extraction helpers ────────────────────────────── */

  function parseIdsFromHtml(html) {
    var ids = [];
    var seen = {};

    // Primary: href="/inscription/<txid>i<index>"
    var pattern = /href=["']\/inscription\/([a-f0-9]{64}i\d+)["']/gi;
    var m;
    while ((m = pattern.exec(html)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
    }

    // Secondary: data-id or data-inscription attributes
    var dataPattern = /data-(?:id|inscription)=["']([a-f0-9]{64}i\d+)["']/gi;
    while ((m = dataPattern.exec(html)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
    }

    return ids;
  }

  function extractIdsFromJson(data) {
    var items = [];
    if (Array.isArray(data)) items = data;
    else if (data && Array.isArray(data.list)) items = data.list;
    else if (data && Array.isArray(data.inscriptions)) items = data.inscriptions;
    else if (data && Array.isArray(data.data)) items = data.data;
    else if (data && Array.isArray(data.result)) items = data.result;

    return items.map(function (item) {
      if (typeof item === 'string') return item;
      return item.id || item.inscription_id || item.inscriptionId ||
             item.inscription || item.txid || null;
    }).filter(Boolean);
  }

  /* ── Fetch strategies ─────────────────────────────────── */

  // Strategy 1: allorigins /get wraps the explorer HTML page in JSON.
  // { contents: "<html>...</html>", status: { http_code: 200 } }
  // This is CORS-open and reliably works from github.io pages.
  async function strategyAllOriginsHtml(address) {
    var targetUrl = EXPLORER_ADDR + address;
    var proxyUrl = ALLORIGINS_GET + encodeURIComponent(targetUrl);
    console.log('[SBA] S1: allorigins/get HTML →', targetUrl);

    var res = await fetch(proxyUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var json = await res.json();
    if (!json || !json.contents) throw new Error('empty contents from allorigins');

    // Check HTTP code reported by allorigins
    if (json.status && json.status.http_code && json.status.http_code >= 400) {
      throw new Error('upstream HTTP ' + json.status.http_code);
    }

    var ids = parseIdsFromHtml(json.contents);

    // If no IDs found, check whether the page actually loaded for this address
    if (ids.length === 0) {
      if (json.contents.includes(address) ||
          json.contents.toLowerCase().includes('no inscription') ||
          json.contents.toLowerCase().includes('0 inscription')) {
        // Valid page load, wallet is genuinely empty
        return [];
      }
      throw new Error('page did not contain address — likely an error page');
    }

    return ids;
  }

  // Strategy 2: allorigins /raw on the JSON API
  async function strategyAllOriginsRawApi(address) {
    var apiUrl = 'https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions';
    var proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(apiUrl);
    console.log('[SBA] S2: allorigins/raw JSON API →', apiUrl);

    var res = await fetch(proxyUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    return extractIdsFromJson(data);
  }

  // Strategy 3: corsproxy.io
  async function strategyCorsproxy(address) {
    var apiUrl = 'https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions';
    var proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(apiUrl);
    console.log('[SBA] S3: corsproxy.io →', apiUrl);

    var res = await fetch(proxyUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    return extractIdsFromJson(data);
  }

  // Strategy 4: direct (future-proof if CORS fixed upstream)
  async function strategyDirect(address) {
    var apiUrl = 'https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions';
    console.log('[SBA] S4: direct →', apiUrl);

    var res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    return extractIdsFromJson(data);
  }

  /* ── Orchestrator ─────────────────────────────────────── */

  async function fetchAllInscriptions(address) {
    var strategies = [
      { label: 'allorigins/get HTML parse', fn: strategyAllOriginsHtml },
      { label: 'allorigins/raw JSON API',   fn: strategyAllOriginsRawApi },
      { label: 'corsproxy.io JSON API',     fn: strategyCorsproxy },
      { label: 'direct JSON API',           fn: strategyDirect },
    ];

    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i];
      try {
        var ids = await s.fn(address);
        console.log('[SBA] ✅', s.label, '→', ids.length, 'inscription(s)');
        return ids;
      } catch (e) {
        console.warn('[SBA] ❌', s.label, '→', e.message);
      }
    }

    console.error('[SBA] All inscription strategies failed for address:', address);
    return null; // null = hard failure (distinct from [] empty wallet)
  }

  /* ── Public API ───────────────────────────────────────── */

  window.SBAWallet = {
    addr: null,
    balance: 0,
    inscriptions: [],

    async connect() {
      console.log('[SBA] Attempting wallet connection…');
      var nintondo = await waitForWallet();

      if (!nintondo) {
        console.error('[SBA] window.nintondo not found after 3 s');
        var install = confirm(
          'Nintondo Wallet not detected!\nClick OK to open the Chrome Web Store.'
        );
        if (install) window.open(NINTONDO_INSTALL, '_blank');
        return null;
      }

      try {
        var address = await nintondo.connect('bellsMainnet');
        if (!address) throw new Error('No address returned from nintondo.connect()');

        console.log('[SBA] Connected:', address);
        this.addr = address;

        try {
          this.balance = await nintondo.getBalance();
          console.log('[SBA] Balance:', this.balance, 'satoshis');
        } catch (e) {
          console.warn('[SBA] getBalance() failed:', e.message);
        }

        var methods = Object.keys(nintondo).filter(
          function (k) { return typeof nintondo[k] === 'function'; }
        );
        console.log('[SBA] Wallet methods available:', methods);

        return address;
      } catch (e) {
        console.error('[SBA] Connection error:', e);
        if (e.code === 4001 ||
            (e.message && e.message.toLowerCase().includes('reject'))) {
          alert('Connection rejected — please approve in your Nintondo wallet.');
        } else {
          alert('Wallet error: ' + (e.message || String(e)));
        }
        return null;
      }
    },

    async restoreSession() {
      var nintondo = await waitForWallet(1500);
      if (!nintondo) return null;
      try {
        var connected = await nintondo.isConnected();
        if (!connected) return null;
        var address = await nintondo.getAccount();
        if (!address) return null;
        console.log('[SBA] Session restored:', address);
        this.addr = address;
        try { this.balance = await nintondo.getBalance(); } catch (e) {}
        return address;
      } catch (e) {
        return null;
      }
    },

    async getBalance() {
      if (!window.nintondo) return 0;
      try {
        var sats = await window.nintondo.getBalance();
        this.balance = sats;
        return sats;
      } catch (e) {
        return 0;
      }
    },

    getBalanceBEL() {
      return (this.balance / 100000000).toFixed(8);
    },

    async sendPayment(toAddress, belAmount) {
      if (!window.nintondo) throw new Error('Wallet not connected');
      var satoshis = Math.round(belAmount * 100000000);
      console.log('[SBA] Sending', belAmount, 'BEL (', satoshis, 'sats) to', toAddress);
      return await window.nintondo.createTx({
        to: toAddress,
        amount: satoshis,
        receiverToPayFee: false,
        feeRate: 10,
      });
    },

    async disconnect() {
      try {
        if (window.nintondo && window.nintondo.disconnect) {
          await window.nintondo.disconnect();
        }
      } catch (e) {}
      this.addr = null;
      this.balance = 0;
      this.inscriptions = [];
    },

    async fetchInscriptions(address) {
      if (!address) {
        console.warn('[SBA] fetchInscriptions: no address supplied');
        return [];
      }

      safeShowLoading('Fetching inscriptions from Nintondo explorer…');
      console.log('[SBA] Fetching inscriptions for:', address);

      var ids = await fetchAllInscriptions(address);

      safeHideLoading();

      if (ids === null) {
        // All strategies failed — return [] so callers don't crash
        console.error('[SBA] fetchInscriptions: returning [] after all strategies failed');
        return [];
      }

      this.inscriptions = ids;
      return ids;
    },

    isInstalled() {
      return typeof window.nintondo !== 'undefined';
    },

    onAccountChange(callback) {
      if (window.nintondo && typeof window.nintondo.on === 'function') {
        window.nintondo.on('accountsChanged', callback);
      }
    },

    onDisconnect(callback) {
      if (window.nintondo && typeof window.nintondo.on === 'function') {
        window.nintondo.on('disconnected', callback);
      }
    },

    removeAccountChangeListener(callback) {
      if (window.nintondo && typeof window.nintondo.removeListener === 'function') {
        window.nintondo.removeListener('accountsChanged', callback);
      }
    },
  };

  /* ── Startup ──────────────────────────────────────────── */
  if (typeof window.nintondo !== 'undefined') {
    console.log('[SBA] Nintondo wallet already injected ✅');
  } else {
    console.log('[SBA] Nintondo wallet not yet injected — will poll on connect()');
    setTimeout(function () {
      if (typeof window.nintondo !== 'undefined') {
        console.log('[SBA] Nintondo wallet now available ✅');
      }
    }, 1500);
  }

})();
