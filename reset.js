const db = require('./db');

async function resetQueue() {
    try {
        // تصفير عدادات الطابور لليوم
        await db.query("UPDATE queues SET current_number = 0, last_issued_number = 0");
        // مسح كل تذاكر المرضى القديمة
        await db.query("DELETE FROM tickets");
        
        console.log("✅ تم تصفير النظام بنجاح! العداد الآن رجع للصفر.");
        process.exit(0);
    } catch (err) {
        console.error("❌ خطأ أثناء التصفير:", err);
        process.exit(1);
    }
}

resetQueue();