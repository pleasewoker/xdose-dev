require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { ObjectId } = require('bson');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// Response helpers (pattern กลาง)
// =========================
function ok(res, message = 'Success', data = null, code = 200) {
  return res.status(code).json({ status: true, message, data });
}
function fail(res, message = 'Fail', code = 400, data = null) {
  return res.status(code).json({ status: false, message, data });
}

// =========================
// Middleware
// =========================
app.use(express.json());

// =========================
// Helpers
// =========================
function pickProductFields(input, { allowPartial }) {
  const out = {};
  if (input && typeof input === 'object') {
    if ('name' in input) out.name = input.name;
    if ('price' in input) out.price = input.price;
    if ('description' in input) out.description = input.description;
  }

  if ('name' in out && typeof out.name === 'string') out.name = out.name.trim();

  if (allowPartial) {
    Object.keys(out).forEach((k) => {
      if (out[k] === undefined) delete out[k];
    });
  }
  return out;
}

function isPositiveInt(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0;
}

function isObjectId24(val) {
  return typeof val === 'string' && /^[a-fA-F0-9]{24}$/.test(val);
}

function newMongoLikeId() {
  return new ObjectId().toHexString(); // 24 hex
}

/**
 * รองรับ key ได้ 2 แบบ:
 * - เลข => id
 * - 24 hex => _id
 */
function resolveKey(key) {
  if (isPositiveInt(key)) {
    return { where: 'id = ?', params: [Number(key)], keyType: 'id' };
  }
  if (isObjectId24(key)) {
    return { where: '`_id` = ?', params: [key], keyType: '_id' };
  }
  return null;
}

// =========================
// MySQL pool + init
// =========================
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function initDb() {
  const sql = `
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`_id\` CHAR(24) NOT NULL,
      name VARCHAR(255) NULL,
      price DECIMAL(12,2) NULL,
      description TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_products__id (\`_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.execute(sql);
  console.log('MySQL ready: products table ensured');
}

async function pingDbWithRetry() {
  try {
    await pool.query('SELECT 1');
    console.log('MySQL connected');
    await initDb();
  } catch (err) {
    console.error('MySQL init error:', err.message);
    // setTimeout(pingDbWithRetry, 5000);
  }
}

// =========================
// Routes
// =========================

// Health check
app.get('/', (req, res) => ok(res, 'API is running', { uptime: process.uptime() }));

// Create (สร้างทั้ง id + _id)
app.post('/products', async (req, res, next) => {
  try {
    const payload = pickProductFields(req.body, { allowPartial: false });

    if (!payload.name) return fail(res, 'name is required', 400, null);
    if (payload.price === undefined || payload.price === null) return fail(res, 'price is required', 400, null);

    const description = payload.description ?? '';
    const _id = newMongoLikeId();

    const [result] = await pool.execute(
      'INSERT INTO products (`_id`, name, price, description) VALUES (?, ?, ?, ?)',
      [_id, payload.name, payload.price, description]
    );

    const id = result.insertId;
    const [rows] = await pool.execute('SELECT * FROM products WHERE id = ?', [id]);
    return ok(res, 'Create product successful', rows[0], 201);
  } catch (err) {
    // กรณี _id ชนกัน (โอกาสน้อยมาก แต่รองรับไว้)
    if (err && err.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Duplicate _id, please retry', 409, null);
    }
    next(err);
  }
});

// List
app.get('/products', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM products ORDER BY created_at DESC');
    return ok(res, 'Get products successful', rows);
  } catch (err) {
    next(err);
  }
});

// Get by id OR _id (ใช้ path เดียว)
app.get('/products/:key', async (req, res, next) => {
  try {
    const r = resolveKey(req.params.key);
    if (!r) return fail(res, 'Invalid key format (use numeric id or 24-hex _id)', 400, null);

    const [rows] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    if (!rows.length) return fail(res, 'Product not found', 404, null);

    return ok(res, `Get product successful (by ${r.keyType})`, rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH = Partial update (by id OR _id)
app.patch('/products/:key', async (req, res, next) => {
  try {
    const r = resolveKey(req.params.key);
    if (!r) return fail(res, 'Invalid key format (use numeric id or 24-hex _id)', 400, null);

    const patch = pickProductFields(req.body, { allowPartial: true });
    if (!Object.keys(patch).length) {
      return fail(res, 'PATCH requires at least one updatable field: name, price, description', 400, null);
    }

    // check exists
    const [exist] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    if (!exist.length) return fail(res, 'Product not found', 404, null);

    const fields = [];
    const values = [];

    if ('name' in patch) { fields.push('name = ?'); values.push(patch.name); }
    if ('price' in patch) { fields.push('price = ?'); values.push(patch.price); }
    if ('description' in patch) { fields.push('description = ?'); values.push(patch.description ?? ''); }

    await pool.execute(
      `UPDATE products SET ${fields.join(', ')} WHERE ${r.where}`,
      [...values, ...r.params]
    );

    const [rows] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    return ok(res, `Update product (PATCH) successful (by ${r.keyType})`, rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT = Replace ทั้งก้อน (by id OR _id)
app.put('/products/:key', async (req, res, next) => {
  try {
    const r = resolveKey(req.params.key);
    if (!r) return fail(res, 'Invalid key format (use numeric id or 24-hex _id)', 400, null);

    const payload = pickProductFields(req.body, { allowPartial: false });

    const missing = [];
    if (!payload.name) missing.push('name');
    if (payload.price === undefined || payload.price === null) missing.push('price');
    if (missing.length) {
      return fail(res, `PUT requires full resource. Missing: ${missing.join(', ')}`, 400, null);
    }

    const description = payload.description ?? '';

    const [exist] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    if (!exist.length) return fail(res, 'Product not found', 404, null);

    await pool.execute(
      `UPDATE products SET name = ?, price = ?, description = ? WHERE ${r.where}`,
      [payload.name, payload.price, description, ...r.params]
    );

    const [rows] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    return ok(res, `Replace product (PUT) successful (by ${r.keyType})`, rows[0]);
  } catch (err) {
    next(err);
  }
});

// Delete (by id OR _id)
app.delete('/products/:key', async (req, res, next) => {
  try {
    const r = resolveKey(req.params.key);
    if (!r) return fail(res, 'Invalid key format (use numeric id or 24-hex _id)', 400, null);

    const [rows] = await pool.execute(`SELECT * FROM products WHERE ${r.where} LIMIT 1`, r.params);
    if (!rows.length) return fail(res, 'Product not found', 404, null);

    await pool.execute(`DELETE FROM products WHERE ${r.where}`, r.params);
    return ok(res, `Delete product successful (by ${r.keyType})`, rows[0]);
  } catch (err) {
    next(err);
  }
});

// 404 route
app.use((req, res) => {
  return fail(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, null);
});

// Error handler กลาง
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  return fail(res, 'Internal server error', 500, null);
});

// =========================
// Start server + connect db retry
// =========================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

pingDbWithRetry();
