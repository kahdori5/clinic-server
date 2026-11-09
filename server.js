require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🚀 البناء الجذري لقاعدة البيانات (يُعالج المشكلة من جذورها)
const initDB = async () => {
    try {
        console.log("جاري فحص وبناء قاعدة البيانات...");
        
        // 1. إنشاء الجداول الأساسية إن لم تكن موجودة (هذا ما كان ينقصنا)
        await db.query(`
            CREATE TABLE IF NOT EXISTS clinics (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS queues (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
                queue_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                current_number INTEGER DEFAULT 0,
                last_issued_number INTEGER DEFAULT 0,
                UNIQUE(clinic_id, queue_date)
            );
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                queue_id INTEGER REFERENCES queues(id) ON DELETE CASCADE,
                patient_name VARCHAR(255) NOT NULL,
                ticket_number INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'waiting',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. إضافة أعمدة الاشتراكات بذكاء (يتجاهل الخطأ إذا كانت موجودة)
        const newColumns = [
            `ALTER TABLE clinics ADD COLUMN is_main BOOLEAN DEFAULT true;`,
            `ALTER TABLE clinics ADD COLUMN parent_id INTEGER DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN subscription_end DATE DEFAULT (CURRENT_DATE + INTERVAL '1 month');`
        ];
        
        for (let query of newColumns) {
            try { await db.query(query); } catch(e) { /* العمود موجود بالفعل */ }
        }

        // 3. تحديث القيم القديمة
        try {
            await db.query(`UPDATE clinics SET is_main = true WHERE is_main IS NULL`);
            await db.query(`UPDATE clinics SET subscription_end = CURRENT_DATE + INTERVAL '1 month' WHERE subscription_end IS NULL`);
        } catch(e) {}

        console.log("✅ قاعدة البيانات جاهزة ومكتملة 100%!");
    } catch (e) {
        console.error("❌ خطأ حرج في بناء قاعدة البيانات:", e.message);
    }
};

// تشغيل البناء فور إقلاع السيرفر
initDB();

// 1. إضافة عيادة رئيسية
app.post('/api/clinics', async (req, res) => {
    try {
        const { name, slug } = req.body; 
        const result = await db.query(`
            INSERT INTO clinics (name, slug, is_main, subscription_end) 
            VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month') RETURNING *
        `, [name, slug]);
        res.status(201).json({ message: 'تم إنشاء العيادة بنجاح', clinic: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'الرابط المخصص مستخدم مسبقاً أو يوجد خلل: ' + err.message }); 
    }
});

// 2. سحب تذكرة
app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name } = req.body;
        const clinic = await db.query(`
            SELECT c.id, c.is_main, c.subscription_end as doc_sub, p.subscription_end as parent_sub 
            FROM clinics c LEFT JOIN clinics p ON c.parent_id = p.id 
            WHERE c.slug = $1
        `, [clinic_slug]);
        
        if(clinic.rows.length === 0) return res.status(404).json({ error: 'الرابط غير صحيح' });

        let subEnd = clinic.rows[0].is_main ? clinic.rows[0].doc_sub : clinic.rows[0].parent_sub;
        if(new Date(subEnd) < new Date(new Date().setHours(0,0,0,0))) {
            return res.status(403).json({ error: 'اشتراك العيادة منتهي. يرجى مراجعة الإدارة.' });
        }

        const clinicId = clinic.rows[0].id;
        
        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinicId]);
        if(queue.rows.length === 0) {
            const newQ = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, CURRENT_DATE, 'active', 0, 0) RETURNING *`, [clinicId]);
            queue = newQ;
        }

        if(queue.rows[0].status === 'paused') return res.status(400).json({ error: 'الطابور متوقف مؤقتاً.' });

        const newNumber = queue.rows[0].last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, queue.rows[0].id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [queue.rows[0].id, patient_name, newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber });
        res.status(201).json({ message: `رقمك هو: ${newNumber}` });
    } catch (err) { res.status(500).json({ error: 'خطأ داخلي: ' + err.message }); }
});

