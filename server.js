require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const server = http.createServer(app);

const ALLOWED_ORIGINS = new Set(
    [
        'https://clinic-server-i00s.onrender.com',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        process.env.ALLOWED_ORIGIN
    ].filter(Boolean)
);

const isOriginAllowed = (origin) => {
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(origin);
};

const io = new Server(server, {
    cors: {
        origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
        methods: ['GET', 'POST', 'DELETE'],
        credentials: true
    }
});

// ======================== طبقات الأمان والتشفير ========================

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    crypto
        .createHash('sha256')
        .update((process.env.DATABASE_URL || 'clinicflow-fallback') + '::session-key-v1')
        .digest('hex');

if (!process.env.SESSION_SECRET) {
    console.warn('⚠️ يُنصح بإضافة متغير SESSION_SECRET في إعدادات Render لتقوية توقيع الجلسات.');
}
if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️ متغير ADMIN_PASSWORD غير مضبوط؛ لوحة الأدمن مغلقة تلقائياً لحين إضافته في Render.');
}

const SESSION_COOKIE_NAME = 'cf_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة

function safeEqualStr(a, b) {
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
    if (!stored || typeof plain !== 'string' || plain.length === 0) {
        return { valid: false, needsUpgrade: false };
    }
    if (stored.startsWith('scrypt$')) {
        const parts = stored.split('$');
        if (parts.length !== 3) return { valid: false, needsUpgrade: false };
        const [, salt, storedHex] = parts;
        const derivedBuf = crypto.scryptSync(plain, salt, 64);
        const storedBuf = Buffer.from(storedHex, 'hex');
        if (derivedBuf.length !== storedBuf.length) return { valid: false, needsUpgrade: false };
        return { valid: crypto.timingSafeEqual(derivedBuf, storedBuf), needsUpgrade: false };
    }
    // دعم الترقية التلقائية لكلمات المرور القديمة المخزنة كنص عادي
    const valid = safeEqualStr(plain, stored);
    return { valid, needsUpgrade: valid };
}

function signSession(payload) {
    const body = { ...payload, exp: Date.now() + SESSION_TTL_MS };
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
}

function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
    if (!safeEqualStr(sig, expectedSig)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!parsed.exp || Date.now() > parsed.exp) return null;
        return parsed;
    } catch {
        return null;
    }
}

function parseCookies(req) {
    const list = {};
    const header = req.headers.cookie;
    if (!header) return list;
    header.split(';').forEach((pair) => {
        const idx = pair.indexOf('=');
        if (idx > -1) {
            const key = pair.slice(0, idx).trim();
            const val = pair.slice(idx + 1).trim();
            try {
                list[key] = decodeURIComponent(val);
            } catch {
                list[key] = val;
            }
        }
    });
    return list;
}

function setSessionCookie(req, res, payload) {
    const token = signSession(payload);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ];
    if (isSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
        `${SESSION_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0'
    ];
    if (isSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function makeCancelToken(clinicSlug, bookingDate, ticketNumber) {
    return crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(`cancel::${clinicSlug}::${String(bookingDate).slice(0, 10)}::${parseInt(ticketNumber, 10)}`)
        .digest('base64url');
}

// تنظيف النصوص ضد XSS وتضخم البيانات
function cleanText(val, maxLen = 120) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, maxLen);
}

function cleanMultiline(val, maxLen = 2000) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, maxLen);
}

function cleanSlug(val) {
    return String(val || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 80);
}

function cleanTime(val, fallback) {
    const str = String(val || '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(str) ? str : fallback;
}

// حماية ضد هجمات الإغراق وتخمين كلمات السر (Rate Limiter)
function createRateLimiter({ windowMs, max, message, skip }) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [k, entry] of hits.entries()) {
            if (now > entry.resetAt) hits.delete(k);
        }
    }, Math.min(windowMs, 5 * 60 * 1000)).unref();

    return (req, res, next) => {
        if (skip && skip(req)) return next();
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = hits.get(ip);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count += 1;
        if (entry.count > max) {
            const retrySec = Math.ceil((entry.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retrySec));
            return res.status(429).json({
                error: message || 'طلبات كثيرة جداً من جهازك، يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.'
            });
        }
        next();
    };
}

const globalApiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 140,
    message: 'تم تجاوز الحد المسموح من الطلبات، يرجى الانتظار دقيقة.'
});

const authBruteForceLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 6,
    message: 'تم حظر محاولات الدخول مؤقتاً لمدة 15 دقيقة بسبب تكرار المحاولات الخاطئة.'
});

const publicBookingLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'لقد وصلت للحد الأقصى من الحجوزات المسموح بها من هذا الجهاز مؤقتاً.',
    skip: (req) => Boolean(req.auth && (req.auth.role === 'admin' || req.auth.role === 'staff'))
});

// ترويسات الأمان HTTP ضد الاختراقات والذكاء الاصطناعي الآلي
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://api.qrserver.com https://cdn-icons-png.flaticon.com; connect-src 'self' wss: https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self';"
    );
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

app.use(
    cors({
        origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
        credentials: true,
        methods: ['GET', 'POST', 'DELETE']
    })
);

app.use(express.json({ limit: '50kb' }));

// قراءة الجلسة إن وجدت
app.use((req, res, next) => {
    const cookies = parseCookies(req);
    req.auth = verifySession(cookies[SESSION_COOKIE_NAME]);
    next();
});

// حماية CSRF للطلبات التعديلية عبر التحقق من الأصل
app.use('/api', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
        const origin = req.headers.origin;
        if (origin && !isOriginAllowed(origin)) {
            const hostOrigin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
            if (origin !== hostOrigin) {
                return res.status(403).json({ error: 'مصدر الطلب غير مصرح به.' });
            }
        }
    }
    next();
});

app.use('/api', globalApiLimiter);

function hasAccessToSlug(auth, slug) {
    if (!auth) return false;
    if (auth.role === 'admin') return true;
    return Array.isArray(auth.slugs) && auth.slugs.includes(slug);
}

function requireAdmin(req, res, next) {
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'يرجى إضافة متغير ADMIN_PASSWORD في إعدادات Render لتفعيل لوحة الأدمن.' });
    }
    if (!req.auth || req.auth.role !== 'admin') {
        return res.status(401).json({ error: 'يلزم تسجيل دخول الأدمن أولاً.' });
    }
    next();
}

function requireStaffForSlug(getSlugFn) {
    return (req, res, next) => {
        const slug = getSlugFn(req);
        if (!slug) return res.status(400).json({ error: 'معرف العيادة مطلوب.' });
        if (!hasAccessToSlug(req.auth, slug)) {
            return res.status(401).json({ error: 'غير مصرح بالوصول، يرجى تسجيل الدخول.' });
        }
        next();
    };
}

function requireAnyStaff(req, res, next) {
    if (!req.auth || (req.auth.role !== 'admin' && req.auth.role !== 'staff')) {
        return res.status(401).json({ error: 'غير مصرح بالوصول، يرجى تسجيل الدخول.' });
    }
    next();
}

// حقن حارس الأمان تلقائياً في صفحات الأدمن والطبيب والاستقبال بدون تعديلها يدوياً
app.get(['/admin.html', '/doctor.html', '/reception.html'], (req, res, next) => {
    const filePath = path.join(__dirname, 'public', path.basename(req.path));
    fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) return next();
        const guardTag = '<script src="/security-guard.js"></script>';
        let out = html;
        if (!html.includes('/security-guard.js')) {
            const lastBodyIdx = html.toLowerCase().lastIndexOf('</body>');
            if (lastBodyIdx !== -1) {
                out = html.slice(0, lastBodyIdx) + `    ${guardTag}\n` + html.slice(lastBodyIdx);
            } else {
                out = html + `\n${guardTag}\n`;
            }
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(out);
    });
});

app.use(express.static('public'));

// ======================== الأيقونة وملفات التثبيت ========================

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

app.get('/manifest/reception.json', (req, res) => {
    const clinic = cleanSlug(req.query.clinic) || 'default-clinic';
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

app.get('/manifest/doctor.json', (req, res) => {
    const clinic = cleanSlug(req.query.clinic) || 'default-clinic';
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

// ======================== فحص الصحة والتهيئة ========================

app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, db: 'connected', uptime_seconds: Math.floor(process.uptime()) });
    } catch (err) {
        console.error('Health check DB error:', err.message);
        res.status(500).json({ ok: false, db: 'error' });
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
        for (const q of alterQueries) {
            try { await db.query(q); } catch (e) {}
        }

        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_slug ON clinics(slug);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_clinics_parent ON clinics(parent_id);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_queues_clinic_date ON queues(clinic_id, queue_date);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_records_slug ON patient_records(clinic_slug);`);

        console.log('🚀 قاعدة البيانات جاهزة ومُحمية بالكامل!');
    } catch (e) {
        console.error('❌ خطأ في تهيئة قاعدة البيانات:', e.message);
        if (retries > 0) {
            setTimeout(() => initDB(retries - 1), 5000);
        }
    }
};
initDB();

