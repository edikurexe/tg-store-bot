const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const midtransClient = require('midtrans-client');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');


// === Config ===
const TOKEN = process.env.TG_STORE_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const STORE_NAME = process.env.STORE_NAME || '🏪 Digital Store';
const PAYMENT_INFO = process.env.PAYMENT_INFO || 'Scan QRIS atau transfer via Midtrans';
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const MIDTRANS_IS_PRODUCTION = (process.env.MIDTRANS_PRODUCTION || 'true') === 'true';


if (!TOKEN) {
    console.error('❌ Set TG_STORE_TOKEN env variable!');
    process.exit(1);
}

// === Midtrans ===
let snap = null;
let coreApi = null;
if (MIDTRANS_SERVER_KEY) {
    snap = new midtransClient.Snap({
        isProduction: MIDTRANS_IS_PRODUCTION,
        serverKey: MIDTRANS_SERVER_KEY,
    });
    coreApi = new midtransClient.CoreApi({
        isProduction: MIDTRANS_IS_PRODUCTION,
        serverKey: MIDTRANS_SERVER_KEY,
    });
    console.log(`💳 Midtrans ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'} ready`);
} else {
    console.log('⚠️ No Midtrans key, manual payment mode');
}

// === Database ===
const DB_PATH = path.join(__dirname, 'store.db');
const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price INTEGER NOT NULL,
        stock INTEGER DEFAULT 0,
        category TEXT DEFAULT 'Umum',
        data TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT DEFAULT '',
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        price INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        payment_proof TEXT DEFAULT '',
        delivered_data TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS stock_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        sold INTEGER DEFAULT 0,
        order_id INTEGER DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT DEFAULT '',
        first_name TEXT DEFAULT '',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_orders INTEGER DEFAULT 0
    );
`);

// Prepared statements
const stmts = {
    getProducts: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, name'),
    getProduct: db.prepare('SELECT * FROM products WHERE id = ? AND active = 1'),
    getProductAll: db.prepare('SELECT * FROM products WHERE id = ?'),
    getCategories: db.prepare('SELECT DISTINCT category FROM products WHERE active = 1 ORDER BY category'),
    getByCategory: db.prepare('SELECT * FROM products WHERE category = ? AND active = 1 ORDER BY name'),
    addProduct: db.prepare('INSERT INTO products (name, description, price, stock, category, data) VALUES (?, ?, ?, ?, ?, ?)'),
    updateStock: db.prepare('UPDATE products SET stock = ? WHERE id = ?'),
    updateProduct: db.prepare('UPDATE products SET name = ?, description = ?, price = ?, stock = ?, category = ? WHERE id = ?'),
    deleteProduct: db.prepare('UPDATE products SET active = 0 WHERE id = ?'),
    restoreProduct: db.prepare('UPDATE products SET active = 1 WHERE id = ?'),
    setProductData: db.prepare('UPDATE products SET data = ? WHERE id = ?'),

    createOrder: db.prepare('INSERT INTO orders (user_id, username, product_id, product_name, price) VALUES (?, ?, ?, ?, ?)'),
    getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
    getUserOrders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'),
    getPendingOrders: db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC"),
    getAllOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50'),
    updateOrderStatus: db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    setPaymentProof: db.prepare('UPDATE orders SET payment_proof = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    setDeliveredData: db.prepare('UPDATE orders SET delivered_data = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),

    // Stock queue
    addStockItem: db.prepare('INSERT INTO stock_items (product_id, data) VALUES (?, ?)'),
    getNextStockItem: db.prepare('SELECT * FROM stock_items WHERE product_id = ? AND sold = 0 ORDER BY id LIMIT 1'),
    markStockSold: db.prepare('UPDATE stock_items SET sold = 1, order_id = ? WHERE id = ?'),
    countStockItems: db.prepare('SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND sold = 0'),
    getStockItems: db.prepare('SELECT * FROM stock_items WHERE product_id = ? AND sold = 0 ORDER BY id'),
    deleteStockItem: db.prepare('DELETE FROM stock_items WHERE id = ? AND sold = 0'),
    clearStock: db.prepare('DELETE FROM stock_items WHERE product_id = ? AND sold = 0'),

    // Settings
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

    // Coupons
    getCoupon: db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1'),
    getAllCoupons: db.prepare('SELECT * FROM coupons ORDER BY created_at DESC'),
    addCoupon: db.prepare('INSERT INTO coupons (code, discount_type, discount_value, min_order, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    useCoupon: db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?'),
    deleteCoupon: db.prepare('DELETE FROM coupons WHERE id = ?'),
    toggleCoupon: db.prepare('UPDATE coupons SET active = ? WHERE id = ?'),

    // Wallet
    getBalance: db.prepare('SELECT balance, total_spent, level, total_orders FROM users WHERE id = ?'),
    addBalance: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
    deductBalance: db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ?'),
    addWalletTx: db.prepare('INSERT INTO wallet_tx (user_id, type, amount, description, order_id) VALUES (?, ?, ?, ?, ?)'),
    getWalletHistory: db.prepare('SELECT * FROM wallet_tx WHERE user_id = ? ORDER BY created_at DESC LIMIT 15'),
    updateLevel: db.prepare('UPDATE users SET level = ? WHERE id = ?'),

    // Staff
    getStaff: db.prepare('SELECT * FROM staff WHERE user_id = ?'),
    getAllStaff: db.prepare('SELECT * FROM staff ORDER BY role, created_at'),
    addStaff: db.prepare('INSERT OR REPLACE INTO staff (user_id, username, role, added_by) VALUES (?, ?, ?, ?)'),
    removeStaff: db.prepare('DELETE FROM staff WHERE user_id = ?'),

    upsertUser: db.prepare('INSERT INTO users (id, username, first_name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = ?, first_name = ?'),
    incUserOrders: db.prepare('UPDATE users SET total_orders = total_orders + 1 WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) as count FROM users'),
    getStats: db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN price ELSE 0 END) as revenue, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending FROM orders"),
};

// === Bot ===
const bot = new TelegramBot(TOKEN, { polling: true });
console.log(`🚀 ${STORE_NAME} Bot started!`);

// Track user states for multi-step flows
const userStates = {};

function isOwner(userId) {
    return ADMIN_IDS.includes(userId);
}

function isAdmin(userId) {
    if (ADMIN_IDS.includes(userId)) return true;
    const staff = stmts.getStaff.get(userId);
    return staff?.role === 'admin';
}

function isStaff(userId) {
    if (ADMIN_IDS.includes(userId)) return true;
    const staff = stmts.getStaff.get(userId);
    return !!staff;
}

function getUserRole(userId) {
    if (ADMIN_IDS.includes(userId)) return 'owner';
    const staff = stmts.getStaff.get(userId);
    return staff?.role || null;
}

// === Member Level ===
function calcLevel(totalSpent) {
    if (totalSpent >= 1000000) return { name: '💎 Diamond', min: 1000000 };
    if (totalSpent >= 500000) return { name: '🥇 Gold', min: 500000 };
    if (totalSpent >= 200000) return { name: '🥈 Silver', min: 200000 };
    return { name: '🥉 Bronze', min: 0 };
}

function updateMemberLevel(userId) {
    const user = stmts.getBalance.get(userId);
    if (!user) return;
    const level = calcLevel(user.total_spent);
    stmts.updateLevel.run(level.name, userId);
}

// === Edit or Send helper ===
async function editOrSend(chatId, msgId, text, opts = {}) {
    if (msgId) {
        try {
            return await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                ...opts,
            });
        } catch (e) {
            // If edit fails (message too old, etc), send new
            if (!e.message?.includes('message is not modified')) {
                return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
            }
        }
    }
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}

function getSetting(key, fallback = '') {
    const row = stmts.getSetting.get(key);
    return row ? row.value : fallback;
}

function formatPrice(price) {
    return `Rp ${price.toLocaleString('id-ID')}`;
}

function trackUser(msg) {
    const u = msg.from;
    stmts.upsertUser.run(u.id, u.username || '', u.first_name || '', u.username || '', u.first_name || '');
}

// === /start ===
bot.onText(/\/start/, (msg) => {
    trackUser(msg);
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'Kak';
    const storeName = getSetting('store_name', STORE_NAME);
    const welcomeMsg = getSetting('welcome_msg', 'Mau top up game atau beli produk digital? Kamu di tempat yang tepat!');

    const products = stmts.getProducts.all();
    const categories = stmts.getCategories.all();

    const buttons = [
        [{ text: '🛍️ Lihat Produk', callback_data: 'catalog' }],
    ];

    if (categories.length > 0) {
        const topCats = categories.slice(0, 3).map(c => ({ text: `${c.category}`, callback_data: `cat_${c.category}` }));
        buttons.push(topCats);
    }

    buttons.push(
        [{ text: '💰 Saldo', callback_data: 'wallet' }, { text: '🛒 Order Saya', callback_data: 'my_orders' }],
        [{ text: '💳 Cara Bayar', callback_data: 'payment_info' }, { text: '📞 Bantuan', callback_data: 'help' }],
    );

    if (isStaff(msg.from.id)) {
        buttons.push([{ text: '👑 Admin Panel', callback_data: 'adm_panel' }]);
    }

    bot.sendMessage(chatId,
        `Halo *${name}*! 👋\n\n` +
        `Selamat datang di *${storeName}*\n\n` +
        `${welcomeMsg}\n\n` +
        `📦 *${products.length}* produk tersedia\n` +
        `⚡ Pembayaran otomatis & instan`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        }
    );
});

// === Catalog ===
function showCatalog(chatId, msgId) {
    const categories = stmts.getCategories.all();

    if (categories.length === 0) {
        return editOrSend(chatId, msgId, '😔 Belum ada produk. Nantikan update ya!');
    }

    const buttons = categories.map(c => [{ text: `📁 ${c.category}`, callback_data: `cat_${c.category}` }]);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'start' }]);

    editOrSend(chatId, msgId, `📦 *Kategori Produk:*`, {
        reply_markup: { inline_keyboard: buttons }
    });
}

function showCategory(chatId, category, msgId) {
    const products = stmts.getByCategory.all(category);

    if (products.length === 0) {
        return editOrSend(chatId, msgId, `Kategori "${category}" kosong.`);
    }

    const buttons = products.map(p => {
        const stockLabel = p.stock > 0 ? `✅ ${p.stock}` : '❌ Habis';
        return [{ text: `${p.name} — ${formatPrice(p.price)} [${stockLabel}]`, callback_data: `prod_${p.id}` }];
    });
    buttons.push([{ text: '🔙 Katalog', callback_data: 'catalog' }]);

    editOrSend(chatId, msgId, `📁 *${category}*\n\nPilih produk:`, {
        reply_markup: { inline_keyboard: buttons }
    });
}

function showProduct(chatId, productId, msgId) {
    const p = stmts.getProduct.get(productId);
    if (!p) return editOrSend(chatId, msgId, '❌ Produk tidak ditemukan.');

    const stockLabel = p.stock > 0 ? `✅ Tersedia (${p.stock})` : '❌ Stok Habis';
    const minOrder = p.min_order || 1;
    const maxOrder = Math.min(p.max_order || 100, p.stock);
    const priceLabel = p.price_label || '';

    let priceText = `💰 Harga: *${formatPrice(p.price)}*`;
    if (priceLabel) priceText += ` ${priceLabel}`;
    if (minOrder > 1) priceText += `\n📏 Min. order: ${minOrder}`;

    const text =
        `🏷️ *${p.name}*\n\n` +
        `${p.description || '_Tidak ada deskripsi_'}\n\n` +
        `${priceText}\n` +
        `📦 Stok: ${stockLabel}\n` +
        `📁 Kategori: ${p.category}`;

    const buttons = [];
    if (p.stock > 0 && p.stock >= minOrder) {
        if (minOrder > 1) {
            // 3 buttons: 1x, 2x, 3x min order
            const qty1 = minOrder;
            const qty2 = minOrder * 2;
            const qty3 = minOrder * 3;

            buttons.push([{ text: `🛒 ${qty1}x (${formatPrice(p.price * qty1)})`, callback_data: `buyqty_${p.id}_${qty1}` }]);
            if (qty2 <= maxOrder) buttons.push([{ text: `🛒 ${qty2}x (${formatPrice(p.price * qty2)})`, callback_data: `buyqty_${p.id}_${qty2}` }]);
            if (qty3 <= maxOrder) buttons.push([{ text: `🛒 ${qty3}x (${formatPrice(p.price * qty3)})`, callback_data: `buyqty_${p.id}_${qty3}` }]);
            buttons.push([{ text: '✏️ Jumlah lain', callback_data: `buycustom_${p.id}` }]);
        } else {
            buttons.push([{ text: '🛒 Beli Sekarang', callback_data: `buy_${p.id}` }]);
        }
    }
    buttons.push([{ text: '🔙 Katalog', callback_data: 'catalog' }]);

    editOrSend(chatId, msgId, text, {
        reply_markup: { inline_keyboard: buttons }
    });
}

// === Buy Flow ===
function showBuyConfirm(chatId, productId, qty, msgId) {
    const p = stmts.getProduct.get(productId);
    if (!p) return editOrSend(chatId, msgId, '❌ Produk tidak ditemukan.');
    if (p.stock < qty) return editOrSend(chatId, msgId, `❌ Stok tidak cukup. Tersedia: ${p.stock}`);

    const total = p.price * qty;
    editOrSend(chatId, msgId,
        `🛒 *Konfirmasi Pembelian*\n\n` +
        `🏷️ ${p.name}\n` +
        `📦 Jumlah: ${qty}\n` +
        `💰 Total: *${formatPrice(total)}*\n\n` +
        `Punya kupon? Klik tombol kupon di bawah.`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `✅ Bayar ${formatPrice(total)}`, callback_data: `confirm_${productId}_${qty}` }],
                    [{ text: `💰 Bayar Saldo`, callback_data: `confirmsaldo_${productId}_${qty}` }],
                    [{ text: '🎟️ Pakai Kupon', callback_data: `coupon_${productId}_${qty}` }],
                    [{ text: '❌ Batal', callback_data: `prod_${productId}` }],
                ]
            }
        }
    );
}

async function processDeposit(chatId, msgId, userId, username, amount) {
    const paymentMode = getSetting('payment_mode', 'midtrans');
    const txId = `DEP-${userId}-${Date.now()}`;

    // Midtrans Snap
    if (paymentMode === 'midtrans' && snap) {
        try {
            const snapRes = await snap.createTransaction({
                transaction_details: { order_id: txId, gross_amount: amount },
                customer_details: { first_name: username || String(userId) },
                custom_field1: 'deposit', custom_field2: String(userId), custom_field3: String(amount),
            });
            stmts.addWalletTx.run(userId, 'deposit_pending', amount, txId, null);
            return editOrSend(chatId, msgId, `➕ *Deposit ${formatPrice(amount)}*\n\nKlik tombol di bawah untuk bayar:`, {
                reply_markup: { inline_keyboard: [
                    [{ text: '💳 Bayar Sekarang', url: snapRes.redirect_url }],
                    [{ text: '🔄 Cek Status', callback_data: `depcheck_${txId}` }],
                    [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                ]}
            });
        } catch (e) { console.error('Deposit Midtrans error:', e.message); }
    }

    // Xendit QRIS (deposit)
    if (paymentMode === 'xendit') {
        const secretKey = getSetting('xendit_secret_key');
        if (secretKey) {
            try {
                const res = await fetch('https://api.xendit.co/qr_codes', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        reference_id: txId, type: 'DYNAMIC', currency: 'IDR',
                        amount, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                    }),
                });
                const data = await res.json();
                if (data.qr_string) {
                    stmts.addWalletTx.run(userId, 'deposit_pending', amount, txId, null);
                    const qrPath = `/tmp/qr_dep_${userId}.png`;
                    const QRCode = require('qrcode');
                    await QRCode.toFile(qrPath, data.qr_string, { width: 512 });
                    await bot.sendPhoto(chatId, qrPath, {
                        caption: `➕ *Deposit ${formatPrice(amount)}*\n\n📱 Scan QRIS di atas!\n⏰ Berlaku 15 menit.`,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '🔄 Cek Status', callback_data: `depcheck_${txId}` }],
                            [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                        ]}
                    });
                    try { require('fs').unlinkSync(qrPath); } catch(e) {}
                    return;
                }
            } catch (e) { console.error('Xendit deposit error:', e.message); }
        }
    }

    // Paydisini QRIS
    if (paymentMode === 'paydisini') {
        const apiKey = getSetting('paydisini_api_key');
        if (apiKey) {
            try {
                const crypto = require('crypto');
                const signature = crypto.createHash('md5').update(apiKey + txId + amount + 'NewTransaction').digest('hex');
                const params = new URLSearchParams({
                    key: apiKey, request: 'new', unique_code: txId,
                    service: '11', amount: String(amount), note: `Deposit ${username || userId}`,
                    valid_time: '900', type_fee: '1', signature,
                });
                const res = await fetch('https://paydisini.co.id/api/', { method: 'POST', body: params });
                const data = await res.json();
                if (data.success && data.data?.qrcode_url) {
                    stmts.addWalletTx.run(userId, 'deposit_pending', amount, txId, null);
                    return bot.sendPhoto(chatId, data.data.qrcode_url, {
                        caption: `➕ *Deposit ${formatPrice(amount)}*\n\n📱 Scan QRIS di atas!\n⏰ Berlaku 15 menit.`,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '🔄 Cek Status', callback_data: `depcheck_${txId}` }],
                            [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                        ]}
                    });
                }
            } catch (e) { console.error('Deposit Paydisini error:', e.message); }
        }
    }

    // Manual
    const manualInfo = getSetting('manual_payment_info', 'Hubungi admin');
    const qrisFileId = getSetting('manual_qris_file_id');
    stmts.addWalletTx.run(userId, 'deposit_pending', amount, txId, null);

    if (qrisFileId) {
        return bot.sendPhoto(chatId, qrisFileId, {
            caption: `➕ *Deposit ${formatPrice(amount)}*\n\n📱 Scan QRIS di atas\n${manualInfo}\n\nSetelah bayar, hubungi admin.`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Saldo', callback_data: 'wallet' }]] }
        });
    }
    return editOrSend(chatId, msgId, `➕ *Deposit ${formatPrice(amount)}*\n\n${manualInfo}\n\nSetelah bayar, hubungi admin.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Saldo', callback_data: 'wallet' }]] }
    });
}

