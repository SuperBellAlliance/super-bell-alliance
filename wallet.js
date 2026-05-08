/**
 * ============================================================
 * SBA WALLET - Based on official Nintondo SDK docs v3
 * https://docs.nintondo.io/docs/nintondo-wallet/nintondo-sdk/provider
 * ============================================================
 */

(function () {
  'use strict';

  const NINTONDO_INSTALL = 'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';
  const SBA_PROXY = 'https://sba.superbellalliance.workers.dev';

  // ── Wait for nintondo to inject ──────────────────────────
  // The extension injects window.nintondo after page load.
  // We poll for up to 10 seconds.
  async function waitForNintondo(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    // Wait for DOM to be ready first
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

        // Official API: nintondo.connect(networkType)
        const address = await nintondo.connect('bellsMainnet');

        if (!address) throw new Error('No address returned from connect()');

        console.log('[SBA] Connected:', address);
        this.addr = address;

        // Get balance
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
      // Official API: nintondo.createTx(payload)
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

    async fetchInscriptions(address) {
      console.log('[SBA] fetchInscriptions for:', address);

      // PRIMARY: Nintondo mainnet API (same one used for UTXOs - works!)
      const NINTONDO_API = 'https://bells-mainnet-api.nintondo.io';
      const apiEndpoints = [
        `${NINTONDO_API}/address/${address}/inscriptions`,
        `${NINTONDO_API}/address/${address}/inscription`,
        `${NINTONDO_API}/addr/${address}/inscriptions`,
      ];

      for (const url of apiEndpoints) {
        try {
          console.log('[SBA] Trying:', url);
          const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
          console.log('[SBA] Response:', res.status, url);
          if (res.ok) {
            const data = await res.json();
            console.log('[SBA] Data sample:', JSON.stringify(data).slice(0,200));
            const items = Array.isArray(data) ? data :
              (data.list || data.inscriptions || data.data || data.result || []);
            if (items.length > 0) {
              const ids = this._extractIds(items);
              if (ids.length > 0) {
                console.log('[SBA] Got', ids.length, 'inscriptions via API');
                this.inscriptions = ids;
                return ids;
              }
            }
          }
        } catch (e) {
          console.log('[SBA] API failed:', url, e.message);
        }
      }

      // SECONDARY: Try wallet methods if available
      if (window.nintondo) {
        const methodsToTry = [
          'getInscriptions', 'getMyInscriptions', 'inscriptions',
          'getOrdinals', 'listInscriptions', 'getOwnedInscriptions',
        ];
        for (const method of methodsToTry) {
          if (typeof window.nintondo[method] === 'function') {
            try {
              const result = await window.nintondo[method]();
              if (result) {
                let items = Array.isArray(result) ? result :
                  (result.list || result.inscriptions || result.data || result.result || null);
                if (items && items.length > 0) {
                  const ids = this._extractIds(items);
                  if (ids.length > 0) {
                    console.log('[SBA] Got', ids.length, 'inscriptions via', method);
                    this.inscriptions = ids;
                    return ids;
                  }
                }
              }
            } catch (e) {
              console.log('[SBA]', method, 'failed:', e.message);
            }
          }
        }
      }

      console.log('[SBA] No inscriptions found for', address);
      return [];
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

  // Log detection status
  if (typeof window.nintondo !== 'undefined') {
    console.log('[SBA] Nintondo already injected on load');
  } else {
    console.log('[SBA] Waiting for Nintondo to inject...');
  }

})();