// ======================== مسارات تسجيل الدخول والأمان ========================

async function getAuthorizedSlugsForClinic(clinicRow) {
    const slugs = new Set([clinicRow.slug]);
    if (clinicRow.is_main) {
        const subDocs = await db.query('SELECT slug FROM clinics WHERE parent_id::text = $1::text', [clinicRow.id]);
        for (const d of subDocs.rows) slugs.add(d.slug);
    }
    return Array.from(slugs);
}

app.get('/api/auth/me', (req, res) => {
    const slug = cleanSlug(req.query.clinic);
    if (!req.auth) {
        return res.json({ authenticated: false, role: null, authorized: false });
    }
    const authorized = slug ? hasAccessToSlug(req.auth, slug) : true;
    res.json({
        authenticated: true,
        role: req.auth.role,
        authorized
    });
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
});

app.post('/api/admin/login', authBruteForceLimiter, (req, res) => {
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'يرجى إضافة متغير ADMIN_PASSWORD في إعدادات Render أولاً.' });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string' || !safeEqualStr(password, process.env.ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'كلمة مرور الأدمن غير صحيحة.' });
    }
    setSessionCookie(req, res, { role: 'admin', slugs: ['*'] });
    res.json({ success: true, role: 'admin' });
});

app.post('/api/auth/staff-login', authBruteForceLimiter, async (req, res) => {
    try {
        const slug = cleanSlug(req.body && req.body.clinic_slug);
        const password = req.body && req.body.password;
        if (!password || typeof password !== 'string') {
            return res.status(400).json({ error: 'يرجى إدخال كلمة المرور.' });
        }

        // السماح للأدمن بالدخول إلى أي لوحة طبيب أو استقبال بكلمة مرور الأدمن
        if (process.env.ADMIN_PASSWORD && safeEqualStr(password, process.env.ADMIN_PASSWORD)) {
            setSessionCookie(req, res, { role: 'admin', slugs: ['*'] });
            return res.json({ success: true, role: 'admin' });
        }

        if (!slug) return res.status(400).json({ error: 'معرف العيادة غير صالح.' });

        const clinicRes = await db.query(
            'SELECT id, slug, is_main, parent_id, password FROM clinics WHERE slug = $1',
            [slug]
        );
        if (clinicRes.rows.length === 0) {
            return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
        }

        const cRow = clinicRes.rows[0];
        let matched = false;
        let allowedSlugs = [cRow.slug];

        // 1. فحص كلمة مرور الطبيب أو العيادة نفسها
        if (cRow.password) {
            const check = verifyPassword(password, cRow.password);
            if (check.valid) {
                matched = true;
                if (check.needsUpgrade) {
                    await db.query('UPDATE clinics SET password = $1 WHERE id = $2', [hashPassword(password), cRow.id]);
                }
                allowedSlugs = await getAuthorizedSlugsForClinic(cRow);
            }
        }

        // 2. إذا كان طبيباً فرعياً، نسمح أيضاً بكلمة مرور العيادة الرئيسية (لمكتب الاستقبال)
        if (!matched && cRow.parent_id) {
            const parentRes = await db.query(
                'SELECT id, slug, is_main, password FROM clinics WHERE id::text = $1::text',
                [cRow.parent_id]
            );
            if (parentRes.rows.length > 0 && parentRes.rows[0].password) {
                const pRow = parentRes.rows[0];
                const pCheck = verifyPassword(password, pRow.password);
                if (pCheck.valid) {
                    matched = true;
                    if (pCheck.needsUpgrade) {
                        await db.query('UPDATE clinics SET password = $1 WHERE id = $2', [hashPassword(password), pRow.id]);
                    }
                    allowedSlugs = await getAuthorizedSlugsForClinic(pRow);
                }
            }
        }

        if (!matched) {
            return res.status(401).json({ error: 'كلمة المرور غير صحيحة أو لم يتم تعيين كلمة مرور للعيادة بعد.' });
        }

        setSessionCookie(req, res, { role: 'staff', slugs: allowedSlugs });
        res.json({ success: true, role: 'staff' });
    } catch (err) {
        console.error('Staff login error:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء التحقق من الدخول.' });
    }
});