async function startBuyWithSaldo(chatId, msgId, userId, username, productId, qty = 1, couponCode = null) {
    const p = stmts.getProduct.get(productId);
    if (!p) return editOrSend(chatId, msgId, '❌ Produk tidak ditemukan.');
    if (p.stock <= 0) return editOrSend(chatId, msgId, '❌ Stok habis!');
    if (qty > p.stock) return editOrSend(chatId, msgId, `❌ Stok tidak cukup. Tersedia: ${p.stock}`);

    let totalPrice = p.price * qty;
    let discount = 0;

    // Apply coupon
    if (couponCode) {
        const coupon = stmts.getCoupon.get(couponCode.toUpperCase());
        if (coupon && coupon.active) {
            discount = coupon.discount_type === 'percent'
                ? Math.floor(totalPrice * coupon.discount_value / 100)
                : coupon.discount_value;
            if (discount > totalPrice) discount = totalPrice;
            totalPrice -= discount;
            stmts.useCoupon.run(coupon.id);
        }
    }
    if (userStates[userId]?.couponCode) delete userStates[userId];

    // Check balance
    const user = stmts.getBalance.get(userId);
    const balance = user?.balance || 0;
    if (balance < totalPrice) {
        return editOrSend(chatId, msgId,
            `❌ *Saldo tidak cukup!*\n\n💰 Saldo: ${formatPrice(balance)}\n💵 Harga: ${formatPrice(totalPrice)}\n💸 Kurang: ${formatPrice(totalPrice - balance)}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '➕ Deposit Saldo', callback_data: 'deposit' }],
                        [{ text: '🔙 Menu', callback_data: 'start' }],
                    ]
                }
            }
        );
    }

    // Deduct balance & create order
    stmts.deductBalance.run(totalPrice, totalPrice, userId);
    const result = stmts.createOrder.run(userId, username || '', p.id, `${p.name} x${qty}${discount ? ' (disc ' + formatPrice(discount) + ')' : ''}`, totalPrice);
    const orderId = result.lastInsertRowid;
    stmts.updateStock.run(p.stock - qty, p.id);
    stmts.incUserOrders.run(userId);
    db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(String(qty), orderId);
    stmts.addWalletTx.run(userId, 'purchase', totalPrice, `Order #${orderId} - ${p.name} x${qty}`, orderId);
    updateMemberLevel(userId);

    // Auto-deliver
    await processPaymentSuccess(orderId);

    const newBalance = (stmts.getBalance.get(userId))?.balance || 0;
    editOrSend(chatId, msgId,
        `✅ *Pembelian Berhasil (Saldo)!*\n\n` +
        `🏷️ ${p.name} x${qty}\n` +
        (discount ? `🎟️ Diskon: -${formatPrice(discount)}\n` : '') +
        `💰 Dibayar: ${formatPrice(totalPrice)}\n` +
        `💰 Sisa saldo: ${formatPrice(newBalance)}`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🛍️ Belanja Lagi', callback_data: 'catalog' }, { text: '💰 Saldo', callback_data: 'wallet' }],
                ]
            }
        }
    );

    ADMIN_IDS.forEach(id => bot.sendMessage(id,
        `💰 *Order via Saldo*\n\nOrder #${orderId}\n👤 @${username || userId}\n🏷️ ${p.name} x${qty}\n💰 ${formatPrice(totalPrice)}`,
        { parse_mode: 'Markdown' }
    ));
}

