// ============================================================
// NINTONDO WALLET - wallet.js
// Load this BEFORE your main script
// ============================================================

window.SBAWallet = {
  addr: null,

  async connect(onSuccess) {
    try {
      // Check if extension exists
      if (typeof window.nintondo === 'undefined') {
        alert('Nintondo Wallet not found!\n\nPlease:\n1. Install Nintondo Wallet from the Chrome Web Store\n2. Refresh this page\n3. Try again');
        return null;
      }

      // Check if locked
      const existing = await window.nintondo.getAccounts().catch(() => null);
      if (existing && existing.length > 0) {
        // Already connected - use existing account
        const addr = existing[0];
        window.SBAWallet.addr = addr;
        if (onSuccess) onSuccess(addr);
        return addr;
      }

      // Request connection - this triggers the wallet popup
      const addr = await window.nintondo.connect('bellsMainnet');
      if (!addr) throw new Error('No address returned');

      window.SBAWallet.addr = addr;
      if (onSuccess) onSuccess(addr);
      return addr;

    } catch (e) {
      console.error('Wallet error:', e);
      if (e.code === 4001 || (e.message && e.message.includes('reject'))) {
        alert('Connection rejected. Please approve in your Nintondo wallet.');
      } else if (e.message && e.message.includes('locked')) {
        alert('Please unlock your Nintondo wallet first, then try again.');
      } else {
        alert('Wallet error: ' + (e.message || String(e)));
      }
      return null;
    }
  },

  disconnect() {
    try {
      if (window.nintondo && window.nintondo.disconnect) {
        window.nintondo.disconnect();
      }
    } catch (e) {}
    window.SBAWallet.addr = null;
  },

  async sendPayment(toAddress, belAmount) {
    if (!window.nintondo) throw new Error('Wallet not connected');
    const satoshis = Math.round(belAmount * 100000000);
    // createTx is the correct method per official Nintondo docs
    return await window.nintondo.createTx({
      to: toAddress,
      amount: satoshis,
      receiverToPayFee: false,
      feeRate: 10
    });
  },

  async getInscriptions() {
    if (!window.nintondo) throw new Error('Wallet not connected');
    try {
      return await window.nintondo.getInscriptions();
    } catch (e) {
      return [];
    }
  }
};

console.log('SBAWallet loaded. window.nintondo:', typeof window.nintondo);
