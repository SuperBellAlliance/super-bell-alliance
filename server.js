/**
 * ============================================================
 * SUPER BELL ALLIANCE — MINT AUTOMATION SERVER
 * ============================================================
 * This server:
 * 1. Watches your PAYMENT wallet for incoming BEL
 * 2. Detects how much was sent & calculates quantity
 * 3. Randomly picks inscriptions from vault
 * 4. Sends inscriptions to buyer automatically
 * 5. Logs all orders to database
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  PAYMENT_WALLET:   process.env.PAYMENT_WALLET,   // bel1q0l2z7dqufnmgj4gn9z7z0peeq00t5mpzu257hx
  VAULT_WALLET:     process.env.VAULT_WALLET,      // BDZPi1zyLBUmpc3wCAuMy2pMiucJ7kBjo6
  VAULT_PRIVKEY:    process.env.VAULT_PRIVKEY,     // Your vault wallet private key (KEEP SECRET!)
  MINT_PRICE_BEL:   parseFloat(process.env.MINT_PRICE_BEL || '40'),
  MAX_MINT:         parseInt(process.env.MAX_MINT || '10'),
  PORT:             parseInt(process.env.PORT || '3000'),
  ORD_API:          process.env.ORD_API || 'https://ord.nintondo.io',
  BELLSCOIN_RPC:    process.env.BELLSCOIN_RPC || 'http://localhost:22555',
  CHECK_INTERVAL:   parseInt(process.env.CHECK_INTERVAL || '30'), // seconds
  CONFIRMATIONS:    parseInt(process.env.CONFIRMATIONS || '1'),   // blocks to wait
  TOLERANCE_BEL:    parseFloat(process.env.TOLERANCE_BEL || '0.5'), // payment tolerance
};

// Validate critical config
const required = ['PAYMENT_WALLET','VAULT_WALLET','VAULT_PRIVKEY'];
const missing = required.filter(k => !CONFIG[k]);
if(missing.length){
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('   Please check your .env file');
  process.exit(1);
}

// ── DATABASE ─────────────────────────────────────────────────
const db = new Database('./sba_orders.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id TEXT UNIQUE,
    buyer_address TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    bel_received REAL NOT NULL,
    quantity INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    inscription_ids TEXT,
    transfer_tx_ids TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS processed_txs (
    tx_id TEXT PRIMARY KEY,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inscription_pool (
    inscription_id TEXT PRIMARY KEY,
    sba_number INTEGER,
    status TEXT DEFAULT 'available',
    reserved_for TEXT,
    sold_at DATETIME
  );
`);

console.log('✅ Database initialized: sba_orders.db');

// ── LOAD INSCRIPTION POOL ─────────────────────────────────────
function loadInscriptionPool() {
  const jsonPath = path.join(__dirname, 'SBA_final.json');
  if(!fs.existsSync(jsonPath)){
    console.warn('⚠️  SBA_final.json not found — inscription pool empty');
    return 0;
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const inscriptions = data.inscriptions.filter(e => !e.id.startsWith('PENDING'));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO inscription_pool (inscription_id, sba_number, status)
    VALUES (?, ?, 'available')
  `);

  const insertMany = db.transaction((items) => {
    for(const item of items) insert.run(item.id, item.num);
  });

  insertMany(inscriptions);
  const count = db.prepare('SELECT COUNT(*) as c FROM inscription_pool WHERE status = ?').get('available');
  console.log(`✅ Inscription pool loaded: ${count.c} available inscriptions`);
  return count.c;
}

loadInscriptionPool();

// ── BELLSCOIN API HELPERS ─────────────────────────────────────
async function getAddressTransactions(address) {
  try {
    const res = await axios.get(`${CONFIG.ORD_API}/api/v1/address/${address}/transactions`, {
      timeout: 10000
    });
    return res.data || [];
  } catch(e) {
    // Fallback to ord endpoint
    try {
      const res = await axios.get(`${CONFIG.ORD_API}/address/${address}`, {
        headers: { 'Accept': 'application/json' },
        timeout: 10000
      });
      return res.data?.transactions || [];
    } catch(e2) {
      console.error('❌ Failed to fetch transactions:', e2.message);
      return [];
    }
  }
}

async function getTransactionDetails(txId) {
  try {
    const res = await axios.get(`${CONFIG.ORD_API}/api/v1/tx/${txId}`, { timeout: 10000 });
    return res.data;
  } catch(e) {
    try {
      const res = await axios.get(`${CONFIG.ORD_API}/tx/${txId}`, {
        headers: { 'Accept': 'application/json' },
        timeout: 10000
      });
      return res.data;
    } catch(e2) {
      return null;
    }
  }
}

// ── RANDOM INSCRIPTION PICKER ─────────────────────────────────
function pickRandomInscriptions(quantity) {
  const available = db.prepare(`
    SELECT inscription_id, sba_number FROM inscription_pool
    WHERE status = 'available'
    ORDER BY RANDOM()
    LIMIT ?
  `).all(quantity);

  if(available.length < quantity){
    throw new Error(`Not enough available inscriptions. Need ${quantity}, have ${available.length}`);
  }

  return available;
}

function reserveInscriptions(inscriptionIds, buyerAddress) {
  const reserve = db.prepare(`
    UPDATE inscription_pool
    SET status = 'reserved', reserved_for = ?
    WHERE inscription_id = ?
  `);

  const reserveMany = db.transaction((ids) => {
    for(const id of ids) reserve.run(buyerAddress, id);
  });

  reserveMany(inscriptionIds);
}

function markInscriptionSold(inscriptionId) {
  db.prepare(`
    UPDATE inscription_pool
    SET status = 'sold', sold_at = CURRENT_TIMESTAMP
    WHERE inscription_id = ?
  `).run(inscriptionId);
}

function releaseReservation(inscriptionId) {
  db.prepare(`
    UPDATE inscription_pool
    SET status = 'available', reserved_for = NULL
    WHERE inscription_id = ?
  `).run(inscriptionId);
}

// ── TRANSFER INSCRIPTION ──────────────────────────────────────
async function transferInscription(inscriptionId, toAddress) {
  /**
   * This function sends an inscription from the vault to the buyer.
   *
   * HOW IT WORKS:
   * The vault wallet's private key is used to sign a transaction
   * that moves the inscription UTXO to the buyer's address.
   *
   * This uses the Nintondo ord transfer API or direct RPC call.
   */

  console.log(`📤 Transferring inscription ${inscriptionId.slice(0,16)}... to ${toAddress.slice(0,12)}...`);

  try {
    // Method 1: Use Nintondo's transfer API
    const transferRes = await axios.post(`${CONFIG.ORD_API}/api/v1/inscription/transfer`, {
      inscription_id: inscriptionId,
      from_address: CONFIG.VAULT_WALLET,
      to_address: toAddress,
      private_key: CONFIG.VAULT_PRIVKEY,
    }, { timeout: 30000 });

    if(transferRes.data && transferRes.data.txid){
      console.log(`✅ Transfer successful! TX: ${transferRes.data.txid}`);
      return transferRes.data.txid;
    }

    throw new Error('Transfer API returned no txid');

  } catch(e) {
    // Method 2: Direct Bellscoin RPC (if running local node)
    console.log('⚠️  API transfer failed, trying RPC...');
    try {
      const rpcRes = await axios.post(CONFIG.BELLSCOIN_RPC, {
        jsonrpc: '1.0',
        method: 'sendrawtransaction',
        params: [/* signed raw tx would go here */],
      }, {
        auth: {
          username: process.env.RPC_USER || 'bellscoin',
          password: process.env.RPC_PASS || 'password'
        }
      });

      return rpcRes.data.result;
    } catch(e2) {
      throw new Error(`Transfer failed: ${e.message} | RPC: ${e2.message}`);
    }
  }
}

