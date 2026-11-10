require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST", "DELETE"] } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ensureArchiveTable = async () => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS patient_records (
            id SERIAL PRIMARY KEY,
            clinic_slug TEXT NOT NULL,
            patient_name TEXT NOT NULL,
            age TEXT DEFAULT '',
            blood_type TEXT DEFAULT '',
            allergies TEXT DEFAULT '',
            chronic_diseases TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
};

const initDB = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS clinics (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_main BOOLEAN DEFAULT true,
                parent_id TEXT DEFAULT NULL,
                subscription_end DATE DEFAULT (CURRENT_DATE + INTERVAL '1 month'),
                phone VARCHAR(50) DEFAULT '',
                email VARCHAR(255) DEFAULT '',
                password VARCHAR(255) DEFAULT NULL
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

        const clinicCols = [
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS is_main BOOLEAN DEFAULT true;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS parent_id TEXT DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_end DATE DEFAULT (CURRENT_DATE + INTERVAL '1 month');`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT NULL;`
        ];
        for (let q of clinicCols) {
            try { await db.query(q); } catch (e) { try { await db.query(q.replace('IF NOT EXISTS ', '')); } catch(err){} }
        }

        await ensureArchiveTable();
        console.log("✅ قاعدة البيانات والأرشيف جاهزون بالكامل!");
    } catch (e) {
        console.error("❌ خطأ في تهيئة قاعدة البيانات:", e.message);
    }
};
initDB();

