/**
 * ============================================================
 * SBA WALLET v7
 * Inscription fetching — UTXO matching strategy:
 *   1. Fetch UTXOs via CF Worker /utxo proxy (no CORS issues)
 *   2. Build inscription ID: txid + "i" + vout for each UTXO
 *   3. Match against SBA_LOOKUP hardcoded in the page
 *   4. Fallback: try ord.nintondo.io via /inscriptions proxy
 * This works completely offline from ord.nintondo.io!
 * ============================================================
 */

(function () {
  'use strict';

  const NINTONDO_INSTALL = 'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';
  const SBA_WORKER = 'https://sba.superbellalliance.workers.dev';

  async function waitForNintondo(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if (document.readyState !== 'complete') {
      await new Promise(function (r) { window.addEventListener('load', r, { once: true }); });
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
     * fetchInscriptions
     *
     * PRIMARY STRATEGY — UTXO Matching (no ord.nintondo.io needed):
     *   Each inscription lives in a UTXO. The inscription ID is:
     *   txid + "i" + vout  (e.g. "abc123...i0")
     *   We fetch all UTXOs for the address, build the ID for each one,
     *   then check if it exists in SBA_LOOKUP (hardcoded in the page).
     *   This works even when ord.nintondo.io is offline!
     *
     * FALLBACK — /inscriptions proxy via CF Worker
     */
    async fetchInscriptions(address) {
      console.log('[SBA] fetchInscriptions for:', address);

      // ── Primary: UTXO matching ────────────────────────────────
      try {
        const ids = await this._fetchViaUtxoMatch(address);
        if (ids && ids.length > 0) {
          console.log('[SBA] Got', ids.length, 'inscriptions via UTXO matching');
          this.inscriptions = ids;
          return ids;
        }
        console.log('[SBA] UTXO match found 0 SBA inscriptions, trying API fallback...');
      } catch (e) {
        console.warn('[SBA] UTXO matching failed:', e.message);
      }

      // ── Fallback: CF Worker /inscriptions proxy ───────────────
      try {
        const ids = await this._fetchViaWorker(address);
        if (ids && ids.length > 0) {
          console.log('[SBA] Got', ids.length, 'inscriptions via CF Worker');
          this.inscriptions = ids;
          return ids;
        }
      } catch (e) {
        console.warn('[SBA] CF Worker fetch failed:', e.message);
      }

      console.log('[SBA] No inscriptions found for', address);
      return [];
    },

    /**
     * UTXO Matching Strategy
     * Fetch UTXOs → build inscription ID (txid+i+vout) → return all IDs
     * Dashboard/Assemble pages match these against SBA_LOOKUP themselves
     */
    async _fetchViaUtxoMatch(address) {
      console.log('[SBA] Fetching UTXOs via CF Worker for:', address);

      const url = `${SBA_WORKER}/utxo?address=${encodeURIComponent(address)}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

      if (!res.ok) throw new Error('UTXO fetch failed: ' + res.status);

      const utxos = await res.json();
      if (!Array.isArray(utxos) || utxos.length === 0) {
        console.log('[SBA] No UTXOs returned');
        return [];
      }

      console.log('[SBA] Got', utxos.length, 'UTXOs, building inscription IDs...');

      // Build inscription ID from each UTXO: txid + "i" + vout
      const ids = utxos.map(u => u.txid + 'i' + u.vout);
      console.log('[SBA] Built', ids.length, 'potential inscription IDs from UTXOs');

      return ids;
    },

    // ── CF Worker /inscriptions fallback ───────────────────────
    async _fetchViaWorker(address) {
      const allIds = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const url = `${SBA_WORKER}/inscriptions?address=${encodeURIComponent(address)}&offset=${offset}&limit=${limit}`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) break;
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.list || data.inscriptions || data.data || []);
        const ids = this._extractIds(items);
        allIds.push(...ids);
        if (items.length < limit) break;
        offset += limit;
      }

      return allIds;
    },

    _extractIds(items) {
      return items.map(function (item) {
        if (typeof item === 'string') return item;
        return item.id || item.inscription_id || item.inscriptionId || item.txid || null;
      }).filter(Boolean);
    },

    isInstalled() { return typeof window.nintondo !== 'undefined'; },

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
