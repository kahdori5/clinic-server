require('dotenv').config();
const { Pool } = require('pg');

const useSSL = Boolean(
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('localhost') &&
    !process.env.DATABASE_URL.includes('127.0.0.1')
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
});

// منع توقف السيرفر عند انقطاع اتصال خامل بقاعدة البيانات
pool.on('error', (err) => {
    console.error('⚠️ خطأ عابر في اتصال قاعدة البيانات:', err.message);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};