const db = require('./index');

const createTables = async () => {
    const queryText = `
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

        CREATE TABLE IF NOT EXISTS clinics (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name VARCHAR(255) NOT NULL,
            slug VARCHAR(255) UNIQUE NOT NULL, 
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS queues (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
            queue_date DATE NOT NULL DEFAULT CURRENT_DATE,
            current_number INTEGER DEFAULT 0, 
            last_issued_number INTEGER DEFAULT 0,
            status VARCHAR(50) DEFAULT 'active',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(clinic_id, queue_date)
        );

        CREATE TABLE IF NOT EXISTS tickets (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
            patient_name VARCHAR(255) NOT NULL,
            ticket_number INTEGER NOT NULL,
            status VARCHAR(50) DEFAULT 'waiting',
            language VARCHAR(10) DEFAULT 'ar',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(queue_id, ticket_number)
        );
    `;

    try {
        console.log('⏳ جاري إنشاء الجداول في قاعدة البيانات...');
        await db.query(queryText);
        console.log('✅ تم بناء جميع الجداول بنجاح!');
        process.exit(0);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء بناء الجداول:', error);
        process.exit(1);
    }
};

createTables();