async function startBuy(chatId, userId, username, productId, qty = 1, couponCode = null) {
    const p = stmts.getProduct.get(productId);
    if (!p) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
    if (p.stock <= 0) return bot.sendMessage(chatId, '❌ Maaf, stok habis!');

    // Cek apakah buyer punya order pending buat produk ini
    const existingOrder = db.prepare(
        "SELECT * FROM orders WHERE user_id = ? AND product_id = ? AND status = 'pending' AND created_at > datetime('now', '-30 minutes')"
    ).get(userId, productId);
    if (existingOrder) {
        return bot.sendMessage(chatId,
            `⚠️ Kamu masih punya order pending (#${existingOrder.id}) untuk produk ini.\nBayar dulu atau tunggu expired (30 menit).`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Cek Status', callback_data: `cekbayar_${existingOrder.id}` }],
                        [{ text: '❌ Cancel Order Lama', callback_data: `cancel_${existingOrder.id}` }],
                    ]
                }
            }
        );
    }

    const minOrder = p.min_order || 1;
    if (qty < minOrder) qty = minOrder;
    if (qty > p.stock) return bot.sendMessage(chatId, `❌ Stok tidak cukup. Tersedia: ${p.stock}`);

    let totalPrice = p.price * qty;
    let discount = 0;
    let coupon = null;

    // Apply coupon
    if (couponCode) {
        coupon = stmts.getCoupon.get(couponCode.toUpperCase());
        if (coupon) {
            if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
                coupon = null; // Expired uses
            } else if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
                coupon = null; // Expired date
            } else if (coupon.min_order > 0 && totalPrice < coupon.min_order) {
                coupon = null; // Min order not met
            } else {
                if (coupon.discount_type === 'percent') {
                    discount = Math.floor(totalPrice * coupon.discount_value / 100);
                } else {
                    discount = coupon.discount_value;
                }
                if (discount > totalPrice) discount = totalPrice;
                totalPrice -= discount;
                stmts.useCoupon.run(coupon.id);
            }
        }
    }
    // Clean up coupon state
    if (userStates[userId]?.couponCode) delete userStates[userId];

    // Create order
    const result = stmts.createOrder.run(userId, username || '', p.id, `${p.name} x${qty}${discount ? ' (disc ' + formatPrice(discount) + ')' : ''}`, totalPrice);
    const orderId = result.lastInsertRowid;

    // Decrease stock
    stmts.updateStock.run(p.stock - qty, p.id);
    stmts.incUserOrders.run(userId);

    // Store qty in order notes for delivery
    db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(String(qty), orderId);

    // Gratis (kupon 100% atau harga 0) — langsung deliver tanpa bayar
    if (totalPrice <= 0) {
        await processPaymentSuccess(orderId);
        await bot.sendMessage(chatId,
            `🎉 *Order #${orderId} — GRATIS!*\n\n` +
            `🏷️ ${p.name} x${qty}\n` +
            (discount ? `🎟️ Diskon: ${formatPrice(discount)}\n` : '') +
            `💰 Total: *Rp 0 (Gratis!)*`,
            { parse_mode: 'Markdown' }
        );
        ADMIN_IDS.forEach(id => bot.sendMessage(id,
            `🎁 *Order Gratis!*\n\nOrder #${orderId}\n👤 @${username || userId}\n🏷️ ${p.name} x${qty}\n🎟️ Kupon: ${couponCode || '-'}`,
            { parse_mode: 'Markdown' }
        ));
        return;
    }

    const paymentMode = getSetting('payment_mode', 'midtrans');

    // Manual payment mode
    if (paymentMode === 'manual') {
        const manualInfo = getSetting('manual_payment_info', 'Hubungi admin untuk info pembayaran');
        const qrisFileId = getSetting('manual_qris_file_id');

        if (qrisFileId) {
            await bot.sendPhoto(chatId, qrisFileId, {
                caption:
                    `✅ *Order #${orderId} Dibuat!*\n\n` +
                    `🏷️ ${p.name}\n` +
                    `💰 Total: *${formatPrice(p.price)}*\n\n` +
                    `📱 *Scan QRIS di atas*\n` +
                    `${manualInfo}\n\n` +
                    `Setelah bayar, kirim bukti: \`/bayar ${orderId}\` + foto`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                    ]
                }
            });
        } else {
            await bot.sendMessage(chatId,
                `✅ *Order #${orderId} Dibuat!*\n\n` +
                `🏷️ ${p.name}\n` +
                `💰 Total: *${formatPrice(p.price)}*\n\n` +
                `💳 *Cara Bayar:*\n${manualInfo}\n\n` +
                `Setelah bayar, kirim bukti: \`/bayar ${orderId}\` + foto`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                        ]
                    }
                }
            );
        }

        // Notify admins
        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId,
                `🔔 *Order Baru (Manual)*\n\n📋 Order #${orderId}\n👤 @${username || userId}\n🏷️ ${p.name}\n💰 ${formatPrice(p.price)}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Approve', callback_data: `approve_${orderId}` }, { text: '❌ Reject', callback_data: `reject_${orderId}` }],
                        ]
                    }
                }
            );
        });
        return;
    }

    // Duitku mode
    if (paymentMode === 'duitku') {
        const merchantCode = getSetting('duitku_merchant_code');
        const apiKey = getSetting('duitku_api_key');
        if (merchantCode && apiKey) {
            try {
                const crypto = require('crypto');
                const txId = `ORDER-${orderId}-${Date.now()}`;
                const amount = totalPrice;
                const signature = crypto.createHash('md5').update(merchantCode + txId + amount + apiKey).digest('hex');

                const res = await fetch('https://passport.duitku.com/webapi/api/merchant/v2/inquiry', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        merchantCode, merchantOrderId: txId, paymentAmount: amount,
                        paymentMethod: 'SP', productDetails: p.name,
                        customerVaName: username || String(userId),
                        email: 'buyer@store.com', phoneNumber: '08000000000',
                        callbackUrl: `https://servernyaedi-1.tailbe2e82.ts.net/midtrans-webhook`,
                        returnUrl: 'https://t.me/tutorwir_bot',
                        signature, expiryPeriod: 15,
                    }),
                });
                const data = await res.json();
                if (data.paymentUrl) {
                    db.prepare('UPDATE orders SET payment_proof = ? WHERE id = ?').run(txId, orderId);
                    await bot.sendMessage(chatId,
                        `✅ *Order #${orderId} Dibuat!*\n\n🏷️ ${p.name}\n💰 Total: *${formatPrice(p.price)}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [
                                [{ text: '💳 Bayar Sekarang', url: data.paymentUrl }],
                                [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                            ]}
                        }
                    );
                    ADMIN_IDS.forEach(id => bot.sendMessage(id, `🔔 Order #${orderId} @${username||userId} ${p.name} ${formatPrice(p.price)} (Duitku)`));
                    return;
                }
            } catch (e) { console.error('Duitku error:', e.message); }
        }
    }

    // Paydisini mode
    if (paymentMode === 'paydisini') {
        const apiKey = getSetting('paydisini_api_key');
        if (apiKey) {
            try {
                const txId = `ORDER-${orderId}-${Date.now()}`;
                const crypto = require('crypto');
                const signature = crypto.createHash('md5').update(apiKey + txId + totalPrice + 'NewTransaction').digest('hex');

                const params = new URLSearchParams({
                    key: apiKey, request: 'new', unique_code: txId,
                    service: '11', amount: String(totalPrice), note: p.name,
                    valid_time: '900', type_fee: '1', signature,
                });
                const res = await fetch('https://paydisini.co.id/api/', { method: 'POST', body: params });
                const data = await res.json();
                if (data.success && data.data?.qrcode_url) {
                    db.prepare('UPDATE orders SET payment_proof = ? WHERE id = ?').run(txId, orderId);
                    await bot.sendPhoto(chatId, data.data.qrcode_url, {
                        caption: `✅ *Order #${orderId}*\n\n🏷️ ${p.name}\n💰 *${formatPrice(p.price)}*\n\n📱 Scan QRIS di atas untuk bayar!\n⏰ Berlaku 15 menit.`,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '🔄 Cek Status', callback_data: `cekbayar_${orderId}` }],
                            [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                        ]}
                    });
                    ADMIN_IDS.forEach(id => bot.sendMessage(id, `🔔 Order #${orderId} @${username||userId} ${p.name} ${formatPrice(p.price)} (Paydisini QRIS)`));
                    return;
                }
            } catch (e) { console.error('Paydisini error:', e.message); }
        }
    }

    // Tripay mode
    if (paymentMode === 'tripay') {
        const apiKey = getSetting('tripay_api_key');
        const merchantCode = getSetting('tripay_merchant_code');
        if (apiKey && merchantCode) {
            try {
                const crypto = require('crypto');
                const txId = `ORDER-${orderId}-${Date.now()}`;
                const signature = crypto.createHmac('sha256', apiKey).update(merchantCode + txId + p.price).digest('hex');

                const res = await fetch('https://tripay.co.id/api/transaction/create', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        method: 'QRIS2', merchant_ref: txId, amount: totalPrice,
                        customer_name: username || String(userId),
                        customer_email: 'buyer@store.com', customer_phone: '08000000000',
                        order_items: [{ name: p.name, price: totalPrice, quantity: 1 }],
                        callback_url: `https://servernyaedi-1.tailbe2e82.ts.net/midtrans-webhook`,
                        return_url: 'https://t.me/tutorwir_bot',
                        expired_time: Math.floor(Date.now()/1000) + 900,
                        signature,
                    }),
                });
                const data = await res.json();
                if (data.success && data.data?.qr_url) {
                    db.prepare('UPDATE orders SET payment_proof = ? WHERE id = ?').run(txId, orderId);
                    await bot.sendPhoto(chatId, data.data.qr_url, {
                        caption: `✅ *Order #${orderId}*\n\n🏷️ ${p.name}\n💰 *${formatPrice(p.price)}*\n\n📱 Scan QRIS di atas!\n⏰ Berlaku 15 menit.`,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '🔄 Cek Status', callback_data: `cekbayar_${orderId}` }],
                            [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                        ]}
                    });
                    ADMIN_IDS.forEach(id => bot.sendMessage(id, `🔔 Order #${orderId} @${username||userId} ${p.name} ${formatPrice(p.price)} (Tripay QRIS)`));
                    return;
                }
            } catch (e) { console.error('Tripay error:', e.message); }
        }
    }

    // Xendit mode (QRIS direct)
    if (paymentMode === 'xendit') {
        const secretKey = getSetting('xendit_secret_key');
        if (secretKey) {
            try {
                const txId = `ORDER-${orderId}-${Date.now()}`;
                const res = await fetch('https://api.xendit.co/qr_codes', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        reference_id: txId,
                        type: 'DYNAMIC',
                        currency: 'IDR',
                        amount: totalPrice,
                        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                    }),
                });
                const data = await res.json();
                if (data.qr_string) {
                    db.prepare('UPDATE orders SET payment_proof = ? WHERE id = ?').run(txId, orderId);
                    // Generate QR image from string
                    const qrPath = `/tmp/qr_${orderId}.png`;
                    await QRCode.toFile(qrPath, data.qr_string, { width: 512 });
                    await bot.sendPhoto(chatId, qrPath, {
                        caption: `✅ *Order #${orderId}*\n\n🏷️ ${p.name} x${qty}\n💰 *${formatPrice(totalPrice)}*\n\n📱 Scan QRIS di atas!\n⏰ Berlaku 15 menit.`,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '🔄 Cek Status', callback_data: `cekbayar_${orderId}` }],
                            [{ text: '❌ Cancel', callback_data: `cancel_${orderId}` }],
                        ]}
                    });
                    try { require('fs').unlinkSync(qrPath); } catch(e) {}
                    ADMIN_IDS.forEach(id => bot.sendMessage(id, `🔔 Order #${orderId} @${username||userId} ${p.name} ${formatPrice(totalPrice)} (Xendit QRIS)`));
                    return;
                }
            } catch (e) { console.error('Xendit error:', e.message); }
        }
    }

    // Midtrans Snap mode
    if (snap && paymentMode === 'midtrans') {
        try {
            const txId = `ORDER-${orderId}-${Date.now()}`;
            const snapResponse = await snap.createTransaction({
                transaction_details: {
                    order_id: txId,
                    gross_amount: totalPrice,
                },
                customer_details: {
                    first_name: username || String(userId),
                },
                custom_field1: String(orderId),
                custom_field2: String(userId),
            });

            const paymentUrl = snapResponse.redirect_url;

            // Save midtrans tx id
            db.prepare('UPDATE orders SET payment_proof = ? WHERE id = ?').run(txId, orderId);

            await bot.sendMessage(chatId,
                `✅ *Order #${orderId} Dibuat!*\n\n` +
                `🏷️ ${p.name}\n` +
                `💰 Total: *${formatPrice(p.price)}*\n\n` +
                `💳 Klik tombol di bawah untuk bayar:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Bayar Sekarang', url: paymentUrl }],
                            [{ text: '🔄 Cek Status', callback_data: `cekbayar_${orderId}` }],
                            [{ text: '❌ Cancel Order', callback_data: `cancel_${orderId}` }],
                        ]
                    }
                }
            );

            // Notify admins
            ADMIN_IDS.forEach(adminId => {
                bot.sendMessage(adminId,
                    `🔔 *Order Baru*\n\n` +
                    `📋 Order #${orderId}\n` +
                    `👤 @${username || userId}\n` +
                    `🏷️ ${p.name}\n` +
                    `💰 ${formatPrice(p.price)}\n` +
                    `🎫 TX: \`${txId}\``,
                    { parse_mode: 'Markdown' }
                );
            });
            return;
        } catch (err) {
            console.error('Midtrans Snap error:', err.message);
            // Fall through to manual payment
        }
    }

    // Fallback: manual payment
    const text =
        `✅ *Order Dibuat!*\n\n` +
        `📋 Order ID: \`#${orderId}\`\n` +
        `🏷️ Produk: ${p.name}\n` +
        `💰 Total: *${formatPrice(p.price)}*\n\n` +
        `💳 *Cara Bayar:*\n${PAYMENT_INFO}\n\n` +
        `Setelah transfer, kirim bukti bayar dengan:\n` +
        `\`/bayar ${orderId}\` + foto bukti transfer`;

    bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Cancel Order', callback_data: `cancel_${orderId}` }],
                [{ text: '🔙 Menu Utama', callback_data: 'start' }],
            ]
        }
    });

    // Notify admins
    ADMIN_IDS.forEach(adminId => {
        bot.sendMessage(adminId,
            `🔔 *Order Baru!*\n\n` +
            `📋 Order #${orderId}\n` +
            `👤 @${username || userId}\n` +
            `🏷️ ${p.name}\n` +
            `💰 ${formatPrice(p.price)}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Approve', callback_data: `approve_${orderId}` }, { text: '❌ Reject', callback_data: `reject_${orderId}` }],
                    ]
                }
            }
        );
    });
}

// === Payment proof ===
bot.onText(/\/bayar (\d+)/, (msg, match) => {
    trackUser(msg);
    const chatId = msg.chat.id;
    const orderId = parseInt(match[1]);
    const order = stmts.getOrder.get(orderId);

    if (!order || order.user_id !== msg.from.id) {
        return bot.sendMessage(chatId, '❌ Order tidak ditemukan.');
    }
    if (order.status !== 'pending') {
        return bot.sendMessage(chatId, `ℹ️ Order #${orderId} status: ${order.status}`);
    }

    userStates[msg.from.id] = { action: 'payment_proof', orderId };
    bot.sendMessage(chatId, `📸 Kirim foto bukti transfer untuk Order #${orderId}:`);
});

// === My Orders ===
function showMyOrders(chatId, userId, msgId) {
    const orders = stmts.getUserOrders.all(userId);

    if (orders.length === 0) {
        return editOrSend(chatId, msgId, '📭 Belum ada order. Yuk belanja!', {
            reply_markup: {
                inline_keyboard: [[{ text: '🛍️ Katalog', callback_data: 'catalog' }]]
            }
        });
    }

    const statusEmoji = { pending: '⏳', paid: '💳', completed: '✅', cancelled: '❌', rejected: '🚫' };
    const lines = orders.map(o =>
        `${statusEmoji[o.status] || '❓'} \`#${o.id}\` ${o.product_name} — ${formatPrice(o.price)} [${o.status}]`
    );

    editOrSend(chatId, msgId,
        `🛒 *Order Saya:*\n\n${lines.join('\n')}`,
        {
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'start' }]]
            }
        }
    );
}