// ======================== مسارات الطبيب والعيادة ========================

app.get('/api/doctor/auth-status/:slug', async (req, res) => {
    try {
        const slug = cleanSlug(req.params.slug);
        const clinic = await db.query(`
            SELECT c.password, c.specialty, c.phone, c.email, c.address, c.max_daily_tickets,
                   c.open_time, c.close_time,
                   p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
        const row = clinic.rows[0];
        const passwordConfigured = Boolean(row.password && row.password.length > 0);
        const isAlreadyAuthed = hasAccessToSlug(req.auth, slug);
        res.json({
            hasPassword: isAlreadyAuthed ? false : passwordConfigured,
            passwordConfigured,
            specialty: row.specialty || 'طب عام',
            doctor_phone: row.phone || row.parent_phone || '',
            doctor_email: row.email || row.parent_email || '',
            clinic_address: row.address || row.parent_address || '',
            max_daily_tickets: parseInt(row.max_daily_tickets || 0, 10),
            open_time: row.open_time || row.parent_open_time || '08:00',
            close_time: row.close_time || row.parent_close_time || '16:00'
        });
    } catch (err) {
        console.error('auth-status error:', err.message);
        res.status(500).json({ error: 'حدث خطأ مؤقت.' });
    }
});

app.post('/api/doctor/verify-password', authBruteForceLimiter, async (req, res) => {
    try {
        const slug = cleanSlug(req.body && req.body.clinic_slug);
        const password = req.body && req.body.password;
        if (!slug || typeof password !== 'string') {
            return res.status(400).json({ error: 'بيانات غير صالحة.' });
        }

        if (process.env.ADMIN_PASSWORD && safeEqualStr(password, process.env.ADMIN_PASSWORD)) {
            setSessionCookie(req, res, { role: 'admin', slugs: ['*'] });
            return res.json({ success: true });
        }

        const clinic = await db.query('SELECT id, slug, is_main, password FROM clinics WHERE slug = $1', [slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });

        const cRow = clinic.rows[0];
        const check = verifyPassword(password, cRow.password);
        if (!check.valid) return res.status(401).json({ error: 'كلمة السر غير صحيحة' });

        if (check.needsUpgrade) {
            await db.query('UPDATE clinics SET password = $1 WHERE id = $2', [hashPassword(password), cRow.id]);
        }
        const slugs = await getAuthorizedSlugsForClinic(cRow);
        setSessionCookie(req, res, { role: 'staff', slugs });
        res.json({ success: true });
    } catch (err) {
        console.error('verify-password error:', err.message);
        res.status(500).json({ error: 'حدث خطأ مؤقت.' });
    }
});

app.post(
    '/api/doctor/set-password',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const newPassword = req.body.new_password;
            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
                return res.status(400).json({ error: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل لحماية ملفات المرضى.' });
            }
            const hashed = hashPassword(newPassword);
            await db.query('UPDATE clinics SET password = $1 WHERE slug = $2', [hashed, slug]);
            res.json({ message: 'تم تشفير وحفظ كلمة المرور بنجاح' });
        } catch (err) {
            console.error('set-password error:', err.message);
            res.status(500).json({ error: 'تعذر تحديث كلمة المرور.' });
        }
    }
);

app.post(
    '/api/doctor/set-specialty',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const specialty = cleanText(req.body.specialty, 100) || 'طب عام';
            await db.query('UPDATE clinics SET specialty = $1 WHERE slug = $2', [specialty, slug]);
            res.json({ message: 'تم تحديث الاختصاص الطبي بنجاح' });
        } catch (err) {
            console.error('set-specialty error:', err.message);
            res.status(500).json({ error: 'تعذر تحديث الاختصاص.' });
        }
    }
);

app.post(
    '/api/clinic/set-hours',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const openTime = cleanTime(req.body.open_time, null);
            const closeTime = cleanTime(req.body.close_time, null);
            if (!openTime || !closeTime) {
                return res.status(400).json({ error: 'صيغة الوقت غير صحيحة (مثال: 08:00).' });
            }

            const clinicRes = await db.query('SELECT id, is_main, parent_id FROM clinics WHERE slug = $1', [slug]);
            if (clinicRes.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة' });

            const row = clinicRes.rows[0];
            const mainId = (!row.is_main && row.parent_id) ? row.parent_id : row.id;

            await db.query(
                'UPDATE clinics SET open_time = $1, close_time = $2 WHERE id::text = $3::text OR parent_id::text = $3::text',
                [openTime, closeTime, String(mainId)]
            );

            io.emit('clinic_hours_changed', { clinic_slug: slug, open_time: openTime, close_time: closeTime });
            res.json({
                message: `تم حفظ أوقات عمل العيادة (${openTime} - ${closeTime}) بنجاح`,
                open_time: openTime,
                close_time: closeTime
            });
        } catch (err) {
            console.error('set-hours error:', err.message);
            res.status(500).json({ error: 'تعذر حفظ أوقات العمل.' });
        }
    }
);

app.post(
    '/api/doctor/toggle-presence',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [slug]);
            if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
            const clinicId = clinic.rows[0].id;
            const docName = clinic.rows[0].name;

            const queue = await db.query('SELECT id, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinicId]);
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

            io.emit('doctor_presence_changed', { clinic_slug: slug, doctor_present: newPresence });
            res.json({
                doctor_present: newPresence,
                message: newPresence
                    ? `🟢 تم تأكيد حضور (${docName}) في العيادة الآن`
                    : `🟠 تم تحديث حالة (${docName}): لم يحضر بعد`
            });
        } catch (err) {
            console.error('toggle-presence error:', err.message);
            res.status(500).json({ error: 'تعذر تحديث حالة الحضور.' });
        }
    }
);

app.post(
    '/api/queue/set-max-tickets',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const { max_tickets, apply_to_all_week, booking_date } = req.body;
            const parsedLimit = Math.min(500, Math.max(0, parseInt(max_tickets, 10) || 0));

            const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
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
                        `INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number, max_tickets) VALUES ($1, $2::date, 'active', 0, 0, $3)`,
                        [clinicId, targetDate, parsedLimit]
                    );
                } else {
                    await db.query('UPDATE queues SET max_tickets = $1 WHERE id = $2', [parsedLimit, q.rows[0].id]);
                }
            }

            io.emit('queue_status_changed', { clinic_slug: slug, max_tickets: parsedLimit });
            res.json({
                message: apply_to_all_week
                    ? (parsedLimit > 0 ? `تم تحديد العدد الأقصى بـ ${parsedLimit} تذكرة يومياً طوال الأسبوع` : 'تم فتح العدد الأقصى للتذاكر (غير محدود) طوال الأسبوع')
                    : (parsedLimit > 0 ? `تم تحديد العدد الأقصى لهذا اليوم بـ ${parsedLimit} تذكرة` : 'تم جعل عدد التذاكر لهذا اليوم غير محدود'),
                max_tickets: parsedLimit
            });
        } catch (err) {
            console.error('set-max-tickets error:', err.message);
            res.status(500).json({ error: 'تعذر تحديث الحد الأقصى.' });
        }
    }
);

// ======================== مسارات الدليل والمعاينة العامة ========================

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
        for (const row of clinicsRes.rows) {
            const effectiveSub = row.parent_sub || row.subscription_end;
            if (effectiveSub && new Date(effectiveSub) < today) continue;

            const effectiveMax = (row.queue_max_tickets !== null && row.queue_max_tickets !== undefined)
                ? parseInt(row.queue_max_tickets, 10)
                : parseInt(row.max_daily_tickets || 0, 10);
            const lastIssued = parseInt(row.last_issued_number || 0, 10);

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
                current_number: parseInt(row.current_number || 0, 10),
                next_ticket_today: lastIssued + 1,
                max_tickets: effectiveMax,
                is_full: effectiveMax > 0 && lastIssued >= effectiveMax,
                status: row.status
            });
        }

        res.json(directoryList);
    } catch (err) {
        console.error('directory/doctors error:', err.message);
        res.status(500).json({ error: 'تعذر تحميل الدليل.' });
    }
});

app.get('/api/directory/preview/:clinic_slug', async (req, res) => {
    try {
        const slug = cleanSlug(req.params.clinic_slug);
        const { date } = req.query;
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.max_daily_tickets, c.open_time, c.close_time,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });

        const cRow = clinic.rows[0];
        const defaultMax = parseInt(cRow.max_daily_tickets || 0, 10);
        const openTime = cRow.open_time || cRow.parent_open_time || '08:00';
        const closeTime = cRow.close_time || cRow.parent_close_time || '16:00';

        const todayPresenceRes = await db.query('SELECT doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [cRow.id]);
        const doctorPresentToday = todayPresenceRes.rows.length > 0 ? Boolean(todayPresenceRes.rows[0].doctor_present) : false;

        const targetDateRes = date
            ? await db.query(`SELECT ($1::date) as d, EXTRACT(DOW FROM $1::date) as dow, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL '7 days')::date as max_d`, [date])
            : await db.query(`SELECT CURRENT_DATE as d, EXTRACT(DOW FROM CURRENT_DATE) as dow, CURRENT_DATE as today, (CURRENT_DATE + INTERVAL '7 days')::date as max_d`);

        const { d, dow, today, max_d } = targetDateRes.rows[0];
        if (new Date(d) < new Date(today) || new Date(d) > new Date(max_d)) {
            return res.status(400).json({ error: 'يمكن الحجز فقط خلال أسبوع كامل (7 أيام كحد أقصى)' });
        }

        if (parseInt(dow, 10) === 5) {
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
            ? parseInt(qRow.max_tickets, 10)
            : defaultMax;

        const activeTicketsRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
        const activeCount = parseInt(activeTicketsRes.rows[0].count || 0, 10);
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
    } catch (err) {
        console.error('preview error:', err.message);
        res.status(500).json({ error: 'تعذر معاينة الطابور.' });
    }
});

// مسار آمن للمريض للتحقق من حالة تذكرته فقط (بدون كشف أسماء باقي المرضى)
app.get('/api/tickets/check/:clinic_slug', async (req, res) => {
    try {
        const slug = cleanSlug(req.params.clinic_slug);
        const ticketNum = parseInt(req.query.ticket, 10);
        const { date } = req.query;
        if (!slug || isNaN(ticketNum) || ticketNum <= 0) {
            return res.status(400).json({ error: 'رقم التذكرة غير صالح.' });
        }

        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });

        const targetDateRes = date
            ? await db.query('SELECT ($1::date)::text as d', [date])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = targetDateRes.rows[0].d;

        const q = await db.query('SELECT id, current_number FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinic.rows[0].id, targetDate]);
        if (q.rows.length === 0) return res.json({ exists: false, status: 'cancelled', current_number: 0 });

        const t = await db.query('SELECT status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [q.rows[0].id, ticketNum]);
        if (t.rows.length === 0) return res.json({ exists: false, status: 'cancelled', current_number: q.rows[0].current_number });

        res.json({
            exists: true,
            status: t.rows[0].status,
            current_number: q.rows[0].current_number
        });
    } catch (err) {
        console.error('tickets/check error:', err.message);
        res.status(500).json({ error: 'تعذر التحقق من التذكرة.' });
    }
});

// محمي: لائحة أسماء المرضى المسجلين للممرضة والطبيب والأدمن فقط
app.get(
    '/api/reception/tickets/:clinic_slug',
    requireStaffForSlug((req) => cleanSlug(req.params.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.params.clinic_slug);
            const { date } = req.query;
            const clinic = await db.query(`
                SELECT c.id, c.name, c.specialty, c.max_daily_tickets, c.open_time, c.close_time,
                       p.name as parent_clinic_name, p.open_time as parent_open_time, p.close_time as parent_close_time
                FROM clinics c
                LEFT JOIN clinics p ON c.parent_id::text = p.id::text
                WHERE c.slug = $1
            `, [slug]);

            if (clinic.rows.length === 0) return res.status(404).json({ error: 'الطبيب غير موجود' });
            const row = clinic.rows[0];
            const defaultMax = parseInt(row.max_daily_tickets || 0, 10);
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
                ? parseInt(qRow.max_tickets, 10)
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
        } catch (err) {
            console.error('reception/tickets error:', err.message);
            res.status(500).json({ error: 'تعذر تحميل لائحة المرضى.' });
        }
    }
);

app.post(
    '/api/queue/toggle-status',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const { booking_date } = req.body;
            const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
            if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة' });
            const clinicId = clinic.rows[0].id;

            const dateRes = booking_date
                ? await db.query('SELECT ($1::date)::text as d', [booking_date])
                : await db.query('SELECT CURRENT_DATE::text as d');
            const targetDate = dateRes.rows[0].d;

            let queue = await db.query('SELECT * FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinicId, targetDate]);
            if (queue.rows.length === 0) {
                queue = await db.query(`INSERT INTO queues (clinic_id, queue_date, status, current_number, last_issued_number) VALUES ($1, $2::date, 'paused', 0, 0) RETURNING *`, [clinicId, targetDate]);
                io.emit('queue_status_changed', { clinic_slug: slug, status: 'paused', booking_date: targetDate });
                return res.json({ status: 'paused' });
            }

            const newStatus = queue.rows[0].status === 'paused' ? 'active' : 'paused';
            await db.query('UPDATE queues SET status = $1 WHERE id = $2', [newStatus, queue.rows[0].id]);
            io.emit('queue_status_changed', { clinic_slug: slug, status: newStatus, booking_date: targetDate });
            res.json({ status: newStatus });
        } catch (err) {
            console.error('toggle-status error:', err.message);
            res.status(500).json({ error: 'تعذر تغيير حالة الطابور.' });
        }
    }
);

// محمي: إنشاء عيادة جديدة للأدمن فقط
app.post('/api/clinics', requireAdmin, async (req, res) => {
    try {
        const name = cleanText(req.body.name, 120);
        const slug = cleanSlug(req.body.slug);
        if (!name || !slug) return res.status(400).json({ error: 'اسم العيادة والرابط مطلوبان.' });

        const phone = cleanText(req.body.phone, 40);
        const email = cleanText(req.body.email, 120);
        const address = cleanText(req.body.address, 200);
        const specialty = cleanText(req.body.specialty, 100) || 'عيادة طبية';
        const openTime = cleanTime(req.body.open_time, '08:00');
        const closeTime = cleanTime(req.body.close_time, '16:00');

        const result = await db.query(
            `INSERT INTO clinics (name, slug, is_main, subscription_end, phone, email, address, specialty, open_time, close_time) VALUES ($1, $2, true, CURRENT_DATE + INTERVAL '1 month', $3, $4, $5, $6, $7, $8) RETURNING id, name, slug, subscription_end, phone, email, address, specialty, open_time, close_time`,
            [name, slug, phone, email, address, specialty, openTime, closeTime]
        );
        res.status(201).json({ message: 'تم', clinic: result.rows[0] });
    } catch (err) {
        res.status(400).json({ error: 'الرابط مستخدم مسبقاً أو البيانات غير صالحة.' });
    }
});

// إصدار التذاكر (محمي ضد الإغراق الآلي + تنظيف الاسم + توليد رمز إلغاء سري)
app.post('/api/tickets', publicBookingLimiter, async (req, res) => {
    try {
        const slug = cleanSlug(req.body && req.body.clinic_slug);
        const patientName = cleanText(req.body && req.body.patient_name, 80) || 'مريض';
        const bookingDate = req.body && req.body.booking_date;
        if (!slug) return res.status(400).json({ error: 'الرابط غير صالح.' });

        const clinic = await db.query(`SELECT id, name, is_main, subscription_end as doc_sub, parent_id, max_daily_tickets FROM clinics WHERE slug = $1`, [slug]);
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
        if (bookingDate) {
            const checkDate = await db.query(`
                SELECT ($1::date >= CURRENT_DATE AND $1::date <= (CURRENT_DATE + INTERVAL '7 days')::date) as is_valid,
                       ($1::date)::text as target_date,
                       EXTRACT(DOW FROM $1::date) as dow
            `, [bookingDate]);
            if (!checkDate.rows[0].is_valid) {
                return res.status(400).json({ error: 'يمكن التسجيل والحجز في حدود أسبوع كامل (7 أيام) كحد أقصى.' });
            }
            targetDateQuery = checkDate;
        }
        const targetDate = targetDateQuery.rows[0].target_date;
        const targetDow = parseInt(targetDateQuery.rows[0].dow, 10);

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
            ? parseInt(qRow.max_tickets, 10)
            : parseInt(cRow.max_daily_tickets || 0, 10);

        if (effectiveMax > 0) {
            const activeCountRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
            const activeCount = parseInt(activeCountRes.rows[0].count || 0, 10);
            if (activeCount >= effectiveMax) {
                return res.status(400).json({ error: `نعتذر، اكتمل العدد الأقصى للتذاكر المسموح به لهذا اليوم (${effectiveMax} تذكرة).` });
            }
        }

        const newNumber = qRow.last_issued_number + 1;
        await db.query('UPDATE queues SET last_issued_number = $1 WHERE id = $2', [newNumber, qRow.id]);
        await db.query('INSERT INTO tickets (queue_id, patient_name, ticket_number) VALUES ($1, $2, $3)', [qRow.id, patientName, newNumber]);

        const cancelToken = makeCancelToken(slug, targetDate, newNumber);

        // عدم بث اسم المريض في قناة Socket العامة لحماية الخصوصية
        io.emit('new_ticket', { clinic_slug: slug, ticket_number: newNumber, booking_date: targetDate });
        res.status(201).json({
            message: `رقمك هو: ${newNumber}`,
            ticket_number: newNumber,
            booking_date: targetDate,
            doctor_name: cRow.name,
            cancel_token: cancelToken
        });
    } catch (err) {
        console.error('tickets POST error:', err.message);
        res.status(500).json({ error: 'تعذر إصدار التذكرة حالياً.' });
    }
});

// محمي: إلغاء التذكرة برمز سري لصاحب التذكرة أو عبر صلاحية الممرضة/الطبيب/الأدمن
app.post('/api/tickets/cancel', async (req, res) => {
    try {
        const slug = cleanSlug(req.body && req.body.clinic_slug);
        const ticketNumber = parseInt(req.body && req.body.ticket_number, 10);
        const bookingDate = req.body && req.body.booking_date;
        const cancelToken = req.body && req.body.cancel_token;

        if (!slug || isNaN(ticketNumber) || ticketNumber <= 0) {
            return res.status(400).json({ error: 'بيانات التذكرة غير صالحة.' });
        }

        const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
        if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة.' });

        const dateRes = bookingDate
            ? await db.query('SELECT ($1::date)::text as d', [bookingDate])
            : await db.query('SELECT CURRENT_DATE::text as d');
        const targetDate = dateRes.rows[0].d;

        const isStaff = hasAccessToSlug(req.auth, slug);
        if (!isStaff) {
            const expectedToken = makeCancelToken(slug, targetDate, ticketNumber);
            if (!cancelToken || !safeEqualStr(cancelToken, expectedToken)) {
                return res.status(403).json({ error: 'غير مصرح بإلغاء هذه التذكرة.' });
            }
        }

        const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = $2::date', [clinic.rows[0].id, targetDate]);
        if (queue.rows.length > 0) {
            await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3', ['cancelled', queue.rows[0].id, ticketNumber]);
            io.emit('new_ticket', { clinic_slug: slug });
            io.emit('ticket_cancelled', { clinic_slug: slug, ticket_number: ticketNumber });
        }
        res.json({ message: 'تم الإلغاء' });
    } catch (err) {
        console.error('tickets/cancel error:', err.message);
        res.status(500).json({ error: 'تعذر إلغاء التذكرة.' });
    }
});

// محمي: مناداة المريض التالي للطبيب/الموظف/الأدمن فقط
app.post(
    '/api/call-next',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const clinic = await db.query('SELECT id, name FROM clinics WHERE slug = $1', [slug]);
            if (clinic.rows.length === 0) return res.status(404).json({ error: 'العيادة غير موجودة.' });

            const queue = await db.query('SELECT id, current_number, last_issued_number, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
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
                io.emit('doctor_presence_changed', { clinic_slug: slug, doctor_present: true });
            }
            io.emit('call_patient', { clinic_slug: slug, current_number: newCurrent, status: ticketStatus });
            res.status(200).json({ message: `الرقم: ${newCurrent}`, patient_name: patientName, ticket_status: ticketStatus, doctor_name: clinic.rows[0].name });
        } catch (err) {
            console.error('call-next error:', err.message);
            res.status(500).json({ error: 'تعذر النداء على المريض التالي.' });
        }
    }
);

// ======================== ملفات المرضى الطبية (محمية بالكامل ضد IDOR) ========================

app.post(
    '/api/patient/get',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const patientName = cleanText(req.body.patient_name, 100);
            const patient = await db.query('SELECT * FROM patient_records WHERE clinic_slug = $1 AND patient_name = $2 ORDER BY updated_at DESC LIMIT 1', [slug, patientName]);
            if (patient.rows.length > 0) res.json(patient.rows[0]);
            else res.json({ age: '', blood_type: '', allergies: '', chronic_diseases: '', notes: '' });
        } catch (err) {
            console.error('patient/get error:', err.message);
            res.status(500).json({ error: 'تعذر جلب الملف الطبي.' });
        }
    }
);

app.post(
    '/api/patient/save',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const patientName = cleanText(req.body.patient_name, 100);
            if (!patientName) return res.status(400).json({ error: 'اسم المريض مطلوب' });

            const age = cleanText(req.body.age, 30);
            const bloodType = cleanText(req.body.blood_type, 20);
            const allergies = cleanMultiline(req.body.allergies, 500);
            const chronic = cleanMultiline(req.body.chronic, 500);
            const notes = cleanMultiline(req.body.notes, 3000);

            const existing = await db.query('SELECT id FROM patient_records WHERE clinic_slug = $1 AND patient_name = $2', [slug, patientName]);
            if (existing.rows.length > 0) {
                await db.query(
                    `UPDATE patient_records SET age = $1, blood_type = $2, allergies = $3, chronic_diseases = $4, notes = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
                    [age, bloodType, allergies, chronic, notes, existing.rows[0].id]
                );
            } else {
                await db.query(
                    `INSERT INTO patient_records (clinic_slug, patient_name, age, blood_type, allergies, chronic_diseases, notes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
                    [slug, patientName, age, bloodType, allergies, chronic, notes]
                );
            }
            res.json({ message: 'تم حفظ الملف الطبي بنجاح' });
        } catch (err) {
            console.error('patient/save error:', err.message);
            res.status(500).json({ error: 'تعذر حفظ الملف الطبي.' });
        }
    }
);

app.delete('/api/patients/delete/:id', requireAnyStaff, async (req, res) => {
    try {
        const recordId = String(req.params.id || '').trim();
        if (req.auth.role === 'admin') {
            await db.query('DELETE FROM patient_records WHERE id::text = $1::text', [recordId]);
        } else {
            // منع طبيب من حذف ملفات طبيب آخر (حماية IDOR)
            await db.query(
                'DELETE FROM patient_records WHERE id::text = $1::text AND clinic_slug = ANY($2::text[])',
                [recordId, req.auth.slugs || []]
            );
        }
        res.json({ message: 'تم حذف المريض من الأرشيف بنجاح' });
    } catch (err) {
        console.error('patients/delete error:', err.message);
        res.status(500).json({ error: 'تعذر حذف الملف الطبي.' });
    }
});

app.get(
    '/api/patients/all/:clinic_slug',
    requireStaffForSlug((req) => cleanSlug(req.params.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.params.clinic_slug);
            const patientsList = await db.query(
                'SELECT id, patient_name, age, blood_type, allergies, chronic_diseases, notes, updated_at FROM patient_records WHERE clinic_slug = $1 ORDER BY updated_at DESC',
                [slug]
            );
            res.json(patientsList.rows);
        } catch (err) {
            console.error('patients/all error:', err.message);
            res.status(500).json({ error: 'تعذر تحميل الأرشيف.' });
        }
    }
);

// ======================== حالة الطابور والإحصائيات ========================

app.get('/api/queue-status/:clinic_slug', async (req, res) => {
    try {
        const slug = cleanSlug(req.params.clinic_slug);
        const clinic = await db.query(`
            SELECT c.id, c.name, c.specialty, c.phone, c.email, c.address, c.is_main, c.parent_id, c.max_daily_tickets,
                   c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.phone as parent_phone, p.email as parent_email, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [slug]);

        if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted', message: 'هذا الرابط غير صالح أو تم حذف الطبيب' });

        const row = clinic.rows[0];
        const mainClinicName = row.parent_clinic_name || row.name;
        const docPhone = row.phone || row.parent_phone || '';
        const docEmail = row.email || row.parent_email || '';
        const docAddress = row.address || row.parent_address || '';
        const openTime = row.open_time || row.parent_open_time || '08:00';
        const closeTime = row.close_time || row.parent_close_time || '16:00';
        const defaultMax = parseInt(row.max_daily_tickets || 0, 10);

        const queue = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [row.id]);
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
            ? parseInt(qRow.max_tickets, 10)
            : defaultMax;

        // اسم المريض الحالي يظهر للطبيب/الموظف المسجّل الدخول فقط لحماية الخصوصية
        let currentPatientName = '';
        let currentTicketStatus = 'waiting';
        if (currentNum > 0) {
            const t = await db.query('SELECT patient_name, status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [qId, currentNum]);
            if (t.rows.length > 0) {
                currentTicketStatus = t.rows[0].status;
                if (hasAccessToSlug(req.auth, slug)) {
                    currentPatientName = t.rows[0].patient_name;
                }
            }
        }

        const activeTicketsRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qId]);
        const activeTicketsCount = parseInt(activeTicketsRes.rows[0].count || 0, 10);

        const waitingRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [qId, currentNum]);
        const waitingCount = parseInt(waitingRes.rows[0].count || 0, 10);

        let aheadCount = waitingCount;
        let myTicketStatus = 'waiting';
        const myTicket = parseInt(req.query.my_ticket, 10);
        if (!isNaN(myTicket) && myTicket > 0) {
            const myT = await db.query('SELECT status FROM tickets WHERE queue_id = $1 AND ticket_number = $2', [qId, myTicket]);
            if (myT.rows.length > 0) myTicketStatus = myT.rows[0].status;

            if (currentNum >= myTicket) {
                aheadCount = 0;
            } else {
                const aheadRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND ticket_number < $3 AND status != 'cancelled'`, [qId, currentNum, myTicket]);
                aheadCount = parseInt(aheadRes.rows[0].count || 0, 10);
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
    } catch (err) {
        console.error('queue-status error:', err.message);
        res.status(500).json({ error: 'تعذر جلب حالة الطابور.' });
    }
});

app.get(
    '/api/doctor-stats/:clinic_slug',
    requireStaffForSlug((req) => cleanSlug(req.params.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.params.clinic_slug);
            const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
            if (clinic.rows.length === 0) return res.status(404).json({ error: 'deleted' });
            const cId = clinic.rows[0].id;

            const q = await db.query('SELECT id, current_number, last_issued_number FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [cId]);
            let today = 0, waiting = 0;
            if (q.rows.length > 0) {
                const totalRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [q.rows[0].id]);
                today = parseInt(totalRes.rows[0].count || 0, 10);
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [q.rows[0].id, q.rows[0].current_number]);
                waiting = parseInt(waitRes.rows[0].count || 0, 10);
            }

            const weeklyRes = await db.query(`SELECT COUNT(*) FROM tickets t JOIN queues q ON t.queue_id = q.id WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '7 days' AND t.status != 'cancelled'`, [cId]);
            const weekly = parseInt(weeklyRes.rows[0].count || 0, 10);
            const monthlyRes = await db.query(`SELECT COUNT(*) FROM tickets t JOIN queues q ON t.queue_id = q.id WHERE q.clinic_id = $1 AND q.queue_date >= CURRENT_DATE - INTERVAL '30 days' AND t.status != 'cancelled'`, [cId]);
            const monthly = parseInt(monthlyRes.rows[0].count || 0, 10);

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
                busiest_day_index = parseInt(busyRes.rows[0].dow, 10);
                busiest_day = daysAr[busiest_day_index];
            }

            res.json({ today, waiting, weekly, monthly, busiest_day, busiest_day_index });
        } catch (e) {
            console.error('doctor-stats error:', e.message);
            res.status(500).json({ error: 'تعذر تحميل الإحصائيات.' });
        }
    }
);

app.get('/api/clinic-doctors/:main_slug', async (req, res) => {
    try {
        const slug = cleanSlug(req.params.main_slug);
        const main = await db.query(`
            SELECT c.id, c.name, c.slug, c.specialty, c.address, c.is_main, c.parent_id, c.max_daily_tickets,
                   c.open_time, c.close_time,
                   p.name as parent_clinic_name, p.address as parent_address,
                   p.open_time as parent_open_time, p.close_time as parent_close_time
            FROM clinics c
            LEFT JOIN clinics p ON c.parent_id::text = p.id::text
            WHERE c.slug = $1
        `, [slug]);

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

        const result = [];
        for (const doc of docList) {
            const defaultMax = parseInt(doc.max_daily_tickets || 0, 10);
            const openTime = doc.open_time || clinicOpenTime;
            const closeTime = doc.close_time || clinicCloseTime;
            const q = await db.query('SELECT id, current_number, last_issued_number, status, max_tickets, doctor_present FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [doc.id]);
            if (q.rows.length > 0) {
                const qRow = q.rows[0];
                const effectiveMax = (qRow.max_tickets !== null && qRow.max_tickets !== undefined)
                    ? parseInt(qRow.max_tickets, 10)
                    : defaultMax;
                const waitRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND ticket_number > $2 AND status != 'cancelled'`, [qRow.id, qRow.current_number]);
                const activeRes = await db.query(`SELECT COUNT(*) FROM tickets WHERE queue_id = $1 AND status != 'cancelled'`, [qRow.id]);
                const activeCount = parseInt(activeRes.rows[0].count || 0, 10);

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
                    waiting: parseInt(waitRes.rows[0].count || 0, 10),
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
    } catch (e) {
        console.error('clinic-doctors error:', e.message);
        res.status(500).json({ error: 'تعذر تحميل قائمة الأطباء.' });
    }
});

