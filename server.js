const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();

// Production mein ALLOWED_ORIGINS environment variable set karein.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '15mb' }));

// ==========================================
// COMMON HELPERS
// ==========================================

const ACTIVE = 'COALESCE(is_deleted, FALSE) = FALSE';
const BALANCE_TOLERANCE = 0.01;
const PAYMENT_TXN_TYPES = ['CASH_IN', 'SUPPLIER_PAYMENT', 'CASH_OUT', 'RETURN'];

const TABLES = [
  'customers',
  'suppliers',
  'transactions',
  'banks',
  'bank_transactions',
  'cash_transactions',
  'expenses'
];

const BIN_TABLES = {
  customers: 'customers',
  suppliers: 'suppliers',
  transactions: 'transactions',
  banks: 'banks',
  bankTransactions: 'bank_transactions',
  cashTransactions: 'cash_transactions',
  expenses: 'expenses'
};

function hasRemainingBalance(balance) {
  return Math.abs(Number(balance || 0)) > BALANCE_TOLERANCE;
}

function formatBalance(balance) {
  return Math.abs(Number(balance || 0))
    .toLocaleString('en-PK', { maximumFractionDigits: 2 });
}

function getDeleteBalanceMessage(title, balance) {
  const type = Number(balance) > 0 ? 'Excess' : 'Outstanding';
  return `${title} delete nahi ho sakta! ${type} balance Rs ${formatBalance(balance)} baqi hai. Pehle balance clear karein.`;
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
      console.error('API Error:', err);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Server Error' });
      }
    });
  };
}

async function inTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await work(client);

    await client.query('COMMIT');

    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback error:', rollbackErr);
    }

    throw err;
  } finally {
    client.release();
  }
}