// === Callback Handler ===
bot.on('callback_query', async (query) => {
    try {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const msgId = query.message.message_id;
    console.log(`👆 Callback: ${data} from ${userId}`);

    bot.answerCallbackQuery(query.id);

    if (data === 'start') {
        const btns = [
            [{ text: '🛍️ Lihat Produk', callback_data: 'catalog' }],
            [{ text: '💰 Saldo', callback_data: 'wallet' }, { text: '🛒 Order Saya', callback_data: 'my_orders' }],
            [{ text: '💳 Cara Bayar', callback_data: 'payment_info' }, { text: '📞 Bantuan', callback_data: 'help' }],
        ];
        if (isStaff(userId)) btns.push([{ text: '👑 Admin Panel', callback_data: 'adm_panel' }]);
        return editOrSend(chatId, msgId, `📌 *Menu Utama*\n\nPilih menu di bawah:`, {
            reply_markup: { inline_keyboard: btns }
        });
    }

    if (data === 'catalog') return showCatalog(chatId, msgId);
    if (data === 'my_orders') return showMyOrders(chatId, userId, msgId);

    // === Wallet ===
    if (data === 'wallet') {
        const user = stmts.getBalance.get(userId);
        const bal = user?.balance || 0;
        const spent = user?.total_spent || 0;
        const level = user?.level || '🥉 Bronze';
        const orders = user?.total_orders || 0;

        return editOrSend(chatId, msgId,
            `💰 *Saldo & Member*\n\n` +
            `👤 Level: *${level}*\n` +
            `💰 Saldo: *${formatPrice(bal)}*\n` +
            `💸 Total Belanja: ${formatPrice(spent)}\n` +
            `📦 Total Order: ${orders}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '➕ Deposit Saldo', callback_data: 'deposit' }],
                        [{ text: '📋 Riwayat Saldo', callback_data: 'wallet_history' }],
                        [{ text: '🔙 Menu', callback_data: 'start' }],
                    ]
                }
            }
        );
    }

    if (data === 'deposit') {
        return editOrSend(chatId, msgId,
            `➕ *Deposit Saldo*\n\nPilih nominal:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Rp 10.000', callback_data: 'dep_10000' }, { text: 'Rp 25.000', callback_data: 'dep_25000' }],
                        [{ text: 'Rp 50.000', callback_data: 'dep_50000' }, { text: 'Rp 100.000', callback_data: 'dep_100000' }],
                        [{ text: '✏️ Nominal Lain', callback_data: 'dep_custom' }],
                        [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                    ]
                }
            }
        );
    }

    if (data.startsWith('dep_') && data !== 'dep_custom') {
        const amount = parseInt(data.slice(4));
        if (!amount || amount < 1000) return;
        return await processDeposit(chatId, msgId, userId, query.from.username, amount);
    }

    if (data === 'dep_custom') {
        userStates[userId] = { action: 'deposit_custom' };
        return bot.sendMessage(chatId, '✏️ Kirim nominal deposit (angka, min Rp 1.000):');
    }

    if (data.startsWith('depcheck_')) {
        const txId = data.slice(9);
        try {
            const status = await coreApi.transaction.status(txId);
            if (status.transaction_status === 'settlement' || status.transaction_status === 'capture') {
                // Check if already credited
                const existing = db.prepare("SELECT * FROM wallet_tx WHERE description = ? AND type = 'deposit'").get(txId);
                if (!existing) {
                    const amount = parseInt(status.gross_amount);
                    stmts.addBalance.run(amount, userId);
                    stmts.addWalletTx.run(userId, 'deposit', amount, txId, null);
                    updateMemberLevel(userId);
                    return editOrSend(chatId, msgId, `✅ Deposit *${formatPrice(amount)}* berhasil!`, {
                        reply_markup: { inline_keyboard: [[{ text: '💰 Saldo', callback_data: 'wallet' }]] }
                    });
                }
                return editOrSend(chatId, msgId, `✅ Deposit sudah dikreditkan.`, {
                    reply_markup: { inline_keyboard: [[{ text: '💰 Saldo', callback_data: 'wallet' }]] }
                });
            } else {
                return editOrSend(chatId, msgId, `⏳ Status: ${status.transaction_status}. Belum dibayar.`, {
                    reply_markup: { inline_keyboard: [
                        [{ text: '🔄 Cek Lagi', callback_data: `depcheck_${txId}` }],
                        [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                    ]}
                });
            }
        } catch (e) {
            return editOrSend(chatId, msgId, `⏳ Menunggu pembayaran...`, {
                reply_markup: { inline_keyboard: [
                    [{ text: '🔄 Cek Lagi', callback_data: `depcheck_${txId}` }],
                    [{ text: '🔙 Saldo', callback_data: 'wallet' }],
                ]}
            });
        }
    }

    if (data === 'wallet_history') {
        const txs = stmts.getWalletHistory.all(userId);
        if (txs.length === 0) {
            return editOrSend(chatId, msgId, '📋 Belum ada riwayat saldo.', {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Saldo', callback_data: 'wallet' }]] }
            });
        }
        const typeEmoji = { deposit: '➕', purchase: '🛒', refund: '🔄', deposit_pending: '⏳' };
        const lines = txs.map(t =>
            `${typeEmoji[t.type] || '❓'} ${formatPrice(t.amount)} — ${t.type}${t.order_id ? ' #' + t.order_id : ''}`
        );
        return editOrSend(chatId, msgId, `📋 *Riwayat Saldo:*\n\n${lines.join('\n')}`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Saldo', callback_data: 'wallet' }]] }
        });
    }
    if (data === 'payment_info') {
        const payText = getSetting('payment_info_text', 'Scan QRIS atau transfer. Setelah bayar, kirim bukti dengan /bayar <order_id> + foto.');
        return editOrSend(chatId, msgId, `💳 *Cara Bayar:*\n\n${payText}`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Menu', callback_data: 'start' }]] }
        });
    }
    if (data === 'help') {
        const helpText = getSetting('help_text', 'Ada masalah? Hubungi admin.');
        return editOrSend(chatId, msgId,
            `📞 *Bantuan*\n\n` +
            `/start — Menu utama\n` +
            `/katalog — Lihat produk\n` +
            `/bayar <id> — Kirim bukti bayar\n` +
            `/order <id> — Cek status order\n\n` +
            `${helpText}`,
            {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Menu', callback_data: 'start' }]] }
            }
        );
    }

    if (data.startsWith('cat_')) return showCategory(chatId, data.slice(4), msgId);
    if (data.startsWith('prod_')) return showProduct(chatId, parseInt(data.slice(5)), msgId);
    if (data.startsWith('buy_')) {
        return showBuyConfirm(chatId, parseInt(data.slice(4)), 1, msgId);
    }
    if (data.startsWith('buyqty_')) {
        const parts = data.slice(7).split('_');
        return showBuyConfirm(chatId, parseInt(parts[0]), parseInt(parts[1]), msgId);
    }
    if (data.startsWith('confirmsaldo_')) {
        const parts = data.slice(13).split('_');
        const pid = parseInt(parts[0]);
        const qty = parseInt(parts[1]);
        const couponCode = userStates[userId]?.couponCode || null;
        try { return await startBuyWithSaldo(chatId, msgId, userId, query.from.username, pid, qty, couponCode); }
        catch (e) { console.error('Saldo buy error:', e); return bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
    }
    if (data.startsWith('confirm_')) {
        const parts = data.slice(8).split('_');
        const pid = parseInt(parts[0]);
        const qty = parseInt(parts[1]);
        const couponCode = userStates[userId]?.couponCode || null;
        try { return await startBuy(chatId, userId, query.from.username, pid, qty, couponCode); }
        catch (e) { console.error('Buy error:', e); return bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
    }
    if (data.startsWith('stocksep_')) {
        const state = userStates[userId];
        if (!state || state.action !== 'admin_addstock_sep' || !state.rawText) return;

        const sep = data.slice(9);
        const text = state.rawText;
        let items;

        const separators = {
            single: null,
            space: /\s+/,
            comma: /,/,
            semicolon: /;/,
            pipe: /\|/,
        };

        if (sep === 'single') {
            items = [text.trim()];
        } else if (separators[sep]) {
            items = text.split(separators[sep]).map(s => s.trim()).filter(s => s.length > 0);
        } else {
            items = [text.trim()];
        }

        const pid = state.productId;
        let added = 0;
        for (const item of items) {
            stmts.addStockItem.run(pid, item);
            added++;
        }
        const remaining = stmts.countStockItems.get(pid);
        stmts.updateStock.run(remaining.count, pid);
        delete userStates[userId];

        return bot.sendMessage(chatId, `✅ *${added} item* ditambahkan!\nTotal stok: ${remaining.count}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: '📦 Lihat Stock', callback_data: `adm_stockq_${pid}` }],
                [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
            ]}
        });
    }

    if (data.startsWith('coupontype_')) {
        const state = userStates[userId];
        if (state?.action === 'admin_addcoupon') {
            state.data.type = data.slice(11); // 'percent' or 'fixed'
            state.step = 3;
            const label = state.data.type === 'percent' ? 'persen (contoh: 50 = 50%)' : 'rupiah (contoh: 5000)';
            return bot.sendMessage(chatId, `Kirim nilai diskon (${label}):`);
        }
    }
    if (data.startsWith('coupon_')) {
        const parts = data.slice(7).split('_');
        userStates[userId] = { action: 'enter_coupon', productId: parseInt(parts[0]), qty: parseInt(parts[1]) };
        return bot.sendMessage(chatId, '🎟️ Kirim kode kupon:');
    }
    if (data.startsWith('buycustom_')) {
        const pid = parseInt(data.slice(10));
        const p = stmts.getProduct.get(pid);
        if (!p) return;
        userStates[userId] = { action: 'buy_custom_qty', productId: pid };
        return bot.sendMessage(chatId, `✏️ Mau beli berapa *${p.name}*?\n\nMin: ${p.min_order || 1}, Max: ${Math.min(p.max_order || 100, p.stock)}\n\nKetik jumlah:`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('cancel_')) {
        const orderId = parseInt(data.slice(7));
        const order = stmts.getOrder.get(orderId);
        if (!order || (order.user_id !== userId && !isAdmin(userId))) return;
        if (order.status !== 'pending') return bot.sendMessage(chatId, `Order #${orderId} sudah ${order.status}`);

        stmts.updateOrderStatus.run('cancelled', orderId);
        // Restore stock based on qty
        const qty = parseInt(order.notes) || 1;
        const product = stmts.getProductAll.get(order.product_id);
        if (product) stmts.updateStock.run(product.stock + qty, product.id);

        editOrSend(chatId, msgId, `❌ Order #${orderId} dibatalkan. Stok +${qty} dikembalikan.`, {
            reply_markup: { inline_keyboard: [[{ text: '🛍️ Lihat Produk', callback_data: 'catalog' }, { text: '🔙 Menu', callback_data: 'start' }]] }
        });
    }

    // Admin actions
    if (data.startsWith('approve_') && isAdmin(userId)) {
        const orderId = parseInt(data.slice(8));
        const order = stmts.getOrder.get(orderId);
        if (!order) return;

        const product = stmts.getProductAll.get(order.product_id);
        const productData = product?.data || '';

        if (productData) {
            // Auto-deliver digital product
            stmts.setDeliveredData.run(productData, 'completed', orderId);
            bot.sendMessage(order.user_id,
                `✅ *Order #${orderId} Selesai!*\n\n` +
                `🏷️ ${order.product_name}\n\n` +
                `📦 *Produk kamu:*\n\`${productData}\``,
                { parse_mode: 'Markdown' }
            );
            bot.sendMessage(chatId, `✅ Order #${orderId} completed & delivered.`);
        } else {
            stmts.updateOrderStatus.run('completed', orderId);
            bot.sendMessage(order.user_id, `✅ *Order #${orderId} Selesai!*\nTerima kasih sudah belanja! 🎉`, { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, `✅ Order #${orderId} approved.`);
        }
    }

    if (data.startsWith('reject_') && isAdmin(userId)) {
        const orderId = parseInt(data.slice(7));
        const order = stmts.getOrder.get(orderId);
        if (!order) return;

        stmts.updateOrderStatus.run('rejected', orderId);
        const product = stmts.getProductAll.get(order.product_id);
        if (product) { const _qty = parseInt(order.notes) || 1; stmts.updateStock.run(product.stock + _qty, product.id); }

        bot.sendMessage(order.user_id, `🚫 *Order #${orderId} Ditolak*\nStok dikembalikan. Hubungi admin jika ada pertanyaan.`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, `🚫 Order #${orderId} rejected. Stock restored.`);
    }
    // Check Midtrans payment status
    if (data.startsWith('cekbayar_')) {
        const orderId = parseInt(data.slice(9));
        const order = stmts.getOrder.get(orderId);
        if (!order) return bot.sendMessage(chatId, '❌ Order tidak ditemukan.');

        if (order.status === 'completed') {
            return bot.sendMessage(chatId, `✅ Order #${orderId} sudah selesai!`);
        }
        if (order.status === 'cancelled') {
            return bot.sendMessage(chatId, `❌ Order #${orderId} sudah dibatalkan.`);
        }

        const status = await checkMidtransPayment(orderId);
        if (status) {
            if (status.transaction_status === 'settlement' || status.transaction_status === 'capture') {
                await processPaymentSuccess(orderId);
                return bot.sendMessage(chatId, `✅ Pembayaran Order #${orderId} berhasil! Produk sedang diproses.`);
            } else if (status.transaction_status === 'pending') {
                return bot.sendMessage(chatId, `⏳ Order #${orderId} menunggu pembayaran. Silakan scan QRIS di atas.`);
            } else {
                return bot.sendMessage(chatId, `ℹ️ Order #${orderId} status: ${status.transaction_status}`);
            }
        } else {
            return bot.sendMessage(chatId, `⏳ Order #${orderId} masih pending. Sudah bayar? Tunggu beberapa saat.`);
        }
    }

    // === Admin inline callbacks ===
    if (!isStaff(userId)) return; // Below are staff/admin/owner only

    const userRole = getUserRole(userId);

    if (data === 'adm_panel') return showAdminPanel(chatId, userId);
    if (data === 'adm_products') return showAdminProducts(chatId);
    if (data === 'adm_pending') return showAdminPending(chatId);
    if (data === 'adm_orders') return showAdminOrders(chatId);

    if (data === 'adm_addproduct') {
        userStates[userId] = { action: 'add_product', step: 1, data: {} };
        return bot.sendMessage(chatId, '📦 *Tambah Produk Baru*\n\nKirim nama produk:', { parse_mode: 'Markdown' });
    }

    if (data.startsWith('adm_prod_')) {
        return showAdminProduct(chatId, parseInt(data.slice(9)));
    }

    if (data.startsWith('adm_del_')) {
        const pid = parseInt(data.slice(8));
        stmts.deleteProduct.run(pid);
        bot.sendMessage(chatId, `🗑️ Produk #${pid} dihapus.`, {
            reply_markup: { inline_keyboard: [[{ text: '♻️ Undo', callback_data: `adm_restore_${pid}` }, { text: '🔙 Produk', callback_data: 'adm_products' }]] }
        });
    }

    if (data.startsWith('adm_restore_')) {
        const pid = parseInt(data.slice(12));
        stmts.restoreProduct.run(pid);
        bot.sendMessage(chatId, `♻️ Produk #${pid} di-restore.`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: 'adm_products' }]] }
        });
    }

    if (data.startsWith('adm_setstock_')) {
        const pid = parseInt(data.slice(13));
        userStates[userId] = { action: 'admin_setstock', productId: pid };
        return bot.sendMessage(chatId, `📦 Kirim jumlah stok baru untuk produk #${pid}:`);
    }

    if (data.startsWith('adm_setdata_')) {
        const pid = parseInt(data.slice(12));
        userStates[userId] = { action: 'admin_setdata', productId: pid };
        return bot.sendMessage(chatId, `💾 Kirim data produk digital untuk #${pid}:\n(contoh: email:pass, link, kode voucher)`);
    }

    if (data.startsWith('adm_setprice_')) {
        const pid = parseInt(data.slice(13));
        userStates[userId] = { action: 'admin_setprice', productId: pid };
        return bot.sendMessage(chatId, `💰 Kirim harga baru untuk produk #${pid} (angka saja):`);
    }

    if (data.startsWith('adm_setname_')) {
        const pid = parseInt(data.slice(12));
        userStates[userId] = { action: 'admin_setname', productId: pid };
        return bot.sendMessage(chatId, `✏️ Kirim nama baru untuk produk #${pid}:`);
    }

    if (data.startsWith('adm_setmin_')) {
        const pid = parseInt(data.slice(11));
        userStates[userId] = { action: 'admin_setmin', productId: pid };
        return bot.sendMessage(chatId, `📏 Kirim min order baru untuk produk #${pid} (angka):`);
    }

    if (data.startsWith('adm_setmax_')) {
        const pid = parseInt(data.slice(11));
        userStates[userId] = { action: 'admin_setmax', productId: pid };
        return bot.sendMessage(chatId, `📏 Kirim max order baru untuk produk #${pid} (angka):`);
    }

    if (data.startsWith('adm_setlabel_')) {
        const pid = parseInt(data.slice(13));
        userStates[userId] = { action: 'admin_setlabel', productId: pid };
        return bot.sendMessage(chatId, `🏷️ Kirim price label (contoh: /akun, /bulan, /item):`);
    }

    if (data === 'adm_broadcast') {
        userStates[userId] = { action: 'admin_broadcast' };
        return bot.sendMessage(chatId, '📢 Kirim pesan yang mau di-broadcast ke semua user:');
    }

    if (data.startsWith('adm_addstock_')) {
        const pid = parseInt(data.slice(13));
        const p = stmts.getProductAll.get(pid);
        return bot.sendMessage(chatId,
            `📦 *Add Stock: ${p?.name || '#' + pid}*\n\nPilih mode:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔢 Input Angka (stok biasa)', callback_data: `adm_stocknum_${pid}` }],
                        [{ text: '💾 Input Data (produk digital)', callback_data: `adm_stockdata_${pid}` }],
                        [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
                    ]
                }
            }
        );
    }

    if (data.startsWith('adm_stocknum_')) {
        const pid = parseInt(data.slice(13));
        userStates[userId] = { action: 'admin_stocknum', productId: pid };
        return bot.sendMessage(chatId, `🔢 Kirim jumlah stok untuk produk #${pid} (angka):`);
    }

    if (data.startsWith('adm_stockdata_')) {
        const pid = parseInt(data.slice(14));
        userStates[userId] = { action: 'admin_addstock', productId: pid };
        return bot.sendMessage(chatId,
            `💾 *Add Stock Data: Produk #${pid}*\n\n` +
            `Kirim data langsung atau *upload file .txt*\n\n` +
            `*Ketik langsung (1 baris = 1 item):*\n` +
            `\`\`\`\nuser1:pass1\nuser2:pass2\n\`\`\`\n\n` +
            `*Multi-line (pisah ===):*\n` +
            `\`\`\`\ndata item 1\n===\ndata item 2\n\`\`\`\n\n` +
            `📄 *Upload file .txt* buat import massal (1000+ item)`,
            { parse_mode: 'Markdown' }
        );
    }

    if (data.startsWith('adm_stockq_')) {
        const pid = parseInt(data.slice(11));
        const items = stmts.getStockItems.all(pid);
        const product = stmts.getProductAll.get(pid);
        if (items.length === 0) {
            return bot.sendMessage(chatId, `📦 Stock queue untuk *${product?.name || '#' + pid}* kosong.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [
                    [{ text: '➕ Add Stock', callback_data: `adm_addstock_${pid}` }],
                    [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
                ]}
            });
        }
        const lines = items.slice(0, 20).map((item, i) =>
            `${i + 1}. \`${item.data.substring(0, 40)}${item.data.length > 40 ? '...' : ''}\``
        );
        const total = items.length;
        bot.sendMessage(chatId,
            `📦 *Stock Queue: ${product?.name || '#' + pid}*\n` +
            `Total: ${total} item\n\n` +
            lines.join('\n'),
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [
                    [{ text: '➕ Add Stock', callback_data: `adm_addstock_${pid}` }, { text: '🗑️ Clear All', callback_data: `adm_clearstock_${pid}` }],
                    [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
                ]}
            }
        );
    }

    // === Manual Deliver ===
    if (data.startsWith('deliver_') && isStaff(userId)) {
        const orderId = parseInt(data.slice(8));
        userStates[userId] = { action: 'admin_deliver', orderId };
        return bot.sendMessage(chatId, `📦 Kirim data produk untuk Order #${orderId}:\n(Ini akan dikirim langsung ke buyer)`);
    }

    // === Staff Management (owner only) ===
    if (data === 'adm_staff' && isOwner(userId)) {
        const allStaff = stmts.getAllStaff.all();
        const roleEmoji = { admin: '🔑', staff: '👷' };
        if (allStaff.length === 0) {
            return bot.sendMessage(chatId, '👥 Belum ada staff/admin.', {
                reply_markup: { inline_keyboard: [
                    [{ text: '➕ Add Admin', callback_data: 'adm_addstaff_admin' }, { text: '➕ Add Staff', callback_data: 'adm_addstaff_staff' }],
                    [{ text: '🔙 Admin', callback_data: 'adm_panel' }],
                ]}
            });
        }
        const lines = allStaff.map(s =>
            `${roleEmoji[s.role] || '❓'} @${s.username || s.user_id} (${s.role})`
        );
        const buttons = allStaff.map(s => [
            { text: `❌ Remove @${s.username || s.user_id}`, callback_data: `adm_rmstaff_${s.user_id}` }
        ]);
        buttons.push([{ text: '➕ Add Admin', callback_data: 'adm_addstaff_admin' }, { text: '➕ Add Staff', callback_data: 'adm_addstaff_staff' }]);
        buttons.push([{ text: '🔙 Admin', callback_data: 'adm_panel' }]);

        return bot.sendMessage(chatId, `👥 *Staff & Admin*\n\n${lines.join('\n')}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    if (data.startsWith('adm_addstaff_') && isOwner(userId)) {
        const role = data.slice(13); // 'admin' or 'staff'
        userStates[userId] = { action: 'admin_addstaff', role };
        return bot.sendMessage(chatId, `➕ Forward pesan dari user yang mau dijadikan *${role}*, atau kirim user ID:`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('adm_rmstaff_') && isOwner(userId)) {
        const staffId = parseInt(data.slice(12));
        stmts.removeStaff.run(staffId);
        return bot.sendMessage(chatId, `✅ Staff removed.`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Staff', callback_data: 'adm_staff' }]] }
        });
    }

    // Owner-only guards for sensitive features
    if (['adm_settings', 'adm_apikeys'].some(x => data === x || data.startsWith(x)) && !isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Fitur ini hanya untuk Admin/Owner.');
    }

    // === Coupons ===
    if (data === 'adm_coupons') {
        const coupons = stmts.getAllCoupons.all();
        if (coupons.length === 0) {
            return bot.sendMessage(chatId, '🎟️ Belum ada kupon.', {
                reply_markup: { inline_keyboard: [
                    [{ text: '➕ Buat Kupon', callback_data: 'adm_addcoupon' }],
                    [{ text: '🔙 Admin', callback_data: 'adm_panel' }],
                ]}
            });
        } else {
            const lines = coupons.map(c => {
                const status = c.active ? '✅' : '❌';
                const discLabel = c.discount_type === 'percent' ? `${c.discount_value}%` : formatPrice(c.discount_value);
                const uses = c.max_uses > 0 ? `${c.used_count}/${c.max_uses}` : `${c.used_count}/∞`;
                return `${status} \`${c.code}\` — ${discLabel} off (${uses} used)`;
            });
            const buttons = coupons.map(c => [
                { text: `${c.active ? '❌' : '✅'} ${c.code}`, callback_data: `adm_togglecoupon_${c.id}` },
                { text: `🗑️`, callback_data: `adm_delcoupon_${c.id}` },
            ]);
            buttons.push([{ text: '➕ Buat Kupon', callback_data: 'adm_addcoupon' }]);
            buttons.push([{ text: '🔙 Admin', callback_data: 'adm_panel' }]);
            bot.sendMessage(chatId, `🎟️ *Kupon:*\n\n${lines.join('\n')}\n\nKlik nama kupon untuk on/off, 🗑️ untuk hapus.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }

    if (data.startsWith('adm_delcoupon_')) {
        const cid = parseInt(data.slice(14));
        stmts.deleteCoupon.run(cid);
        return bot.sendMessage(chatId, `🗑️ Kupon dihapus.`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Kupon', callback_data: 'adm_coupons' }]] }
        });
    }

    if (data.startsWith('adm_togglecoupon_')) {
        const cid = parseInt(data.slice(17));
        const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(cid);
        if (coupon) {
            stmts.toggleCoupon.run(coupon.active ? 0 : 1, cid);
            return bot.sendMessage(chatId, `${coupon.active ? '❌' : '✅'} Kupon \`${coupon.code}\` ${coupon.active ? 'dinonaktifkan' : 'diaktifkan'}.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kupon', callback_data: 'adm_coupons' }]] }
            });
        }
    }

    if (data === 'adm_addcoupon') {
        userStates[userId] = { action: 'admin_addcoupon', step: 1, data: {} };
        return bot.sendMessage(chatId, '🎟️ *Buat Kupon Baru*\n\nKirim kode kupon (contoh: DISKON50):', { parse_mode: 'Markdown' });
    }

    // === Settings ===
    if (data === 'adm_settings') {
        const mode = getSetting('payment_mode', 'midtrans');
        const modeLabel = { midtrans: '💳 Midtrans Snap', manual: '📱 Manual Transfer', duitku: '💳 Duitku', paydisini: '💳 Paydisini' };
        const manualInfo = getSetting('manual_payment_info', '-');
        const hasQris = getSetting('manual_qris_file_id') ? '✅' : '❌';

        return bot.sendMessage(chatId,
            `⚙️ *Settings*\n\n` +
            `💳 Payment Mode: *${modeLabel[mode] || mode}*\n` +
            `📱 Manual Info: ${manualInfo.substring(0, 50)}...\n` +
            `📷 QRIS Image: ${hasQris}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: mode === 'midtrans' ? '✅ Midtrans' : 'Midtrans', callback_data: 'adm_setmode_midtrans' },
                         { text: mode === 'manual' ? '✅ Manual' : 'Manual', callback_data: 'adm_setmode_manual' }],
                        [{ text: mode === 'duitku' ? '✅ Duitku' : 'Duitku', callback_data: 'adm_setmode_duitku' },
                         { text: mode === 'paydisini' ? '✅ Paydisini' : 'Paydisini', callback_data: 'adm_setmode_paydisini' }],
                        [{ text: mode === 'tripay' ? '✅ Tripay' : 'Tripay', callback_data: 'adm_setmode_tripay' },
                         { text: mode === 'xendit' ? '✅ Xendit' : 'Xendit', callback_data: 'adm_setmode_xendit' }],
                        [{ text: '🔑 Set API Keys', callback_data: 'adm_apikeys' }],
                        [{ text: '📱 Edit Info Transfer', callback_data: 'adm_set_manualinfo' }],
                        [{ text: '📷 Upload QRIS Image', callback_data: 'adm_set_qris' }],
                        [{ text: '🏪 Edit Nama Toko', callback_data: 'adm_set_storename' }],
                        [{ text: '💬 Edit Welcome Message', callback_data: 'adm_set_welcome' }],
                        [{ text: '💳 Edit Cara Bayar', callback_data: 'adm_set_payinfo' }, { text: '📞 Edit Bantuan', callback_data: 'adm_set_help' }],
                        [{ text: '🔙 Admin', callback_data: 'adm_panel' }],
                    ]
                }
            }
        );
    }

    if (data.startsWith('adm_setmode_')) {
        const mode = data.slice(12);
        stmts.setSetting.run('payment_mode', mode);
        bot.sendMessage(chatId, `✅ Payment mode diubah ke *${mode}*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
        });
    }

    if (data === 'adm_apikeys') {
        const midKey = getSetting('midtrans_server_key') ? '✅' : '❌';
        const duitkuCode = getSetting('duitku_merchant_code') ? '✅' : '❌';
        const duitkuKey = getSetting('duitku_api_key') ? '✅' : '❌';
        const paydisiniKey = getSetting('paydisini_api_key') ? '✅' : '❌';
        const tripayKey = getSetting('tripay_api_key') ? '✅' : '❌';
        const tripayMerchant = getSetting('tripay_merchant_code') ? '✅' : '❌';
        const xenditKey = getSetting('xendit_secret_key') ? '✅' : '❌';

        return bot.sendMessage(chatId,
            `🔑 *API Keys*\n\n` +
            `💳 Midtrans Server Key: ${midKey}\n` +
            `💳 Duitku Merchant Code: ${duitkuCode}\n` +
            `💳 Duitku API Key: ${duitkuKey}\n` +
            `💳 Paydisini API Key: ${paydisiniKey}\n` +
            `💳 Tripay API Key: ${tripayKey}\n` +
            `💳 Tripay Merchant Code: ${tripayMerchant}\n` +
            `💳 Xendit Secret Key: ${xenditKey}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Midtrans Key', callback_data: 'adm_key_midtrans_server_key' }],
                        [{ text: 'Duitku Code', callback_data: 'adm_key_duitku_merchant_code' }, { text: 'Duitku Key', callback_data: 'adm_key_duitku_api_key' }],
                        [{ text: 'Paydisini Key', callback_data: 'adm_key_paydisini_api_key' }],
                        [{ text: 'Tripay Key', callback_data: 'adm_key_tripay_api_key' }, { text: 'Tripay Code', callback_data: 'adm_key_tripay_merchant_code' }],
                        [{ text: 'Xendit Secret Key', callback_data: 'adm_key_xendit_secret_key' }],
                        [{ text: '🔙 Settings', callback_data: 'adm_settings' }],
                    ]
                }
            }
        );
    }

    if (data.startsWith('adm_key_')) {
        const keyName = data.slice(8);
        const labels = {
            midtrans_server_key: 'Midtrans Server Key',
            duitku_merchant_code: 'Duitku Merchant Code',
            duitku_api_key: 'Duitku API Key',
            paydisini_api_key: 'Paydisini API Key',
            tripay_api_key: 'Tripay API Key',
            tripay_merchant_code: 'Tripay Merchant Code',
            xendit_secret_key: 'Xendit Secret Key',
        };
        userStates[userId] = { action: 'admin_set_apikey', keyName };
        return bot.sendMessage(chatId, `🔑 Kirim *${labels[keyName] || keyName}*:`, { parse_mode: 'Markdown' });
    }

    if (data === 'adm_set_manualinfo') {
        userStates[userId] = { action: 'admin_set_manualinfo' };
        return bot.sendMessage(chatId, '📱 Kirim info pembayaran manual:\n(contoh: Transfer ke BCA 1234567890 a.n. Nama)');
    }

    if (data === 'adm_set_qris') {
        userStates[userId] = { action: 'admin_set_qris' };
        return bot.sendMessage(chatId, '📷 Kirim foto QRIS kamu:');
    }

    if (data === 'adm_set_storename') {
        userStates[userId] = { action: 'admin_set_storename' };
        return bot.sendMessage(chatId, '🏪 Kirim nama toko baru:');
    }

    if (data === 'adm_set_welcome') {
        userStates[userId] = { action: 'admin_set_welcome' };
        return bot.sendMessage(chatId, '💬 Kirim welcome message baru:');
    }

    if (data === 'adm_set_payinfo') {
        userStates[userId] = { action: 'admin_set_payinfo' };
        const current = getSetting('payment_info_text', '-');
        return bot.sendMessage(chatId, `💳 *Edit Cara Bayar*\n\nSekarang:\n${current}\n\nKirim teks baru:`, { parse_mode: 'Markdown' });
    }

    if (data === 'adm_set_help') {
        userStates[userId] = { action: 'admin_set_help' };
        const current = getSetting('help_text', '-');
        return bot.sendMessage(chatId, `📞 *Edit Bantuan*\n\nSekarang:\n${current}\n\nKirim teks baru:`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('adm_clearstock_')) {
        const pid = parseInt(data.slice(15));
        stmts.clearStock.run(pid);
        stmts.updateStock.run(0, pid);
        bot.sendMessage(chatId, `🗑️ Stock queue produk #${pid} dikosongkan.`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }]] }
        });
    }
    } catch (err) {
        console.error('❌ Callback error:', err.message, err.stack?.substring(0, 200));
        try { bot.sendMessage(query.message.chat.id, `❌ Error: ${err.message}`); } catch(e) {}
    }
});