// ======================== مسارات الأدمن (محمية بالكامل) ========================

app.get('/api/admin/clinics', requireAdmin, async (req, res) => {
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
    } catch (err) {
        console.error('admin/clinics error:', err.message);
        res.status(500).json({ error: 'تعذر تحميل العيادات.' });
    }
});

app.post('/api/admin/add-doctor', requireAdmin, async (req, res) => {
    try {
        const { parent_id } = req.body;
        const name = cleanText(req.body.name, 120);
        const slug = cleanSlug(req.body.slug);
        if (!name || !slug) return res.status(400).json({ error: 'اسم الطبيب والرابط مطلوبان.' });

        let finalAddress = cleanText(req.body.address, 200);
        let finalPhone = cleanText(req.body.phone, 40);
        let finalEmail = cleanText(req.body.email, 120);
        const specialty = cleanText(req.body.specialty, 100) || 'طب عام';
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
            [name, slug, parent_id, finalPhone, finalEmail, finalAddress, specialty, finalOpen, finalClose]
        );
        res.json({ message: 'تم' });
    } catch (err) {
        console.error('add-doctor error:', err.message);
        res.status(400).json({ error: 'تعذر إضافة الطبيب (قد يكون الرابط مستخدماً مسبقاً).' });
    }
});

// مصحّح بالكامل ضد ثغرة SQL Injection
app.post('/api/admin/renew', requireAdmin, async (req, res) => {
    try {
        const months = parseInt(req.body && req.body.months, 10);
        const clinicId = String(req.body && req.body.clinic_id || '').trim();
        if (!clinicId || !Number.isInteger(months) || months < 1 || months > 60) {
            return res.status(400).json({ error: 'عدد الأشهر أو معرف العيادة غير صالح.' });
        }
        await db.query(
            `UPDATE clinics SET subscription_end = GREATEST(COALESCE(subscription_end, CURRENT_DATE), CURRENT_DATE) + ($2 * INTERVAL '1 month') WHERE id::text = $1::text`,
            [clinicId, months]
        );
        res.json({ message: 'تم التجديد بنجاح' });
    } catch (err) {
        console.error('admin/renew error:', err.message);
        res.status(500).json({ error: 'تعذر تجديد الاشتراك.' });
    }
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

app.delete('/api/admin/clinics/:id', requireAdmin, async (req, res) => {
    try {
        const subDocs = await db.query('SELECT id FROM clinics WHERE parent_id::text = $1::text', [req.params.id]);
        for (const doc of subDocs.rows) {
            await deepDeleteClinicById(doc.id);
        }
        await deepDeleteClinicById(req.params.id);
        res.json({ message: 'تم حذف العيادة وجميع بياناتها بنجاح' });
    } catch (err) {
        console.error('delete clinic error:', err.message);
        res.status(500).json({ error: 'تعذر حذف العيادة.' });
    }
});

app.delete('/api/admin/doctors/:id', requireAdmin, async (req, res) => {
    try {
        await deepDeleteClinicById(req.params.id);
        res.json({ message: 'تم حذف الطبيب وإيقاف رابطه بنجاح' });
    } catch (err) {
        console.error('delete doctor error:', err.message);
        res.status(500).json({ error: 'تعذر حذف الطبيب.' });
    }
});

app.get('/api/admin/clinic-doctors-links/:main_id', requireAdmin, async (req, res) => {
    try {
        const docs = await db.query('SELECT id, name, slug, phone, email, address, specialty FROM clinics WHERE parent_id::text = $1::text ORDER BY id ASC', [req.params.main_id]);
        res.json(docs.rows);
    } catch (e) {
        console.error('clinic-doctors-links error:', e.message);
        res.status(500).json({ error: 'تعذر جلب الروابط.' });
    }
});

app.post(
    '/api/tickets/status',
    requireStaffForSlug((req) => cleanSlug(req.body && req.body.clinic_slug)),
    async (req, res) => {
        try {
            const slug = cleanSlug(req.body.clinic_slug);
            const ticketNumber = parseInt(req.body.ticket_number, 10);
            const allowedStatuses = new Set(['waiting', 'completed', 'absent', 'cancelled']);
            const status = String(req.body.status || '');
            if (!allowedStatuses.has(status) || isNaN(ticketNumber)) {
                return res.status(400).json({ error: 'حالة غير صالحة.' });
            }

            const clinic = await db.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
            if (clinic.rows.length > 0) {
                const queue = await db.query('SELECT id FROM queues WHERE clinic_id = $1 AND queue_date = CURRENT_DATE', [clinic.rows[0].id]);
                if (queue.rows.length > 0) {
                    await db.query('UPDATE tickets SET status = $1 WHERE queue_id = $2 AND ticket_number = $3', [status, queue.rows[0].id, ticketNumber]);
                    io.emit('ticket_status_updated', { clinic_slug: slug, ticket_number: ticketNumber, status });
                }
            }
            res.json({ message: 'تم' });
        } catch (e) {
            console.error('tickets/status error:', e.message);
            res.status(500).json({ error: 'تعذر تحديث الحالة.' });
        }
    }
);

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
server.listen(PORT, () => console.log(`Secure ClinicFlow server running on port ${PORT}`));