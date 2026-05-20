/**
 * ============================================================
 * SBA WALLET - Based on official Nintondo SDK docs v3
 * Uses window.nintondo.getInscriptions() for inscription fetching
 * Same method used by nintondo.io itself — bypasses CORS entirely
 * ============================================================
 */

(function () {
  'use strict';

  const NINTONDO_INSTALL = 'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';
  const SBA_PROXY = 'https://sba.superbellalliance.workers.dev';

  // ── Wait for nintondo to inject ──────────────────────────
  async function waitForNintondo(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if(document.readyState !== 'complete'){
      await new Promise(function(r){ window.addEventListener('load', r, {once:true}); });
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.nintondo) {
        console.log('[SBA] window.nintondo found!');
        return window.nintondo;
      }
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    console.warn('[SBA] window.nintondo not found after ' + timeoutMs + 'ms');
    return null;
  }

  window.SBAWallet = {
    addr: null,
    balance: 0,
    inscriptions: [],

    async connect() {
      console.log('[SBA] connect() called...');

      const nintondo = await waitForNintondo(10000);

      if (!nintondo) {
        console.error('[SBA] Nintondo not detected');
        const install = confirm(
          'Nintondo Wallet not detected!\n\n' +
          'Make sure:\n' +
          '1. Nintondo extension is installed\n' +
          '2. Extension is enabled for this site\n' +
          '3. Try refreshing the page\n\n' +
          'Click OK to open Chrome Web Store.'
        );
        if (install) window.open(NINTONDO_INSTALL, '_blank');
        return null;
      }

      try {
        console.log('[SBA] Calling nintondo.connect("bellsMainnet")...');
        const address = await nintondo.connect('bellsMainnet');
        if (!address) throw new Error('No address returned from connect()');
        console.log('[SBA] Connected:', address);
        this.addr = address;

        try {
          const sats = await nintondo.getBalance();
          this.balance = sats;
          console.log('[SBA] Balance:', sats, 'sats =', (sats / 1e8).toFixed(8), 'BEL');
        } catch (e) {
          console.warn('[SBA] getBalance failed:', e.message);
        }

        return address;

      } catch (e) {
        console.error('[SBA] connect() error:', e);
        if (e.code === 4001 || (e.message && e.message.toLowerCase().includes('reject'))) {
          alert('Connection rejected. Please approve in your Nintondo wallet.');
        } else {
          alert('Wallet error: ' + (e.message || String(e)));
        }
        return null;
      }
    },

    async getBalance() {
      if (!window.nintondo) return 0;
      try {
        const sats = await window.nintondo.getBalance();
        this.balance = sats;
        return sats;
      } catch (e) { return 0; }
    },

    getBalanceBEL() {
      return (this.balance / 100000000).toFixed(8);
    },

    async sendPayment(toAddress, belAmount) {
      if (!window.nintondo) throw new Error('Wallet not connected');
      const satoshis = Math.round(belAmount * 100000000);
      console.log('[SBA] createTx:', belAmount, 'BEL to', toAddress);
      return await window.nintondo.createTx({
        to: toAddress,
        amount: satoshis,
        receiverToPayFee: false,
        feeRate: 10
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

    /**
     * fetchInscriptions — uses window.nintondo.getInscriptions(offset, limit)
     * This is the SAME method nintondo.io uses on its own profile page.
     * The wallet extension handles the API call internally — no CORS issues.
     * Paginates through all pages until done.
     */
    async fetchInscriptions(address) {
      console.log('[SBA] fetchInscriptions for:', address);

      if (!window.nintondo) {
        console.warn('[SBA] window.nintondo not available for fetchInscriptions');
        return [];
      }

      // Check if getInscriptions is available on the wallet
      if (typeof window.nintondo.getInscriptions !== 'function') {
        console.warn('[SBA] window.nintondo.getInscriptions not available on this wallet version');
        console.warn('[SBA] Available methods:', Object.keys(window.nintondo));
        return [];
      }

      const allIds = [];
      const PAGE_SIZE = 100;
      let offset = 0;
      let total = null;

      try {
        while (true) {
          console.log('[SBA] Fetching inscriptions offset:', offset);
          const result = await window.nintondo.getInscriptions(offset, PAGE_SIZE);

          // result shape: { total: N, list: [...] } or just an array
          let items = [];
          if (result) {
            if (Array.isArray(result)) {
              items = result;
              // If no total known, stop when we get fewer than PAGE_SIZE
              if (items.length < PAGE_SIZE) {
                allIds.push(...this._extractIds(items));
                break;
              }
            } else {
              if (total === null) total = result.total || 0;
              items = result.list || result.inscriptions || result.data || [];
            }
          }

          const ids = this._extractIds(items);
          allIds.push(...ids);

          console.log('[SBA] Got', ids.length, 'inscriptions this page, total so far:', allIds.length);

          offset += PAGE_SIZE;

          // Stop if we've fetched everything
          if (total !== null && allIds.length >= total) break;
          if (items.length < PAGE_SIZE) break;
          if (items.length === 0) break;
        }

        console.log('[SBA] Total inscriptions fetched:', allIds.length);
        this.inscriptions = allIds;
        return allIds;

      } catch (e) {
        console.error('[SBA] getInscriptions failed:', e.message || e);
        return [];
      }
    },

    _extractIds(items) {
      return items.map(function (item) {
        if (typeof item === 'string') return item;
        return item.id || item.inscription_id || item.inscriptionId ||
          item.inscription || item.txid || null;
      }).filter(Boolean);
    },

    isInstalled() {
      return typeof window.nintondo !== 'undefined';
    },

    onAccountChange(callback) {
      if (window.nintondo && window.nintondo.on) {
        window.nintondo.on('accountsChanged', callback);
      }
    }
  };

  if (typeof window.nintondo !== 'undefined') {
    console.log('[SBA] Nintondo already injected on load');
  } else {
    console.log('[SBA] Waiting for Nintondo to inject...');
  }

})();
