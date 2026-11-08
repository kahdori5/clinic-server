const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// هذا الجزء سيقوم بإنشاء جدول التذاكر السحابي تلقائياً فور تشغيل السيرفر
pool.query(`
  CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    patient_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'waiting',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log("DB Init Error:", err));

module.exports = {
  query: (text, params) => pool.query(text, params),
};