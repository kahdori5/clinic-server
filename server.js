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
                password VARCHAR(255) DEFAULT NULL,
                specialty VARCHAR(255) DEFAULT 'طب عام'
            );
            CREATE TABLE IF NOT EXISTS queues (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
                queue_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                current_number INTEGER DEFAULT 0,
                last_issued_number INTEGER DEFAULT 0,
                UNIQUE(clinic_id, queue_date)
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                queue_id INTEGER REFERENCES queues(id) ON DELETE CASCADE,
                patient_name VARCHAR(255) NOT NULL,
                ticket_number INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'waiting',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
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

        const clinicCols = [
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS is_main BOOLEAN DEFAULT true;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS parent_id TEXT DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_end DATE DEFAULT (CURRENT_DATE + INTERVAL '1 month');`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS specialty VARCHAR(255) DEFAULT 'طب عام';`
        ];
        for (let q of clinicCols) {
            try { await db.query(q); } catch (e) {}
        }

        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_slug ON clinics(slug);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_parent ON clinics(parent_id);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_queues_clinic_date ON queues(clinic_id, queue_date);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_records_slug ON patient_records(clinic_slug);`);

        console.log("🚀 قاعدة البيانات جاهزة ومُسرّعة بالكامل!");
    } catch (e) {
        console.error("❌ خطأ في تهيئة قاعدة البيانات:", e.message);
    }
};
initDB();

app.get('/api/doctor/auth-status/:slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT password, specialty FROM clinics WHERE slug = $1', [req.params.slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
        const hasPassword = Boolean(clinic.rows[0].password && clinic.rows[0].password.length > 0);
        res.json({ hasPassword, specialty: clinic.rows[0].specialty || 'طب عام' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/doctor/verify-password', async (req, res) => {
    try {
        const { clinic_slug, password } = req.body;
        const clinic = await db.query('SELECT password FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
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

app.post('/api/doctor/set-specialty', async (req, res) => {
    try {
        const { clinic_slug, specialty } = req.body;
        await db.query('UPDATE clinics SET specialty = $1 WHERE slug = $2', [specialty || 'طب عام', clinic_slug]);
        res.json({ message: 'تم تحديث الاختصاص الطبي بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// عرض الأطباء المضافين فعلياً في الدليل الطبي الجماعي
app.get('/api/directory/doctors', async (req, res) => {
    try {
        const clinicsRes = await db.query(`
            SELECT c.id, c.name, c.slug, c.specialty, c.phone, c.is_main, c.parent_id, c.subscription_end,
                   p.name as parent_clinic_name, p.subscription_end as parent_sub,
                   COALESCE(q.current_number, 0) as current_number,
                   COALESCE(q.last_issued_number, 0) + 1 as next_ticket_today,
                   COALESCE(q.status, 'active') as status
            FROM clinics c
            INNER JOIN clinics p ON c.parent_id::text = p.id::text
            LEFT JOIN queues q ON q.clinic_id = c.id AND q.queue_date = CURRENT_DATE
            WHERE c.is_main = false AND c.parent_id IS NOT NULL
            ORDER BY c.created_at DESC
        `);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const directoryList = [];
        for (let row of clinicsRes.rows) {
            const effectiveSub = row.parent_sub || row.subscription_end;
            if (effectiveSub && new Date(effectiveSub) < today) continue;

            directoryList.push({
                id: row.id,
                name: row.name,
                slug: row.slug,
                specialty: row.specialty || 'طب عام',
                phone: row.phone || '',
                clinic_name: row.parent_clinic_name || row.name,
                current_number: parseInt(row.current_number || 0),
                next_ticket_today: parseInt(row.next_ticket_today || 1),
                status: row.status
            });
        }

        res.json(directoryList);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// معاينة الطابور والرقم المتوقع لمدة أسبوع كامل (7 أيام)
app.get('/api/directory/preview/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query('SELECT id, name, specialty FROM clinics WHERE slug = $1', [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });

        const targetDateRes = date
            ? await db.query('SELECT ($1::date) as d, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL \'7 days\')::date as max_d', [date])
            : await db.query('SELECT CURRENT_DATE as d, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL \'7 days\')::date as max_d');

        const { d, today, max_d } = targetDateRes.rows[0];
        if (new Date(d) < new Date(today) || new Date(d) > new Date(max_d)) {
            return res.status(400).json({ error: 'يمكن الحجز فقط خلال أسبوع كامل (7 أيام كحد أقصى)' });
        }

        const q = await db.query('SELECT current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinic.rows[0].id, d]);
        if (q.rows.length === 0) {
            return res.json({ current_number: 0, prospective_number: 1, status: 'active', doctor_name: clinic.rows[0].name, specialty: clinic.rows[0].specialty || 'طب عام' });
        }

        res.json({
            current_number: q.rows[0].current_number,
            prospective_number: q.rows[0].last_issued_number + 1,
            status: q.rows[0].status,
            doctor_name: clinic.rows[0].name,
            specialty: clinic.rows[0].specialty || 'طب عام'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// مسار جديد لمكتب الاستقبال: جلب لائحة المرضى المسجلين لأي يوم من أيام الأسبوع السبعة
app.get('/api/reception/tickets/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, p.name as parent_clinic_name
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const row = clinic.rows[0];

        const targetDateRes = date
            ? await db.query('SELECT ($1::date)::text as d', [date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = targetDateRes.rows[0].d;

        const q = await db.query('SELECT id, current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [row.id, targetDate]);
        if (q.rows.length === 0) {
            return res.json({
                queue_date: targetDate,
                doctor_name: row.name,
                clinic_name: row.parent_clinic_name || row.name,
                specialty: row.specialty || 'طب عام',
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                status: 'active',
                tickets: []
            });
        }

        const ticketsRes = await db.query(
            'SELECT id, patient_name, ticket_number, status, created_at FROM tickets WHERE queue_id = $1 ORDER BY ticket_number ASC',
            [q.rows[0].id]
        );

        const currentNum = q.rows[0].current_number;
        const waitingCount = ticketsRes.rows.filter(t => t.ticket_number > currentNum && t.status !== 'cancelled').length;

        res.json({
            queue_date: targetDate,
            doctor_name: row.name,
            clinic_name: row.parent_clinic_name || row.name,
            specialty: row.specialty || 'طب عام',
            current_number: currentNum,
            last_issued_number: q.rows[0].last_issued_number,
            waiting_count: waitingCount,
            status: q.rows[0].status,
            tickets: ticketsRes.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/queue/toggle-status', async (req, res) => {
    try {
        const { clinic_slug, booking_date } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة' });
        const clinicId = clinic.rows[0].id;

        const dateRes = booking_date
            ? await db.query('SELECT ($1::date)::text as d', [booking_date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = dateRes.rows[0].d;

        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinicId, targetDate]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, $2::date, 'paused', 0, 0) RETURNING *`, [clinicId, targetDate]);
            io.emit('queue_status_changed', { clinic_slug, status: 'paused', booking_date: targetDate });
            return res.json({ status: 'paused' });
        }

        const newStatus = queue.rows[0].status === 'paused' ? 'active' : 'paused';
        await db.query('UPDATE queues SET status = $1 WHERE id = $2', [newStatus, queue.rows[0].id]);
        io.emit('queue_status_changed', { clinic_slug, status: newStatus, booking_date: targetDate });
        res.json({ status: newStatus });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clinics', async (req, res) => {
    try {
        const { name, slug, phone, email, specialty } = req.body;
        const result = await db.query(`INSERT INTO clinics (name, slug, is_main, subscription_end, phone, email, specialty) VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month', $3, $4, $5) RETURNING *`, [name, slug, phone || '', email || '', specialty || 'عيادة طبية']);
        res.status(201).json({ message: 'تم', clinic: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'الرابط مستخدم مسبقاً.' }); }
});

