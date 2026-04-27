# SUPER BELL ALLIANCE — MINT SERVER SETUP GUIDE
# ================================================

## STEP 1: GET A VPS SERVER ($5-10/month)

### Recommended: Hetzner Cloud (cheapest + reliable)
1. Go to: https://www.hetzner.com/cloud
2. Click "Get Started"
3. Create account (free)
4. Click "Create Server"
5. Choose:
   - Location: Singapore (closest to Malaysia)
   - OS: Ubuntu 24.04
   - Type: CX22 (2 vCPU, 4GB RAM) = €3.29/month (~$3.50)
6. Add your SSH key OR choose password
7. Click "Create & Buy Now"
8. You'll get an IP address like: 65.21.xxx.xxx

### Alternative: DigitalOcean ($6/month)
1. Go to: https://digitalocean.com
2. Create account
3. Create Droplet → Ubuntu 24.04 → Basic → $6/month
4. Choose Singapore region

---

## STEP 2: CONNECT TO YOUR SERVER

### On Windows:
1. Download PuTTY: https://putty.org
2. Open PuTTY
3. Host: YOUR_SERVER_IP
4. Port: 22
5. Click Open
6. Login: root
7. Password: (the one you set when creating server)

### On Mac/Linux:
Open Terminal and type:
```
ssh root@YOUR_SERVER_IP
```

---

## STEP 3: INSTALL NODE.JS ON SERVER

Copy and paste these commands one by one:

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installation
node --version   # Should show v20.x.x
npm --version    # Should show 10.x.x

# Install PM2 (keeps server running 24/7)
npm install -g pm2
```

---

## STEP 4: UPLOAD YOUR FILES TO SERVER

### On Windows — use WinSCP:
1. Download WinSCP: https://winscp.net
2. Connect to your server IP
3. Upload these files to /root/sba-mint-server/:
   - server.js
   - package.json
   - .env (create from .env.example)
   - SBA_final.json (copy from your outputs folder)

### On Mac/Linux — use SCP:
```bash
scp -r /path/to/sba-mint-server root@YOUR_SERVER_IP:/root/
```

---

## STEP 5: CONFIGURE YOUR .ENV FILE

On the server, create your .env file:
```bash
cd /root/sba-mint-server
nano .env
```

Paste and fill in your details:
```
PAYMENT_WALLET=bel1q0l2z7dqufnmgj4gn9z7z0peeq00t5mpzu257hx
VAULT_WALLET=BDZPi1zyLBUmpc3wCAuMy2pMiucJ7kBjo6
VAULT_PRIVKEY=YOUR_ACTUAL_PRIVATE_KEY_HERE
MINT_PRICE_BEL=40
MAX_MINT=10
PORT=3000
CHECK_INTERVAL=30
CONFIRMATIONS=1
ORD_API=https://ord.nintondo.io
```

Save: Press Ctrl+X → Y → Enter

### HOW TO GET YOUR VAULT PRIVATE KEY:
1. Open Nintondo Wallet in Chrome
2. Click the menu (3 dots)
3. Settings → Security
4. Export Private Key
5. Enter your password
6. Copy the private key
7. Paste it as VAULT_PRIVKEY in .env

⚠️ NEVER share your private key with anyone!

---

## STEP 6: INSTALL & START SERVER

```bash
cd /root/sba-mint-server

# Install dependencies
npm install

# Test run (check for errors)
node server.js

# If no errors, press Ctrl+C to stop

# Start with PM2 (runs 24/7, auto-restarts on crash)
pm2 start server.js --name sba-mint

# Save PM2 config (survives reboots)
pm2 save
pm2 startup

# Check server is running
pm2 status
pm2 logs sba-mint
```

---

## STEP 7: OPEN FIREWALL PORT

```bash
# Allow port 3000 (your API)
ufw allow 3000
ufw allow 22
ufw enable
```

---

## STEP 8: TEST YOUR SERVER

Open browser and visit:
```
http://YOUR_SERVER_IP:3000/health
```

You should see JSON like:
```json
{
  "status": "running",
  "inscriptions_available": 9841,
  "mint_price": 40,
  "total_orders": 0
}
```

---

## STEP 9: UPDATE YOUR MINT PAGE

In your index.html, update the stats URL:
```javascript
const SERVER_URL = 'http://YOUR_SERVER_IP:3000';
```

The mint page will now show real-time stats from your server!

---

## STEP 10: TEST WITH SMALL AMOUNT

1. Send exactly 40 BEL to your payment wallet from a test wallet
2. Watch server logs: `pm2 logs sba-mint`
3. After 30 seconds, server detects payment
4. Server picks random inscription
5. Inscription sent to your test wallet
6. Check your test wallet on Nintondo!

---

## USEFUL COMMANDS

```bash
# View live logs
pm2 logs sba-mint

# Restart server
pm2 restart sba-mint

# Stop server
pm2 stop sba-mint

# Check server health
curl http://localhost:3000/health

# View all orders
curl http://localhost:3000/orders

# View stats
curl http://localhost:3000/stats
```

---

## SECURITY CHECKLIST

✅ .env file is not in any Git repo
✅ Private key only in .env on server
✅ Server has firewall enabled
✅ Only port 22 (SSH) and 3000 (API) are open
✅ Vault wallet has ZERO BEL balance (only inscriptions)
✅ Payment wallet is separate from vault wallet
✅ PM2 running with --name for easy management

---

## HOW LONG DOES SETUP TAKE?

| Step | Time |
|------|------|
| Get VPS | 5 minutes |
| Connect & install Node.js | 10 minutes |
| Upload files | 5 minutes |
| Configure .env | 5 minutes |
| Start server | 2 minutes |
| Test first mint | 10 minutes |
| **TOTAL** | **~40 minutes** |

So yes — you can be fully live in **under 1 hour** if you follow these steps! 🚀
