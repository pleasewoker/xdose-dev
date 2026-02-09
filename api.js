require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

function generateOrgCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    const idx = crypto.randomInt(0, chars.length);
    result += chars[idx];
  }

  return result;
}


const SALT_ROUNDS = 10;

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
// CRUD Factory (สำหรับ table ทั่วไป)
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
      const payload = {};
      for (const f of fields) if (f in req.body) payload[f] = req.body[f];

      const missing = requiredOnCreate.filter(
        (f) => payload[f] === undefined || payload[f] === null || payload[f] === ''
      );
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

  // PATCH
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

  // PUT
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
// Custom CRUD: m_organization (hash password + hide password)
// =========================
const organizationRouter = express.Router();

// =========================
// LIST
// =========================
organizationRouter.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT 
        organization_id,
        email,
        name,
        picture,
        active_status,
        total_user,
        end_date,
        start_date,
        created_date,
        updated_date,
        code
       FROM m_organization
       ORDER BY organization_id DESC`
    );

    return ok(res, 'Get m_organization successful', rows);
  } catch (e) { next(e); }
});

// =========================
// GET BY ID
// =========================
organizationRouter.get('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return fail(res, 'Invalid id format', 400);
    }

    const [rows] = await pool.execute(
      `SELECT 
        organization_id,
        email,
        name,
        picture,
        active_status,
        total_user,
        end_date,
        start_date,
        created_date,
        updated_date,
        code
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) return fail(res, 'Not found', 404);

    return ok(res, 'Get m_organization successful', rows[0]);
  } catch (e) { next(e); }
});

// =========================
// CREATE
// =========================
organizationRouter.post('/', async (req, res, next) => {
  try {
    const {
      email,
      name,
      password,
      picture,
      active_status,
      total_user,
      end_date,
      start_date,
      code
    } = req.body || {};

    if (!name) return fail(res, 'name is required', 400);
    if (!email) return fail(res, 'email is required', 400);
    if (!password) return fail(res, 'password is required', 400);

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    // ถ้าไม่ส่ง code → generate auto
    let orgCode = code;

    if (!orgCode) {
      let isDuplicate = true;

      // loop กันชน unique
      while (isDuplicate) {
        orgCode = generateOrgCode(6);

        const [chk] = await pool.execute(
          `SELECT organization_id
           FROM m_organization
           WHERE code = ?
           LIMIT 1`,
          [orgCode]
        );

        isDuplicate = chk.length > 0;
      }
    }

    const [result] = await pool.execute(
      `INSERT INTO m_organization
       (email, name, password, picture, active_status, total_user, end_date, start_date, code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        email,
        name,
        hash,
        picture ?? null,
        active_status ?? 1,
        total_user ?? 0,
        end_date ?? null,
        start_date ?? null,
        orgCode
      ]
    );

    const [rows] = await pool.execute(
      `SELECT 
        organization_id,
        email,
        name,
        picture,
        active_status,
        total_user,
        end_date,
        start_date,
        created_date,
        updated_date,
        code
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [result.insertId]
    );

    return ok(res, 'Create m_organization successful', rows[0], 201);

  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Organization email already exists', 409);
    }
    next(e);
  }
});

// =========================
// PATCH (Partial Update)
// =========================
organizationRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return fail(res, 'Invalid id format', 400);
    }

    const fields = [];
    const values = [];

    const allow = [
      'email',
      'name',
      'password',
      'picture',
      'active_status',
      'total_user',
      'end_date',
      'start_date',
      'code'   // ✅ เพิ่มแล้ว
    ];

    for (const k of allow) {
      if (k in (req.body || {})) {

        if (k === 'password') {
          const hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
          fields.push('password = ?');
          values.push(hash);

        } else {
          fields.push(`${k} = ?`);
          values.push(req.body[k]);
        }
      }
    }

    if (!fields.length) {
      return fail(res, 'No updatable fields', 400);
    }

    const [exist] = await pool.execute(
      `SELECT organization_id
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    if (!exist.length) return fail(res, 'Not found', 404);

    values.push(req.params.id);

    await pool.execute(
      `UPDATE m_organization
       SET ${fields.join(', ')}
       WHERE organization_id = ?`,
      values
    );

    const [rows] = await pool.execute(
      `SELECT 
        organization_id,
        email,
        name,
        picture,
        active_status,
        total_user,
        end_date,
        start_date,
        created_date,
        updated_date,
        code
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    return ok(res, 'Update m_organization (PATCH) successful', rows[0]);

  } catch (e) { next(e); }
});

