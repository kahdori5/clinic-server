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
                address VARCHAR(255) DEFAULT '',
                password VARCHAR(255) DEFAULT NULL,
                specialty VARCHAR(255) DEFAULT 'طب عام',
                max_daily_tickets INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS doctor_off_days (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
                off_date DATE NOT NULL,
                UNIQUE(clinic_id, off_date)
            );
            CREATE TABLE IF NOT EXISTS queues (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
                queue_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                current_number INTEGER DEFAULT 0,
                last_issued_number INTEGER DEFAULT 0,
                max_tickets INTEGER DEFAULT NULL,
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

        const alterQueries = [
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS is_main BOOLEAN DEFAULT true;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS parent_id TEXT DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_end DATE DEFAULT (CURRENT_DATE + INTERVAL '1 month');`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS address VARCHAR(255) DEFAULT '';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT NULL;`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS specialty VARCHAR(255) DEFAULT 'طب عام';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS max_daily_tickets INTEGER DEFAULT 0;`,
            `ALTER TABLE queues ADD COLUMN IF NOT EXISTS max_tickets INTEGER DEFAULT NULL;`
        ];
        for (let q of alterQueries) {
            try { await db.query(q); } catch (e) {}
        }

        console.log("🚀 قاعدة البيانات مهيأة بالكامل وجاهزة!");
    } catch (e) {
        console.error("❌ خطأ في تهيئة قاعدة البيانات:", e.message);
    }
};
initDB();

app.get('/api/doctor/auth-status/:slug', async (req, res) => {
    try {
        const clinic = await db.query(`
            SELECT c.password, c.specialty, c.phone, c.email, c.address, c.max_daily_tickets,
                   p.phone as parent_phone, p.email as parent_email, p.address as parent_address
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
        const row = clinic.rows[0];
        res.json({
            hasPassword: Boolean(row.password && row.password.length > 0),
            specialty: row.specialty || 'طب عام',
            doctor_phone: row.phone || row.parent_phone || '',
            doctor_email: row.email || row.parent_email || '',
            clinic_address: row.address || row.parent_address || '',
            max_daily_tickets: parseInt(row.max_daily_tickets || 0)
        });
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

// إدارة أيام الغياب الشخصية للطبيب
app.get('/api/doctor/off-days/:slug', async (req, res) => {
    try {
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [req.params.slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const offRes = await db.query('SELECT off_date::text FROM doctor_off_days WHERE clinic_id = $1 ORDER BY off_date ASC', [clinic.rows[0].id]);
        res.json(offRes.rows.map(r => r.off_date));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/doctor/toggle-off-day', async (req, res) => {
    try {
        const { clinic_slug, off_date } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const clinicId = clinic.rows[0].id;

        const d = new Date(off_date);
        if (d.getDay() === 5) {
            return res.status(400).json({ error: 'يوم الجمعة عطلة رسمية أساسية ولا يحتاج لتسجيله يدوياً.' });
        }

        const existing = await db.query('SELECT id FROM doctor_off_days WHERE clinic_id = $1 AND off_date = $2::date', [clinicId, off_date]);
        if (existing.rows.length > 0) {
            await db.query('DELETE FROM doctor_off_days WHERE id = $1', [existing.rows[0].id]);
            res.json({ status: 'removed', message: '✔️ تم إلغاء عطلة الغياب وإعادة تفعيل العمل في هذا التاريخ' });
        } else {
            await db.query('INSERT INTO doctor_off_days (clinic_id, off_date) VALUES ($1, $2::date)', [clinicId, off_date]);
            res.json({ status: 'added', message: '✔️ تم تسجيل هذا التاريخ كعطلة للطبيب' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function isDayOff(clinicId, dateStr) {
    const d = new Date(dateStr);
    if (d.getDay() === 5) return true; // الجمعة عطلة تلقائية لكل الأطباء والعيادات
    const checkOff = await db.query('SELECT id FROM doctor_off_days WHERE clinic_id = $1 AND off_date = $2::date', [clinicId, dateStr]);
    return checkOff.rows.length > 0;
}

app.post('/api/queue/set-max-tickets', async (req, res) => {
    try {
        const { clinic_slug, max_tickets, apply_to_all_week, booking_date } = req.body;
        const parsedLimit = Math.max(0, parseInt(max_tickets) || 0);

        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const clinicId = clinic.rows[0].id;

        if (apply_to_all_week) {
            await db.query('UPDATE clinics SET max_daily_tickets = $1 WHERE id = $2', [parsedLimit, clinicId]);
            await db.query('UPDATE queues SET max_tickets = $1 WHERE clinic_id = $2 AND queue_date >= CURRENT_DATE', [parsedLimit > 0 ? parsedLimit : null, clinicId]);
        } else {
            const dateRes = booking_date
                ? await db.query('SELECT ($1::date)::text as d', [booking_date])
                : await db.query('SELECT CURRENT_DATE::text as d');
            const targetDate = dateRes.rows[0].d;

            const q = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinicId, targetDate]);
            if (q.rows.length === 0) {
                await db.query(
                    'INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number, max_tickets) VALUES ($1, $2::date, \'active\', 0, 0, $3)',
                    [clinicId, targetDate, parsedLimit]
                );
            } else {
                await db.query('UPDATE queues SET max_tickets = $1 WHERE id = $2', [parsedLimit, q.rows[0].id]);
            }
        }

        io.emit('queue_status_changed', { clinic_slug, max_tickets: parsedLimit });
        res.json({ message: 'تم تحديث الحد الأقصى للتذاكر بنجاح', max_tickets: parsedLimit });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إصلاح مشكلة ظهور الأطباء في الدليل الجماعي
app.get('/api/directory/doctors', async (req, res) => {
    try {
        const clinicsRes = await db.query(`
            SELECT c.id, c.name, c.slug, c.specialty, c.phone, c.email, c.address, c.is_main, c.parent_id, c.subscription_end, c.max_daily_tickets,
                   p.name as parent_clinic_name, p.subscription_end as parent_sub,
                   p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   COALESCE(q.current_number, 0) as current_number,
                   COALESCE(q.last_issued_number, 0) as last_issued_number,
                   COALESCE(q.status, 'active') as status,
                   q.max_tickets as queue_max_tickets
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

            const effectiveMax = (row.queue_max_tickets !== null && row.queue_max_tickets !== undefined)
                ? parseInt(row.queue_max_tickets)
                : parseInt(row.max_daily_tickets || 0);
            const lastIssued = parseInt(row.last_issued_number || 0);

            const todayStr = today.toISOString().slice(0, 10);
            const isTodayOff = await isDayOff(row.id, todayStr);

            directoryList.push({
                id: row.id,
                name: row.name,
                slug: row.slug,
                specialty: row.specialty || 'طب عام',
                phone: row.phone || row.parent_phone || '',
                email: row.email || row.parent_email || '',
                address: row.address || row.parent_address || '',
                clinic_name: row.parent_clinic_name || row.name,
                current_number: parseInt(row.current_number || 0),
                next_ticket_today: lastIssued + 1,
                max_tickets: effectiveMax,
                is_full: isTodayOff || (effectiveMax > 0 && lastIssued >= effectiveMax),
                is_off_day: isTodayOff,
                status: isTodayOff ? 'paused' : row.status
            });
        }

        res.json(directoryList);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/directory/preview/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query('SELECT id, name, specialty, max_daily_tickets FROM clinics WHERE slug = $1', [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const cRow = clinic.rows[0];

        const targetDateRes = date
            ? await db.query('SELECT ($1::date)::text as d', [date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = targetDateRes.rows[0].d;

        const dayIsOff = await isDayOff(cRow.id, targetDate);
        if (dayIsOff) {
            return res.json({
                current_number: 0,
                prospective_number: 0,
                status: 'paused',
                is_off_day: true,
                is_full: true,
                doctor_name: cRow.name,
                specialty: cRow.specialty || 'طب عام'
            });
        }

        const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [cRow.id, targetDate]);
        const defaultMax = parseInt(cRow.max_daily_tickets || 0);

        if (q.rows.length === 0) {
            return res.json({
                current_number: 0,
                prospective_number: 1,
                status: 'active',
                is_off_day: false,
                max_tickets: defaultMax,
                active_booked_count: 0,
                is_full: false,
                doctor_name: cRow.name,
                specialty: cRow.specialty || 'طب عام'
            });
        }

        const qRow = q.rows[0];
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined) ? parseInt(qRow.max_tickets) : defaultMax;
        const activeRes = await db.query('SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != \'cancelled\'', [qRow.id]);
        const activeCount = parseInt(activeRes.rows[0].count || 0);

        res.json({
            current_number: qRow.current_number,
            prospective_number: qRow.last_issued_number + 1,
            status: qRow.status,
            is_off_day: false,
            max_tickets: effectiveMax,
            active_booked_count: activeCount,
            is_full: effectiveMax > 0 && activeCount >= effectiveMax,
            doctor_name: cRow.name,
            specialty: cRow.specialty || 'طب عام'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reception/tickets/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.max_daily_tickets, p.name as parent_clinic_name
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const row = clinic.rows[0];
        const defaultMax = parseInt(row.max_daily_tickets || 0);

        const targetDateRes = date
            ? await db.query('SELECT ($1::date)::text as d', [date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = targetDateRes.rows[0].d;

        const dayIsOff = await isDayOff(row.id, targetDate);

        const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [row.id, targetDate]);
        if (q.rows.length === 0) {
            return res.json({
                queue_date: targetDate,
                doctor_name: row.name,
                clinic_name: row.parent_clinic_name || row.name,
                specialty: row.specialty || 'طب عام',
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                max_tickets: defaultMax,
                is_off_day: dayIsOff,
                is_full: dayIsOff,
                status: dayIsOff ? 'paused' : 'active',
                tickets: []
            });
        }

        const qRow = q.rows[0];
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined) ? parseInt(qRow.max_tickets) : defaultMax;
        const ticketsRes = await db.query('SELECT id, patient_name, ticket_number, status, created_at FROM tickets WHERE queue_id = $1 ORDER BY ticket_number ASC', [qRow.id]);

        const currentNum = qRow.current_number;
        const activeTicketsCount = ticketsRes.rows.filter(t => t.status !== 'cancelled').length;
        const waitingCount = ticketsRes.rows.filter(t => t.ticket_number > currentNum && t.status !== 'cancelled').length;

        res.json({
            queue_date: targetDate,
            doctor_name: row.name,
            clinic_name: row.parent_clinic_name || row.name,
            specialty: row.specialty || 'طب عام',
            current_number: currentNum,
            last_issued_number: qRow.last_issued_number,
            waiting_count: waitingCount,
            active_tickets_count: activeTicketsCount,
            max_tickets: effectiveMax,
            is_off_day: dayIsOff,
            is_full: dayIsOff || (effectiveMax > 0 && activeTicketsCount >= effectiveMax),
            status: dayIsOff ? 'paused' : qRow.status,
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
            io.emit('queue_status_changed', { clinic_slug, status: 'paused' });
            return res.json({ status: 'paused' });
        }

        const newStatus = queue.rows[0].status === 'paused' ? 'active' : 'paused';
        await db.query('UPDATE queues SET status = $1 WHERE id = $2', [newStatus, queue.rows[0].id]);
        io.emit('queue_status_changed', { clinic_slug, status: newStatus });
        res.json({ status: newStatus });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clinics', async (req, res) => {
    try {
        const { name, slug, phone, email, address, specialty } = req.body;
        const result = await db.query(
            `INSERT INTO clinics (name, slug, is_main, subscription_end, phone, email, address, specialty) VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month', $3, $4, $5, $6) RETURNING *`,
            [name, slug, phone || '', email || '', address || '', specialty || 'عيادة طبية']
        );
        res.status(201).json({ message: 'تم', clinic: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'الرابط مستخدم مسبقاً.' }); }
});

app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name, booking_date } = req.body;
        const clinic = await db.query(`SELECT id, name, is_main, subscription_end as doc_sub, parent_id, max_daily_tickets FROM clinics WHERE slug = $1`, [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const cRow = clinic.rows[0];

        let targetDateQuery = await db.query(`SELECT CURRENT_DATE::text as target_date`);
        if (booking_date) {
            targetDateQuery = await db.query('SELECT ($1::date)::text as target_date', [booking_date]);
        }
        const targetDate = targetDateQuery.rows[0].target_date;

        const dayIsOff = await isDayOff(cRow.id, targetDate);
        if (dayIsOff) {
            return res.status(400).json({ error: 'نعتذر، هذا اليوم عطلة رسمية (يوم الجمعة) أو إجازة معلنة من طرف الطبيب ولا يمكن الحجز فيه.' });
        }

        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [cRow.id, targetDate]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, $2::date, 'active', 0, 0) RETURNING *`, [cRow.id, targetDate]);
        }

        const qRow = queue.rows[0];
        if (qRow.status === 'paused') return res.status(400).json({ error: 'استقبال التذاكر متوقف مؤقتاً لهذا اليوم.' });

        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined) ? parseInt(qRow.max_tickets) : parseInt(cRow.max_daily_tickets || 0);
        if (effectiveMax > 0) {
            const activeCountRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
            if (parseInt(activeCountRes.rows[0].count || 0) >= effectiveMax) {
                return res.status(400).json({ error: `نعتذر، اكتمل العدد الأقصى للتذاكر لهذا اليوم (${effectiveMax} تذكرة).` });
            }
        }

        const newNumber = qRow.last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, qRow.id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [qRow.id, patient_name || 'مريض', newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber, booking_date: targetDate });
        res.status(201).json({ message: `رقمك هو: ${newNumber}`, ticket_number: newNumber, booking_date: targetDate });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
            SELECT c.id, c.name, c.specialty, c.phone, c.email, c.address, c.is_main, c.parent_id, c.max_daily_tickets,
                   p.name as parent_clinic_name, p.phone as parent_phone, p.email as parent_email, p.address as parent_address
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted', message: 'هذا الرابط غير صالح أو تم حذف الطبيب' });
        
        const row = clinic.rows[0];
        const mainClinicName = row.parent_clinic_name || row.name;
        const docPhone = row.phone || row.parent_phone || '';
        const docEmail = row.email || row.parent_email || '';
        const docAddress = row.address || row.parent_address || '';
        const defaultMax = parseInt(row.max_daily_tickets || 0);

        const todayStr = new Date().toISOString().slice(0, 10);
        const dayIsOff = await isDayOff(row.id, todayStr);

        let queue = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [row.id]);
        if (queue.rows.length === 0) {
            return res.json({
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                ahead_count: 0,
                my_ticket_status: 'waiting',
                status: dayIsOff ? 'paused' : 'active',
                max_tickets: defaultMax,
                is_full: dayIsOff,
                is_off_day: dayIsOff,
                doctor_name: row.name,
                clinic_name: mainClinicName,
                specialty: row.specialty || 'طب عام',
                doctor_phone: docPhone,
                doctor_email: docEmail,
                clinic_address: docAddress
            });
        }

        const qRow = queue.rows[0];
        const qId = qRow.id;
        const currentNum = qRow.current_number;
        const lastIssued = qRow.last_issued_number;
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined) ? parseInt(qRow.max_tickets) : defaultMax;

        let currentPatientName = '';
        let currentTicketStatus = 'waiting';
        if (currentNum > 0) {
            const t = await db.query('SELECT patient_name, status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [qId, currentNum]);
            if (t.rows.length > 0) {
                currentPatientName = t.rows[0].patient_name;
                currentTicketStatus = t.rows[0].status;
            }
        }

        const activeTicketsRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qId]);
        const activeTicketsCount = parseInt(activeTicketsRes.rows[0].count || 0);

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
            active_tickets_count: activeTicketsCount,
            ahead_count: aheadCount,
            my_ticket_status: myTicketStatus,
            status: dayIsOff ? 'paused' : qRow.status,
            max_tickets: effectiveMax,
            is_full: dayIsOff || (effectiveMax > 0 && activeTicketsCount >= effectiveMax),
            is_off_day: dayIsOff,
            current_patient_name: currentPatientName,
            current_ticket_status: currentTicketStatus,
            doctor_name: row.name,
            clinic_name: mainClinicName,
            specialty: row.specialty || 'طب عام',
            doctor_phone: docPhone,
            doctor_email: docEmail,
            clinic_address: docAddress
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
            SELECT c.id, c.name, c.slug, c.specialty, c.address, c.is_main, c.parent_id, c.max_daily_tickets,
                   p.name as parent_clinic_name, p.address as parent_address
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.main_slug]);

        if (main.rows.length === 0) return res.json([]);

        const mainRow = main.rows[0];
        const clinicTitle = mainRow.parent_clinic_name || mainRow.name;
        const clinicAddress = mainRow.address || mainRow.parent_address || '';

        let docList = [];
        if (mainRow.is_main) {
            const doctors = await db.query('SELECT id, name, slug, specialty, address, max_daily_tickets FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.id]);
            docList = doctors.rows;
        } else {
            const siblingDocs = await db.query('SELECT id, name, slug, specialty, address, max_daily_tickets FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.parent_id]);
            docList = siblingDocs.rows.length > 0 ? siblingDocs.rows : [mainRow];
        }
        
        const todayStr = new Date().toISOString().slice(0, 10);
        let result = [];
        for (let doc of docList) {
            const defaultMax = parseInt(doc.max_daily_tickets || 0);
            const isTodayOff = await isDayOff(doc.id, todayStr);

            const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if (q.rows.length > 0) {
                const qRow = q.rows[0];
                const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined) ? parseInt(qRow.max_tickets) : defaultMax;
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [qRow.id, qRow.current_number]);
                const activeRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
                const activeCount = parseInt(activeRes.rows[0].count || 0);

                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    address: doc.address || clinicAddress,
                    current: qRow.current_number,
                    last_issued: qRow.last_issued_number,
                    waiting: parseInt(waitRes.rows[0].count || 0),
                    max_tickets: effectiveMax,
                    is_full: isTodayOff || (effectiveMax > 0 && activeCount >= effectiveMax),
                    is_off_day: isTodayOff,
                    status: isTodayOff ? 'paused' : qRow.status
                });
            } else {
                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    address: doc.address || clinicAddress,
                    current: 0,
                    last_issued: 0,
                    waiting: 0,
                    max_tickets: defaultMax,
                    is_full: isTodayOff,
                    is_off_day: isTodayOff,
                    status: isTodayOff ? 'paused' : 'active'
                });
            }
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clinics', async (req, res) => {
    try {
        const allRes = await db.query(`SELECT id, name, slug, subscription_end, phone, email, address, specialty, is_main, parent_id, max_daily_tickets, created_at FROM clinics ORDER BY created_at DESC`);
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
        const { parent_id, name, slug, phone, email, address, specialty } = req.body;
        let finalAddress = address || '';
        let finalPhone = phone || '';
        let finalEmail = email || '';

        if (parent_id) {
            const parentRes = await db.query('SELECT phone, email, address FROM clinics WHERE id::text = $1::text', [parent_id]);
            if (parentRes.rows.length > 0) {
                if (!finalAddress) finalAddress = parentRes.rows[0].address || '';
                if (!finalPhone) finalPhone = parentRes.rows[0].phone || '';
                if (!finalEmail) finalEmail = parentRes.rows[0].email || '';
            }
        }

        await db.query(
            'INSERT INTO clinics (name, slug, is_main, parent_id, phone, email, address, specialty) VALUES ($1, $2, false, $3, $4, $5, $6, $7)',
            [name, slug, parent_id, finalPhone, finalEmail, finalAddress, specialty || 'طب عام']
        );
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
        const docs = await db.query('SELECT id, name, slug, phone, email, address, specialty FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [req.params.main_id]);
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