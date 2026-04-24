# 🏪 Telegram Store Bot

A full-featured Telegram bot for selling digital products with automatic delivery, multiple payment gateways, member system, and admin panel.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Telegram](https://img.shields.io/badge/Telegram-Bot-blue?logo=telegram)

## ✨ Features

### 🛍️ Store
- Product catalog with categories
- Stock management (numeric or digital data)
- Stock queue — each buyer gets a unique item
- Bulk import via `.txt` file (1000+ items)
- Min/max order per product
- Price labels (e.g., `/account`, `/month`)

### 💳 6 Payment Gateways
| Gateway | Mode | QRIS in Chat |
|---------|------|:---:|
| Midtrans | Snap (redirect) | ❌ |
| Xendit | QRIS direct | ✅ |
| Paydisini | QRIS direct | ✅ |
| Tripay | QRIS direct | ✅ |
| Duitku | Redirect | ❌ |
| Manual | Static QRIS + transfer | ✅ |

Switch between gateways from admin panel — no code changes needed!

### ⚡ Auto-Delivery
- Buyer pays → product delivered instantly
- Digital products (accounts, vouchers, keys, configs)
- Manual delivery option for non-digital products

### 💰 Wallet & Member System
- Deposit balance via any payment gateway
- Pay with balance (instant, no redirect)
- Transaction history
- Member levels: 🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Diamond

### 🎟️ Coupons & Discounts
- Percentage or fixed amount discounts
- Usage limits
- Toggle on/off from admin

### 👑 Admin Panel (Full Inline)
- Everything managed via buttons — no commands needed
- Add/edit/delete products
- Approve/reject orders
- Broadcast to all users
- Sales statistics & revenue

### 👥 Multi-Role System
| Role | Permissions |
|------|------------|
| 👑 Owner | Full access, settings, staff management |
| 🔑 Admin | Products, coupons, broadcast, orders |
| 👷 Staff | Stock management, approve orders |

### 🛡️ Other Features
- ⏰ Auto-cancel expired orders (30 min)
- ✅ Buy confirmation before payment
- 📏 Quantity orders (min/max)
- 🔄 Anti-spam (1 pending order per product)
- 📊 Statistics dashboard
- ⚙️ All settings editable from bot
- 📝 Edit message navigation (clean chat)

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

### Installation

```bash
# Clone the repository
git clone https://github.com/edikurexe/tg-store-bot.git
cd tg-store-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your values
nano .env

# Start the bot
node bot.js
```

### Environment Variables

| Variable | Required | Description |
|----------|:---:|-------------|
| `TG_STORE_TOKEN` | ✅ | Telegram Bot Token |
| `ADMIN_IDS` | ✅ | Owner Telegram User ID(s), comma separated |
| `STORE_NAME` | ❌ | Store name (default: 🏪 Digital Store) |
| `MIDTRANS_SERVER_KEY` | ❌ | Midtrans Server Key |
| `MIDTRANS_PRODUCTION` | ❌ | `true` for production, `false` for sandbox |

> Other payment gateway keys can be set from the admin panel → ⚙️ Settings → 🔑 API Keys

### 🐳 Docker (Recommended)

```bash
# Clone
git clone https://github.com/edikurexe/tg-store-bot.git
cd tg-store-bot

# Setup environment
cp .env.example .env
nano .env  # Fill in your bot token & admin ID

# Run with Docker Compose
docker compose up -d

# View logs
docker compose logs -f
```

Data is persisted in `./data/` directory.

### Running as a Service (systemd)

```bash
# Create service file
cat > ~/.config/systemd/user/tg-store-bot.service << 'EOF'
[Unit]
Description=Telegram Store Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/tg-store-bot
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=10
Environment=TG_STORE_TOKEN=your_token
Environment=ADMIN_IDS=your_user_id
Environment=STORE_NAME=🏪 My Store

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable tg-store-bot
systemctl --user start tg-store-bot
```

## 📖 Usage

### For Buyers
1. Open the bot and press `/start`
2. Browse products by category
3. Select a product and quantity
4. Apply coupon (optional)
5. Choose payment method (gateway or balance)
6. Pay → receive product automatically!

### For Admins
1. Press `/admin` or tap 👑 Admin Panel
2. Add products → set stock (numeric or digital data)
3. Configure payment gateway in ⚙️ Settings
4. Manage coupons, staff, and orders

### Adding Products
1. `/admin` → ➕ Add Product
2. Follow the guided steps (name, description, price, stock, category)
3. Add stock:
   - **🔢 Numeric** — just enter a number
   - **💾 Digital data** — paste items or upload `.txt` file

### Stock Data Formats
```
# One line per item (separated by Enter)
user1@mail.com:pass1
user2@mail.com:pass2

# Multi-line per item (separated by ===)
server: sg1.vpn.com
user: abc
pass: 123
===
server: sg2.vpn.com
user: def
pass: 456
```

## 🔧 Payment Gateway Setup

### Midtrans
1. Register at [midtrans.com](https://midtrans.com)
2. Get Server Key from Dashboard → Settings → Access Keys
3. Set in bot: Admin → ⚙️ Settings → 🔑 API Keys → Midtrans Key

### Xendit
1. Register at [xendit.co](https://xendit.co)
2. Get Secret Key from Dashboard → Settings → API Keys
3. Set in bot: Admin → ⚙️ Settings → 🔑 API Keys → Xendit Secret Key

### Paydisini
1. Register at [paydisini.co.id](https://paydisini.co.id)
2. Get API Key from Dashboard
3. Set in bot: Admin → ⚙️ Settings → 🔑 API Keys → Paydisini Key

### Tripay
1. Register at [tripay.co.id](https://tripay.co.id)
2. Get API Key and Merchant Code
3. Set in bot: Admin → ⚙️ Settings → 🔑 API Keys

### Manual (No Gateway)
1. Admin → ⚙️ Settings → Select "Manual"
2. Upload QRIS image
3. Set transfer info text

## 📁 Project Structure

```
tg-store-bot/
├── bot.js          # Main bot file
├── store.db        # SQLite database (auto-created)
├── package.json
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## 🗄️ Database Tables

| Table | Description |
|-------|-------------|
| `products` | Product catalog |
| `orders` | Order records |
| `users` | User profiles & balances |
| `stock_items` | Digital product stock queue |
| `coupons` | Discount coupons |
| `settings` | Bot configuration |
| `staff` | Admin & staff roles |
| `wallet_tx` | Wallet transactions |

## 🤝 Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 👨‍💻 Author

**edikurexe** — [GitHub](https://github.com/edikurexe) | [Telegram](https://t.me/TutorWir)

---

⭐ If you find this useful, give it a star!
