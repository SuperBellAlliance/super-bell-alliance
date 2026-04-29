/**
 * ============================================================
 * NINTONDO WALLET INTEGRATION — Based on Official SDK
 * https://docs.nintondo.io/docs/to-developers/nintondo-wallet/nintondo-sdk/provider
 * ============================================================
 *
 * From Nintondo docs:
 * - Methods are called like: nintondo.connect(), nintondo.getBalance() etc
 * - The provider is window.nintondo when extension is injected
 * - Connect returns: address string
 * - getBalance returns: number (in satoshis)
 *
 * CDN/API for inscriptions:
 * - https://ord.nintondo.io/api/v1/address/{addr}/inscriptions
 * - https://bells-mainnet-content.nintondo.io/preview/{inscriptionId}
 */

(function() {
  'use strict';

  const ORD_API = 'https://ord.nintondo.io';
  const NINTONDO_INSTALL = 'https://chromewebstore.google.com/detail/nintondo-wallet/akkmagafhjjjjclaejjomkeccmjhdkpa';

  // Wait for wallet to inject (it injects after page load)
  async function waitForWallet(timeoutMs = 3000) {
    if (window.nintondo) return window.nintondo;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.nintondo) return window.nintondo;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  window.SBAWallet = {
    addr: null,
    balance: 0,

    /**
     * Connect to Nintondo wallet
     * Returns: address string or null
     */
    async connect() {
      console.log('[SBA] Attempting wallet connection...');

      const nintondo = await waitForWallet();

      if (!nintondo) {
        console.error('[SBA] window.nintondo not found');
        const choice = confirm(
          'Nintondo Wallet not detected!\n\n' +
          'Click OK to install the Chrome extension.\n' +
          'Click Cancel if it is already installed (refresh page first).'
        );
        if (choice) window.open(NINTONDO_INSTALL, '_blank');
        return null;
      }

      try {
        // Per official docs: nintondo.connect("bellsMainnet")
        const address = await nintondo.connect('bellsMainnet');
        if (!address) throw new Error('No address returned');

        console.log('[SBA] Connected:', address);
        this.addr = address;

        // Try to get balance immediately
        try {
          this.balance = await nintondo.getBalance();
          console.log('[SBA] Balance:', this.balance, 'satoshis');
        } catch (e) {
          console.log('[SBA] Could not fetch balance:', e.message);
        }

        return address;

      } catch (e) {
        console.error('[SBA] Connection error:', e);
        if (e.code === 4001 || (e.message && e.message.toLowerCase().includes('reject'))) {
          alert('Connection rejected. Please approve in your Nintondo wallet.');
        } else {
          alert('Wallet connection failed: ' + (e.message || String(e)));
        }
        return null;
      }
    },

    /**
     * Get current account address
     */
    async getAccount() {
      if (!window.nintondo) return null;
      try {
        return await window.nintondo.getAccount();
      } catch (e) {
        return null;
      }
    },

    /**
     * Get balance in satoshis (1 BEL = 100,000,000 satoshis)
     */
    async getBalance() {
      if (!window.nintondo) return 0;
      try {
        const sats = await window.nintondo.getBalance();
        this.balance = sats;
        return sats;
      } catch (e) {
        console.error('[SBA] getBalance error:', e);
        return 0;
      }
    },

    /**
     * Get balance in BEL (formatted)
     */
    getBalanceBEL() {
      return (this.balance / 100000000).toFixed(8);
    },

    /**
     * Send BEL to address (triggers wallet popup)
     * @param toAddress - destination address
     * @param belAmount - amount in BEL (will be converted to satoshis)
     * @returns signed tx hex
     */
    async sendPayment(toAddress, belAmount) {
      if (!window.nintondo) throw new Error('Wallet not connected');

      const satoshis = Math.round(belAmount * 100000000);
      console.log(`[SBA] Sending ${belAmount} BEL (${satoshis} sats) to ${toAddress}`);

      // Per official docs: nintondo.createTx({to, amount, receiverToPayFee, feeRate})
      const signedTxHex = await window.nintondo.createTx({
        to: toAddress,
        amount: satoshis,
        receiverToPayFee: false,
        feeRate: 10
      });

      console.log('[SBA] Transaction created:', signedTxHex.slice(0, 30) + '...');
      return signedTxHex;
    },

    /**
     * Disconnect wallet
     */
    async disconnect() {
      try {
        if (window.nintondo && window.nintondo.disconnect) {
          await window.nintondo.disconnect();
        }
      } catch (e) {}
      this.addr = null;
      this.balance = 0;
    },

    /**
     * Fetch ALL inscriptions for an address - tries multiple endpoints
     */
    async fetchInscriptions(address) {
      console.log('[SBA] Fetching inscriptions for:', address);

      // Try multiple endpoints in order
      const endpoints = [
        // Primary: Nintondo CDN (often has CORS)
        `https://bells-mainnet-content.nintondo.io/api/v1/address/${address}/inscriptions`,
        // Backup: ord.nintondo.io
        `https://ord.nintondo.io/api/v1/address/${address}/inscriptions`,
        // CORS proxy fallback
        `https://corsproxy.io/?https://ord.nintondo.io/api/v1/address/${address}/inscriptions`,
        // Alternative CORS proxy
        `https://api.allorigins.win/raw?url=${encodeURIComponent('https://ord.nintondo.io/api/v1/address/' + address + '/inscriptions')}`,
      ];

      const all = [];

      for (const baseUrl of endpoints) {
        console.log('[SBA] Trying endpoint:', baseUrl.slice(0, 60) + '...');
        try {
          let offset = 0;
          const limit = 100;
          let hasMore = true;
          let pageCount = 0;

          while (hasMore && pageCount < 100) {
            const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + `offset=${offset}&limit=${limit}`;
            const res = await fetch(url, {
              method: 'GET',
              mode: 'cors',
              headers: { 'Accept': 'application/json' }
            });

            if (!res.ok) {
              console.warn('[SBA] HTTP', res.status, 'from', baseUrl.slice(0, 50));
              break;
            }

            const data = await res.json();
            const inscriptions = Array.isArray(data) ? data :
                                 (data.inscriptions || data.result || data.data || []);

            if (!inscriptions || inscriptions.length === 0) {
              hasMore = false;
              break;
            }

            all.push(...inscriptions);
            console.log(`[SBA] Loaded ${all.length} inscriptions...`);

            if (inscriptions.length < limit) hasMore = false;
            else offset += limit;
            pageCount++;

            await new Promise(r => setTimeout(r, 100));
          }

          if (all.length > 0) {
            console.log('[SBA] Successfully fetched', all.length, 'from', baseUrl.slice(0, 50));
            break; // Got data, stop trying other endpoints
          }
        } catch (e) {
          console.warn('[SBA] Endpoint failed:', e.message);
          continue; // Try next endpoint
        }
      }

      // Extract IDs from various response formats
      const ids = all.map(item => {
        if (typeof item === 'string') return item;
        return item.id || item.inscription_id || item.inscriptionId || null;
      }).filter(Boolean);

      console.log('[SBA] Total inscriptions found:', ids.length);
      return ids;
    },


    /**
     * Quick check if wallet is installed
     */
    isInstalled() {
      return typeof window.nintondo !== 'undefined';
    },

    /**
     * Listen for account changes
     */
    onAccountChange(callback) {
      if (window.nintondo && window.nintondo.on) {
        window.nintondo.on('accountsChanged', callback);
      }
    }
  };

  // Auto-detect if wallet is already injected
  if (typeof window.nintondo !== 'undefined') {
    console.log('[SBA] Nintondo wallet detected');
  } else {
    console.log('[SBA] Waiting for Nintondo wallet to inject...');
    // Try again after short delay
    setTimeout(() => {
      if (typeof window.nintondo !== 'undefined') {
        console.log('[SBA] Nintondo wallet now available');
      }
    }, 1500);
  }
})();