// 3. مناداة المريض
app.post('/api/call-next', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        let queue = await db.query('SELECT id, current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        
        if (queue.rows.length === 0 || queue.rows[0].current_number >= queue.rows[0].last_issued_number) {
            return res.status(400).json({ error: 'لا يوجد مرضى في الانتظار.' });
        }
        
        const newCurrent = queue.rows[0].current_number + 1;
        await db.query('UPDATE queues SET current_number = $1 WHERE id = $2', [newCurrent, queue.rows[0].id]);

        io.emit('call_patient', { clinic_slug, current_number: newCurrent });
        res.status(200).json({ message: `الرقم: ${newCurrent}` });
    } catch (err) { res.status(500).json({ error: 'خطأ في النظام: ' + err.message }); }
});

// 4. حالة الطابور للطبيب والمريض
app.get('/api/queue-status/:clinic_slug', async (req, res) => {
    try {
        const { clinic_slug } = req.params;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if(clinic.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0 });
        
        let queue = await db.query('SELECT current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        if(queue.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0, status: 'active' });
        
        res.json(queue.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. جلب كل أطباء العيادة 
app.get('/api/clinic-doctors/:main_slug', async (req, res) => {
    try {
        const main = await db.query('SELECT id FROM clinics WHERE slug = $1 AND is_main = true', [req.params.main_slug]);
        if(main.rows.length === 0) return res.json([]);
        const doctors = await db.query('SELECT id, name, slug FROM clinics WHERE parent_id = $1', [main.rows[0].id]);
        let result = [];
        for(let doc of doctors.rows) {
            const q = await db.query('SELECT current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if(q.rows.length > 0) result.push({ name: doc.name, slug: doc.slug, current: q.rows[0].current_number, waiting: q.rows[0].last_issued_number - q.rows[0].current_number, status: q.rows[0].status });
            else result.push({ name: doc.name, slug: doc.slug, current: 0, waiting: 0, status: 'active' });
        }
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 6. مسار لوحة الإدارة (تم إضافة تمرير الخطأ الحقيقي)
app.get('/api/admin/clinics', async (req, res) => {
    try {
        // التأكد أولاً أن الجدول موجود لتجنب انهيار التطبيق
        await initDB(); 
        const clinics = await db.query(`
            SELECT id, name, slug, subscription_end,
                   (SELECT COUNT(*) FROM clinics d WHERE d.parent_id = c.id) as doctors_count
            FROM clinics c WHERE is_main = true OR parent_id IS NULL ORDER BY id DESC
        `);
        res.json(clinics.rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/admin/add-doctor', async (req, res) => {
    try {
        const { parent_id, name, slug } = req.body;
        await db.query('INSERT INTO clinics (name, slug, is_main, parent_id) VALUES ($1, $2, false, $3)', [name, slug, parent_id]);
        res.json({ message: 'تم إضافة الطبيب بنجاح' });
    } catch (err) { res.status(500).json({ error: 'الرابط مستخدم مسبقاً' }); }
});

app.post('/api/admin/renew', async (req, res) => {
    try {
        const { clinic_id, months } = req.body;
        await db.query(`UPDATE clinics SET subscription_end = GREATEST(subscription_end, CURRENT_DATE) + INTERVAL '${months} month' WHERE id = $1`, [clinic_id]);
        res.json({ message: 'تم تجديد الاشتراك بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/clinics/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM clinics WHERE parent_id = $1', [req.params.id]); 
        await db.query('DELETE FROM clinics WHERE id = $1', [req.params.id]); 
        res.json({ message: 'تم حذف العيادة' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clinic-doctors-links/:main_id', async (req, res) => {
    try {
        const docs = await db.query('SELECT name, slug FROM clinics WHERE parent_id = $1', [req.params.main_id]);
        res.json(docs.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/status', async (req, res) => {
    const { clinic_slug, ticket_number, status } = req.body; 
    const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
    const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
    await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3', [status, queue.rows[0].id, ticket_number]);
    res.json({ message: `تم` });
});

app.post('/api/queues/toggle', async (req, res) => {
    const { clinic_slug, status } = req.body; 
    const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
    await db.query('UPDATE queues SET status = $1 WHERE clinic_id = $2 AND queue_date = CURRENT_DATE', [status, clinic.rows[0].id]);
    io.emit('queue_status_changed', { clinic_slug, status }); 
    res.json({ message: `تم التغيير` });
});

app.get('/api/export/:clinic_slug', async (req, res) => {
    res.send('تصدير البيانات مؤقت للعمل'); // تم إيقافه مؤقتاً لتخفيف الحمل
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));