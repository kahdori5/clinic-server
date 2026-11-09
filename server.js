// 8. جلب إحصائيات العيادة (للطبيب)
app.get('/api/stats/:clinic_slug', async (req, res) => {
    try {
        const { clinic_slug } = req.params;
        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [clinic_slug]);
        if(clinic.rows.length === 0) return res.json({ today: 0, waiting: 0, week: 0, breakdown: [] });
        
        const clinicId = clinic.rows[0].id;

        // إحصائيات اليوم (الإجمالي + المنتظرين)
        const todayStats = await db.query(`
            SELECT 
                COUNT(t.id) as total_today,
                SUM(CASE WHEN t.status = 'waiting' THEN 1 ELSE 0 END) as waiting_today
            FROM tickets t 
            JOIN queues q ON t.queue_id = q.id 
            WHERE q.clinic_id = $1 AND q.queue_date = CURRENT_DATE
        `, [clinicId]);

        // إحصائيات آخر 7 أيام
        const weekStats = await db.query(`
            SELECT COUNT(t.id) as total_week 
            FROM tickets t 
            JOIN queues q ON t.queue_id = q.id 
            WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '7 days'
        `, [clinicId]);

        // تفصيل الأيام (كل يوم كم مريض)
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