// === Photo handler (payment proof) ===
// === Document handler (file upload for stock) ===
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    const state = userStates[userId];
    if (!state || state.action !== 'admin_addstock') return;
    if (!isStaff(userId)) return;

    const doc = msg.document;
    if (!doc.file_name?.endsWith('.txt') && !doc.mime_type?.includes('text')) {
        return bot.sendMessage(msg.chat.id, '❌ Kirim file .txt aja.');
    }
    if (doc.file_size > 5 * 1024 * 1024) {
        return bot.sendMessage(msg.chat.id, '❌ File terlalu besar (max 5MB).');
    }

    try {
        const fileLink = await bot.getFileLink(doc.file_id);
        const response = await fetch(fileLink);
        const text = await response.text();

        let items;
        if (text.includes('===')) {
            items = text.split('===').map(s => s.trim()).filter(s => s.length > 0);
        } else {
            items = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }

        if (items.length === 0) {
            return bot.sendMessage(msg.chat.id, '❌ File kosong.');
        }

        const pid = state.productId;
        let added = 0;
        for (const item of items) {
            stmts.addStockItem.run(pid, item);
            added++;
        }
        const remaining = stmts.countStockItems.get(pid);
        stmts.updateStock.run(remaining.count, pid);

        delete userStates[userId];
        bot.sendMessage(msg.chat.id, `✅ *${added} item* imported dari file!\nTotal stok: ${remaining.count}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: '📦 Lihat Stock', callback_data: `adm_stockq_${pid}` }],
                [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
            ]}
        });
    } catch (e) {
        console.error('File import error:', e.message);
        bot.sendMessage(msg.chat.id, `❌ Error import: ${e.message}`);
    }
});

bot.on('photo', (msg) => {
    const userId = msg.from.id;
    const state = userStates[userId];

    // Admin: upload QRIS image
    if (state?.action === 'admin_set_qris' && isAdmin(userId)) {
        const photo = msg.photo[msg.photo.length - 1];
        stmts.setSetting.run('manual_qris_file_id', photo.file_id);
        delete userStates[userId];
        return bot.sendMessage(msg.chat.id, '✅ QRIS image disimpan!', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
        });
    }

    if (state?.action === 'payment_proof') {
        const photo = msg.photo[msg.photo.length - 1]; // highest res
        const orderId = state.orderId;

        stmts.setPaymentProof.run(photo.file_id, 'paid', orderId);
        delete userStates[userId];

        bot.sendMessage(msg.chat.id, `✅ Bukti bayar untuk Order #${orderId} diterima!\nMenunggu konfirmasi admin...`);

        // Notify admins
        ADMIN_IDS.forEach(adminId => {
            bot.sendPhoto(adminId, photo.file_id, {
                caption: `💳 *Bukti Bayar*\n\nOrder #${orderId}\n👤 @${msg.from.username || userId}`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Approve', callback_data: `approve_${orderId}` }, { text: '❌ Reject', callback_data: `reject_${orderId}` }],
                    ]
                }
            });
        });
    }
});

