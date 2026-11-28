(function () {
    'use strict';

    const path = window.location.pathname.toLowerCase();
    const isAdminPage = path.endsWith('/admin.html');
    const isDoctorPage = path.endsWith('/doctor.html');
    const isReceptionPage = path.endsWith('/reception.html');

    if (!isAdminPage && !isDoctorPage && !isReceptionPage) return;

    function getClinicSlug() {
        const q = new URLSearchParams(window.location.search).get('clinic');
        if (q) return q;
        if (isDoctorPage) return localStorage.getItem('saved_doc_clinic_slug') || 'default-clinic';
        if (isReceptionPage) return localStorage.getItem('saved_rec_clinic_slug') || 'default-clinic';
        return '';
    }

    function showSecurityModal(reasonMsg) {
        if (document.getElementById('cf-sec-overlay')) {
            const errEl = document.getElementById('cf-sec-err');
            if (errEl && reasonMsg) errEl.textContent = reasonMsg;
            return;
        }

        const title = isAdminPage
            ? '🔐 تسجيل دخول الأدمن'
            : (isDoctorPage ? '🩺 تسجيل دخول الطبيب' : '🖥️ تسجيل دخول مكتب الاستقبال');

        const subtitle = isAdminPage
            ? 'أدخل كلمة مرور الأدمن المحفوظة في إعدادات السيرفر'
            : 'أدخل كلمة مرور الطبيب أو العيادة (أو كلمة مرور الأدمن)';

        const overlay = document.createElement('div');
        overlay.id = 'cf-sec-overlay';
        overlay.setAttribute('dir', 'rtl');
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:999999;background:rgba(15,23,42,0.94);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Tajawal,Arial,sans-serif;';

        overlay.innerHTML = `
            <div style="background:#1e293b;color:#f8fafc;border:2px solid #10b981;border-radius:22px;padding:30px 24px;width:100%;max-width:410px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.45);">
                <div style="font-size:2.6rem;margin-bottom:8px;">🛡️</div>
                <h2 style="margin:0 0 8px;color:#10b981;font-size:1.35rem;">${title}</h2>
                <p style="margin:0 0 18px;color:#94a3b8;font-size:0.9rem;font-weight:700;">${subtitle}</p>
                <input id="cf-sec-pass" type="password" autocomplete="current-password" placeholder="أدخل كلمة المرور هنا..."
                    style="width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1.05rem;text-align:center;margin-bottom:12px;outline:none;font-family:inherit;">
                <div id="cf-sec-err" style="color:#f87171;font-size:0.88rem;font-weight:800;min-height:22px;margin-bottom:10px;">${reasonMsg || ''}</div>
                <button id="cf-sec-submit"
                    style="width:100%;padding:14px;border:none;border-radius:12px;background:#10b981;color:#fff;font-size:1.05rem;font-weight:800;cursor:pointer;font-family:inherit;">
                    دخول آمن
                </button>
            </div>
        `;

        document.body.appendChild(overlay);

        const passInput = document.getElementById('cf-sec-pass');
        const submitBtn = document.getElementById('cf-sec-submit');
        const errBox = document.getElementById('cf-sec-err');

        async function doLogin() {
            const password = passInput.value;
            if (!password) {
                errBox.textContent = 'يرجى إدخال كلمة المرور';
                return;
            }
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري التحقق...';
            errBox.textContent = '';

            try {
                const endpoint = isAdminPage ? '/api/admin/login' : '/api/auth/staff-login';
                const payload = isAdminPage
                    ? { password }
                    : { clinic_slug: getClinicSlug(), password };

                const res = await originalFetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify(payload)
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    window.location.reload();
                } else {
                    errBox.textContent = data.error || 'كلمة المرور غير صحيحة';
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'دخول آمن';
                    passInput.select();
                }
            } catch (e) {
                errBox.textContent = 'تعذر الاتصال بالخادم';
                submitBtn.disabled = false;
                submitBtn.textContent = 'دخول آمن';
            }
        }

        submitBtn.addEventListener('click', doLogin);
        passInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
        setTimeout(() => passInput.focus(), 80);
    }

    function addLogoutButton() {
        if (document.getElementById('cf-sec-logout')) return;
        const style = document.createElement('style');
        style.textContent = '@media print { #cf-sec-logout, #cf-sec-overlay { display: none !important; } }';
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'cf-sec-logout';
        btn.textContent = '🔒 قفل الجلسة';
        btn.style.cssText =
            'position:fixed;bottom:16px;right:16px;z-index:9400;background:#1e293b;color:#f8fafc;border:1px solid #ef4444;border-radius:999px;padding:8px 14px;font-family:Tajawal,Arial,sans-serif;font-size:0.8rem;font-weight:800;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.2);';
        btn.addEventListener('click', async () => {
            await originalFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            window.location.reload();
        });
        document.body.appendChild(btn);
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const nextInit = Object.assign({ credentials: 'same-origin' }, init || {});
        const res = await originalFetch(input, nextInit);
        if (res.status === 401) {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (!url.includes('/api/admin/login') && !url.includes('/api/auth/staff-login') && !url.includes('/api/doctor/verify-password')) {
                showSecurityModal('انتهت الجلسة أو يلزم تسجيل الدخول للمتابعة');
            }
        }
        return res;
    };

    async function verifySessionOnLoad() {
        try {
            const slug = getClinicSlug();
            const res = await originalFetch(`/api/auth/me?clinic=${encodeURIComponent(slug)}`, {
                credentials: 'same-origin'
            });
            const data = await res.json();
            if (isAdminPage && data.role !== 'admin') {
                showSecurityModal('');
            } else if ((isDoctorPage || isReceptionPage) && !data.authorized) {
                showSecurityModal('');
            } else {
                addLogoutButton();
            }
        } catch (e) {
            showSecurityModal('تعذر التحقق من الجلسة');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', verifySessionOnLoad);
    } else {
        verifySessionOnLoad();
    }
})();