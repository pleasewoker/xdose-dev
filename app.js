require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

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
// Schema & Model
// =========================
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

const Product = mongoose.model('Product', productSchema);

// =========================
// Helpers: whitelist fields กัน field แปลก ๆ
// =========================
function pickProductFields(input, { allowPartial }) {
  const out = {};

  if (input && typeof input === 'object') {
    if ('name' in input) out.name = input.name;
    if ('price' in input) out.price = input.price;
    if ('description' in input) out.description = input.description;
  }

  // normalize
  if ('name' in out && typeof out.name === 'string') out.name = out.name.trim();

  // PATCH: กัน undefined หลุดไป set ทับค่าเดิม
  if (allowPartial) {
    Object.keys(out).forEach((k) => {
      if (out[k] === undefined) delete out[k];
    });
  }

  return out;
}

// =========================
// Routes
// =========================

// Health check
app.get('/', (req, res) => ok(res, 'API is running', { uptime: process.uptime() }));

// Create
app.post('/products', async (req, res, next) => {
  try {
    const saved = await new Product(req.body).save();
    return ok(res, 'Create product successful', saved, 201);
  } catch (err) {
    return next(err);
  }
});

// List
app.get('/products', async (req, res, next) => {
  try {
    const list = await Product.find().sort({ createdAt: -1 });
    return ok(res, 'Get products successful', list);
  } catch (err) {
    return next(err);
  }
});

// Get by id
app.get('/products/:id', async (req, res, next) => {
  try {
    const item = await Product.findById(req.params.id);
    if (!item) return fail(res, 'Product not found', 404, null);
    return ok(res, 'Get product successful', item);
  } catch (err) {
    return next(err);
  }
});

// =========================
// PATCH = Partial update (แก้เฉพาะ field ที่ส่งมา)
// =========================
app.patch('/products/:id', async (req, res, next) => {
  try {
    const patch = pickProductFields(req.body, { allowPartial: true });

    if (!Object.keys(patch).length) {
      return fail(res, 'PATCH requires at least one updatable field: name, price, description', 400, null);
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true, runValidators: true }
    );

    if (!updated) return fail(res, 'Product not found', 404, null);
    return ok(res, 'Update product (PATCH) successful', updated);
  } catch (err) {
    return next(err);
  }
});

// =========================
// PUT = Replace ทั้งก้อน (ต้องส่งครบ)
// =========================
app.put('/products/:id', async (req, res, next) => {
  try {
    const payload = pickProductFields(req.body, { allowPartial: false });

    // PUT ตาม REST: ควรส่งครบ (อย่างน้อย required fields)
    const missing = [];
    if (!payload.name) missing.push('name');
    if (payload.price === undefined || payload.price === null) missing.push('price');

    if (missing.length) {
      return fail(res, `PUT requires full resource. Missing: ${missing.join(', ')}`, 400, null);
    }

    // Replace ทั้ง document
    // - description ถ้าไม่ส่งมา ให้ถือว่า replace เป็นค่า default '' เพื่อให้ behavior ชัดเจน
    const replaced = await Product.findOneAndReplace(
      { _id: req.params.id },
      {
        name: payload.name,
        price: payload.price,
        description: payload.description ?? '',
      },
      { new: true, runValidators: true }
    );

    if (!replaced) return fail(res, 'Product not found', 404, null);
    return ok(res, 'Replace product (PUT) successful', replaced);
  } catch (err) {
    return next(err);
  }
});

// Delete
app.delete('/products/:id', async (req, res, next) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) return fail(res, 'Product not found', 404, null);
    return ok(res, 'Delete product successful', deleted);
  } catch (err) {
    return next(err);
  }
});

// 404 route (ถ้า path ไม่ตรง)
app.use((req, res) => {
  return fail(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, null);
});

// =========================
// Error handler กลาง (สำคัญ)
// =========================
app.use((err, req, res, next) => {
  // Mongoose validation error
  if (err?.name === 'ValidationError') {
    return fail(res, err.message, 400, null);
  }

  // Invalid ObjectId
  if (err?.name === 'CastError') {
    return fail(res, 'Invalid id format', 400, null);
  }

  console.error('Unhandled error:', err);
  return fail(res, 'Internal server error', 500, null);
});

// // =========================
// // Connect DB & Start server
// // =========================
// mongoose
//   .connect(process.env.MONGODB_URI)
//   .then(() => {
//     console.log('MongoDB connected');
//     app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
//   })
//   .catch((err) => {
//     console.error('Mongo connect error:', err);
//     process.exit(1);
//   });
// =========================
// Start server first (Render ต้องเห็น PORT)
// =========================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// =========================
// Connect DB (retry ได้)
// =========================
async function connectWithRetry() {
  try {
    if (!process.env.MONGODB_URI) {
      console.error('Missing MONGODB_URI in environment variables');
      return;
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log('MongoDB connected');
  } catch (err) {
    console.error('Mongo connect error:', err.message);
    // รอแล้ว retry ทุก 5 วิ
    setTimeout(connectWithRetry, 5000);
  }
}

connectWithRetry();