// === Admin Panel (Inline) ===

function showAdminPanel(chatId, userId) {
    const stats = stmts.getStats.get();
    const userCount = stmts.countUsers.get();
    const role = getUserRole(userId);
    const roleLabel = { owner: '👑 Owner', admin: '🔑 Admin', staff: '👷 Staff' };

    // Staff: only stock & approve orders
    const staffButtons = [
        [{ text: '📦 Produk', callback_data: 'adm_products' }],
        [{ text: '⏳ Pending', callback_data: 'adm_pending' }, { text: '📋 Semua Order', callback_data: 'adm_orders' }],
    ];

    // Admin: + add product, coupons, broadcast
    const adminButtons = [
        [{ text: '📦 Produk', callback_data: 'adm_products' }, { text: '➕ Tambah Produk', callback_data: 'adm_addproduct' }],
        [{ text: '⏳ Pending', callback_data: 'adm_pending' }, { text: '📋 Semua Order', callback_data: 'adm_orders' }],
        [{ text: '🎟️ Kupon', callback_data: 'adm_coupons' }],
        [{ text: '📢 Broadcast', callback_data: 'adm_broadcast' }],
    ];

    // Owner: + settings, staff management
    const ownerButtons = [
        [{ text: '📦 Produk', callback_data: 'adm_products' }, { text: '➕ Tambah Produk', callback_data: 'adm_addproduct' }],
        [{ text: '⏳ Pending', callback_data: 'adm_pending' }, { text: '📋 Semua Order', callback_data: 'adm_orders' }],
        [{ text: '🎟️ Kupon', callback_data: 'adm_coupons' }, { text: '⚙️ Settings', callback_data: 'adm_settings' }],
        [{ text: '👥 Staff', callback_data: 'adm_staff' }, { text: '📢 Broadcast', callback_data: 'adm_broadcast' }],
    ];

    const buttons = role === 'owner' ? ownerButtons : role === 'admin' ? adminButtons : staffButtons;

    bot.sendMessage(chatId,
        `👑 *Admin Panel* (${roleLabel[role] || role})\n\n` +
        `📊 *Stats:*\n` +
        `👥 Users: ${userCount.count}\n` +
        `📦 Total Orders: ${stats.total}\n` +
        `⏳ Pending: ${stats.pending}\n` +
        `💰 Revenue: ${formatPrice(stats.revenue || 0)}`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        }
    );
}

