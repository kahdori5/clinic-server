async function runTest() {
    console.log("⏳ جاري سحب تذكرة لمريض جديد...");
    await fetch('http://localhost:3000/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinic_slug: 'shifa-clinic', patient_name: 'مريض تجريبي' })
    });

    console.log("✅ المريض الآن في صالة الانتظار. الطبيب سيناديه بعد ثانيتين...");

    setTimeout(async () => {
        await fetch('http://localhost:3000/api/call-next', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clinic_slug: 'shifa-clinic' })
        });
        console.log("📢 الطبيب ضغط الزر! انظر إلى شاشة المتصفح فوراً!");
    }, 2000);
}

runTest();