// ── PROCESS PAYMENT ───────────────────────────────────────────
async function processPayment(txId, buyerAddress, belAmount, deliveryAddress) {
  console.log(`\n💰 Processing payment:`);
  console.log(`   TX: ${txId}`);
  console.log(`   From: ${buyerAddress}`);
  console.log(`   Amount: ${belAmount} BEL`);
  console.log(`   Deliver to: ${deliveryAddress}`);

  // Calculate quantity
  const quantity = Math.min(
    Math.floor(belAmount / CONFIG.MINT_PRICE_BEL),
    CONFIG.MAX_MINT
  );

  if(quantity < 1){
    console.log(`❌ Payment too low: ${belAmount} BEL (min: ${CONFIG.MINT_PRICE_BEL} BEL)`);
    return;
  }

  console.log(`   Quantity: ${quantity} inscription(s)`);

  // Create order in DB
  db.prepare(`
    INSERT OR IGNORE INTO orders
    (tx_id, buyer_address, delivery_address, bel_received, quantity, status)
    VALUES (?, ?, ?, ?, ?, 'processing')
  `).run(txId, buyerAddress, deliveryAddress, belAmount, quantity);

  // Pick random inscriptions
  let picked;
  try {
    picked = pickRandomInscriptions(quantity);
    reserveInscriptions(picked.map(p => p.inscription_id), deliveryAddress);
    console.log(`✅ Reserved inscriptions: ${picked.map(p => '#'+p.sba_number).join(', ')}`);
  } catch(e) {
    db.prepare(`UPDATE orders SET status = 'failed', error = ? WHERE tx_id = ?`)
      .run(e.message, txId);
    console.error('❌ Failed to reserve inscriptions:', e.message);
    return;
  }

  // Transfer each inscription
  const transferTxIds = [];
  const failedIds = [];

  for(const inscription of picked){
    try {
      const transferTxId = await transferInscription(inscription.inscription_id, deliveryAddress);
      transferTxIds.push(transferTxId);
      markInscriptionSold(inscription.inscription_id);
      console.log(`✅ Sent SBA #${inscription.sba_number} to ${deliveryAddress.slice(0,12)}...`);

      // Small delay between transfers
      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`❌ Failed to transfer SBA #${inscription.sba_number}:`, e.message);
      failedIds.push(inscription.inscription_id);
      releaseReservation(inscription.inscription_id);
    }
  }

  // Update order status
  const status = failedIds.length === 0 ? 'completed' : 
                 failedIds.length === picked.length ? 'failed' : 'partial';

  db.prepare(`
    UPDATE orders SET
      status = ?,
      inscription_ids = ?,
      transfer_tx_ids = ?,
      completed_at = CURRENT_TIMESTAMP
    WHERE tx_id = ?
  `).run(
    status,
    picked.map(p => p.inscription_id).join(','),
    transferTxIds.join(','),
    txId
  );

  console.log(`\n🎉 Order ${status.toUpperCase()}!`);
  console.log(`   Inscriptions sent: ${transferTxIds.length}/${picked.length}`);
  if(failedIds.length > 0){
    console.log(`   Failed: ${failedIds.length} (released back to pool)`);
  }
}