function showAdminProducts(chatId) {
    const products = stmts.getProducts.all();
    if (products.length === 0) return bot.sendMessage(chatId, 'Belum ada produk.', {
        reply_markup: { inline_keyboard: [[{ text: '➕ Tambah Produk', callback_data: 'adm_addproduct' }, { text: '🔙 Admin', callback_data: 'adm_panel' }]] }
    });

    const buttons = products.map(p => [
        { text: `#${p.id} ${p.name} (${p.stock}) ${formatPrice(p.price)}${p.data ? ' 📦' : ''}`, callback_data: `adm_prod_${p.id}` }
    ]);
    buttons.push([{ text: '➕ Tambah Produk', callback_data: 'adm_addproduct' }, { text: '🔙 Admin', callback_data: 'adm_panel' }]);

    bot.sendMessage(chatId, `📦 *Produk:*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
}

function showAdminProduct(chatId, productId) {
    const p = stmts.getProductAll.get(productId);
    if (!p) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

    bot.sendMessage(chatId,
        `🏷️ *${p.name}* ${p.active ? '' : '(❌ nonaktif)'}\n\n` +
        `📝 ${p.description || '-'}\n` +
        `💰 ${formatPrice(p.price)}\n` +
        `📦 Stok: ${p.stock}\n` +
        `📁 ${p.category}\n` +
        `💾 Data: ${p.data ? '✅ Ada' : '❌ Belum set'}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Add Stock', callback_data: `adm_addstock_${p.id}` }, { text: `📦 Stock (${stmts.countStockItems.get(p.id).count})`, callback_data: `adm_stockq_${p.id}` }],
                    [{ text: '💰 Harga', callback_data: `adm_setprice_${p.id}` }, { text: '✏️ Nama', callback_data: `adm_setname_${p.id}` }],
                    [{ text: `📏 Min: ${p.min_order||1}`, callback_data: `adm_setmin_${p.id}` }, { text: '🏷️ Label', callback_data: `adm_setlabel_${p.id}` }],
                    [{ text: p.active ? '🗑️ Hapus' : '♻️ Restore', callback_data: p.active ? `adm_del_${p.id}` : `adm_restore_${p.id}` }],
                    [{ text: '🔙 Produk', callback_data: 'adm_products' }, { text: '🔙 Admin', callback_data: 'adm_panel' }],
                ]
            }
        }
    );
}

