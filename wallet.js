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
     * Fetch ALL inscriptions for an address from Nintondo API
     */
    async fetchInscriptions(address) {
      console.log('[SBA] Fetching inscriptions for:', address);

      const all = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore && offset < 10000) {
        try {
          const url = `${ORD_API}/api/v1/address/${address}/inscriptions?offset=${offset}&limit=${limit}`;
          const res = await fetch(url);
          if (!res.ok) {
            console.warn('[SBA] API returned', res.status);
            break;
          }

          const data = await res.json();
          const inscriptions = Array.isArray(data) ? data : (data.inscriptions || data.result || []);

          if (inscriptions.length === 0) {
            hasMore = false;
            break;
          }

          all.push(...inscriptions);
          console.log(`[SBA] Loaded ${all.length} inscriptions so far...`);

          if (inscriptions.length < limit) {
            hasMore = false;
          } else {
            offset += limit;
          }

          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          console.error('[SBA] Fetch error:', e);
          break;
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