async function initSoftDeleteSchema() {
  for (const table of TABLES) {
    await pool.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE`
    );

    await pool.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`
    );
    if (table === 'transactions') {
      await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS attachment JSONB`);
      await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS time TEXT`);
    }
    if (table === 'bank_transactions' || table === 'cash_transactions') {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS time TEXT`);
    }
  }
}

function cleanPaymentMode(value) {
  return String(value || 'Cash').trim();
}

function makePartyNotes(partyType, partyName, notes, type) {
  return `${partyType === 'SUPPLIER' ? 'Paid to' : 'Received from'} ${partyName} (${notes || type})`;
}

async function getPartyName(client, partyType, partyId) {
  const table = partyType === 'SUPPLIER' ? 'suppliers' : 'customers';

  const result = await client.query(
    `SELECT name FROM ${table} WHERE id = $1`,
    [partyId]
  );

  return result.rows[0]?.name || 'Party';
}

// ==========================================
// CASH LEDGER UPSERT
// ==========================================

async function upsertCash(client, data) {
  const {
    id,
    voucher_no,
    date,
    time,
    type,
    amount,
    notes
  } = data;

  return client.query(
    `INSERT INTO cash_transactions
      (id, voucher_no, date, time, type, amount, notes, is_deleted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)

     ON CONFLICT (id)
     DO UPDATE SET
       voucher_no = EXCLUDED.voucher_no,
       date = EXCLUDED.date,
       time = EXCLUDED.time,
       type = EXCLUDED.type,
       amount = EXCLUDED.amount,
       notes = EXCLUDED.notes,
       is_deleted = FALSE,
       deleted_at = NULL

     RETURNING *`,
    [
      id,
      voucher_no || null,
      date,
      time || null,
      type,
      amount,
      notes || ''
    ]
  );
}

// ==========================================
// BANK LEDGER UPSERT
// ==========================================

async function upsertBank(client, data) {
  const {
    id,
    bank_id,
    voucher_no,
    date,
    time,
    type,
    amount,
    notes
  } = data;

  return client.query(
    `INSERT INTO bank_transactions
      (id, bank_id, voucher_no, date, time, type, amount, notes, is_deleted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)

     ON CONFLICT (id)
     DO UPDATE SET
       bank_id = EXCLUDED.bank_id,
       voucher_no = EXCLUDED.voucher_no,
       date = EXCLUDED.date,
       time = EXCLUDED.time,
       type = EXCLUDED.type,
       amount = EXCLUDED.amount,
       notes = EXCLUDED.notes,
       is_deleted = FALSE,
       deleted_at = NULL

     RETURNING *`,
    [
      id,
      bank_id,
      voucher_no || null,
      date,
      time || null,
      type,
      amount,
      notes || ''
    ]
  );
}

// ==========================================
// LINKED LEDGER HELPERS
// ==========================================

async function softDeleteLinked(client, id) {
  await client.query(
    `UPDATE cash_transactions
     SET is_deleted = TRUE,
         deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
     WHERE id = $1`,
    [`ct_${id}`]
  );

  await client.query(
    `UPDATE bank_transactions
     SET is_deleted = TRUE,
         deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
     WHERE id = $1`,
    [`bt_${id}`]
  );
}

async function restoreTransactionLinks(client, id) {
  const result = await client.query(
    `SELECT type, payment_mode, bank_id
     FROM transactions
     WHERE id = $1`,
    [id]
  );

  if (!result.rows.length) return;

  const txn = result.rows[0];

  // Pehle dono linked entries inactive karein.
  await softDeleteLinked(client, id);

  // Sirf payment transactions ke linked Cash/Bank entries restore honge.
  if (!PAYMENT_TXN_TYPES.includes(txn.type)) return;

  if (txn.payment_mode === 'Cash') {
    await client.query(
      `UPDATE cash_transactions
       SET is_deleted = FALSE, deleted_at = NULL
       WHERE id = $1`,
      [`ct_${id}`]
    );
  } else if (txn.payment_mode === 'Bank' && txn.bank_id) {
    await client.query(
      `UPDATE bank_transactions
       SET is_deleted = FALSE, deleted_at = NULL
       WHERE id = $1`,
      [`bt_${id}`]
    );
  }
}

async function restoreExpenseLinks(client, id) {
  const result = await client.query(
    `SELECT payment_mode, bank_id
     FROM expenses
     WHERE id = $1`,
    [id]
  );

  if (!result.rows.length) return;

  const exp = result.rows[0];

  await softDeleteLinked(client, id);

  if (!exp.payment_mode || exp.payment_mode === 'Cash') {
    await client.query(
      `UPDATE cash_transactions
       SET is_deleted = FALSE, deleted_at = NULL
       WHERE id = $1`,
      [`ct_${id}`]
    );
  } else if (exp.payment_mode === 'Bank' && exp.bank_id) {
    await client.query(
      `UPDATE bank_transactions
       SET is_deleted = FALSE, deleted_at = NULL
       WHERE id = $1`,
      [`bt_${id}`]
    );
  }
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    message: 'Hi-Fi LED House API running'
  });
});

// ==========================================
// CUSTOMERS
// ==========================================

app.get('/api/customers', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM customers
     WHERE ${ACTIVE}
     ORDER BY name ASC`
  );

  res.json(r.rows);
}));

app.post('/api/customers', asyncRoute(async (req, res) => {
  const {
    id,
    name,
    mobile,
    address,
    opening_balance
  } = req.body;

  if (!id || !name) {
    return res.status(400).json({
      error: 'Customer id and name are required'
    });
  }

  const r = await pool.query(
    `INSERT INTO customers
      (id, name, mobile, address, opening_balance, is_deleted)
     VALUES ($1,$2,$3,$4,$5,FALSE)

     ON CONFLICT (id)
     DO UPDATE SET
       name = EXCLUDED.name,
       mobile = EXCLUDED.mobile,
       address = EXCLUDED.address,
       opening_balance = EXCLUDED.opening_balance,
       is_deleted = FALSE,
       deleted_at = NULL

     RETURNING *`,
    [
      id,
      name,
      mobile || '',
      address || '',
      Number(opening_balance || 0)
    ]
  );

  res.json(r.rows[0]);
}));