// =========================
// PUT (Replace)
// =========================
organizationRouter.put('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return fail(res, 'Invalid id format', 400);
    }

    const {
      email,
      name,
      password,
      picture,
      active_status,
      total_user,
      end_date,
      start_date,
      code    // ✅ เพิ่มแล้ว
    } = req.body || {};

    const missing = [];
    if (!email) missing.push('email');
    if (!name) missing.push('name');
    if (!password) missing.push('password');

    if (missing.length) {
      return fail(res, `PUT requires: ${missing.join(', ')}`, 400);
    }

    const [exist] = await pool.execute(
      `SELECT organization_id
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    if (!exist.length) return fail(res, 'Not found', 404);

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    await pool.execute(
      `UPDATE m_organization
       SET
         email = ?,
         name = ?,
         password = ?,
         picture = ?,
         active_status = ?,
         total_user = ?,
         end_date = ?,
         start_date = ?,
         code = ?
       WHERE organization_id = ?`,
      [
        email,
        name,
        hash,
        picture ?? null,
        active_status ?? 1,
        total_user ?? 0,
        end_date ?? null,
        start_date ?? null,
        code ?? null,
        req.params.id
      ]
    );

    const [rows] = await pool.execute(
      `SELECT 
        organization_id,
        email,
        name,
        picture,
        active_status,
        total_user,
        end_date,
        start_date,
        created_date,
        updated_date,
        code
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    return ok(res, 'Replace m_organization (PUT) successful', rows[0]);

  } catch (e) { next(e); }
});

// =========================
// DELETE
// =========================
organizationRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return fail(res, 'Invalid id format', 400);
    }

    const [rows] = await pool.execute(
      `SELECT organization_id, email, name, code
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) return fail(res, 'Not found', 404);

    await pool.execute(
      `DELETE FROM m_organization
       WHERE organization_id = ?`,
      [req.params.id]
    );

    return ok(res, 'Delete m_organization successful', rows[0]);

  } catch (e) { next(e); }
});

app.use('/organizations', organizationRouter);


// =========================
// Custom CRUD: m_user (hash password + hide password)
// =========================
const userRouter = express.Router();

userRouter.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT user_id, organization_id, group_id, email, license, picture, active_status, created_date, updated_date
       FROM m_user
       ORDER BY user_id DESC`
    );
    return ok(res, 'Get m_user successful', rows);
  } catch (e) { next(e); }
});

userRouter.get('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const [rows] = await pool.execute(
      `SELECT user_id, organization_id, group_id, email, license, picture, active_status, created_date, updated_date
       FROM m_user WHERE user_id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Not found', 404);
    return ok(res, 'Get m_user successful', rows[0]);
  } catch (e) { next(e); }
});

userRouter.post('/', async (req, res, next) => {
  try {
    const {
      organization_id, group_id,
      email, license, password,
      picture, active_status
    } = req.body || {};

    if (!email) return fail(res, 'email is required', 400);
    if (!password) return fail(res, 'password is required', 400);

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await pool.execute(
      `INSERT INTO m_user (organization_id, group_id, email, license, password, picture, active_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        organization_id ?? null,
        group_id ?? null,
        email,
        license ?? null,
        hash,
        picture ?? null,
        active_status ?? 1
      ]
    );

    const [rows] = await pool.execute(
      `SELECT user_id, organization_id, group_id, email, license, picture, active_status, created_date, updated_date
       FROM m_user WHERE user_id = ? LIMIT 1`,
      [result.insertId]
    );

    return ok(res, 'Create m_user successful', rows[0], 201);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return fail(res, 'User email already exists', 409);
    next(e);
  }
});

userRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const fields = [];
    const values = [];

    const allow = ['organization_id','group_id','email','license','password','picture','active_status'];
    for (const k of allow) {
      if (k in (req.body || {})) {
        if (k === 'password') {
          const hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
          fields.push('password = ?'); values.push(hash);
        } else {
          fields.push(`${k} = ?`); values.push(req.body[k]);
        }
      }
    }

    if (!fields.length) return fail(res, 'No updatable fields', 400);

    const [exist] = await pool.execute(`SELECT user_id FROM m_user WHERE user_id = ? LIMIT 1`, [req.params.id]);
    if (!exist.length) return fail(res, 'Not found', 404);

    values.push(req.params.id);
    await pool.execute(`UPDATE m_user SET ${fields.join(', ')} WHERE user_id = ?`, values);

    const [rows] = await pool.execute(
      `SELECT user_id, organization_id, group_id, email, license, picture, active_status, created_date, updated_date
       FROM m_user WHERE user_id = ? LIMIT 1`,
      [req.params.id]
    );

    return ok(res, 'Update m_user (PATCH) successful', rows[0]);
  } catch (e) { next(e); }
});

userRouter.put('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const {
      organization_id, group_id,
      email, license, password,
      picture, active_status
    } = req.body || {};

    const missing = [];
    if (!email) missing.push('email');
    if (!password) missing.push('password');
    if (missing.length) return fail(res, `PUT requires: ${missing.join(', ')}`, 400);

    const [exist] = await pool.execute(`SELECT user_id FROM m_user WHERE user_id = ? LIMIT 1`, [req.params.id]);
    if (!exist.length) return fail(res, 'Not found', 404);

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    await pool.execute(
      `UPDATE m_user
       SET organization_id = ?, group_id = ?, email = ?, license = ?, password = ?, picture = ?, active_status = ?
       WHERE user_id = ?`,
      [
        organization_id ?? null,
        group_id ?? null,
        email,
        license ?? null,
        hash,
        picture ?? null,
        active_status ?? 1,
        req.params.id
      ]
    );

    const [rows] = await pool.execute(
      `SELECT user_id, organization_id, group_id, email, license, picture, active_status, created_date, updated_date
       FROM m_user WHERE user_id = ? LIMIT 1`,
      [req.params.id]
    );

    return ok(res, 'Replace m_user (PUT) successful', rows[0]);
  } catch (e) { next(e); }
});

userRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const [rows] = await pool.execute(
      `SELECT user_id, email
       FROM m_user WHERE user_id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Not found', 404);

    await pool.execute(`DELETE FROM m_user WHERE user_id = ?`, [req.params.id]);
    return ok(res, 'Delete m_user successful', rows[0]);
  } catch (e) { next(e); }
});

app.use('/users', userRouter);

// =========================
// Register CRUD for remaining tables (ใช้ factory เดิม)
// =========================

// group
app.use('/groups', createCrudRouter({
  table: '`m_group`',
  pk: 'group_id',
  fields: ['group_name', 'organization_id', 'active_status'],
  requiredOnCreate: ['group_name'],
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
  fields: ['user_id', 'course_score', 'course_id'],
  requiredOnCreate: ['user_id', 'course_score', 'course_id'],
}));

// m_course
app.use('/courses', createCrudRouter({
  table: 'm_course',
  pk: 'course_id',
  fields: ['course_name', 'desciption', 'active_status','mascot_id'],
  requiredOnCreate: ['course_name'],
}));

// m_subject
app.use('/subjects', createCrudRouter({
  table: 'm_subject',
  pk: 'subject_id',
  fields: [
    'course_id',
    'sort_order',
    'subject_name',
    'subject_description',
    'active_status'
  ],
  requiredOnCreate: ['course_id', 'subject_name'],
}));

// m_quiz
app.use('/quizzes', createCrudRouter({
  table: 'm_quiz',
  pk: 'quiz_id',
  fields: [
    'subject_id',
    'quiz_name',
    'quiz_description',
    'active_status'
  ],
  requiredOnCreate: ['subject_id', 'quiz_name'],
}));

// t_quiz_question
app.use('/quiz-questions', createCrudRouter({
  table: 't_quiz_question',
  pk: 'question_id',
  fields: [
    'quiz_id',
    'question_text',
    'question_type',
    'choice_a', 'choice_b', 'choice_c', 'choice_d',
    'true_label', 'false_label',
    'correct_answer',
    'score',
    'sort_order',
    'active_status'
  ],
  requiredOnCreate: ['quiz_id', 'question_text', 'question_type', 'correct_answer'],
}));

// t_quiz_attempt
app.use('/quiz-attempts', createCrudRouter({
  table: 't_quiz_attempt',
  pk: 'attempt_id',
  fields: [
    'user_id',
    'quiz_id',
    'score',
    'max_score',
    'status',
    'started_at',
    'submitted_at'
  ],
  requiredOnCreate: ['user_id', 'quiz_id'],
}));


// // m_course_type
// app.use('/course-types', createCrudRouter({
//   table: 'm_course_type',
//   pk: 'course_type_id',
//   fields: ['course_type_name', 'active_status'],
//   requiredOnCreate: ['course_type_name'],
// }));

// =========================
// m_moderator CRUD (custom เพราะต้อง hash password)
// =========================
const moderatorRouter = require('express').Router();

// List
moderatorRouter.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, created_date FROM m_moderator ORDER BY moderator_id DESC'
    );
    return ok(res, 'Get moderators successful', rows);
  } catch (e) { next(e); }
});

// Get by id
moderatorRouter.get('/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return fail(res, 'Invalid id format', 400);

    const [rows] = await pool.execute(
      'SELECT moderator_id, user_name, created_date FROM m_moderator WHERE moderator_id = ?',
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
      'SELECT moderator_id, user_name, created_date FROM m_moderator WHERE moderator_id = ?',
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
      'SELECT moderator_id, user_name, created_date FROM m_moderator WHERE moderator_id = ?',
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

app.use('/moderators', moderatorRouter);

// =========================
// JWT + Refresh Token
// =========================
const ACCESS_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function signAccessToken(payload) {
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}
function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: `${REFRESH_DAYS}d` });
}
function refreshExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_DAYS);
  return d;
}

async function issueTokens({ subjectType, subjectId, extra = {} }) {
  const base = { sub: String(subjectId), typ: subjectType, ...extra };

  const accessToken = signAccessToken(base);
  const refreshToken = signRefreshToken(base);

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

async function rotateRefreshToken(refreshToken) {
  try {
    jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
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

  await pool.execute(`UPDATE t_refresh_token SET revoked_at = NOW() WHERE token_id = ?`, [row.token_id]);

  const tokens = await issueTokens({
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    extra: { typ: row.subject_type, sub: String(row.subject_id) }
  });

  return { ok: true, ...tokens };
}

// =========================
// VERIFY APIs
// =========================
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

// Organization login (ใช้ m_organization.password)
app.post('/auth/organization/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'email and password required', 400);

    const [rows] = await pool.execute(
      `SELECT organization_id, email, name, password, active_status
       FROM m_organization
       WHERE email = ? LIMIT 1`,
      [email]
    );

    if (!rows.length) return fail(res, 'Invalid credentials', 401);

    const org = rows[0];
    if (org.active_status === 0) return fail(res, 'Organization inactive', 403);
    if (!org.password) return fail(res, 'Organization has no password set', 400);

    const okPass = await bcrypt.compare(password, org.password);
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

// m_user login (password เป็น hash)
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

app.post('/auth/logout', async (req, res, next) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return fail(res, 'refresh_token is required', 400);

    await revokeRefreshToken(refresh_token);
    return ok(res, 'Logout successful', null);
  } catch (e) { next(e); }
});

// =========================
// RESET PASSWORD (USER) - DEBUG/ADMIN TOOL
// =========================
app.post('/debug/user/reset-password', async (req, res, next) => {
  try {
    const { id, new_password, secret } = req.body || {};

    // require id
    if (!isPositiveInt(id)) {
      return fail(res, 'id is required and must be positive integer', 400);
    }

    // require secret
    if (!secret) {
      return fail(res, 'ACCESS_TOKEN_SECRET is required', 400);
    }
    if (secret !== process.env.ACCESS_TOKEN_SECRET) {
      return fail(res, 'Invalid secret', 401);
    }

    // หา user ก่อน
    const [rows] = await pool.execute(
      `SELECT user_id, email
       FROM m_user
       WHERE user_id = ?
       LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];

    // ถ้าไม่ส่ง new_password -> สุ่มให้ (อ่านง่าย + ใช้งานได้ทันที)
    const plainPassword =
      (typeof new_password === 'string' && new_password.trim().length > 0)
        ? new_password
        : crypto.randomBytes(6).toString('base64url'); // ~8 chars

    // hash แล้ว update
    const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);

    await pool.execute(
      `UPDATE m_user
       SET password = ?, updated_date = NOW()
       WHERE user_id = ?`,
      [hash, id]
    );

    return ok(res, 'Reset password successful', {
      user_id: user.user_id,
      email: user.email,
      plain_password: plainPassword,   // ✅ password ใหม่ (เอาไป debug / แจ้ง user)
      password_hash: hash             // ✅ hash ใหม่ (ไว้ตรวจสอบ)
    });

  } catch (e) { next(e); }
});

