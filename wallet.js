/**
 * ============================================================
 * NINTONDO WALLET - Production Ready (v3)
 * ============================================================
 */

(function() {
  'use strict';

  const NINTONDO_INSTALL = 'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';

  async function waitForWallet(timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    if (window.nintondo) return window.nintondo;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.nintondo) return window.nintondo;
      await new Promise(function(r) { setTimeout(r, 100); });
    }
    return null;
  }

  window.SBAWallet = {
    addr: null,
    balance: 0,
    inscriptions: [],

    async connect() {
      console.log('[SBA] Attempting wallet connection...');
      const nintondo = await waitForWallet();

      if (!nintondo) {
        console.error('[SBA] window.nintondo not found');
        const choice = confirm('Nintondo Wallet not detected!\nClick OK to install.');
        if (choice) window.open(NINTONDO_INSTALL, '_blank');
        return null;
      }

      try {
        const address = await nintondo.connect('bellsMainnet');
        if (!address) throw new Error('No address returned');
        console.log('[SBA] Connected:', address);
        this.addr = address;

        try {
          this.balance = await nintondo.getBalance();
          console.log('[SBA] Balance:', this.balance, 'satoshis');
        } catch (e) {
          console.log('[SBA] getBalance error:', e.message);
        }

        // Log all available wallet methods for debugging
        const methods = [];
        for (const k in nintondo) {
          if (typeof nintondo[k] === 'function') methods.push(k);
        }
        console.log('[SBA] Wallet methods available:', methods);

        return address;
      } catch (e) {
        console.error('[SBA] Connection error:', e);
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
      console.log('[SBA] Sending', belAmount, 'BEL to', toAddress);
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
     * Fetch inscriptions - uses wallet provider's own methods primarily
     */
    async fetchInscriptions(address) {
      console.log('[SBA] Fetching inscriptions for:', address);

      if (!window.nintondo) {
        console.error('[SBA] Wallet not available');
        return [];
      }

      // Try every possible wallet method that might return inscriptions
      const methodsToTry = [
        'getInscriptions',
        'getMyInscriptions',
        'inscriptions',
        'getOrdinals',
        'listInscriptions',
        'getOwnedInscriptions',
      ];

      for (const methodName of methodsToTry) {
        if (typeof window.nintondo[methodName] === 'function') {
          try {
            console.log('[SBA] Trying window.nintondo.' + methodName + '()...');
            const result = await window.nintondo[methodName]();
            console.log('[SBA] Result from ' + methodName + ':', result);
            
            if (result) {
              // Try various response formats
              let items = null;
              if (Array.isArray(result)) items = result;
              else if (result.list && Array.isArray(result.list)) items = result.list;
              else if (result.inscriptions && Array.isArray(result.inscriptions)) items = result.inscriptions;
              else if (result.data && Array.isArray(result.data)) items = result.data;
              else if (result.result && Array.isArray(result.result)) items = result.result;
              
              if (items && items.length > 0) {
                const ids = this._extractIds(items);
                if (ids.length > 0) {
                  console.log('[SBA] ✅ Got', ids.length, 'inscriptions via wallet.' + methodName);
                  this.inscriptions = ids;
                  return ids;
                }
              }
            }
          } catch (e) {
            console.log('[SBA] ' + methodName + ' failed:', e.message);
          }
        }
      }

      // Try ord.nintondo.io API endpoints
      const apiEndpoints = [
        'https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions',
        'https://bells-mainnet-content.nintondo.io/api/v1/address/' + address + '/inscriptions',
        'https://corsproxy.io/?https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions',
        'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions'),
      ];

      for (const url of apiEndpoints) {
        console.log('[SBA] Trying:', url.slice(0, 70));
        try {
          const res = await fetch(url, { 
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });
          if (!res.ok) {
            console.log('[SBA] HTTP', res.status);
            continue;
          }
          const data = await res.json();
          const items = Array.isArray(data) ? data : (data.list || data.inscriptions || data.data || data.result || []);
          if (items && items.length > 0) {
            const ids = this._extractIds(items);
            if (ids.length > 0) {
              console.log('[SBA] ✅ Got', ids.length, 'from external API');
              this.inscriptions = ids;
              return ids;
            }
          }
        } catch (e) {
          console.log('[SBA] Failed:', e.message);
        }
      }

      console.warn('[SBA] All inscription endpoints failed - returning empty list');
      return [];
    },

    _extractIds(items) {
      return items.map(function(item) {
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
    console.log('[SBA] Nintondo wallet detected');
  } else {
    console.log('[SBA] Waiting for Nintondo wallet to inject...');
    setTimeout(function() {
      if (typeof window.nintondo !== 'undefined') {
        console.log('[SBA] Nintondo wallet now available');
      }
    }, 1500);
  }
})();