// ── PAYMENT WATCHER ───────────────────────────────────────────
async function watchPayments() {
  console.log(`\n🔍 Checking payment wallet: ${CONFIG.PAYMENT_WALLET.slice(0,12)}...`);

  try {
    const transactions = await getAddressTransactions(CONFIG.PAYMENT_WALLET);

    for(const tx of transactions){
      const txId = tx.txid || tx.tx_hash || tx.id;
      if(!txId) continue;

      // Skip already processed
      const alreadyProcessed = db.prepare(
        'SELECT tx_id FROM processed_txs WHERE tx_id = ?'
      ).get(txId);
      if(alreadyProcessed) continue;

      // Get full transaction details
      const txDetails = await getTransactionDetails(txId);
      if(!txDetails) continue;

      // Check confirmations
      const confirmations = txDetails.confirmations || 0;
      if(confirmations < CONFIG.CONFIRMATIONS) {
        console.log(`⏳ TX ${txId.slice(0,12)}... has ${confirmations} confirmations (need ${CONFIG.CONFIRMATIONS})`);
        continue;
      }

      // Parse outputs to find payment to our wallet
      const outputs = txDetails.vout || txDetails.outputs || [];
      let belReceived = 0;
      let senderAddress = '';

      for(const output of outputs){
        const addr = output.scriptPubKey?.address || output.address;
        const value = output.value || output.amount || 0;
        if(addr === CONFIG.PAYMENT_WALLET){
          belReceived += value;
        }
      }

      // Get sender from inputs
      const inputs = txDetails.vin || txDetails.inputs || [];
      if(inputs.length > 0){
        senderAddress = inputs[0].address || 
                       inputs[0].scriptSig?.address || 
                       CONFIG.PAYMENT_WALLET; // fallback
      }

      if(belReceived < CONFIG.MINT_PRICE_BEL - CONFIG.TOLERANCE_BEL){
        console.log(`⚠️  TX ${txId.slice(0,12)}... received ${belReceived} BEL (below mint price)`);
        // Mark as processed so we don't re-check
        db.prepare('INSERT OR IGNORE INTO processed_txs (tx_id) VALUES (?)').run(txId);
        continue;
      }

      // Mark as processed BEFORE processing to avoid double-processing
      db.prepare('INSERT OR IGNORE INTO processed_txs (tx_id) VALUES (?)').run(txId);

      // Check if order already exists
      const existingOrder = db.prepare('SELECT id FROM orders WHERE tx_id = ?').get(txId);
      if(existingOrder) continue;

      // Process the payment!
      console.log(`\n🚨 NEW PAYMENT DETECTED!`);
      console.log(`   TX: ${txId}`);
      console.log(`   Amount: ${belReceived} BEL`);

      // Delivery address = sender address (unless they specified a different one)
      await processPayment(txId, senderAddress, belReceived, senderAddress);
    }

  } catch(e) {
    console.error('❌ Watch error:', e.message);
  }
}