// =========================
// RESET PASSWORD (ORGANIZATION) - DEBUG/ADMIN TOOL
// =========================
app.post('/debug/organization/reset-password', async (req, res, next) => {
  try {
    const { id, new_password, secret } = req.body || {};

    // require id
    if (!isPositiveInt(id)) {
      return fail(res, 'id is required and must be positive integer', 400);
    }

    // require secret
    if (!secret) {
      return fail(res, 'ACCESS_TOKEN_SECRET is required', 400);
    }
    if (secret !== process.env.ACCESS_TOKEN_SECRET) {
      return fail(res, 'Invalid secret', 401);
    }

    // หา organization ก่อน
    const [rows] = await pool.execute(
      `SELECT organization_id, email, name
       FROM m_organization
       WHERE organization_id = ?
       LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return fail(res, 'Organization not found', 404);
    }

    const org = rows[0];

    // ถ้าไม่ส่ง new_password -> สุ่มให้
    const plainPassword =
      (typeof new_password === 'string' && new_password.trim().length > 0)
        ? new_password
        : crypto.randomBytes(6).toString('base64url'); // ~8 chars

    // hash แล้ว update
    const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);

    await pool.execute(
      `UPDATE m_organization
       SET password = ?, updated_date = NOW()
       WHERE organization_id = ?`,
      [hash, id]
    );

    return ok(res, 'Reset organization password successful', {
      organization_id: org.organization_id,
      email: org.email,
      name: org.name,
      plain_password: plainPassword,
      password_hash: hash
    });

  } catch (e) { next(e); }
});



// Health
app.get('/', (req, res) => ok(res, 'API is running', { uptime: process.uptime() }));

// 404
app.use((req, res) => fail(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, null));

// Error handler
app.use((err, req, res, next) => {
  if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
    return fail(res, 'Foreign key constraint failed (referenced id not found)', 400, null);
  }
  if (err?.code === 'ER_DUP_ENTRY') {
    return fail(res, 'Duplicate entry', 409, null);
  }
  console.error('Unhandled error:', err);
  return fail(res, 'Internal server error', 500, null);
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
