const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// دالة تجهيز قاعدة البيانات تلقائياً
const initDB = async () => {
  try {
    // 1. إنشاء جميع الجداول المطلوبة
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinics (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        slug VARCHAR(255) UNIQUE
      );
      
      CREATE TABLE IF NOT EXISTS queues (
        id SERIAL PRIMARY KEY,
        clinic_id INT REFERENCES clinics(id),
        queue_date DATE,
        status VARCHAR(50) DEFAULT 'active',
        last_issued_number INT DEFAULT 0,
        current_number INT DEFAULT 0,
        UNIQUE(clinic_id, queue_date)
      );
      
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        queue_id INT REFERENCES queues(id),
        patient_name VARCHAR(255),
        ticket_number INT,
        status VARCHAR(50) DEFAULT 'waiting'
      );
    `);

    // 2. تسجيل عيادة افتراضية تلقائياً
    await pool.query(`
      INSERT INTO clinics (name, slug) 
      VALUES ('العيادة الرئيسية', 'default-clinic') 
      ON CONFLICT (slug) DO NOTHING;
    `);

    // 3. فتح طابور اليوم تلقائياً
    const clinic = await pool.query(`SELECT id FROM clinics WHERE slug = 'default-clinic'`);
    if (clinic.rows.length > 0) {
      await pool.query(`
        INSERT INTO queues (clinic_id, queue_date) 
        VALUES ($1, CURRENT_DATE) 
        ON CONFLICT (clinic_id, queue_date) DO NOTHING;
      `, [clinic.rows[0].id]);
    }
    console.log("✅ تم تجهيز قاعدة البيانات والعيادة بنجاح!");
  } catch (err) {
    console.error("❌ خطأ في تجهيز قاعدة البيانات:", err);
  }
};

// تشغيل الدالة فوراً
initDB();

module.exports = {
  query: (text, params) => pool.query(text, params),
};