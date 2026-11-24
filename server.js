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

// أيقونة سماعة الطبيب لتطبيقات سطح المكتب
app.get('/icons/stethoscope.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#10b981"/>
          <stop offset="100%" stop-color="#047857"/>
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#bgGrad)"/>
      <g fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
        <path d="M150 105 h-22 a14 14 0 0 0 -14 14 v75 c0 66 52 118 116 118 s116 -52 116 -118 v-75 a14 14 0 0 0 -14 -14 h-22"/>
        <path d="M230 312 v44 c0 44 36 80 80 80 s80 -36 80 -80 v-74"/>
      </g>
      <circle cx="155" cy="105" r="14" fill="#ffffff"/>
      <circle cx="305" cy="105" r="14" fill="#ffffff"/>
      <circle cx="390" cy="260" r="38" fill="#ffffff"/>
      <circle cx="390" cy="260" r="18" fill="#059669"/>
    </svg>`);
});

// تعريف مستقل لتطبيق الاستقبال (يسمح بتثبيته بجانب تطبيق الطبيب بدون ملف .bat)
app.get('/manifest/reception.json', (req, res) => {
    const clinic = req.query.clinic || 'default-clinic';
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
        id: `/reception-app-${clinic}`,
        name: `ClinicFlow - الاستقبال (${clinic})`,
        short_name: 'الاستقبال',
        start_url: `/reception.html?clinic=${encodeURIComponent(clinic)}`,
        scope: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#10b981',
        icons: [
            { src: '/icons/stethoscope.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icons/stethoscope.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
        ]
    });
});

// تعريف مستقل لتطبيق الطبيب
app.get('/manifest/doctor.json', (req, res) => {
    const clinic = req.query.clinic || 'default-clinic';
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
        id: `/doctor-app-${clinic}`,
        name: `ClinicFlow - الطبيب (${clinic})`,
        short_name: 'لوحة الطبيب',
        start_url: `/doctor.html?clinic=${encodeURIComponent(clinic)}`,
        scope: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#10b981',
        icons: [
            { src: '/icons/stethoscope.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icons/stethoscope.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
        ]
    });
});

// مسار فحص حالة السيرفر وقاعدة البيانات
app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, db: 'connected', uptime_seconds: Math.floor(process.uptime()) });
    } catch (err) {
        res.status(500).json({ ok: false, db: 'error', error: err.message });
    }
});

const initDB = async (retries = 3) => {
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
                max_daily_tickets INTEGER DEFAULT 0,
                open_time VARCHAR(10) DEFAULT '08:00',
                close_time VARCHAR(10) DEFAULT '16:00'
            );
            CREATE TABLE IF NOT EXISTS queues (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
                queue_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                current_number INTEGER DEFAULT 0,
                last_issued_number INTEGER DEFAULT 0,
                max_tickets INTEGER DEFAULT NULL,
                doctor_present BOOLEAN DEFAULT false,
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
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS open_time VARCHAR(10) DEFAULT '08:00';`,
            `ALTER TABLE clinics ADD COLUMN IF NOT EXISTS close_time VARCHAR(10) DEFAULT '16:00';`,
            `ALTER TABLE queues ADD COLUMN IF NOT EXISTS max_tickets INTEGER DEFAULT NULL;`,
            `ALTER TABLE queues ADD COLUMN IF NOT EXISTS doctor_present BOOLEAN DEFAULT false;`
        ];
        for (let q of alterQueries) {
            try { await db.query(q); } catch (e) {}
        }

        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_slug ON clinics(slug);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_parent ON clinics(parent_id);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_queues_clinic_date ON queues(clinic_id, queue_date);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_records_slug ON patient_records(clinic_slug);`);

        console.log("🚀 قاعدة البيانات جاهزة ومُسرّعة بالكامل!");
    } catch (e) {
        console.error("❌ خطأ في تهيئة قاعدة البيانات:", e.message);
        if (retries > 0) {
            console.log(`🔄 إعادة محاولة الاتصال بقاعدة البيانات بعد 5 ثوانٍ... (المتبقي: ${retries})`);
            setTimeout(() => initDB(retries - 1), 5000);
        }
    }
};
initDB();

app.get('/api/doctor/auth-status/:slug', async (req, res) => {
    try {
        const clinic = await db.query(`
            SELECT c.password, c.specialty, c.phone, c.email, c.address, c.max_daily_tickets,
                   c.open_time, c.close_time,
                   p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
        const row = clinic.rows[0];
        const hasPassword = Boolean(row.password && row.password.length > 0);
        res.json({
            hasPassword,
            specialty: row.specialty || 'طب عام',
            doctor_phone: row.phone || row.parent_phone || '',
            doctor_email: row.email || row.parent_email || '',
            clinic_address: row.address || row.parent_address || '',
            max_daily_tickets: parseInt(row.max_daily_tickets || 0),
            open_time: row.open_time || row.parent_open_time || '08:00',
            close_time: row.close_time || row.parent_close_time || '16:00'
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

app.post('/api/doctor/set-specialty', async (req, res) => {
    try {
        const { clinic_slug, specialty } = req.body;
        await db.query('UPDATE clinics SET specialty = $1 WHERE slug = $2', [specialty || 'طب عام', clinic_slug]);
        res.json({ message: 'تم تحديث الاختصاص الطبي بنجاح' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تعديل أوقات فتح وغلق العيادة
app.post('/api/clinic/set-hours', async (req, res) => {
    try {
        const { clinic_slug, open_time, close_time } = req.body;
        if (!open_time || !close_time) {
            return res.status(400).json({ error: 'يرجى تحديد وقت الفتح ووقت الغلق' });
        }

        const clinicRes = await db.query('SELECT id, is_main, parent_id FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinicRes.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة' });

        const row = clinicRes.rows[0];
        const mainId = (!row.is_main && row.parent_id) ? row.parent_id : row.id;

        await db.query(
            'UPDATE clinics SET open_time = $1, close_time = $2 WHERE id::text = $3::text OR parent_id::text = $3::text',
            [open_time, close_time, String(mainId)]
        );

        io.emit('clinic_hours_changed', { clinic_slug, open_time, close_time });
        res.json({
            message: `تم حفظ أوقات عمل العيادة (${open_time} - ${close_time}) بنجاح`,
            open_time,
            close_time
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تبديل حالة حضور الطبيب اليوم (تقوم بها الممرضة وتظهر فوراً عند المرضى)
app.post('/api/doctor/toggle-presence', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const clinicId = clinic.rows[0].id;
        const docName = clinic.rows[0].name;

        let queue = await db.query('SELECT id, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinicId]);
        let newPresence = true;

        if (queue.rows.length === 0) {
            await db.query(
                `INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number, doctor_present) VALUES ($1, CURRENT_DATE, 'active', 0, 0, true)`,
                [clinicId]
            );
            newPresence = true;
        } else {
            newPresence = !Boolean(queue.rows[0].doctor_present);
            await db.query('UPDATE queues SET doctor_present = $1 WHERE id = $2', [newPresence, queue.rows[0].id]);
        }

        io.emit('doctor_presence_changed', { clinic_slug, doctor_present: newPresence });
        res.json({
            doctor_present: newPresence,
            message: newPresence
                ? `🟢 تم تأكيد حضور (${docName}) في العيادة الآن`
                : `🟠 تم تحديث حالة (${docName}): لم يحضر بعد`
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تحديد العدد الأقصى للتذاكر طوال الأسبوع أو ليوم محدد
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
        res.json({
            message: apply_to_all_week
                ? (parsedLimit > 0 ? `تم تحديد العدد الأقصى بـ ${parsedLimit} تذكرة يومياً طوال الأسبوع` : 'تم فتح العدد الأقصى للتذاكر (غير محدود) طوال الأسبوع')
                : (parsedLimit > 0 ? `تم تحديد العدد الأقصى لهذا اليوم بـ ${parsedLimit} تذكرة` : 'تم جعل عدد التذاكر لهذا اليوم غير محدود'),
            max_tickets: parsedLimit
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// عرض الأطباء في الدليل الجماعي مع أوقات العمل وحالة حضور الطبيب
app.get('/api/directory/doctors', async (req, res) => {
    try {
        const clinicsRes = await db.query(`
            SELECT c.id, c.name, c.slug, c.specialty, c.phone, c.email, c.address, c.is_main, c.parent_id, c.subscription_end, c.max_daily_tickets,
                   c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.subscription_end as parent_sub,
                   p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time,
                   COALESCE(q.current_number, 0) as current_number,
                   COALESCE(q.last_issued_number, 0) as last_issued_number,
                   COALESCE(q.status, 'active') as status,
                   COALESCE(q.doctor_present, false) as doctor_present,
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

            directoryList.push({
                id: row.id,
                name: row.name,
                slug: row.slug,
                specialty: row.specialty || 'طب عام',
                phone: row.phone || row.parent_phone || '',
                email: row.email || row.parent_email || '',
                address: row.address || row.parent_address || '',
                clinic_name: row.parent_clinic_name || row.name,
                open_time: row.open_time || row.parent_open_time || '08:00',
                close_time: row.close_time || row.parent_close_time || '16:00',
                doctor_present: Boolean(row.doctor_present),
                current_number: parseInt(row.current_number || 0),
                next_ticket_today: lastIssued + 1,
                max_tickets: effectiveMax,
                is_full: effectiveMax > 0 && lastIssued >= effectiveMax,
                status: row.status
            });
        }

        res.json(directoryList);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// معاينة الطابور والرقم المتوقع مع حظر يوم الجمعة
app.get('/api/directory/preview/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.max_daily_tickets, c.open_time, c.close_time,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });

        const cRow = clinic.rows[0];
        const defaultMax = parseInt(cRow.max_daily_tickets || 0);
        const openTime = cRow.open_time || cRow.parent_open_time || '08:00';
        const closeTime = cRow.close_time || cRow.parent_close_time || '16:00';

        const todayPresenceRes = await db.query('SELECT doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [cRow.id]);
        const doctorPresentToday = todayPresenceRes.rows.length > 0 ? Boolean(todayPresenceRes.rows[0].doctor_present) : false;

        const targetDateRes = date
            ? await db.query('SELECT ($1::date) as d, EXTRACT(DOW FROM $1::date) as dow, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL \'7 days\')::date as max_d', [date])
            : await db.query('SELECT CURRENT_DATE as d, EXTRACT(DOW FROM CURRENT_DATE) as dow, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL \'7 days\')::date as max_d');

        const { d, dow, today, max_d } = targetDateRes.rows[0];
        if (new Date(d) < new Date(today) || new Date(d) > new Date(max_d)) {
            return res.status(400).json({ error: 'يمكن الحجز فقط خلال أسبوع كامل (7 أيام كحد أقصى)' });
        }

        if (parseInt(dow) === 5) {
            return res.json({
                current_number: 0,
                prospective_number: 0,
                status: 'friday_off',
                doctor_name: cRow.name,
                specialty: cRow.specialty || 'طب عام',
                open_time: openTime,
                close_time: closeTime,
                doctor_present: doctorPresentToday,
                max_tickets: defaultMax,
                is_full: true
            });
        }

        const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [cRow.id, d]);
        if (q.rows.length === 0) {
            return res.json({
                current_number: 0,
                prospective_number: 1,
                status: 'active',
                doctor_name: cRow.name,
                specialty: cRow.specialty || 'طب عام',
                open_time: openTime,
                close_time: closeTime,
                doctor_present: doctorPresentToday,
                max_tickets: defaultMax,
                is_full: false
            });
        }

        const qRow = q.rows[0];
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
            ? parseInt(qRow.max_tickets)
            : defaultMax;

        const activeTicketsRes = await db.query('SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != \'cancelled\'', [qRow.id]);
        const activeCount = parseInt(activeTicketsRes.rows[0].count || 0);
        const isFull = effectiveMax > 0 && activeCount >= effectiveMax;

        res.json({
            current_number: qRow.current_number,
            prospective_number: qRow.last_issued_number + 1,
            status: qRow.status,
            doctor_name: cRow.name,
            specialty: cRow.specialty || 'طب عام',
            open_time: openTime,
            close_time: closeTime,
            doctor_present: doctorPresentToday,
            max_tickets: effectiveMax,
            active_booked_count: activeCount,
            is_full: isFull
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// جلب لائحة المرضى المسجلين لأي يوم من أيام الأسبوع مع أوقات العمل وحالة حضور الطبيب اليوم
app.get('/api/reception/tickets/:clinic_slug', async (req, res) => {
    try {
        const { date } = req.query;
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.max_daily_tickets, c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.clinic_slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const row = clinic.rows[0];
        const defaultMax = parseInt(row.max_daily_tickets || 0);
        const openTime = row.open_time || row.parent_open_time || '08:00';
        const closeTime = row.close_time || row.parent_close_time || '16:00';

        const todayPresenceRes = await db.query('SELECT doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [row.id]);
        const doctorPresentToday = todayPresenceRes.rows.length > 0 ? Boolean(todayPresenceRes.rows[0].doctor_present) : false;

        const targetDateRes = date
            ? await db.query('SELECT ($1::date)::text as d', [date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = targetDateRes.rows[0].d;

        const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [row.id, targetDate]);
        if (q.rows.length === 0) {
            return res.json({
                queue_date: targetDate,
                doctor_name: row.name,
                clinic_name: row.parent_clinic_name || row.name,
                specialty: row.specialty || 'طب عام',
                open_time: openTime,
                close_time: closeTime,
                doctor_present: doctorPresentToday,
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                max_tickets: defaultMax,
                max_daily_tickets: defaultMax,
                is_full: false,
                status: 'active',
                tickets: []
            });
        }

        const qRow = q.rows[0];
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
            ? parseInt(qRow.max_tickets)
            : defaultMax;

        const ticketsRes = await db.query(
            'SELECT id, patient_name, ticket_number, status, created_at FROM tickets WHERE queue_id = $1 ORDER BY ticket_number ASC',
            [qRow.id]
        );

        const currentNum = qRow.current_number;
        const activeTicketsCount = ticketsRes.rows.filter(t => t.status !== 'cancelled').length;
        const waitingCount = ticketsRes.rows.filter(t => t.ticket_number > currentNum && t.status !== 'cancelled').length;

        res.json({
            queue_date: targetDate,
            doctor_name: row.name,
            clinic_name: row.parent_clinic_name || row.name,
            specialty: row.specialty || 'طب عام',
            open_time: openTime,
            close_time: closeTime,
            doctor_present: doctorPresentToday,
            current_number: currentNum,
            last_issued_number: qRow.last_issued_number,
            waiting_count: waitingCount,
            active_tickets_count: activeTicketsCount,
            max_tickets: effectiveMax,
            max_daily_tickets: defaultMax,
            is_full: effectiveMax > 0 && activeTicketsCount >= effectiveMax,
            status: qRow.status,
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
        const { name, slug, phone, email, address, specialty, open_time, close_time } = req.body;
        const result = await db.query(
            `INSERT INTO clinics (name, slug, is_main, subscription_end, phone, email, address, specialty, open_time, close_time) VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month', $3, $4, $5, $6, $7, $8) RETURNING *`,
            [name, slug, phone || '', email || '', address || '', specialty || 'عيادة طبية', open_time || '08:00', close_time || '16:00']
        );
        res.status(201).json({ message: 'تم', clinic: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'الرابط مستخدم مسبقاً.' }); }
});

// إصدار التذاكر مع منع الحجز يوم الجمعة والتحقق من العدد الأقصى
app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name, booking_date } = req.body;
        const clinic = await db.query(`SELECT id, name, is_main, subscription_end as doc_sub, parent_id, max_daily_tickets FROM clinics WHERE slug = $1`, [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الرابط غير صحيح أو تم حذف الطبيب' });

        const cRow = clinic.rows[0];
        let subEnd = cRow.doc_sub;
        if (!cRow.is_main && cRow.parent_id) {
            const parentRes = await db.query(`SELECT subscription_end FROM clinics WHERE id::text = $1::text`, [cRow.parent_id]);
            if (parentRes.rows.length > 0) subEnd = parentRes.rows[0].subscription_end;
        }
        if (subEnd && new Date(subEnd) < new Date(new Date().setHours(0, 0, 0, 0))) {
            return res.status(403).json({ error: 'اشتراك العيادة منتهي.' });
        }

        let targetDateQuery = await db.query(`SELECT CURRENT_DATE::text as target_date, EXTRACT(DOW FROM CURRENT_DATE) as dow`);
        if (booking_date) {
            const checkDate = await db.query(`
                SELECT ($1::date >= CURRENT_DATE AND $1::date <= (CURRENT_DATE + INTERVAL '7 days')::date) as is_valid,
                       ($1::date)::text as target_date,
                       EXTRACT(DOW FROM $1::date) as dow
            `, [booking_date]);
            if (!checkDate.rows[0].is_valid) {
                return res.status(400).json({ error: 'يمكن التسجيل والحجز في حدود أسبوع كامل (7 أيام) كحد أقصى.' });
            }
            targetDateQuery = checkDate;
        }
        const targetDate = targetDateQuery.rows[0].target_date;
        const targetDow = parseInt(targetDateQuery.rows[0].dow);

        if (targetDow === 5) {
            return res.status(400).json({ error: 'يوم الجمعة عطلة أسبوعية، لا يوجد عمل أو حجوزات يوم الجمعة.' });
        }

        const clinicId = cRow.id;
        let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinicId, targetDate]);
        if (queue.rows.length === 0) {
            queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, $2::date, 'active', 0, 0) RETURNING *`, [clinicId, targetDate]);
        }

        const qRow = queue.rows[0];
        if (qRow.status === 'paused') return res.status(400).json({ error: 'استقبال التذاكر متوقف مؤقتاً لهذا اليوم.' });

        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
            ? parseInt(qRow.max_tickets)
            : parseInt(cRow.max_daily_tickets || 0);

        if (effectiveMax > 0) {
            const activeCountRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
            const activeCount = parseInt(activeCountRes.rows[0].count || 0);
            if (activeCount >= effectiveMax) {
                return res.status(400).json({ error: `نعتذر، اكتمل العدد الأقصى للتذاكر المسموح به لهذا اليوم (${effectiveMax} تذكرة).` });
            }
        }

        const newNumber = qRow.last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, qRow.id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [qRow.id, patient_name || 'مريض', newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber, patient_name: patient_name || 'مريض', booking_date: targetDate });
        res.status(201).json({ message: `رقمك هو: ${newNumber}`, ticket_number: newNumber, booking_date: targetDate, doctor_name: cRow.name });
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

// مصحّح: تأكيد حضور الطبيب تلقائياً عند بدء مناداة المرضى
app.post('/api/call-next', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [clinic_slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة.' });

        let queue = await db.query('SELECT id, current_number, last_issued_number, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        if (queue.rows.length === 0 || queue.rows[0].current_number >= queue.rows[0].last_issued_number) {
            return res.status(400).json({ error: 'لا يوجد مرضى في الانتظار.' });
        }

        const wasPresent = Boolean(queue.rows[0].doctor_present);
        const newCurrent = queue.rows[0].current_number + 1;
        await db.query('UPDATE queues SET current_number = $1, doctor_present = true WHERE id = $2', [newCurrent, queue.rows[0].id]);

        const ticket = await db.query('SELECT patient_name, status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [queue.rows[0].id, newCurrent]);
        const patientName = ticket.rows.length > 0 ? ticket.rows[0].patient_name : `مريض رقم ${newCurrent}`;
        const ticketStatus = ticket.rows.length > 0 ? ticket.rows[0].status : 'waiting';

        if (!wasPresent) {
            io.emit('doctor_presence_changed', { clinic_slug, doctor_present: true });
        }
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
                   c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
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
        const openTime = row.open_time || row.parent_open_time || '08:00';
        const closeTime = row.close_time || row.parent_close_time || '16:00';
        const defaultMax = parseInt(row.max_daily_tickets || 0);

        let queue = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [row.id]);
        if (queue.rows.length === 0) {
            return res.json({
                current_number: 0,
                last_issued_number: 0,
                waiting_count: 0,
                ahead_count: 0,
                my_ticket_status: 'waiting',
                status: 'active',
                max_tickets: defaultMax,
                max_daily_tickets: defaultMax,
                is_full: false,
                doctor_present: false,
                open_time: openTime,
                close_time: closeTime,
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
        const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
            ? parseInt(qRow.max_tickets)
            : defaultMax;

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
            status: qRow.status,
            max_tickets: effectiveMax,
            max_daily_tickets: defaultMax,
            is_full: effectiveMax > 0 && activeTicketsCount >= effectiveMax,
            doctor_present: Boolean(qRow.doctor_present),
            open_time: openTime,
            close_time: closeTime,
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
                   c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [req.params.main_slug]);

        if (main.rows.length === 0) return res.json([]);

        const mainRow = main.rows[0];
        const clinicTitle = mainRow.parent_clinic_name || mainRow.name;
        const clinicAddress = mainRow.address || mainRow.parent_address || '';
        const clinicOpenTime = mainRow.open_time || mainRow.parent_open_time || '08:00';
        const clinicCloseTime = mainRow.close_time || mainRow.parent_close_time || '16:00';

        let docList = [];
        if (mainRow.is_main) {
            const doctors = await db.query('SELECT id, name, slug, specialty, address, max_daily_tickets, open_time, close_time FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.id]);
            docList = doctors.rows;
        } else {
            const siblingDocs = await db.query('SELECT id, name, slug, specialty, address, max_daily_tickets, open_time, close_time FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [mainRow.parent_id]);
            docList = siblingDocs.rows.length > 0 ? siblingDocs.rows : [mainRow];
        }
        
        let result = [];
        for (let doc of docList) {
            const defaultMax = parseInt(doc.max_daily_tickets || 0);
            const openTime = doc.open_time || clinicOpenTime;
            const closeTime = doc.close_time || clinicCloseTime;
            const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if (q.rows.length > 0) {
                const qRow = q.rows[0];
                const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
                    ? parseInt(qRow.max_tickets)
                    : defaultMax;
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [qRow.id, qRow.current_number]);
                const activeRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
                const activeCount = parseInt(activeRes.rows[0].count || 0);

                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    address: doc.address || clinicAddress,
                    open_time: openTime,
                    close_time: closeTime,
                    doctor_present: Boolean(qRow.doctor_present),
                    current: qRow.current_number,
                    last_issued: qRow.last_issued_number,
                    waiting: parseInt(waitRes.rows[0].count || 0),
                    max_tickets: effectiveMax,
                    is_full: effectiveMax > 0 && activeCount >= effectiveMax,
                    status: qRow.status
                });
            } else {
                result.push({
                    name: doc.name,
                    slug: doc.slug,
                    specialty: doc.specialty || 'طب عام',
                    clinic_name: clinicTitle,
                    address: doc.address || clinicAddress,
                    open_time: openTime,
                    close_time: closeTime,
                    doctor_present: false,
                    current: 0,
                    last_issued: 0,
                    waiting: 0,
                    max_tickets: defaultMax,
                    is_full: false,
                    status: 'active'
                });
            }
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clinics', async (req, res) => {
    try {
        const allRes = await db.query(`SELECT id, name, slug, subscription_end, phone, email, address, specialty, is_main, parent_id, max_daily_tickets, open_time, close_time, created_at FROM clinics ORDER BY created_at DESC`);
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
        let finalOpen = '08:00';
        let finalClose = '16:00';

        if (parent_id) {
            const parentRes = await db.query('SELECT phone, email, address, open_time, close_time FROM clinics WHERE id::text = $1::text', [parent_id]);
            if (parentRes.rows.length > 0) {
                if (!finalAddress) finalAddress = parentRes.rows[0].address || '';
                if (!finalPhone) finalPhone = parentRes.rows[0].phone || '';
                if (!finalEmail) finalEmail = parentRes.rows[0].email || '';
                if (parentRes.rows[0].open_time) finalOpen = parentRes.rows[0].open_time;
                if (parentRes.rows[0].close_time) finalClose = parentRes.rows[0].close_time;
            }
        }

        await db.query(
            'INSERT INTO clinics (name, slug, is_main, parent_id, phone, email, address, specialty, open_time, close_time) VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9)',
            [name, slug, parent_id, finalPhone, finalEmail, finalAddress, specialty || 'طب عام', finalOpen, finalClose]
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

app.use((err, req, res, next) => {
    console.error('⚠️ Express Error:', err.message);
    res.status(500).json({ error: 'حدث خطأ مؤقت في الخادم، يرجى المحاولة مرة أخرى.' });
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('🛑 Uncaught Exception:', err.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));