// --- مسارات الحماية بكلمة السر للطبيب ---
app.get('/api/doctor/auth-status/:slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT password FROM clinics WHERE slug = $1', [req.params.slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
        const hasPassword = Boolean(clinic.rows[0].password && clinic.rows[0].password.length > 0);
        res.json({ hasPassword });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/doctor/verify-password', async (req, res) => {
    try {
        const { clinic_slug, password } = req.body;
        const clinic = await db.query('SELECT password FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
        if (clinic.rows[0].password === password) res.json({ success: true });
        else res.status(401).json({ error: 'كلمة السر غير صحيحة' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/doctor/set-password', async (req, res) => {
    try {
        const { clinic_slug, new_password } = req.body;
        await db.query('UPDATE clinics SET password = $1 WHERE slug = $2', [new_password || null, clinic_slug]);
        res.json({ message: 'تم تحديث إعدادات الحماية بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- مسار إيقاف وتفعيل الطابور مؤقتاً من طرف الطبيب ---
app.post('/api/queue/toggle-status', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة' });
        const clinicId = clinic.rows[0].id;

        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinicId]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, CURRENT_DATE, 'paused', 0, 0) RETURNING *`, [clinicId]);
            io.emit('queue_status_changed', { clinic_slug, status: 'paused' });
            return res.json({ status: 'paused' });
        }

        const newStatus = queue.rows[0].status === 'paused' ? 'active' : 'paused';
        await db.query('UPDATE queues SET status = $1 WHERE id = $2', [newStatus, queue.rows[0].id]);
        io.emit('queue_status_changed', { clinic_slug, status: newStatus });
        res.json({ status: newStatus });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- المسارات الأساسية ---
app.post('/api/clinics', async (req, res) => {
    try {
        const { name, slug, phone, email } = req.body;
        const result = await db.query(`INSERT INTO clinics (name, slug, is_main, subscription_end, phone, email) VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month', $3, $4) RETURNING *`, [name, slug, phone || '', email || '']);
        res.status(201).json({ message: 'تم', clinic: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'الرابط مستخدم مسبقاً.' }); }
});

app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name } = req.body;
        const clinic = await db.query(`SELECT id, is_main, subscription_end as doc_sub, parent_id FROM clinics WHERE slug = $1`, [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الرابط غير صحيح' });

        let subEnd = clinic.rows[0].doc_sub;
        if (!clinic.rows[0].is_main && clinic.rows[0].parent_id) {
            const parentRes = await db.query(`SELECT subscription_end FROM clinics WHERE id::text = $1::text`, [clinic.rows[0].parent_id]);
            if (parentRes.rows.length > 0) subEnd = parentRes.rows[0].subscription_end;
        }
        if (subEnd && new Date(subEnd) < new Date(new Date().setHours(0, 0, 0, 0))) {
            return res.status(403).json({ error: 'اشتراك العيادة منتهي.' });
        }

        const clinicId = clinic.rows[0].id;
        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinicId]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, CURRENT_DATE, 'active', 0, 0) RETURNING *`, [clinicId]);
        }
        if (queue.rows[0].status === 'paused') return res.status(400).json({ error: 'استقبال التذاكر متوقف مؤقتاً من طرف الطبيب.' });

        const newNumber = queue.rows[0].last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, queue.rows[0].id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [queue.rows[0].id, patient_name || 'مريض', newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber });
        res.status(201).json({ message: `رقمك هو: ${newNumber}`, ticket_number: newNumber });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/cancel', async (req, res) => {
    try {
        const { clinic_slug, ticket_number } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length > 0) {
            const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
            if (queue.rows.length > 0) {
                const ticketRes = await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3 RETURNING patient_name', ['cancelled', queue.rows[0].id, ticket_number]);
                const cancelledName = ticketRes.rows.length > 0 ? ticketRes.rows[0].patient_name : 'مريض';
                io.emit('new_ticket', { clinic_slug });
                io.emit('ticket_cancelled', { clinic_slug, ticket_number, patient_name: cancelledName });
            }
        }
        res.json({ message: 'تم الإلغاء' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/call-next', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة.' });

        let queue = await db.query('SELECT id, current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        if (queue.rows.length === 0 || queue.rows[0].current_number >= queue.rows[0].last_issued_number) {
            return res.status(400).json({ error: 'لا يوجد مرضى في الانتظار.' });
        }

        const newCurrent = queue.rows[0].current_number + 1;
        await db.query('UPDATE queues SET current_number = $1 WHERE id = $2', [newCurrent, queue.rows[0].id]);

        const ticket = await db.query('SELECT patient_name, status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [queue.rows[0].id, newCurrent]);
        const patientName = ticket.rows.length > 0 ? ticket.rows[0].patient_name : `مريض رقم ${newCurrent}`;
        const ticketStatus = ticket.rows.length > 0 ? ticket.rows[0].status : 'waiting';

        io.emit('call_patient', { clinic_slug, current_number: newCurrent, status: ticketStatus });
        res.status(200).json({ message: `الرقم: ${newCurrent}`, patient_name: patientName, ticket_status: ticketStatus, doctor_name: clinic.rows[0].name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patient/get', async (req, res) => {
    try {
        await ensureArchiveTable();
        const { clinic_slug, patient_name } = req.body;
        const patient = await db.query('SELECT * FROM patient_records WHERE clinic_slug = $1 AND patient_name = $2 ORDER BY updated_at DESC LIMIT 1', [clinic_slug, patient_name]);
        if (patient.rows.length > 0) res.json(patient.rows[0]);
        else res.json({ age: '', blood_type: '', allergies: '', chronic_diseases: '', notes: '' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patient/save', async (req, res) => {
    try {
        await ensureArchiveTable();
        const { clinic_slug, patient_name, age, blood_type, allergies, chronic, notes } = req.body;
        if (!patient_name) return res.status(400).json({ error: 'اسم المريض مطلوب' });

        const existing = await db.query('SELECT id FROM patient_records WHERE clinic_slug = $1 AND patient_name = $2', [clinic_slug, patient_name]);
        if (existing.rows.length > 0) {
            await db.query(`UPDATE patient_records SET age = $1, blood_type = $2, allergies = $3, chronic_diseases = $4, notes = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`, [age || '', blood_type || '', allergies || '', chronic || '', notes || '', existing.rows[0].id]);
        } else {
            await db.query(`INSERT INTO patient_records (clinic_slug, patient_name, age, blood_type, allergies, chronic_diseases, notes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`, [clinic_slug, patient_name, age || '', blood_type || '', allergies || '', chronic || '', notes || '']);
        }
        res.json({ message: 'تم حفظ الملف الطبي بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/patients/delete/:id', async (req, res) => {
    try {
        await ensureArchiveTable();
        await db.query('DELETE FROM patient_records WHERE id::text = $1::text', [req.params.id]);
        res.json({ message: 'تم حذف المريض من الأرشيف بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patients/all/:clinic_slug', async (req, res) => {
    try {
        await ensureArchiveTable();
        const patientsList = await db.query('SELECT id, patient_name, age, blood_type, allergies, chronic_diseases, notes, updated_at FROM patient_records WHERE clinic_slug = $1 ORDER BY updated_at DESC', [req.params.clinic_slug]);
        res.json(patientsList.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/queue-status/:clinic_slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0, waiting_count: 0, ahead_count: 0, status: 'active' });
        let queue = await db.query('SELECT id, current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        if (queue.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0, waiting_count: 0, ahead_count: 0, status: 'active', doctor_name: clinic.rows[0].name });

        const qId = queue.rows[0].id;
        const currentNum = queue.rows[0].current_number;
        const lastIssued = queue.rows[0].last_issued_number;

        let currentPatientName = '';
        let currentTicketStatus = 'waiting';
        if (currentNum > 0) {
            const t = await db.query('SELECT patient_name, status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [qId, currentNum]);
            if (t.rows.length > 0) {
                currentPatientName = t.rows[0].patient_name;
                currentTicketStatus = t.rows[0].status;
            }
        }

        const waitingRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [qId, currentNum]);
        const waitingCount = parseInt(waitingRes.rows[0].count || 0);

        let aheadCount = waitingCount;
        let myTicketStatus = 'waiting';
        const myTicket = parseInt(req.query.my_ticket);
        if (!isNaN(myTicket) && myTicket > 0) {
            const myT = await db.query('SELECT status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [qId, myTicket]);
            if (myT.rows.length > 0) myTicketStatus = myT.rows[0].status;

            if (currentNum >= myTicket) {
                aheadCount = 0;
            } else {
                const aheadRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND ticket_number < $3 AND status != 'cancelled'`, [qId, currentNum, myTicket]);
                aheadCount = parseInt(aheadRes.rows[0].count || 0);
            }
        }

        res.json({
            current_number: currentNum,
            last_issued_number: lastIssued,
            waiting_count: waitingCount,
            ahead_count: aheadCount,
            my_ticket_status: myTicketStatus,
            status: queue.rows[0].status,
            current_patient_name: currentPatientName,
            current_ticket_status: currentTicketStatus,
            doctor_name: clinic.rows[0].name
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/doctor-stats/:clinic_slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.json({ today: 0, waiting: 0, weekly: 0, monthly: 0, busiest_day: 'غير محدد', busiest_day_index: -1 });
        const cId = clinic.rows[0].id;
        
        let q = await db.query('SELECT id, current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [cId]);
        let today = 0, waiting = 0;
        if (q.rows.length > 0) {
            const totalRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [q.rows[0].id]);
            today = parseInt(totalRes.rows[0].count || 0);
            const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [q.rows[0].id, q.rows[0].current_number]);
            waiting = parseInt(waitRes.rows[0].count || 0);
        }

        const weeklyRes = await db.query(`SELECT COUNT(*) FROM tickets t JOIN queues q ON t.queue_id = q.id WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '7 days' AND t.status != 'cancelled'`, [cId]);
        const weekly = parseInt(weeklyRes.rows[0].count || 0);
        const monthlyRes = await db.query(`SELECT COUNT(*) FROM tickets t JOIN queues q ON t.queue_id = q.id WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '30 days' AND t.status != 'cancelled'`, [cId]);
        const monthly = parseInt(monthlyRes.rows[0].count || 0);

        const busyRes = await db.query(`
            SELECT EXTRACT(DOW FROM q.queue_date) as dow, COUNT(t.id) as total
            FROM tickets t JOIN queues q ON t.queue_id = q.id
            WHERE q.clinic_id = $1 AND t.status != 'cancelled'
            GROUP BY dow ORDER BY total DESC LIMIT 1
        `, [cId]);
        
        let busiest_day = 'غير محدد';
        let busiest_day_index = -1;
        if (busyRes.rows.length > 0) {
            const daysAr = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
            busiest_day_index = parseInt(busyRes.rows[0].dow);
            busiest_day = daysAr[busiest_day_index];
        }

        res.json({ today, waiting, weekly, monthly, busiest_day, busiest_day_index });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// دعم العيادات المتعددة والعيادات الفردية تلقائياً
app.get('/api/clinic-doctors/:main_slug', async (req, res) => {
    try {
        const main = await db.query('SELECT id, name, slug FROM clinics WHERE slug = $1', [req.params.main_slug]);
        if (main.rows.length === 0) return res.json([]);
        let doctors = await db.query('SELECT id, name, slug FROM clinics WHERE parent_id::text = $1::text', [main.rows[0].id]);
        
        // إذا كانت العيادة فردية وليس تحتها أطباء فرعيون، نستخدم العيادة نفسها كطبيب
        const docList = doctors.rows.length > 0 ? doctors.rows : [main.rows[0]];
        
        let result = [];
        for (let doc of docList) {
            const q = await db.query('SELECT id, current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if (q.rows.length > 0) {
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [q.rows[0].id, q.rows[0].current_number]);
                result.push({ name: doc.name, slug: doc.slug, current: q.rows[0].current_number, waiting: parseInt(waitRes.rows[0].count || 0), status: q.rows[0].status });
            } else {
                result.push({ name: doc.name, slug: doc.slug, current: 0, waiting: 0, status: 'active' });
            }
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clinics', async (req, res) => {
    try {
        const clinics = await db.query(`SELECT id, name, slug, subscription_end, phone, email, (SELECT COUNT(*) FROM clinics d WHERE d.parent_id::text = c.id::text) as doctors_count FROM clinics c WHERE is_main = true OR parent_id IS NULL ORDER BY created_at DESC`);
        res.json(clinics.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/add-doctor', async (req, res) => {
    try {
        const { parent_id, name, slug, phone, email } = req.body;
        await db.query('INSERT INTO clinics (name, slug, is_main, parent_id, phone, email) VALUES ($1, $2, false, $3, $4, $5)', [name, slug, parent_id, phone || '', email || '']);
        res.json({ message: 'تم' });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/renew', async (req, res) => {
    try {
        await db.query(`UPDATE clinics SET subscription_end = GREATEST(subscription_end, CURRENT_DATE) + INTERVAL '${req.body.months} month' WHERE id::text = $1::text`, [req.body.clinic_id]);
        res.json({ message: 'تم' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/clinics/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM clinics WHERE parent_id::text = $1::text', [req.params.id]);
        await db.query('DELETE FROM clinics WHERE id::text = $1::text', [req.params.id]);
        res.json({ message: 'تم الحذف بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/doctors/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM clinics WHERE id::text = $1::text', [req.params.id]);
        res.json({ message: 'تم الحذف بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clinic-doctors-links/:main_id', async (req, res) => {
    try {
        const docs = await db.query('SELECT id, name, slug, phone, email FROM clinics WHERE parent_id::text = $1::text', [req.params.main_id]);
        res.json(docs.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/status', async (req, res) => {
    try {
        const { clinic_slug, ticket_number, status } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length > 0) {
            const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
            if (queue.rows.length > 0) {
                await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3', [status, queue.rows[0].id, ticket_number]);
            }
        }
        res.json({ message: 'تم' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));