// إصدار التذاكر مع دعم الحجز طوال الأسبوع الكامل (7 أيام)
app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name, booking_date } = req.body;
        const clinic = await db.query(`SELECT id, name, is_main, subscription_end as doc_sub, parent_id FROM clinics WHERE slug = $1`, [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الرابط غير صحيح أو تم حذف الطبيب' });

        let subEnd = clinic.rows[0].doc_sub;
        if (!clinic.rows[0].is_main && clinic.rows[0].parent_id) {
            const parentRes = await db.query(`SELECT subscription_end FROM clinics WHERE id::text = $1::text`, [clinic.rows[0].parent_id]);
            if (parentRes.rows.length > 0) subEnd = parentRes.rows[0].subscription_end;
        }
        if (subEnd && new Date(subEnd) < new Date(new Date().setHours(0, 0, 0, 0))) {
            return res.status(403).json({ error: 'اشتراك العيادة منتهي.' });
        }

        let targetDateQuery = await db.query(`SELECT CURRENT_DATE::text as target_date`);
        if (booking_date) {
            const checkDate = await db.query(`
                SELECT ($1::date >= CURRENT_DATE AND $1::date <= (CURRENT_DATE + INTERVAL '7 days')::date) as is_valid,
                       ($1::date)::text as target_date
            `, [booking_date]);
            if (!checkDate.rows[0].is_valid) {
                return res.status(400).json({ error: 'يمكن التسجيل والحجز في حدود أسبوع كامل (7 أيام) كحد أقصى.' });
            }
            targetDateQuery = checkDate;
        }
        const targetDate = targetDateQuery.rows[0].target_date;

        const clinicId = clinic.rows[0].id;
        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinicId, targetDate]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, $2::date, 'active', 0, 0) RETURNING *`, [clinicId, targetDate]);
        }
        if (queue.rows[0].status === 'paused') return res.status(400).json({ error: 'استقبال التذاكر متوقف مؤقتاً لهذا اليوم.' });

        const newNumber = queue.rows[0].last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, queue.rows[0].id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [queue.rows[0].id, patient_name || 'مريض', newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber, patient_name: patient_name || 'مريض', booking_date: targetDate });
        res.status(201).json({ message: `رقمك هو: ${newNumber}`, ticket_number: newNumber, booking_date: targetDate, doctor_name: clinic.rows[0].name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إلغاء التذكرة (يدعم إلغاء تذكرة اليوم أو أي يوم خلال الأسبوع من مكتب الاستقبال)
app.post('/api/tickets/cancel', async (req, res) => {
    try {
        const { clinic_slug, ticket_number, booking_date } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length > 0) {
            const queue = booking_date
                ? await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinic.rows[0].id, booking_date])
                : await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);

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
        const { clinic_slug, patient_name } = req.body;
        const patient = await db.query('SELECT * FROM patient_records WHERE clinic_slug = $1 AND patient_name = $2 ORDER BY updated_at DESC LIMIT 1', [clinic_slug, patient_name]);
        if (patient.rows.length > 0) res.json(patient.rows[0]);
        else res.json({ age: '', blood_type: '', allergies: '', chronic_diseases: '', notes: '' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patient/save', async (req, res) => {
    try {
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
        await db.query('DELETE FROM patient_records WHERE id::text = $1::text', [req.params.id]);
        res.json({ message: 'تم حذف المريض من الأرشيف بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patients/all/:clinic_slug', async (req, res) => {
    try {
        const patientsList = await db.query('SELECT id, patient_name, age, blood_type, allergies, chronic_diseases, notes, updated_at FROM patient_records WHERE clinic_slug = $1 ORDER BY updated_at DESC', [req.params.clinic_slug]);
        res.json(patientsList.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/queue-status/:clinic_slug', async (req, res) => {
    try {
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.is_main, c.parent_id, p.name as parent_clinic_name
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted', message: 'هذا الرابط غير صالح أو تم حذف الطبيب' });
        
        const row = clinic.rows[0];
        const mainClinicName = row.parent_clinic_name || row.name;

        let queue = await db.query('SELECT id, current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [row.id]);
        if (queue.rows.length === 0) {
            return res.json({
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                ahead_count: 0,
                my_ticket_status: 'waiting',
                status: 'active',
                doctor_name: row.name,
                clinic_name: mainClinicName,
                specialty: row.specialty || 'طب عام'
            });
        }

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
            doctor_name: row.name,
            clinic_name: mainClinicName,
            specialty: row.specialty || 'طب عام'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/doctor-stats/:clinic_slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
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

app.get('/api/clinic-doctors/:main_slug', async (req, res) => {
    try {
        const main = await db.query(`
            SELECT c.id, c.name, c.slug, c.specialty, c.is_main, c.parent_id, p.name as parent_clinic_name
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.main_slug]);

        if (main.rows.length === 0) return res.json([]);

        const mainRow = main.rows[0];
        const clinicTitle = mainRow.parent_clinic_name || mainRow.name;

        let docList = [];
        if (mainRow.is_main) {
            const doctors = await db.query('SELECT id, name, slug, specialty FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.id]);
            docList = doctors.rows;
        } else {
            const siblingDocs = await db.query('SELECT id, name, slug, specialty FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.parent_id]);
            docList = siblingDocs.rows.length > 0 ? siblingDocs.rows : [mainRow];
        }
        
        let result = [];
        for (let doc of docList) {
            const q = await db.query('SELECT id, current_number, last_issued_number, status FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if (q.rows.length > 0) {
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [q.rows[0].id, q.rows[0].current_number]);
                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    current: q.rows[0].current_number,
                    last_issued: q.rows[0].last_issued_number,
                    waiting: parseInt(waitRes.rows[0].count || 0),
                    status: q.rows[0].status
                });
            } else {
                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    current: 0,
                    last_issued: 0,
                    waiting: 0,
                    status: 'active'
                });
            }
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clinics', async (req, res) => {
    try {
        const allRes = await db.query(`SELECT id, name, slug, subscription_end, phone, email, specialty, is_main, parent_id, created_at FROM clinics ORDER BY created_at DESC`);
        const mainClinics = allRes.rows.filter(r => r.is_main === true || !r.parent_id);
        const subDocs = allRes.rows.filter(r => !r.is_main && r.parent_id);

        const result = mainClinics.map(c => {
            const docs = subDocs.filter(d => String(d.parent_id) === String(c.id));
            return {
                ...c,
                doctors_count: docs.length,
                sub_doctors: docs
            };
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/add-doctor', async (req, res) => {
    try {
        const { parent_id, name, slug, phone, email, specialty } = req.body;
        await db.query('INSERT INTO clinics (name, slug, is_main, parent_id, phone, email, specialty) VALUES ($1, $2, false, $3, $4, $5, $6)', [name, slug, parent_id, phone || '', email || '', specialty || 'طب عام']);
        res.json({ message: 'تم' });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/renew', async (req, res) => {
    try {
        await db.query(`UPDATE clinics SET subscription_end = GREATEST(subscription_end, CURRENT_DATE) + INTERVAL '${req.body.months} month' WHERE id::text = $1::text`, [req.body.clinic_id]);
        res.json({ message: 'تم' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function deepDeleteClinicById(clinicId) {
    const docRes = await db.query('SELECT id, slug FROM clinics WHERE id::text = $1::text', [clinicId]);
    if (docRes.rows.length === 0) return null;
    const { id, slug } = docRes.rows[0];

    await db.query('DELETE FROM tickets WHERE queue_id IN (SELECT id FROM queues WHERE clinic_id = $1)', [id]);
    await db.query('DELETE FROM queues WHERE clinic_id = $1', [id]);
    try { await db.query('DELETE FROM patient_records WHERE clinic_slug = $1', [slug]); } catch (e) {}
    await db.query('DELETE FROM clinics WHERE id = $1', [id]);
    io.emit('doctor_deleted', { clinic_slug: slug });
    return slug;
}

app.delete('/api/admin/clinics/:id', async (req, res) => {
    try {
        const subDocs = await db.query('SELECT id FROM clinics WHERE parent_id::text = $1::text', [req.params.id]);
        for (let doc of subDocs.rows) {
            await deepDeleteClinicById(doc.id);
        }
        await deepDeleteClinicById(req.params.id);
        res.json({ message: 'تم حذف العيادة وجميع بياناتها بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/doctors/:id', async (req, res) => {
    try {
        await deepDeleteClinicById(req.params.id);
        res.json({ message: 'تم حذف الطبيب وإيقاف رابطه بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clinic-doctors-links/:main_id', async (req, res) => {
    try {
        const docs = await db.query('SELECT id, name, slug, phone, email, specialty FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [req.params.main_id]);
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
                io.emit('ticket_status_updated', { clinic_slug, ticket_number: parseInt(ticket_number), status });
            }
        }
        res.json({ message: 'تم' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));