require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. تسجيل عيادة
app.post('/api/clinics', async (req, res) => {
    try {
        const { name, slug } = req.body; 
        const result = await db.query('INSERT INTO clinics (name, slug) VALUES ($1, $2) RETURNING *', [name, slug]);
        res.status(201).json({ message: '✅ تم تسجيل العيادة!', clinic: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

// 2. فتح طابور
app.post('/api/queues', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        const queue = await db.query(
            `INSERT INTO queues (clinic_id, queue_date) VALUES ($1, CURRENT_DATE) 
             ON CONFLICT (clinic_id, queue_date) DO UPDATE SET status = 'active' RETURNING *`,
            [clinic.rows[0].id]
        );
        res.status(201).json({ message: '✅ تم فتح الطابور!', queue: queue.rows[0] });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

// 3. سحب تذكرة
app.post('/api/tickets', async (req, res) => {
    try {
        const { clinic_slug, patient_name } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        const queue = await db.query('SELECT id, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        
        const newNumber = queue.rows[0].last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, queue.rows[0].id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [queue.rows[0].id, patient_name, newNumber]);

        io.emit('new_ticket', { clinic_slug, ticket_number: newNumber });
        res.status(201).json({ message: `✅ رقمك هو: ${newNumber}` });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

// 4. مناداة المريض
app.post('/api/call-next', async (req, res) => {
    try {
        const { clinic_slug } = req.body;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        const queue = await db.query('SELECT id, current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        
        if (queue.rows[0].current_number >= queue.rows[0].last_issued_number) return res.status(400).json({ message: '🛑 لا يوجد مرضى' });
        
        const newCurrent = queue.rows[0].current_number + 1;
        await db.query('UPDATE queues SET current_number = $1 WHERE id = $2', [newCurrent, queue.rows[0].id]);

        io.emit('call_patient', { clinic_slug, current_number: newCurrent });
        res.status(200).json({ message: `📢 تفضل بالدخول رقم: ${newCurrent}` });
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

// 5. إنهاء الكشف أو غياب المريض
app.post('/api/tickets/status', async (req, res) => {
    try {
        const { clinic_slug, ticket_number, status } = req.body; 
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        
        await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3', [status, queue.rows[0].id, ticket_number]);
        io.emit('ticket_status_changed', { clinic_slug, ticket_number, status });
        res.status(200).json({ message: `✅ تم تحويل الحالة إلى: ${status}` });
    } catch (err) { res.status(500).json({ error: 'خطأ داخلي' }); }
});

// 6. توليد كود QR
app.get('/api/qr/:clinic_slug', async (req, res) => {
    try {
        const { clinic_slug } = req.params;
        const dateString = new Date().toISOString().split('T')[0];
        const secretString = clinic_slug + dateString + process.env.DB_PASSWORD;
        const secureToken = crypto.createHash('sha256').update(secretString).digest('hex');
        const bookingUrl = `http://localhost:3000/book/${clinic_slug}?token=${secureToken}`;
        const qrImageBase64 = await QRCode.toDataURL(bookingUrl);

        res.status(200).json({ message: '✅ تم توليد كود QR بنجاح!', url: bookingUrl, qr_image: qrImageBase64 });
    } catch (err) { res.status(500).json({ error: 'حدث خطأ أثناء توليد الـ QR' }); }
});

// 7. حالة الطابور المباشرة
app.get('/api/queue-status/:clinic_slug', async (req, res) => {
    try {
        const { clinic_slug } = req.params;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if(clinic.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0 });
        
        const queue = await db.query('SELECT current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
        if(queue.rows.length === 0) return res.json({ current_number: 0, last_issued_number: 0 });
        
        res.json(queue.rows[0]);
    } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

// 8. جلب إحصائيات العيادة (للطبيب)
app.get('/api/stats/:clinic_slug', async (req, res) => {
    try {
        const { clinic_slug } = req.params;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if(clinic.rows.length === 0) return res.json({ today: 0, waiting: 0, week: 0, breakdown: [] });
        
        const clinicId = clinic.rows[0].id;

        const todayStats = await db.query(`
            SELECT 
                COUNT(t.id) as total_today,
                SUM(CASE WHEN t.status = 'waiting' THEN 1 ELSE 0 END) as waiting_today
            FROM tickets t 
            JOIN queues q ON t.queue_id = q.id 
            WHERE q.clinic_id = $1 AND q.queue_date = CURRENT_DATE
        `, [clinicId]);

        const weekStats = await db.query(`
            SELECT COUNT(t.id) as total_week 
            FROM tickets t 
            JOIN queues q ON t.queue_id = q.id 
            WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '7 days'
        `, [clinicId]);

        const dailyBreakdown = await db.query(`
            SELECT TO_CHAR(q.queue_date, 'YYYY-MM-DD') as date, COUNT(t.id) as count 
            FROM queues q 
            LEFT JOIN tickets t ON q.id = t.queue_id 
            WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY q.queue_date 
            ORDER BY q.queue_date DESC
        `, [clinicId]);

        res.json({
            today: todayStats.rows[0].total_today || 0,
            waiting: todayStats.rows[0].waiting_today || 0,
            week: weekStats.rows[0].total_week || 0,
            breakdown: dailyBreakdown.rows
        });
    } catch (err) { res.status(500).json({ error: 'خطأ في جلب الإحصائيات' }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`));