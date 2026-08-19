# Covert Chat — Render Online Deployment Guide 🚀

This guide walks you through deploying **Covert Chat** online to [Render](https://render.com) so you can share your encrypted chat link and access it across phones, laptops, and networks.

---

## 🌟 Architecture Highlights
- **Single Fullstack Service**: The Node.js server automatically serves the built React frontend bundle **and** handles the WebRTC signaling WebSocket on the same port (`$PORT`).
- **Free Tier Compatible**: Requires only **1 free Web Service** on Render.
- **Auto HTTPS & WSS**: Render automatically provisions TLS certificates so cryptographic APIs (`window.crypto.subtle`, WebRTC) work smoothly.
- **Built-in Health Checks**: `/health` endpoint is configured for zero-downtime health verification and uptime pingers.

---

## 🛠️ Step 1: Push Code to GitHub

Make sure your latest code is pushed to your GitHub repository:

```bash
git add .
git commit -m "Configure single-service fullstack deployment for Render"
git push origin main
```

---

## 🌐 Step 2: Deploy on Render

You can deploy using **Option A (Blueprint - Recommended)** or **Option B (Manual Web Service)**:

### Option A: Render Blueprint (1-Click Setup)
1. Go to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** in the top right corner and select **Blueprint**.
3. Connect your GitHub repository (`Covert-Chatter`).
4. Render will automatically read `render.yaml` and configure the Web Service with:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
5. Click **Apply**. Render will automatically build the client, start the server, and give you your live URL (e.g. `https://covert-chat.onrender.com`).

---

### Option B: Manual Web Service Setup
1. Go to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Select your repository.
4. Fill in the following settings:
   - **Name**: `covert-chat` (or your preferred name)
   - **Language / Runtime**: `Node`
   - **Branch**: `main`
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Under **Advanced**:
   - **Health Check Path**: `/health`
6. Click **Create Web Service**.

---

## 🔒 Step 3: Configure TURN Server (Recommended for Mobile & Cross-Network)

By default, WebRTC connects over Google's public STUN servers (`stun.l.google.com:19302`).  
If you are connecting across mobile cellular networks (4G/5G) or strict firewalls, configure free TURN server credentials (e.g. from [Metered.ca](https://www.metered.ca/tools/openrelay/)):

1. In Render Dashboard, click your Web Service and navigate to **Environment**.
2. Add the following environment variables:
   - `VITE_TURN_URL` : `turn:global.relay.metered.ca:80` (or your TURN provider URL)
   - `VITE_TURN_USERNAME` : `<your_turn_username>`
   - `VITE_TURN_CREDENTIAL` : `<your_turn_password>`
3. Click **Save Changes** (Render will trigger a quick rebuild with the credentials embedded in the client build).

---

## 📱 Step 4: Test Your Live Deployment

1. Once deployment succeeds, open the generated `https://your-service-name.onrender.com` link on your laptop.
2. Click **Create Secure Room** to generate a 6-character room code and QR code.
3. Open the same link on your mobile phone or a second browser window.
4. Click **Join Secure Room**, scan the QR code or enter the code.
5. Once connected:
   - Cryptographic keys (ECDSA + ECDH) will negotiate end-to-end encryption.
   - Send messages, ephemeral self-destruct timers, or files securely.

---

## 💡 Pro-Tip: Preventing Free Tier Spin-Down
Render's free tier spins down after 15 minutes of inactivity.  
You can use a free uptime monitor (like [UptimeRobot](https://uptimerobot.com) or [Cron-Job.org](https://cron-job.org)) to ping `https://your-service-name.onrender.com/health` every 10 minutes to keep it warm and responsive 24/7!
