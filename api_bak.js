require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');


const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function ok(res, message = 'Success', data = null, code = 200) {
  return res.status(code).json({ status: true, message, data });
}
function fail(res, message = 'Fail', code = 400, data = null) {
  return res.status(code).json({ status: false, message, data });
}

function isPositiveInt(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0;
}

// =========================
// MySQL pool
// =========================
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

// =========================
// CRUD Factory
// =========================
function createCrudRouter({ table, pk, fields, requiredOnCreate = [] }) {
  const router = express.Router();

  // List
  router.get('/', async (req, res, next) => {
    try {
      const [rows] = await pool.execute(`SELECT * FROM ${table} ORDER BY ${pk} DESC`);
      return ok(res, `Get ${table} successful`, rows);
    } catch (e) { next(e); }
  });

  // Get by id
  router.get('/:id', async (req, res, next) => {
    try {
      if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400, null);
      const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      if (!rows.length) return fail(res, 'Not found', 404, null);
      return ok(res, `Get ${table} successful`, rows[0]);
    } catch (e) { next(e); }
  });

  // Create
  router.post('/', async (req, res, next) => {
    try {
      // pick fields
      const payload = {};
      for (const f of fields) if (f in req.body) payload[f] = req.body[f];

      // validate required
      const missing = requiredOnCreate.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
      if (missing.length) return fail(res, `Missing required: ${missing.join(', ')}`, 400, null);

      const cols = Object.keys(payload);
      const vals = Object.values(payload);
      const qs = cols.map(() => '?').join(',');

      const [result] = await pool.execute(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${qs})`,
        vals
      );

      const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${pk} = ? LIMIT 1`, [result.insertId]);
      return ok(res, `Create ${table} successful`, rows[0], 201);
    } catch (e) { next(e); }
  });

  // PATCH (partial)
  router.patch('/:id', async (req, res, next) => {
    try {
      if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400, null);

      const patch = {};
      for (const f of fields) if (f in req.body) patch[f] = req.body[f];
      if (!Object.keys(patch).length) return fail(res, 'No updatable fields', 400, null);

      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      const vals = [...Object.values(patch), req.params.id];

      const [exist] = await pool.execute(`SELECT ${pk} FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      if (!exist.length) return fail(res, 'Not found', 404, null);

      await pool.execute(`UPDATE ${table} SET ${sets} WHERE ${pk} = ?`, vals);
      const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      return ok(res, `Update ${table} (PATCH) successful`, rows[0]);
    } catch (e) { next(e); }
  });

  // PUT (replace - require requiredOnCreate)
  router.put('/:id', async (req, res, next) => {
    try {
      if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400, null);

      const payload = {};
      for (const f of fields) payload[f] = (f in req.body ? req.body[f] : null);

      const missing = requiredOnCreate.filter((f) => payload[f] === null || payload[f] === '');
      if (missing.length) return fail(res, `PUT requires: ${missing.join(', ')}`, 400, null);

      const sets = Object.keys(payload).map((k) => `${k} = ?`).join(', ');
      const vals = [...Object.values(payload), req.params.id];

      const [exist] = await pool.execute(`SELECT ${pk} FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      if (!exist.length) return fail(res, 'Not found', 404, null);

      await pool.execute(`UPDATE ${table} SET ${sets} WHERE ${pk} = ?`, vals);
      const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      return ok(res, `Replace ${table} (PUT) successful`, rows[0]);
    } catch (e) { next(e); }
  });

  // Delete
  router.delete('/:id', async (req, res, next) => {
    try {
      if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400, null);

      const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${pk} = ? LIMIT 1`, [req.params.id]);
      if (!rows.length) return fail(res, 'Not found', 404, null);

      await pool.execute(`DELETE FROM ${table} WHERE ${pk} = ?`, [req.params.id]);
      return ok(res, `Delete ${table} successful`, rows[0]);
    } catch (e) { next(e); }
  });

  return router;
}


// =========================
// Register CRUD for each table
// =========================

// organization
app.use('/organizations', createCrudRouter({
  table: 'm_organization',
  pk: 'organization_id',
  fields: ['email', 'name', 'picture', 'active_status', 'total_user', 'end_date', 'start_date'],
  requiredOnCreate: ['name'],
}));

// group (reserved word => use backticks)
app.use('/groups', createCrudRouter({
  table: '`m_group`',
  pk: 'group_id',
  fields: ['group_name', 'organization_id', 'active_status'],
  requiredOnCreate: ['group_name'],
}));

// user (reserved word => use backticks)
app.use('/users', createCrudRouter({
  table: '`m_user`',
  pk: 'user_id',
  fields: ['organization_id', 'group_id', 'email', 'license', 'password', 'picture', 'active_status'],
  requiredOnCreate: ['email', 'password'],
}));

// user_stat
app.use('/user-stats', createCrudRouter({
  table: 't_user_stat',
  pk: 'stat_id',
  fields: ['user_id', 'level', 'exp', 'streak', 'point'],
  requiredOnCreate: ['user_id'],
}));

// user_course_score
app.use('/user-course-scores', createCrudRouter({
  table: 't_user_course_score',
  pk: 'score_id',
  fields: ['user_id', 'course_score','course_id'],
  requiredOnCreate: ['user_id', 'course_score','course_id'],
}));

// m_course 
app.use('/courses', createCrudRouter({
  table: 'm_course',
  pk: 'course_id',
  fields: [
    'course_name',
    'course_type_id',
    'desciption',
    'active_status'
  ],
  requiredOnCreate: ['course_name'],
}));

// m_course_type
app.use('/course-types', createCrudRouter({
  table: 'm_course_type',
  pk: 'course_type_id',
  fields: [
    'course_type_name',
    'active_status'
  ],
  requiredOnCreate: ['course_type_name'],
}));

// =========================
// m_moderator CRUD (custom เพราะต้อง hash password)
// =========================
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;

const moderatorRouter = require('express').Router();

// List
moderatorRouter.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, create_date FROM m_moderator ORDER BY moderator_id DESC'
    );
    return ok(res, 'Get moderators successful', rows);
  } catch (e) { next(e); }
});

// Get by id
moderatorRouter.get('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, create_date FROM m_moderator WHERE moderator_id = ?',
      [req.params.id]
    );

    if (!rows.length) return fail(res, 'Moderator not found', 404);
    return ok(res, 'Get moderator successful', rows[0]);
  } catch (e) { next(e); }
});

// Create
moderatorRouter.post('/', async (req, res, next) => {
  try {
    const { user_name, password } = req.body;

    if (!user_name || !password) {
      return fail(res, 'user_name and password required', 400);
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await pool.execute(
      'INSERT INTO m_moderator (user_name, password) VALUES (?, ?)',
      [user_name, hash]
    );

    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, create_date FROM m_moderator WHERE moderator_id = ?',
      [result.insertId]
    );

    return ok(res, 'Create moderator successful', rows[0], 201);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Username already exists', 409);
    }
    next(e);
  }
});

// PATCH
moderatorRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const fields = [];
    const values = [];

    if ('user_name' in req.body) {
      fields.push('user_name = ?');
      values.push(req.body.user_name);
    }

    if ('password' in req.body) {
      const hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
      fields.push('password = ?');
      values.push(hash);
    }

    if (!fields.length) return fail(res, 'No updatable fields', 400);

    values.push(req.params.id);

    await pool.execute(
      `UPDATE m_moderator SET ${fields.join(', ')} WHERE moderator_id = ?`,
      values
    );

    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, create_date FROM m_moderator WHERE moderator_id = ?',
      [req.params.id]
    );

    return ok(res, 'Update moderator successful', rows[0]);
  } catch (e) { next(e); }
});

// Delete
moderatorRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name FROM m_moderator WHERE moderator_id = ?',
      [req.params.id]
    );

    if (!rows.length) return fail(res, 'Moderator not found', 404);

    await pool.execute(
      'DELETE FROM m_moderator WHERE moderator_id = ?',
      [req.params.id]
    );

    return ok(res, 'Delete moderator successful', rows[0]);
  } catch (e) { next(e); }
});

// Register route
app.use('/moderators', moderatorRouter);


const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

function signRefreshToken(payload) {
  // refresh token ควรมี secret แยก และอายุยาวกว่า
  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: `${REFRESH_DAYS}d` });
}

function refreshExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_DAYS);
  return d;
}

async function issueTokens({ subjectType, subjectId, extra = {} }) {
  // payload พื้นฐาน
  const base = { sub: String(subjectId), typ: subjectType, ...extra };

  const accessToken = signAccessToken(base);
  const refreshToken = signRefreshToken(base);

  // เก็บ refresh แบบ hash ลง DB (กัน token หลุดจาก DB แล้วใช้ได้)
  const tokenHash = sha256Hex(refreshToken);
  const expiresAt = refreshExpiresAt();

  await pool.execute(
    `INSERT INTO t_refresh_token (subject_type, subject_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [subjectType, subjectId, tokenHash, expiresAt]
  );

  return { accessToken, refreshToken, expiresAt };
}

async function revokeRefreshToken(refreshToken) {
  const tokenHash = sha256Hex(refreshToken);
  await pool.execute(
    `UPDATE t_refresh_token SET revoked_at = NOW()
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash]
  );
}

/**
 * Refresh Token Rotation:
 * - ตรวจ refresh token ว่าถูกต้อง + ยังไม่ revoked + ยังไม่หมดอายุ
 * - revoke ตัวเก่า
 * - ออก access+refresh ใหม่
 */
async function rotateRefreshToken(refreshToken) {
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
  } catch (e) {
    return { ok: false, reason: 'Invalid refresh token' };
  }

  const tokenHash = sha256Hex(refreshToken);

  const [rows] = await pool.execute(
    `SELECT token_id, subject_type, subject_id, revoked_at, expires_at
     FROM t_refresh_token
     WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );

  if (!rows.length) return { ok: false, reason: 'Refresh token not found' };
  const row = rows[0];

  if (row.revoked_at) return { ok: false, reason: 'Refresh token revoked' };

  const exp = new Date(row.expires_at);
  if (exp.getTime() < Date.now()) return { ok: false, reason: 'Refresh token expired' };

  // revoke เก่า
  await pool.execute(`UPDATE t_refresh_token SET revoked_at = NOW() WHERE token_id = ?`, [row.token_id]);

  // issue ใหม่
  const tokens = await issueTokens({
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    extra: { typ: row.subject_type, sub: String(row.subject_id) }
  });

  return { ok: true, ...tokens, subjectType: row.subject_type, subjectId: row.subject_id };
}

// =========================
// VERIFY APIs (ตามที่คุณขอ)
// =========================

// verify #1: email exists?
app.post('/auth/user/verify-email', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return fail(res, 'email is required', 400);

    const [rows] = await pool.execute(
      `SELECT user_id FROM m_user WHERE email = ? LIMIT 1`,
      [email]
    );

    return ok(res, 'Verify email', { exists: rows.length > 0 });
  } catch (e) { next(e); }
});

