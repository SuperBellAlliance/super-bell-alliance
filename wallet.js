/**
 * ============================================================
 * NINTONDO WALLET — Super Bell Alliance (v4)
 * Updated to match official Nintondo SDK provider docs:
 * https://docs.nintondo.io/docs/to-developers/nintondo-wallet/nintondo-sdk/provider
 * ============================================================
 *
 * KEY CORRECTIONS vs v3
 * ─────────────────────
 * 1. API surface: The extension injects `window.nintondo`, which is
 *    the provider object itself. All methods live directly on it —
 *    NOT on `window.nintondo.provider`. Call nintondo.connect(),
 *    nintondo.getBalance(), etc. directly.
 *
 * 2. connect() signature: docs show `nintondo.connect(networkType?)`
 *    with default "bellsMainnet". v3 already passed this correctly.
 *
 * 3. getBalance() returns a raw number (satoshis). v3 handled this OK.
 *
 * 4. getAccount() / isConnected() — official methods for checking
 *    session state without re-prompting the user. Use these on page
 *    load to auto-restore a session.
 *
 * 5. Inscriptions: The Nintondo wallet does NOT expose a
 *    getInscriptions() method in the documented public API. You must
 *    query the ord.nintondo.io REST API. The v3 "try every method
 *    name" loop was speculative and messy; this version goes straight
 *    to the API with a clean fallback chain.
 *
 * 6. Event API: `nintondo.on('accountsChanged', cb)` and
 *    `nintondo.on('disconnected', cb)` are the two documented events.
 *    Use removeListener() / removeAllListeners() to clean up.
 *
 * 7. createTx payload typo: docs spell it `receiverToPayFee` (NOT
 *    `recaiverToPayFee`). v3 already had the correct spelling.
 * ============================================================
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────── */

  const NINTONDO_INSTALL =
    'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';

  /**
   * Ordered list of REST endpoints used to fetch inscriptions.
   * Each is a function so the address is interpolated lazily.
   * We try them in order and return the first successful result.
   */
  const INSCRIPTION_ENDPOINTS = [
    (addr) =>
      `https://ord.nintondo.io/api/v1/address/${addr}/inscriptions`,
    (addr) =>
      `https://bells-mainnet-content.nintondo.io/api/v1/address/${addr}/inscriptions`,
    // CORS proxies as last-resort fallbacks
    (addr) =>
      `https://corsproxy.io/?${encodeURIComponent(
        `https://ord.nintondo.io/api/v1/address/${addr}/inscriptions`
      )}`,
    (addr) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(
        `https://ord.nintondo.io/api/v1/address/${addr}/inscriptions`
      )}`,
  ];

  /* ── Utilities ─────────────────────────────────────────── */

  /**
   * Poll for `window.nintondo` up to `timeoutMs` milliseconds.
   * The extension injects the object asynchronously after page load.
   */
  async function waitForWallet(timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    if (window.nintondo) return window.nintondo;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.nintondo) return window.nintondo;
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    return null;
  }

  /**
   * Extract a flat array of inscription ID strings from whatever
   * shape the API returns.
   */
  function extractIds(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map(function (item) {
        if (typeof item === 'string') return item;
        return (
          item.id ||
          item.inscription_id ||
          item.inscriptionId ||
          item.inscription ||
          item.txid ||
          null
        );
      })
      .filter(Boolean);
  }

  /**
   * Normalise varying API response shapes into a plain array.
   */
  function normaliseResponse(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.list)) return data.list;
    if (data && Array.isArray(data.inscriptions)) return data.inscriptions;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.result)) return data.result;
    return [];
  }

  /* ── SBAWallet public object ───────────────────────────── */

  window.SBAWallet = {
    addr: null,
    balance: 0,
    inscriptions: [],

    /* ── connect ──────────────────────────────────────────
     * Prompts the user to approve the connection.
     * Returns the connected address string, or null on failure.
     */
    async connect() {
      console.log('[SBA] Attempting wallet connection…');
      const nintondo = await waitForWallet();

      if (!nintondo) {
        console.error('[SBA] window.nintondo not found after 3 s');
        const install = confirm(
          'Nintondo Wallet not detected!\nClick OK to open the Chrome Web Store.'
        );
        if (install) window.open(NINTONDO_INSTALL, '_blank');
        return null;
      }

      try {
        // connect() returns the address string on success.
        // The network parameter defaults to "bellsMainnet".
        const address = await nintondo.connect('bellsMainnet');
        if (!address) throw new Error('No address returned from nintondo.connect()');

        console.log('[SBA] Connected:', address);
        this.addr = address;

        // Fetch balance immediately after connecting
        try {
          this.balance = await nintondo.getBalance();
          console.log('[SBA] Balance:', this.balance, 'satoshis');
        } catch (e) {
          console.warn('[SBA] getBalance() failed:', e.message);
        }

        // Log available methods for debugging during development
        const methods = Object.keys(nintondo).filter(
          (k) => typeof nintondo[k] === 'function'
        );
        console.log('[SBA] Wallet methods available:', methods);

        return address;
      } catch (e) {
        console.error('[SBA] Connection error:', e);
        if (
          e.code === 4001 ||
          (e.message && e.message.toLowerCase().includes('reject'))
        ) {
          alert('Connection rejected — please approve in your Nintondo wallet.');
        } else {
          alert('Wallet error: ' + (e.message || String(e)));
        }
        return null;
      }
    },

    /* ── restoreSession ───────────────────────────────────
     * Silently checks whether a session is already active
     * (user previously approved and hasn't disconnected).
     * Useful on page load — does NOT show a connect prompt.
     * Returns the address string if a session exists, or null.
     */
    async restoreSession() {
      const nintondo = await waitForWallet(1500);
      if (!nintondo) return null;

      try {
        // isConnected() is documented and never triggers a prompt.
        const connected = await nintondo.isConnected();
        if (!connected) return null;

        // getAccount() returns the current address without prompting.
        const address = await nintondo.getAccount();
        if (!address) return null;

        console.log('[SBA] Session restored:', address);
        this.addr = address;

        try {
          this.balance = await nintondo.getBalance();
        } catch (e) {
          console.warn('[SBA] getBalance() failed on restore:', e.message);
        }

        return address;
      } catch (e) {
        // Not an error — simply no active session
        console.log('[SBA] No active session:', e.message);
        return null;
      }
    },

    /* ── getBalance ───────────────────────────────────────
     * Returns current balance in satoshis (updates this.balance).
     */
    async getBalance() {
      if (!window.nintondo) return 0;
      try {
        const sats = await window.nintondo.getBalance();
        this.balance = sats;
        return sats;
      } catch (e) {
        console.warn('[SBA] getBalance() error:', e.message);
        return 0;
      }
    },

    /* ── getBalanceBEL ────────────────────────────────────
     * Convenience: returns balance as a human-readable BEL string.
     */
    getBalanceBEL() {
      return (this.balance / 100000000).toFixed(8);
    },

    /* ── sendPayment ──────────────────────────────────────
     * Creates and signs a BEL transfer transaction.
     * Returns the signed transaction hex string.
     *
     * NOTE: `createTx` returns a *signed hex* string, not a txid.
     * You must still broadcast it (e.g. via the Nintondo API or a
     * Bellscoin node) if you need on-chain confirmation tracking.
     */
    async sendPayment(toAddress, belAmount) {
      if (!window.nintondo) throw new Error('Wallet not connected');
      const satoshis = Math.round(belAmount * 100000000);
      console.log('[SBA] Sending', belAmount, 'BEL (', satoshis, 'sats) to', toAddress);

      // Field spellings taken verbatim from the official docs:
      // to, amount, receiverToPayFee, feeRate
      return await window.nintondo.createTx({
        to: toAddress,
        amount: satoshis,
        receiverToPayFee: false,  // buyer pays fee on top
        feeRate: 10,              // sat/vByte
      });
    },

    /* ── disconnect ───────────────────────────────────────
     * Disconnects the wallet and clears local state.
     */
    async disconnect() {
      try {
        if (window.nintondo && window.nintondo.disconnect) {
          await window.nintondo.disconnect();
        }
      } catch (e) {
        // Ignore — extension may already be in a disconnected state
      }
      this.addr = null;
      this.balance = 0;
      this.inscriptions = [];
    },

    /* ── fetchInscriptions ────────────────────────────────
     * Retrieves the list of inscription IDs held by `address`
     * from the ord.nintondo.io REST API.
     *
     * The Nintondo wallet provider does NOT expose a documented
     * getInscriptions() method in its public SDK — inscription
     * data must be fetched from the indexer API instead.
     *
     * Returns an array of inscription ID strings (may be empty).
     */
    async fetchInscriptions(address) {
      if (!address) {
        console.warn('[SBA] fetchInscriptions: no address supplied');
        return [];
      }
      console.log('[SBA] Fetching inscriptions for:', address);

      for (const buildUrl of INSCRIPTION_ENDPOINTS) {
        const url = buildUrl(address);
        console.log('[SBA] Trying:', url.slice(0, 80) + (url.length > 80 ? '…' : ''));
        try {
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) {
            console.log('[SBA] HTTP', res.status, '—', url.slice(0, 60));
            continue;
          }
          const data = await res.json();
          const items = normaliseResponse(data);
          if (items.length > 0) {
            const ids = extractIds(items);
            if (ids.length > 0) {
              console.log('[SBA] ✅ Got', ids.length, 'inscription(s)');
              this.inscriptions = ids;
              return ids;
            }
          }
        } catch (e) {
          console.warn('[SBA] Endpoint failed:', e.message);
        }
      }

      console.warn('[SBA] All inscription endpoints failed — returning []');
      return [];
    },

    /* ── isInstalled ──────────────────────────────────────
     * Quick synchronous check for the extension object.
     */
    isInstalled() {
      return typeof window.nintondo !== 'undefined';
    },

    /* ── onAccountChange ──────────────────────────────────
     * Subscribes to wallet account-switch events.
     * The official event name is 'accountsChanged'.
     */
    onAccountChange(callback) {
      if (window.nintondo && typeof window.nintondo.on === 'function') {
        window.nintondo.on('accountsChanged', callback);
      }
    },

    /* ── onDisconnect ─────────────────────────────────────
     * Subscribes to the 'disconnected' event (network change or
     * user-initiated disconnect from the extension popup).
     */
    onDisconnect(callback) {
      if (window.nintondo && typeof window.nintondo.on === 'function') {
        window.nintondo.on('disconnected', callback);
      }
    },

    /* ── removeAccountChangeListener ─────────────────────*/
    removeAccountChangeListener(callback) {
      if (window.nintondo && typeof window.nintondo.removeListener === 'function') {
        window.nintondo.removeListener('accountsChanged', callback);
      }
    },
  };

  /* ── Startup logging ────────────────────────────────────── */
  if (typeof window.nintondo !== 'undefined') {
    console.log('[SBA] Nintondo wallet already injected ✅');
  } else {
    console.log('[SBA] Nintondo wallet not yet injected — will poll on connect()');
    // Soft check after 1.5 s (covers most slow extension starts)
    setTimeout(function () {
      if (typeof window.nintondo !== 'undefined') {
        console.log('[SBA] Nintondo wallet now available ✅');
      }
    }, 1500);
  }

})();