// ── START WATCHER ─────────────────────────────────────────────
console.log(`\n⚡ Starting payment watcher (every ${CONFIG.CHECK_INTERVAL}s)...`);
const watchInterval = setInterval(watchPayments, CONFIG.CHECK_INTERVAL * 1000);

// Initial check on startup
setTimeout(watchPayments, 3000);

// ── API ENDPOINTS ─────────────────────────────────────────────
// Health check
app.get('/health', (req, res) => {
  const stats = {
    status: 'running',
    payment_wallet: CONFIG.PAYMENT_WALLET,
    mint_price: CONFIG.MINT_PRICE_BEL,
    inscriptions_available: db.prepare(
      'SELECT COUNT(*) as c FROM inscription_pool WHERE status = ?'
    ).get('available').c,
    inscriptions_sold: db.prepare(
      'SELECT COUNT(*) as c FROM inscription_pool WHERE status = ?'
    ).get('sold').c,
    total_orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    completed_orders: db.prepare(
      'SELECT COUNT(*) as c FROM orders WHERE status = ?'
    ).get('completed').c,
    timestamp: new Date().toISOString()
  };
  res.json(stats);
});

// Get order status by TX ID
app.get('/order/:txId', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE tx_id = ?').get(req.params.txId);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Get all orders (admin)
app.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(orders);
});

// Get mint stats (for website)
app.get('/stats', (req, res) => {
  const available = db.prepare(
    'SELECT COUNT(*) as c FROM inscription_pool WHERE status = ?'
  ).get('available').c;
  const sold = db.prepare(
    'SELECT COUNT(*) as c FROM inscription_pool WHERE status = ?'
  ).get('sold').c;
  res.json({
    total: 10000,
    sold,
    available,
    mint_price: CONFIG.MINT_PRICE_BEL,
    max_mint: CONFIG.MAX_MINT
  });
});

// Check specific TX payment status
app.get('/check-payment/:txId', async (req, res) => {
  const { txId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE tx_id = ?').get(txId);
  if(order){
    return res.json({ found: true, status: order.status, order });
  }
  // Check if it's in processed_txs
  const processed = db.prepare('SELECT * FROM processed_txs WHERE tx_id = ?').get(txId);
  res.json({ found: false, processed: !!processed });
});

// Manual trigger (admin use only)
app.post('/admin/process-tx', async (req, res) => {
  const { txId, deliveryAddress } = req.body;
  if(!txId) return res.status(400).json({ error: 'txId required' });

  const txDetails = await getTransactionDetails(txId);
  if(!txDetails) return res.status(404).json({ error: 'Transaction not found' });

  const outputs = txDetails.vout || [];
  let belReceived = 0;
  for(const out of outputs){
    if((out.scriptPubKey?.address || out.address) === CONFIG.PAYMENT_WALLET){
      belReceived += out.value || 0;
    }
  }

  const delivery = deliveryAddress || CONFIG.PAYMENT_WALLET;
  await processPayment(txId, delivery, belReceived, delivery);
  res.json({ success: true, message: 'Processing initiated' });
});

// ── START SERVER ──────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 SBA Mint Server running on port ${CONFIG.PORT}`);
  console.log(`   Health: http://localhost:${CONFIG.PORT}/health`);
  console.log(`   Stats:  http://localhost:${CONFIG.PORT}/stats`);
  console.log(`   Orders: http://localhost:${CONFIG.PORT}/orders`);
  console.log(`\n💰 Payment wallet: ${CONFIG.PAYMENT_WALLET}`);
  console.log(`🔐 Vault wallet:   ${CONFIG.VAULT_WALLET}`);
  console.log(`💵 Mint price:     ${CONFIG.MINT_PRICE_BEL} BEL`);
  console.log(`\n⚠️  IMPORTANT: Keep your .env file secure. Never share VAULT_PRIVKEY!`);
  console.log(`════════════════════════════════════════════════\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⛔ Shutting down server...');
  clearInterval(watchInterval);
  db.close();
  process.exit(0);
});