// verify #2: email + license exists?
app.post('/auth/user/verify-email-license', async (req, res, next) => {
  try {
    const { email, license } = req.body || {};
    if (!email) return fail(res, 'email is required', 400);
    if (!license) return fail(res, 'license is required', 400);

    const [rows] = await pool.execute(
      `SELECT user_id FROM m_user WHERE email = ? AND license = ? LIMIT 1`,
      [email, license]
    );

    return ok(res, 'Verify email+license', { exists: rows.length > 0 });
  } catch (e) { next(e); }
});

// =========================
// LOGIN APIs
// =========================

// 1) Moderator login
app.post('/auth/moderator/login', async (req, res, next) => {
  try {
    const { user_name, password } = req.body || {};
    if (!user_name || !password) return fail(res, 'user_name and password required', 400);

    const [rows] = await pool.execute(
      `SELECT moderator_id, user_name, password
       FROM m_moderator
       WHERE user_name = ? LIMIT 1`,
      [user_name]
    );

    if (!rows.length) return fail(res, 'Invalid credentials', 401);

    const mod = rows[0];
    const okPass = await bcrypt.compare(password, mod.password);
    if (!okPass) return fail(res, 'Invalid credentials', 401);

    const tokens = await issueTokens({
      subjectType: 'moderator',
      subjectId: mod.moderator_id,
      extra: { role: 'moderator' }
    });

    return ok(res, 'Moderator login successful', {
      moderator_id: mod.moderator_id,
      user_name: mod.user_name,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      refresh_expires_at: tokens.expiresAt
    });
  } catch (e) { next(e); }
});