function showAdminPending(chatId) {
    const orders = stmts.getPendingOrders.all();
    if (orders.length === 0) return bot.sendMessage(chatId, '✅ Tidak ada order pending.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'adm_panel' }]] }
    });

    orders.forEach(o => {
        bot.sendMessage(chatId,
            `⏳ *Order #${o.id}*\n👤 @${o.username || o.user_id}\n🏷️ ${o.product_name}\n💰 ${formatPrice(o.price)}\n📅 ${o.created_at}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Approve', callback_data: `approve_${o.id}` }, { text: '❌ Reject', callback_data: `reject_${o.id}` }],
                    ]
                }
            }
        );
    });
}

function showAdminOrders(chatId) {
    const orders = stmts.getAllOrders.all();
    if (orders.length === 0) return bot.sendMessage(chatId, 'Belum ada order.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'adm_panel' }]] }
    });

    const statusEmoji = { pending: '⏳', paid: '💳', completed: '✅', cancelled: '❌', rejected: '🚫' };
    const lines = orders.slice(0, 20).map(o =>
        `${statusEmoji[o.status] || '❓'} \`#${o.id}\` @${o.username || o.user_id} — ${o.product_name} ${formatPrice(o.price)}`
    );
    bot.sendMessage(chatId, `📋 *Orders:*\n\n${lines.join('\n')}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'adm_panel' }]] }
    });
}

bot.onText(/\/admin/, (msg) => {
    if (!isStaff(msg.from.id)) return;
    showAdminPanel(msg.chat.id, msg.from.id);
});

// Keep command shortcuts for convenience
bot.onText(/\/addproduct/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    userStates[msg.from.id] = { action: 'add_product', step: 1, data: {} };
    bot.sendMessage(msg.chat.id, '📦 *Tambah Produk Baru*\n\nKirim nama produk:', { parse_mode: 'Markdown' });
});

bot.onText(/\/setdata (\d+) (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    stmts.setProductData.run(match[2], parseInt(match[1]));
    bot.sendMessage(msg.chat.id, `✅ Product #${match[1]} data updated.`);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const text = match[1];
    const users = db.prepare('SELECT id FROM users').all();
    let sent = 0;
    users.forEach(u => {
        try { bot.sendMessage(u.id, `📢 *Pengumuman*\n\n${text}`, { parse_mode: 'Markdown' }); sent++; } catch (e) {}
    });
    bot.sendMessage(msg.chat.id, `📢 Broadcast sent to ${sent}/${users.length} users.`);
});

// /katalog alias
bot.onText(/\/katalog/, (msg) => {
    trackUser(msg);
    showCatalog(msg.chat.id);
});

// /order <id>
bot.onText(/\/order (\d+)/, (msg, match) => {
    trackUser(msg);
    const order = stmts.getOrder.get(parseInt(match[1]));
    if (!order || (order.user_id !== msg.from.id && !isAdmin(msg.from.id))) {
        return bot.sendMessage(msg.chat.id, '❌ Order tidak ditemukan.');
    }
    const statusEmoji = { pending: '⏳', paid: '💳', completed: '✅', cancelled: '❌', rejected: '🚫' };
    bot.sendMessage(msg.chat.id,
        `📋 *Order #${order.id}*\n\n` +
        `🏷️ ${order.product_name}\n` +
        `💰 ${formatPrice(order.price)}\n` +
        `📊 Status: ${statusEmoji[order.status] || '❓'} ${order.status}\n` +
        `📅 ${order.created_at}`,
        { parse_mode: 'Markdown' }
    );
});

// === Multi-step text handler ===
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.from.id;
    const state = userStates[userId];
    if (!state) return;

    const chatId = msg.chat.id;

    // Admin quick actions
    if (isAdmin(userId)) {
        if (state.action === 'admin_setstock') {
            const qty = parseInt(msg.text);
            if (isNaN(qty) || qty < 0) return bot.sendMessage(chatId, '❌ Angka tidak valid.');
            stmts.updateStock.run(qty, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Stok produk #${state.productId} diupdate ke ${qty}.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_setdata') {
            stmts.setProductData.run(msg.text, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Data produk #${state.productId} diupdate.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_setprice') {
            const price = parseInt(msg.text.replace(/\D/g, ''));
            if (!price || price <= 0) return bot.sendMessage(chatId, '❌ Harga tidak valid.');
            db.prepare('UPDATE products SET price = ? WHERE id = ?').run(price, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Harga produk #${state.productId} diupdate ke ${formatPrice(price)}.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_setname') {
            db.prepare('UPDATE products SET name = ? WHERE id = ?').run(msg.text, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Nama produk #${state.productId} diupdate.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_addcoupon') {
            switch (state.step) {
                case 1:
                    state.data.code = msg.text.trim().toUpperCase();
                    state.step = 2;
                    return bot.sendMessage(chatId, 'Tipe diskon?', {
                        reply_markup: { inline_keyboard: [
                            [{ text: '% Persen', callback_data: 'coupontype_percent' }, { text: 'Rp Nominal', callback_data: 'coupontype_fixed' }],
                        ]}
                    });
                case 3:
                    const val = parseInt(msg.text.replace(/\D/g, ''));
                    if (!val || val <= 0) return bot.sendMessage(chatId, '❌ Angka tidak valid.');
                    state.data.value = val;
                    state.step = 4;
                    return bot.sendMessage(chatId, 'Max penggunaan? (0 = unlimited):');
                case 4:
                    state.data.maxUses = parseInt(msg.text) || 0;
                    stmts.addCoupon.run(state.data.code, state.data.type, state.data.value, 0, state.data.maxUses, null);
                    const discLabel = state.data.type === 'percent' ? `${state.data.value}%` : formatPrice(state.data.value);
                    delete userStates[userId];
                    return bot.sendMessage(chatId,
                        `✅ *Kupon Dibuat!*\n\n🎟️ Code: \`${state.data.code}\`\n💰 Diskon: ${discLabel}\n🔄 Max: ${state.data.maxUses || 'Unlimited'}`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [
                                [{ text: '➕ Buat Lagi', callback_data: 'adm_addcoupon' }, { text: '🎟️ Kupon', callback_data: 'adm_coupons' }],
                                [{ text: '👑 Admin', callback_data: 'adm_panel' }],
                            ]}
                        }
                    );
            }
            return;
        }
        if (state.action === 'admin_setmin') {
            const val = parseInt(msg.text);
            if (isNaN(val) || val < 1) return bot.sendMessage(chatId, '❌ Angka tidak valid.');
            db.prepare('UPDATE products SET min_order = ? WHERE id = ?').run(val, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Min order produk #${state.productId} = ${val}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_setmax') {
            const val = parseInt(msg.text);
            if (isNaN(val) || val < 1) return bot.sendMessage(chatId, '❌ Angka tidak valid.');
            db.prepare('UPDATE products SET max_order = ? WHERE id = ?').run(val, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Max order produk #${state.productId} = ${val}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_setlabel') {
            db.prepare('UPDATE products SET price_label = ? WHERE id = ?').run(msg.text, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Price label produk #${state.productId} = "${msg.text}"`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_deliver') {
            const order = stmts.getOrder.get(state.orderId);
            if (!order) { delete userStates[userId]; return; }
            stmts.setDeliveredData.run(msg.text, 'completed', state.orderId);
            delete userStates[userId];
            bot.sendMessage(order.user_id,
                `📦 *Produk Order #${state.orderId}:*\n\n\`\`\`\n${msg.text}\n\`\`\`\n\nSimpan data di atas ya! Terima kasih! 🎉`,
                { parse_mode: 'Markdown' }
            );
            return bot.sendMessage(chatId, `✅ Produk dikirim ke buyer untuk Order #${state.orderId}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'adm_panel' }]] }
            });
        }
        if (state.action === 'admin_addstaff') {
            let staffId, staffUsername = '';
            if (msg.forward_from) {
                staffId = msg.forward_from.id;
                staffUsername = msg.forward_from.username || msg.forward_from.first_name || '';
            } else {
                staffId = parseInt(msg.text);
                if (isNaN(staffId)) return bot.sendMessage(chatId, '❌ Kirim user ID (angka) atau forward pesan dari user.');
            }
            stmts.addStaff.run(staffId, staffUsername, state.role, userId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ *${staffUsername || staffId}* ditambahkan sebagai *${state.role}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Staff', callback_data: 'adm_staff' }]] }
            });
        }
        if (state.action === 'admin_set_apikey') {
            stmts.setSetting.run(state.keyName, msg.text.trim());
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ *${state.keyName}* disimpan.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 API Keys', callback_data: 'adm_apikeys' }, { text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_set_manualinfo') {
            stmts.setSetting.run('manual_payment_info', msg.text);
            delete userStates[userId];
            return bot.sendMessage(chatId, '✅ Info pembayaran manual diupdate.', {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_set_storename') {
            stmts.setSetting.run('store_name', msg.text);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Nama toko diubah ke: ${msg.text}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_set_welcome') {
            stmts.setSetting.run('welcome_msg', msg.text);
            delete userStates[userId];
            return bot.sendMessage(chatId, '✅ Welcome message diupdate.', {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_set_payinfo') {
            stmts.setSetting.run('payment_info_text', msg.text);
            delete userStates[userId];
            return bot.sendMessage(chatId, '✅ Cara bayar diupdate.', {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_set_help') {
            stmts.setSetting.run('help_text', msg.text);
            delete userStates[userId];
            return bot.sendMessage(chatId, '✅ Bantuan diupdate.', {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
            });
        }
        if (state.action === 'admin_stocknum') {
            const qty = parseInt(msg.text);
            if (isNaN(qty) || qty < 0) return bot.sendMessage(chatId, '❌ Angka tidak valid.');
            stmts.updateStock.run(qty, state.productId);
            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ Stok produk #${state.productId} diset ke *${qty}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Produk', callback_data: `adm_prod_${state.productId}` }]] }
            });
        }
        if (state.action === 'admin_addstock') {
            let items;
            const text = msg.text;
            if (text.includes('===')) {
                // Mode multi-line: split by ===
                items = text.split('===').map(s => s.trim()).filter(s => s.length > 0);
            } else if (text.includes('\n')) {
                // Mode newline: split by enter
                items = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            } else {
                // Gak ada newline — Telegram mungkin replace jadi spasi
                // Simpan dulu, tanya separator
                userStates[userId] = { ...state, action: 'admin_addstock_sep', rawText: text };
                return bot.sendMessage(chatId,
                    `⚠️ Telegram hapus enter dari data kamu.\n\nIni 1 item atau banyak?`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ 1 item aja', callback_data: 'stocksep_single' }],
                                [{ text: 'Pisah per spasi', callback_data: 'stocksep_space' }],
                                [{ text: 'Pisah per koma (,)', callback_data: 'stocksep_comma' }],
                                [{ text: 'Pisah per titik koma (;)', callback_data: 'stocksep_semicolon' }],
                                [{ text: 'Pisah per pipe (|)', callback_data: 'stocksep_pipe' }],
                                [{ text: '📄 Kirim ulang via file .txt', callback_data: `adm_stockdata_${state.productId}` }],
                            ]
                        }
                    }
                );
            }
            if (items.length === 0) return bot.sendMessage(chatId, '❌ Tidak ada data. Kirim minimal 1 item.');

            const pid = state.productId;
            let added = 0;
            for (const item of items) {
                stmts.addStockItem.run(pid, item);
                added++;
            }
            // Update product stock count
            const remaining = stmts.countStockItems.get(pid);
            stmts.updateStock.run(remaining.count, pid);

            delete userStates[userId];
            return bot.sendMessage(chatId, `✅ ${added} item ditambahkan ke stock queue produk #${pid}.\nTotal stok: ${remaining.count}`, {
                reply_markup: { inline_keyboard: [
                    [{ text: '📦 Lihat Stock', callback_data: `adm_stockq_${pid}` }],
                    [{ text: '🔙 Produk', callback_data: `adm_prod_${pid}` }],
                ]}
            });
        }
        if (state.action === 'admin_broadcast') {
            const text = msg.text;
            const users = db.prepare('SELECT id FROM users').all();
            let sent = 0;
            users.forEach(u => {
                try { bot.sendMessage(u.id, `📢 *Pengumuman*\n\n${text}`, { parse_mode: 'Markdown' }); sent++; } catch (e) {}
            });
            delete userStates[userId];
            return bot.sendMessage(chatId, `📢 Broadcast sent to ${sent}/${users.length} users.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'adm_panel' }]] }
            });
        }
    }

    // Deposit custom amount
    if (state.action === 'deposit_custom') {
        const amount = parseInt(msg.text.replace(/\D/g, ''));
        if (!amount || amount < 1000) return bot.sendMessage(chatId, '❌ Minimal Rp 1.000. Coba lagi:');
        delete userStates[userId];
        return await processDeposit(chatId, null, userId, msg.from.username, amount);
    }

    // Buyer enter coupon
    if (state.action === 'enter_coupon') {
        const code = msg.text.trim().toUpperCase();
        const coupon = stmts.getCoupon.get(code);
        if (!coupon) {
            return bot.sendMessage(chatId, '❌ Kupon tidak valid. Coba lagi atau klik Batal.', {
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `prod_${state.productId}` }]] }
            });
        }
        if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
            return bot.sendMessage(chatId, '❌ Kupon sudah habis dipakai.');
        }
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
            return bot.sendMessage(chatId, '❌ Kupon sudah expired.');
        }

        const p = stmts.getProduct.get(state.productId);
        const qty = state.qty;
        const originalTotal = p.price * qty;
        let disc = coupon.discount_type === 'percent'
            ? Math.floor(originalTotal * coupon.discount_value / 100)
            : coupon.discount_value;
        if (disc > originalTotal) disc = originalTotal;
        const finalTotal = originalTotal - disc;

        userStates[userId] = { couponCode: code };

        const discLabel = coupon.discount_type === 'percent' ? `${coupon.discount_value}%` : formatPrice(coupon.discount_value);
        return bot.sendMessage(chatId,
            `🎟️ *Kupon ${code} Applied!*\n\n` +
            `🏷️ ${p.name} x${qty}\n` +
            `💰 Harga: ${formatPrice(originalTotal)}\n` +
            `🎟️ Diskon: -${formatPrice(disc)} (${discLabel})\n` +
            `💵 Total: *${formatPrice(finalTotal)}*`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `✅ Bayar ${formatPrice(finalTotal)}`, callback_data: `confirm_${state.productId}_${qty}` }],
                        [{ text: '❌ Batal', callback_data: `prod_${state.productId}` }],
                    ]
                }
            }
        );
    }

    // Buyer custom quantity
    if (state.action === 'buy_custom_qty') {
        const qty = parseInt(msg.text);
        const p = stmts.getProduct.get(state.productId);
        if (!p) { delete userStates[userId]; return; }
        const minOrder = p.min_order || 1;
        const maxOrder = Math.min(p.max_order || 100, p.stock);
        if (isNaN(qty) || qty < minOrder || qty > maxOrder) {
            return bot.sendMessage(chatId, `❌ Jumlah harus antara ${minOrder} - ${maxOrder}. Coba lagi:`);
        }
        delete userStates[userId];
        return showBuyConfirm(chatId, state.productId, qty);
    }

    // Add product flow
    if (state.action !== 'add_product') return;

    switch (state.step) {
        case 1: // Name
            state.data.name = msg.text;
            state.step = 2;
            bot.sendMessage(chatId, '📝 Kirim deskripsi produk (atau ketik `-` untuk skip):');
            break;
        case 2: // Description
            state.data.description = msg.text === '-' ? '' : msg.text;
            state.step = 3;
            bot.sendMessage(chatId, '💰 Kirim harga (angka saja, contoh: 25000):');
            break;
        case 3: // Price
            const price = parseInt(msg.text.replace(/\D/g, ''));
            if (!price || price <= 0) return bot.sendMessage(chatId, '❌ Harga harus angka positif. Coba lagi:');
            state.data.price = price;
            state.step = 4;
            bot.sendMessage(chatId, '📦 Kirim jumlah stok:');
            break;
        case 4: // Stock
            const stock = parseInt(msg.text);
            if (isNaN(stock) || stock < 0) return bot.sendMessage(chatId, '❌ Stok harus angka. Coba lagi:');
            state.data.stock = stock;
            state.step = 5;
            bot.sendMessage(chatId, '📁 Kirim nama kategori (contoh: Voucher, Akun, dll):');
            break;
        case 5: // Category
            state.data.category = msg.text;
            const d = state.data;
            const newProd = stmts.addProduct.run(d.name, d.description, d.price, d.stock, d.category, '');
            const newId = newProd.lastInsertRowid;
            delete userStates[userId];
            bot.sendMessage(chatId,
                `✅ *Produk #${newId} Ditambahkan!*\n\n` +
                `🏷️ ${d.name}\n` +
                `📝 ${d.description || '-'}\n` +
                `💰 ${formatPrice(d.price)}\n` +
                `📦 Stok: ${d.stock}\n` +
                `📁 ${d.category}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➕ Add Stock', callback_data: `adm_addstock_${newId}` }],
                            [{ text: '📏 Set Min Order', callback_data: `adm_setmin_${newId}` }, { text: '🏷️ Price Label', callback_data: `adm_setlabel_${newId}` }],
                            [{ text: '📦 Lihat Produk', callback_data: `adm_prod_${newId}` }],
                            [{ text: '➕ Tambah Lagi', callback_data: 'adm_addproduct' }, { text: '👑 Admin', callback_data: 'adm_panel' }],
                        ]
                    }
                }
            );
            break;
    }
});

console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'NONE (set ADMIN_IDS!)'}`);

// === Midtrans: Check payment status ===
async function checkMidtransPayment(orderId) {
    const order = stmts.getOrder.get(orderId);
    if (!order || !order.payment_proof || !coreApi) return null;

    try {
        const txId = order.payment_proof; // We stored midtrans tx id here
        const status = await coreApi.transaction.status(txId);
        return status;
    } catch (e) {
        console.error('Midtrans status check error:', e.message);
        return null;
    }
}

async function processPaymentSuccess(orderId) {
    const order = stmts.getOrder.get(orderId);
    if (!order || order.status === 'completed') return;

    const product = stmts.getProductAll.get(order.product_id);
    const qty = parseInt(order.notes) || 1;
    let deliveredData = '';
    const deliveredItems = [];

    // 1. Try stock queue first — grab N items for quantity orders
    for (let i = 0; i < qty; i++) {
        const stockItem = stmts.getNextStockItem.get(order.product_id);
        if (stockItem) {
            deliveredItems.push(stockItem.data);
            stmts.markStockSold.run(orderId, stockItem.id);
        } else {
            break;
        }
    }

    if (deliveredItems.length > 0) {
        deliveredData = deliveredItems.join('\n');
        // Update stock count
        const remaining = stmts.countStockItems.get(order.product_id);
        stmts.updateStock.run(remaining.count, order.product_id);
    }
    // 2. Fallback to product.data (single data for all)
    else if (product?.data) {
        deliveredData = product.data;
    }

    if (deliveredData) {
        stmts.setDeliveredData.run(deliveredData, 'completed', orderId);
        bot.sendMessage(order.user_id,
            `✅ *Pembayaran Order #${orderId} Berhasil!*\n\n` +
            `🏷️ ${order.product_name}\n\n` +
            `📦 *Produk kamu:*\n\`\`\`\n${deliveredData}\n\`\`\`\n\n` +
            `Simpan data di atas ya! Terima kasih sudah belanja! 🎉`,
            { parse_mode: 'Markdown' }
        );
    } else {
        // Gak ada data digital — set paid, admin kirim manual
        stmts.updateOrderStatus.run('paid', orderId);
        bot.sendMessage(order.user_id,
            `✅ *Pembayaran Order #${orderId} Berhasil!*\n\n` +
            `🏷️ ${order.product_name}\n\n` +
            `⏳ Pesanan kamu sedang diproses admin. Mohon tunggu ya!`,
            { parse_mode: 'Markdown' }
        );
    }

    // Notify admins
    ADMIN_IDS.forEach(adminId => {
        if (deliveredData) {
            bot.sendMessage(adminId,
                `💰 *Payment Received!*\n\nOrder #${orderId}\n👤 @${order.username || order.user_id}\n🏷️ ${order.product_name}\n💰 ${formatPrice(order.price)}\n📦 Auto-delivered ✅`,
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.sendMessage(adminId,
                `💰 *Payment Received — PERLU KIRIM MANUAL!*\n\nOrder #${orderId}\n👤 @${order.username || order.user_id}\n🏷️ ${order.product_name}\n💰 ${formatPrice(order.price)}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📦 Kirim Produk', callback_data: `deliver_${orderId}` }],
                        ]
                    }
                }
            );
        }
    });
}

// === Auto-cancel expired orders (every 60s) ===
setInterval(() => {
    const expired = db.prepare(
        "SELECT * FROM orders WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes')"
    ).all();
    for (const order of expired) {
        const qty = parseInt(order.notes) || 1;
        stmts.updateOrderStatus.run('cancelled', order.id);
        const product = stmts.getProductAll.get(order.product_id);
        if (product) stmts.updateStock.run(product.stock + qty, product.id);
        try {
            bot.sendMessage(order.user_id, `\u23f0 Order #${order.id} otomatis dibatalkan (belum bayar 30 menit). Stok dikembalikan.`);
        } catch (e) {}
        console.log(`\u23f0 Auto-cancelled expired order #${order.id}`);
    }
}, 60000);
console.log('\u23f0 Auto-cancel expired orders active (30 min)');

// === Midtrans Payment Polling (5s) + Webhook ===
if (MIDTRANS_SERVER_KEY) {
    // Polling every 5 seconds
    setInterval(async () => {
        const pendingOrders = stmts.getPendingOrders.all();
        for (const order of pendingOrders) {
            if (!order.payment_proof || !order.payment_proof.startsWith('ORDER-')) continue;
            try {
                const status = await coreApi.transaction.status(order.payment_proof);
                const txStatus = status.transaction_status;

                if (txStatus === 'settlement' || txStatus === 'capture') {
                    console.log(`✅ Payment confirmed: Order #${order.id}`);
                    await processPaymentSuccess(order.id);
                } else if (txStatus === 'expire' || txStatus === 'cancel' || txStatus === 'deny') {
                    console.log(`❌ Payment ${txStatus}: Order #${order.id}`);
                    stmts.updateOrderStatus.run('cancelled', order.id);
                    const product = stmts.getProductAll.get(order.product_id);
                    if (product) { const _qty = parseInt(order.notes) || 1; stmts.updateStock.run(product.stock + _qty, product.id); }
                    bot.sendMessage(order.user_id, `⏰ Order #${order.id} ${txStatus}. Stok dikembalikan.`);
                }
            } catch (e) {
                if (!e.message?.includes('404')) {
                    console.error(`Poll error #${order.id}:`, e.message?.substring(0, 100));
                }
            }
        }
    }, 10000);

    // Also poll pending deposits
    setInterval(async () => {
        const pendingDeps = db.prepare("SELECT * FROM wallet_tx WHERE type = 'deposit_pending'").all();
        for (const dep of pendingDeps) {
            try {
                const status = await coreApi.transaction.status(dep.description);
                if (status.transaction_status === 'settlement' || status.transaction_status === 'capture') {
                    const amount = parseInt(status.gross_amount);
                    stmts.addBalance.run(amount, dep.user_id);
                    db.prepare("UPDATE wallet_tx SET type = 'deposit' WHERE id = ?").run(dep.id);
                    updateMemberLevel(dep.user_id);
                    console.log(`✅ Deposit confirmed: ${amount} for user ${dep.user_id}`);
                    bot.sendMessage(dep.user_id, `✅ Deposit *${formatPrice(amount)}* berhasil! Saldo kamu sudah ditambahkan.`, { parse_mode: 'Markdown' });
                } else if (status.transaction_status === 'expire' || status.transaction_status === 'cancel') {
                    db.prepare('DELETE FROM wallet_tx WHERE id = ?').run(dep.id);
                }
            } catch (e) {}
        }
    }, 10000);

    console.log('🔄 Midtrans payment polling active (every 10s)');
}