app.delete('/api/customers/:id', asyncRoute(async (req, res) => {
  const id = req.params.id;

  const result = await inTransaction(async client => {
    const c = await client.query(
      `SELECT * FROM customers
       WHERE id = $1 AND ${ACTIVE}
       FOR UPDATE`,
      [id]
    );

    if (!c.rows.length) {
      return {
        status: 404,
        body: { error: 'Customer not found' }
      };
    }

    const tx = await client.query(
      `SELECT type, amount
       FROM transactions
       WHERE party_type = 'CUSTOMER'
         AND party_id = $1
         AND ${ACTIVE}`,
      [id]
    );

    if (!tx.rows.length) {
      await client.query(
        `UPDATE customers
         SET is_deleted = TRUE,
             deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
         WHERE id = $1`,
        [id]
      );

      return {
        status: 200,
        body: { message: 'Customer moved to Bin successfully' }
      };
    }

    let balance = Number(c.rows[0].opening_balance || 0);

    for (const t of tx.rows) {
      balance += ['UDHAR', 'SALE'].includes(t.type)
        ? Number(t.amount || 0)
        : -Number(t.amount || 0);
    }

    if (hasRemainingBalance(balance)) {
      return {
        status: 400,
        body: {
          error: getDeleteBalanceMessage('Customer', balance)
        }
      };
    }

    await client.query(
      `UPDATE customers
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [id]
    );

    return {
      status: 200,
      body: { message: 'Customer moved to Bin successfully' }
    };
  });

  res.status(result.status).json(result.body);
}));

// ==========================================
// SUPPLIERS
// ==========================================

app.get('/api/suppliers', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM suppliers
     WHERE ${ACTIVE}
     ORDER BY name ASC`
  );

  res.json(r.rows);
}));

app.post('/api/suppliers', asyncRoute(async (req, res) => {
  const {
    id,
    name,
    mobile,
    address,
    opening_balance
  } = req.body;

  if (!id || !name) {
    return res.status(400).json({
      error: 'Supplier id and name are required'
    });
  }

  const r = await pool.query(
    `INSERT INTO suppliers
      (id, name, mobile, address, opening_balance, is_deleted)
     VALUES ($1,$2,$3,$4,$5,FALSE)

     ON CONFLICT (id)
     DO UPDATE SET
       name = EXCLUDED.name,
       mobile = EXCLUDED.mobile,
       address = EXCLUDED.address,
       opening_balance = EXCLUDED.opening_balance,
       is_deleted = FALSE,
       deleted_at = NULL

     RETURNING *`,
    [
      id,
      name,
      mobile || '',
      address || '',
      Number(opening_balance || 0)
    ]
  );

  res.json(r.rows[0]);
}));

app.delete('/api/suppliers/:id', asyncRoute(async (req, res) => {
  const id = req.params.id;

  const result = await inTransaction(async client => {
    const s = await client.query(
      `SELECT * FROM suppliers
       WHERE id = $1 AND ${ACTIVE}
       FOR UPDATE`,
      [id]
    );

    if (!s.rows.length) {
      return {
        status: 404,
        body: { error: 'Supplier not found' }
      };
    }

    const tx = await client.query(
      `SELECT type, amount
       FROM transactions
       WHERE party_type = 'SUPPLIER'
         AND party_id = $1
         AND ${ACTIVE}`,
      [id]
    );

    if (!tx.rows.length) {
      await client.query(
        `UPDATE suppliers
         SET is_deleted = TRUE,
             deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
         WHERE id = $1`,
        [id]
      );

      return {
        status: 200,
        body: { message: 'Supplier moved to Bin successfully' }
      };
    }

    let balance = Number(s.rows[0].opening_balance || 0);

    for (const t of tx.rows) {
      balance += ['PURCHASE', 'UDHAR_TAKEN'].includes(t.type)
        ? Number(t.amount || 0)
        : -Number(t.amount || 0);
    }

    if (hasRemainingBalance(balance)) {
      return {
        status: 400,
        body: {
          error: getDeleteBalanceMessage('Supplier', balance)
        }
      };
    }

    await client.query(
      `UPDATE suppliers
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [id]
    );

    return {
      status: 200,
      body: { message: 'Supplier moved to Bin successfully' }
    };
  });

  res.status(result.status).json(result.body);
}));

// ==========================================
// TRANSACTIONS
// ==========================================

app.get('/api/transactions', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM transactions
     WHERE ${ACTIVE}
     ORDER BY date DESC`
  );

  res.json(r.rows);
}));

app.post('/api/transactions', asyncRoute(async (req, res) => {
  const {
    id,
    voucher_no,
    date,
    time,
    type,
    party_type,
    party_id,
    amount,
    payment_mode,
    notes,
    bank_id,
    attachment
  } = req.body;

  if (!id || !date || !type || amount === undefined) {
    return res.status(400).json({
      error: 'Transaction required fields missing'
    });
  }

  const mode = cleanPaymentMode(payment_mode);

  if (!['Cash', 'Bank'].includes(mode)) {
    return res.status(400).json({
      error: 'Invalid payment mode'
    });
  }

  if (mode === 'Bank' && !bank_id) {
    return res.status(400).json({
      error: 'Bank account is required'
    });
  }

  const saved = await inTransaction(async client => {
    const r = await client.query(
      `INSERT INTO transactions
        (id, voucher_no, date, time, type, party_type, party_id, amount, payment_mode, notes, bank_id, attachment, is_deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE)

       ON CONFLICT (id)
       DO UPDATE SET
         voucher_no = EXCLUDED.voucher_no,
         date = EXCLUDED.date,
         time = EXCLUDED.time,
         type = EXCLUDED.type,
         party_type = EXCLUDED.party_type,
         party_id = EXCLUDED.party_id,
         amount = EXCLUDED.amount,
         payment_mode = EXCLUDED.payment_mode,
         notes = EXCLUDED.notes,
         bank_id = EXCLUDED.bank_id,
         attachment = EXCLUDED.attachment,
         is_deleted = FALSE,
         deleted_at = NULL

       RETURNING *`,
      [
        id,
        voucher_no || null,
        date,
        time || null,
        type,
        party_type,
        party_id,
        Number(amount),
        mode,
        notes || '',
        bank_id || null,
        attachment || null
      ]
    );

    // Purani linked entry inactive karein.
    await softDeleteLinked(client, id);

    // Sale / Purchase sirf party ledger ko impact karega; Cash ya Bank ko + / - nahi karega.
    if (PAYMENT_TXN_TYPES.includes(type)) {
      const partyName = await getPartyName(client, party_type, party_id);
      const memo = makePartyNotes(party_type, partyName, notes, type);

      if (mode === 'Cash') {
        const cashType = ['CASH_IN', 'RETURN'].includes(type) ? 'IN' : 'OUT';

        await upsertCash(client, {
          id: `ct_${id}`,
          voucher_no,
          date,
          time,
          type: cashType,
          amount: Number(amount),
          notes: memo
        });
      } else {
        const bankType = ['CASH_IN', 'RETURN'].includes(type) ? 'DEPOSIT' : 'WITHDRAW';

        await upsertBank(client, {
          id: `bt_${id}`,
          bank_id,
          voucher_no,
          date,
          time,
          type: bankType,
          amount: Number(amount),
          notes: memo
        });
      }
    }

    return r.rows[0];
  });

  res.json(saved);
}));

app.delete('/api/transactions/:id', asyncRoute(async (req, res) => {
  await inTransaction(async client => {
    await client.query(
      `UPDATE transactions
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [req.params.id]
    );

    await softDeleteLinked(client, req.params.id);
  });

  res.json({ message: 'Moved to Bin' });
}));

// ==========================================
// BANKS
// ==========================================

app.get('/api/banks', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM banks
     WHERE ${ACTIVE}
     ORDER BY bank_name ASC`
  );

  res.json(r.rows);
}));

app.post('/api/banks', asyncRoute(async (req, res) => {
  const {
    id,
    bank_name,
    account_no,
    balance
  } = req.body;

  if (!id || !bank_name) {
    return res.status(400).json({
      error: 'Bank id and name are required'
    });
  }

  const r = await pool.query(
    `INSERT INTO banks
      (id, bank_name, account_no, balance, is_deleted)
     VALUES ($1,$2,$3,$4,FALSE)

     ON CONFLICT (id)
     DO UPDATE SET
       bank_name = EXCLUDED.bank_name,
       account_no = EXCLUDED.account_no,
       balance = EXCLUDED.balance,
       is_deleted = FALSE,
       deleted_at = NULL

     RETURNING *`,
    [
      id,
      bank_name,
      account_no || '',
      Number(balance || 0)
    ]
  );

  res.json(r.rows[0]);
}));

app.delete('/api/banks/:id', asyncRoute(async (req, res) => {
  const id = req.params.id;

  const result = await inTransaction(async client => {
    const b = await client.query(
      `SELECT * FROM banks
       WHERE id = $1 AND ${ACTIVE}
       FOR UPDATE`,
      [id]
    );

    if (!b.rows.length) {
      return {
        status: 404,
        body: { error: 'Bank not found' }
      };
    }

    const tx = await client.query(
      `SELECT type, amount
       FROM bank_transactions
       WHERE bank_id = $1 AND ${ACTIVE}`,
      [id]
    );

    if (!tx.rows.length) {
      await client.query(
        `UPDATE banks
         SET is_deleted = TRUE,
             deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
         WHERE id = $1`,
        [id]
      );

      return {
        status: 200,
        body: { message: 'Bank moved to Bin successfully' }
      };
    }

    let balance = Number(b.rows[0].balance || 0);

    for (const t of tx.rows) {
      balance += t.type === 'DEPOSIT'
        ? Number(t.amount || 0)
        : -Number(t.amount || 0);
    }

    if (hasRemainingBalance(balance)) {
      return {
        status: 400,
        body: {
          error: getDeleteBalanceMessage('Bank', balance)
        }
      };
    }

    await client.query(
      `UPDATE banks
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [id]
    );

    return {
      status: 200,
      body: { message: 'Bank moved to Bin successfully' }
    };
  });

  res.status(result.status).json(result.body);
}));

// ==========================================
// BANK TRANSACTIONS / BANK TRANSFERS
// ==========================================

app.get('/api/bank-transactions', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM bank_transactions
     WHERE ${ACTIVE}
     ORDER BY date DESC`
  );

  res.json(r.rows);
}));

app.post('/api/bank-transactions', asyncRoute(async (req, res) => {
  const {
    id,
    bank_id,
    voucher_no,
    date,
    time,
    type,
    amount,
    notes
  } = req.body;

  if (!id || !bank_id || !date || !type || amount === undefined) {
    return res.status(400).json({
      error: 'Bank transaction required fields missing'
    });
  }

  const saved = await inTransaction(async client => {
    const r = await upsertBank(client, {
      id,
      bank_id,
      voucher_no,
      date,
      time,
      type,
      amount: Number(amount),
      notes
    });

    const cashType = type === 'DEPOSIT' ? 'OUT' : 'IN';

    await upsertCash(client, {
      id: `ct_${id}`,
      voucher_no,
      date,
      time,
      type: cashType,
      amount: Number(amount),
      notes: `Bank Transfer (${notes || type})`
    });

    return r.rows[0];
  });

  res.json(saved);
}));

app.delete('/api/bank-transactions/:id', asyncRoute(async (req, res) => {
  await inTransaction(async client => {
    await client.query(
      `UPDATE bank_transactions
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [req.params.id]
    );

    await client.query(
      `UPDATE cash_transactions
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [`ct_${req.params.id}`]
    );
  });

  res.json({ message: 'Moved to Bin' });
}));

// ==========================================
// CASH TRANSACTIONS
// ==========================================

app.get('/api/cash-transactions', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM cash_transactions
     WHERE ${ACTIVE}
     ORDER BY date DESC`
  );

  res.json(r.rows);
}));

app.post('/api/cash-transactions', asyncRoute(async (req, res) => {
  const {
    id,
    voucher_no,
    date,
    time,
    type,
    amount,
    notes
  } = req.body;

  if (!id || !date || !type || amount === undefined) {
    return res.status(400).json({
      error: 'Cash transaction required fields missing'
    });
  }

  const r = await upsertCash(pool, {
    id,
    voucher_no,
    date,
    time,
    type,
    amount: Number(amount),
    notes
  });

  res.json(r.rows[0]);
}));

app.delete('/api/cash-transactions/:id', asyncRoute(async (req, res) => {
  await pool.query(
    `UPDATE cash_transactions
     SET is_deleted = TRUE,
         deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
     WHERE id = $1`,
    [req.params.id]
  );

  res.json({ message: 'Moved to Bin' });
}));

// ==========================================
// EXPENSES
// ==========================================

app.get('/api/expenses', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM expenses
     WHERE ${ACTIVE}
     ORDER BY date DESC`
  );

  res.json(r.rows);
}));

app.post('/api/expenses', asyncRoute(async (req, res) => {
  const {
    id,
    category,
    amount,
    notes,
    date,
    payment_mode,
    bank_id
  } = req.body;

  if (!id || !category || !date || amount === undefined) {
    return res.status(400).json({
      error: 'Expense required fields missing'
    });
  }

  const mode = cleanPaymentMode(payment_mode);

  if (!['Cash', 'Bank'].includes(mode)) {
    return res.status(400).json({
      error: 'Invalid payment mode'
    });
  }

  if (mode === 'Bank' && !bank_id) {
    return res.status(400).json({
      error: 'Bank account is required'
    });
  }

  const saved = await inTransaction(async client => {
    const r = await client.query(
      `INSERT INTO expenses
        (id, category, amount, notes, date, payment_mode, bank_id, is_deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)

       ON CONFLICT (id)
       DO UPDATE SET
         category = EXCLUDED.category,
         amount = EXCLUDED.amount,
         notes = EXCLUDED.notes,
         date = EXCLUDED.date,
         payment_mode = EXCLUDED.payment_mode,
         bank_id = EXCLUDED.bank_id,
         is_deleted = FALSE,
         deleted_at = NULL

       RETURNING *`,
      [
        id,
        category,
        Number(amount),
        notes || '',
        date,
        mode,
        bank_id || null
      ]
    );

    // Old linked ledger entry inactive.
    await softDeleteLinked(client, id);

    // Same ID par retry hone par voucher change nahi hoga.
    const expVoucher = `EXP-${String(id)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-12) || 'ENTRY'}`;

    const memo = `Expense: ${category} (${notes || ''})`;

    if (mode === 'Cash') {
      await upsertCash(client, {
        id: `ct_${id}`,
        voucher_no: expVoucher,
        date,
        type: 'OUT',
        amount: Number(amount),
        notes: memo
      });
    } else {
      await upsertBank(client, {
        id: `bt_${id}`,
        bank_id,
        voucher_no: expVoucher,
        date,
        type: 'WITHDRAW',
        amount: Number(amount),
        notes: memo
      });
    }

    return r.rows[0];
  });

  res.json(saved);
}));

app.delete('/api/expenses/:id', asyncRoute(async (req, res) => {
  await inTransaction(async client => {
    await client.query(
      `UPDATE expenses
       SET is_deleted = TRUE,
           deleted_at = (NOW() AT TIME ZONE 'Asia/Karachi')
       WHERE id = $1`,
      [req.params.id]
    );

    await softDeleteLinked(client, req.params.id);
  });

  res.json({ message: 'Moved to Bin' });
}));

// ==========================================
// BIN
// ==========================================

app.get('/api/bin', asyncRoute(async (req, res) => {
  const [
    customers,
    suppliers,
    transactions,
    banks,
    bankTxns,
    cashTxns,
    expenses
  ] = await Promise.all([
    pool.query(
      'SELECT * FROM customers WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM suppliers WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM transactions WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM banks WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM bank_transactions WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM cash_transactions WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    ),
    pool.query(
      'SELECT * FROM expenses WHERE is_deleted=TRUE ORDER BY deleted_at DESC NULLS LAST'
    )
  ]);

  res.json({
    customers: customers.rows,
    suppliers: suppliers.rows,
    transactions: transactions.rows,
    banks: banks.rows,
    bankTransactions: bankTxns.rows,
    cashTransactions: cashTxns.rows,
    expenses: expenses.rows
  });
}));

// ==========================================
// RESTORE
// ==========================================

app.post('/api/restore/:type/:id', asyncRoute(async (req, res) => {
  const { type, id } = req.params;

  const table = BIN_TABLES[type];

  if (!table) {
    return res.status(400).json({
      error: 'Invalid item type'
    });
  }

  await inTransaction(async client => {
    const r = await client.query(
      `UPDATE ${table}
       SET is_deleted = FALSE,
           deleted_at = NULL
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (!r.rows.length) return;

    if (type === 'transactions') {
      await restoreTransactionLinks(client, id);
    } else if (type === 'expenses') {
      await restoreExpenseLinks(client, id);
    } else if (type === 'bankTransactions') {
      await client.query(
        `UPDATE cash_transactions
         SET is_deleted = FALSE,
             deleted_at = NULL
         WHERE id = $1`,
        [`ct_${id}`]
      );
    }
  });

  res.json({
    message: 'Restored successfully'
  });
}));

// ==========================================
// PERMANENT DELETE
// ==========================================

async function permanentDeleteOne(client, type, id) {
  const table = BIN_TABLES[type];

  if (!table) return;

  if (type === 'transactions' || type === 'expenses') {
    await softDeleteLinked(client, id);
  }

  if (type === 'bankTransactions') {
    await client.query(
      'DELETE FROM cash_transactions WHERE id=$1',
      [`ct_${id}`]
    );
  }

  if (type === 'transactions' || type === 'expenses') {
    await client.query(
      'DELETE FROM cash_transactions WHERE id=$1',
      [`ct_${id}`]
    );

    await client.query(
      'DELETE FROM bank_transactions WHERE id=$1',
      [`bt_${id}`]
    );
  }

  await client.query(
    `DELETE FROM ${table} WHERE id=$1`,
    [id]
  );
}

app.delete('/api/permanent-delete/:type/:id', asyncRoute(async (req, res) => {
  const { type, id } = req.params;

  if (!BIN_TABLES[type]) {
    return res.status(400).json({
      error: 'Invalid item type'
    });
  }

  await inTransaction(client =>
    permanentDeleteOne(client, type, id)
  );

  res.json({
    message: 'Permanently deleted'
  });
}));

app.delete('/api/permanent-delete-bulk', asyncRoute(async (req, res) => {
  const items = req.body?.items || {};

  await inTransaction(async client => {
    for (const [type, ids] of Object.entries(items)) {
      if (!BIN_TABLES[type] || !Array.isArray(ids)) continue;

      for (const id of ids) {
        await permanentDeleteOne(client, type, id);
      }
    }
  });

  res.json({
    message: 'Selected items permanently deleted'
  });
}));

// ==========================================
// CENTRAL ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
  console.error('Unhandled middleware error:', err);

  if (!res.headersSent) {
    res.status(500).json({
      error: 'Server Error'
    });
  }
});

// ==========================================
// SERVER START
// ==========================================

const PORT = process.env.PORT || 5000;

// Database schema ready hone ke baad hi server start hoga.
initSoftDeleteSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}; soft-delete schema ready`
      );
    });
  })
  .catch(err => {
    console.error(
      'Database schema initialization failed. Server not started:',
      err
    );

    process.exit(1);
  });