// 2) Organization login (ต้องมี password_hash ใน m_organization)
app.post('/auth/organization/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'email and password required', 400);

    const [rows] = await pool.execute(
      `SELECT organization_id, email, name, password_hash, active_status
       FROM m_organization
       WHERE email = ? LIMIT 1`,
      [email]
    );

    if (!rows.length) return fail(res, 'Invalid credentials', 401);

    const org = rows[0];
    if (org.active_status === 0) return fail(res, 'Organization inactive', 403);
    if (!org.password_hash) return fail(res, 'Organization has no password set', 400);

    const okPass = await bcrypt.compare(password, org.password_hash);
    if (!okPass) return fail(res, 'Invalid credentials', 401);

    const tokens = await issueTokens({
      subjectType: 'organization',
      subjectId: org.organization_id,
      extra: { role: 'organization' }
    });

    return ok(res, 'Organization login successful', {
      organization_id: org.organization_id,
      name: org.name,
      email: org.email,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      refresh_expires_at: tokens.expiresAt
    });
  } catch (e) { next(e); }
});

// 3) m_user login
app.post('/auth/user/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'email and password required', 400);

    const [rows] = await pool.execute(
      `SELECT user_id, email, password, organization_id, group_id, license, active_status
       FROM m_user
       WHERE email = ? LIMIT 1`,
      [email]
    );

    if (!rows.length) return fail(res, 'Invalid credentials', 401);

    const user = rows[0];
    if (user.active_status === 0) return fail(res, 'User inactive', 403);

    const okPass = await bcrypt.compare(password, user.password);
    if (!okPass) return fail(res, 'Invalid credentials', 401);

    const tokens = await issueTokens({
      subjectType: 'user',
      subjectId: user.user_id,
      extra: {
        role: 'user',
        organization_id: user.organization_id,
        group_id: user.group_id,
        license: user.license
      }
    });

    return ok(res, 'User login successful', {
      user_id: user.user_id,
      email: user.email,
      organization_id: user.organization_id,
      group_id: user.group_id,
      license: user.license,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      refresh_expires_at: tokens.expiresAt
    });
  } catch (e) { next(e); }
});

// =========================
// REFRESH / LOGOUT
// =========================

// refresh token -> rotate
app.post('/auth/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return fail(res, 'refresh_token is required', 400);

    const r = await rotateRefreshToken(refresh_token);
    if (!r.ok) return fail(res, r.reason, 401);

    return ok(res, 'Refresh successful', {
      access_token: r.accessToken,
      refresh_token: r.refreshToken,
      refresh_expires_at: r.expiresAt
    });
  } catch (e) { next(e); }
});

// logout (revoke refresh)
app.post('/auth/logout', async (req, res, next) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return fail(res, 'refresh_token is required', 400);

    await revokeRefreshToken(refresh_token);
    return ok(res, 'Logout successful', null);
  } catch (e) { next(e); }
});



// Health
app.get('/', (req, res) => ok(res, 'API is running', { uptime: process.uptime() }));

// 404
app.use((req, res) => fail(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, null));

// Error handler
app.use((err, req, res, next) => {
  // FK error
  if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
    return fail(res, 'Foreign key constraint failed (referenced id not found)', 400, null);
  }
  console.error('Unhandled error:', err);
  return fail(res, 'Internal server error', 500, null);
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));


