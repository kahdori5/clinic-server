(function () {
    'use strict';

    const path = window.location.pathname.toLowerCase();
    const isAdminPage = path.endsWith('/admin.html');
    const isDoctorPage = path.endsWith('/doctor.html');
    const isReceptionPage = path.endsWith('/reception.html');

    if (!isAdminPage && !isDoctorPage && !isReceptionPage) return;

    const PAGE_TYPE = isAdminPage ? 'admin' : (isDoctorPage ? 'doctor' : 'reception');

    function getClinicSlug() {
        const q = new URLSearchParams(window.location.search).get('clinic');
        if (q) return q;
        if (isDoctorPage) return localStorage.getItem('saved_doc_clinic_slug') || 'default-clinic';
        if (isReceptionPage) return localStorage.getItem('saved_rec_clinic_slug') || 'default-clinic';
        return '';
    }

    function injectPrintStyles() {
        if (document.getElementById('cf-sec-styles')) return;
        const style = document.createElement('style');
        style.id = 'cf-sec-styles';
        style.textContent = `
            #cf-sec-toolbar {
                position: fixed;
                bottom: 16px;
                right: 16px;
                z-index: 9400;
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                direction: rtl;
                font-family: 'Tajawal', Arial, sans-serif;
            }
            .cf-sec-chip {
                background: #1e293b;
                color: #f8fafc;
                border: 1px solid #334155;
                border-radius: 999px;
                padding: 8px 14px;
                font-family: inherit;
                font-size: 0.8rem;
                font-weight: 800;
                cursor: pointer;
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
            }
            .cf-sec-chip:hover { filter: brightness(1.12); }
            .cf-sec-chip.pass { border-color: #10b981; }
            .cf-sec-chip.reset { border-color: #3b82f6; }
            .cf-sec-chip.lock { border-color: #ef4444; }
            @media print {
                #cf-sec-toolbar, #cf-sec-overlay, #cf-pass-modal { display: none !important; }
            }
        `;
        document.head.appendChild(style);
    }

    function removeExistingOverlay() {
        const old = document.getElementById('cf-sec-overlay');
        if (old) old.remove();
    }

    // شاشة تسجيل الدخول أو إنشاء كلمة المرور لأول مرة
    function showAuthOverlay({ needsSetup, reasonMsg }) {
        injectPrintStyles();
        removeExistingOverlay();

        const labels = {
            admin: {
                loginTitle: '🔐 تسجيل دخول الأدمن',
                loginSub: 'أدخل كلمة مرور الأدمن الخاصة بلوحة الإدارة فقط'
            },
            doctor: {
                loginTitle: '🩺 تسجيل دخول الطبيب',
                loginSub: 'أدخل كلمة مرور الطبيب الخاصة بهذه الصفحة فقط',
                setupTitle: '🆕 إنشاء كلمة مرور الطبيب',
                setupSub: 'اختر كلمة مرور خاصة بحساب الطبيب لحماية ملفات المرضى (6 أحرف على الأقل)'
            },
            reception: {
                loginTitle: '🖥️ تسجيل دخول مكتب الاستقبال',
                loginSub: 'أدخل كلمة مرور الاستقبال الخاصة بهذه العيادة فقط',
                setupTitle: '🆕 إنشاء كلمة مرور مكتب الاستقبال',
                setupSub: 'اختر كلمة مرور مستقلة لمكتب الاستقبال (6 أحرف على الأقل)'
            }
        }[PAGE_TYPE];

        const title = needsSetup ? labels.setupTitle : labels.loginTitle;
        const subtitle = needsSetup ? labels.setupSub : labels.loginSub;

        const overlay = document.createElement('div');
        overlay.id = 'cf-sec-overlay';
        overlay.setAttribute('dir', 'rtl');
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:999999;background:rgba(15,23,42,0.95);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Tajawal,Arial,sans-serif;';

        const confirmInputHtml = needsSetup
            ? `<input id="cf-sec-pass-confirm" type="password" autocomplete="new-password" placeholder="أعد كتابة كلمة المرور للتأكيد..."
                style="width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1.02rem;text-align:center;margin-bottom:12px;outline:none;font-family:inherit;">`
            : '';

        overlay.innerHTML = `
            <div style="background:#1e293b;color:#f8fafc;border:2px solid #10b981;border-radius:22px;padding:30px 24px;width:100%;max-width:420px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.45);">
                <div style="font-size:2.6rem;margin-bottom:8px;">${needsSetup ? '🔑' : '🛡️'}</div>
                <h2 style="margin:0 0 8px;color:#10b981;font-size:1.35rem;">${title}</h2>
                <p style="margin:0 0 18px;color:#94a3b8;font-size:0.9rem;font-weight:700;">${subtitle}</p>
                <input id="cf-sec-pass" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" placeholder="${needsSetup ? 'اكتب كلمة المرور الجديدة...' : 'أدخل كلمة المرور هنا...'}"
                    style="width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1.05rem;text-align:center;margin-bottom:12px;outline:none;font-family:inherit;">
                ${confirmInputHtml}
                <div id="cf-sec-err" style="color:#f87171;font-size:0.88rem;font-weight:800;min-height:22px;margin-bottom:10px;"></div>
                <button id="cf-sec-submit"
                    style="width:100%;padding:14px;border:none;border-radius:12px;background:#10b981;color:#fff;font-size:1.05rem;font-weight:800;cursor:pointer;font-family:inherit;">
                    ${needsSetup ? 'حفظ كلمة المرور والدخول' : 'دخول آمن'}
                </button>
            </div>
        `;

        document.body.appendChild(overlay);

        const passInput = document.getElementById('cf-sec-pass');
        const confirmInput = document.getElementById('cf-sec-pass-confirm');
        const submitBtn = document.getElementById('cf-sec-submit');
        const errBox = document.getElementById('cf-sec-err');
        if (reasonMsg) errBox.textContent = reasonMsg;

        async function handleSubmit() {
            const password = passInput.value;
            if (!password) {
                errBox.textContent = 'يرجى إدخال كلمة المرور.';
                return;
            }
            if (needsSetup) {
                if (password.length < 6) {
                    errBox.textContent = 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.';
                    return;
                }
                if (confirmInput && password !== confirmInput.value) {
                    errBox.textContent = 'كلمتا المرور غير متطابقتين.';
                    return;
                }
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري التحقق...';
            errBox.textContent = '';

            try {
                let endpoint = '/api/admin/login';
                let payload = { password };

                if (needsSetup) {
                    endpoint = '/api/auth/setup-password';
                    payload = { page: PAGE_TYPE, clinic_slug: getClinicSlug(), new_password: password };
                } else if (isDoctorPage) {
                    endpoint = '/api/auth/doctor-login';
                    payload = { clinic_slug: getClinicSlug(), password };
                } else if (isReceptionPage) {
                    endpoint = '/api/auth/reception-login';
                    payload = { clinic_slug: getClinicSlug(), password };
                }

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
                    errBox.textContent = data.error || 'كلمة المرور غير صحيحة.';
                    submitBtn.disabled = false;
                    submitBtn.textContent = needsSetup ? 'حفظ كلمة المرور والدخول' : 'دخول آمن';
                    passInput.select();
                }
            } catch (e) {
                errBox.textContent = 'تعذر الاتصال بالخادم.';
                submitBtn.disabled = false;
                submitBtn.textContent = needsSetup ? 'حفظ كلمة المرور والدخول' : 'دخول آمن';
            }
        }

        submitBtn.addEventListener('click', handleSubmit);
        passInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (confirmInput) confirmInput.focus();
                else handleSubmit();
            }
        });
        if (confirmInput) {
            confirmInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleSubmit();
            });
        }
        setTimeout(() => passInput.focus(), 80);
    }

    // نافذة تغيير كلمة المرور الخاصة بهذه الصفحة
    function openChangePasswordModal() {
        const existing = document.getElementById('cf-pass-modal');
        if (existing) existing.remove();

        const titles = {
            admin: '🔑 تغيير كلمة مرور الأدمن',
            doctor: '🔑 تغيير كلمة مرور الطبيب',
            reception: '🔑 تغيير كلمة مرور مكتب الاستقبال'
        };

        const modal = document.createElement('div');
        modal.id = 'cf-pass-modal';
        modal.setAttribute('dir', 'rtl');
        modal.style.cssText =
            'position:fixed;inset:0;z-index:999998;background:rgba(15,23,42,0.82);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Tajawal,Arial,sans-serif;';

        modal.innerHTML = `
            <div style="background:#1e293b;color:#f8fafc;border:2px solid #10b981;border-radius:20px;padding:26px 22px;width:100%;max-width:410px;text-align:center;position:relative;box-shadow:0 20px 50px rgba(0,0,0,0.45);">
                <button id="cf-pm-close" style="position:absolute;top:14px;left:14px;background:#0f172a;color:#fff;border:1px solid #334155;width:32px;height:32px;border-radius:50%;cursor:pointer;font-weight:bold;">✕</button>
                <h3 style="margin:0 0 16px;color:#10b981;font-size:1.25rem;">${titles[PAGE_TYPE]}</h3>
                <input id="cf-pm-curr" type="password" autocomplete="current-password" placeholder="كلمة المرور الحالية..."
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1rem;text-align:center;margin-bottom:10px;outline:none;font-family:inherit;">
                <input id="cf-pm-new" type="password" autocomplete="new-password" placeholder="كلمة المرور الجديدة (6 أحرف فأكثر)..."
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1rem;text-align:center;margin-bottom:10px;outline:none;font-family:inherit;">
                <input id="cf-pm-conf" type="password" autocomplete="new-password" placeholder="تأكيد كلمة المرور الجديدة..."
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1rem;text-align:center;margin-bottom:10px;outline:none;font-family:inherit;">
                <div id="cf-pm-msg" style="font-size:0.88rem;font-weight:800;min-height:22px;margin-bottom:10px;"></div>
                <button id="cf-pm-save"
                    style="width:100%;padding:13px;border:none;border-radius:12px;background:#10b981;color:#fff;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;">
                    💾 حفظ كلمة المرور الجديدة
                </button>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('cf-pm-close').onclick = () => modal.remove();
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const saveBtn = document.getElementById('cf-pm-save');
        const msgBox = document.getElementById('cf-pm-msg');

        saveBtn.addEventListener('click', async () => {
            const current_password = document.getElementById('cf-pm-curr').value;
            const new_password = document.getElementById('cf-pm-new').value;
            const conf = document.getElementById('cf-pm-conf').value;

            if (!current_password || !new_password) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'يرجى ملء جميع الحقول.';
                return;
            }
            if (new_password.length < 6) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'يجب أن تكون كلمة المرور الجديدة 6 أحرف على الأقل.';
                return;
            }
            if (new_password !== conf) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'كلمتا المرور الجديدتان غير متطابقتين.';
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'جاري الحفظ...';

            try {
                const res = await originalFetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        page: PAGE_TYPE,
                        clinic_slug: getClinicSlug(),
                        current_password,
                        new_password
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    msgBox.style.color = '#34d399';
                    msgBox.textContent = '✔️ ' + (data.message || 'تم التغيير بنجاح');
                    setTimeout(() => modal.remove(), 1200);
                } else {
                    msgBox.style.color = '#f87171';
                    msgBox.textContent = data.error || 'تعذر تغيير كلمة المرور.';
                    saveBtn.disabled = false;
                    saveBtn.textContent = '💾 حفظ كلمة المرور الجديدة';
                }
            } catch (e) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'تعذر الاتصال بالخادم.';
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 حفظ كلمة المرور الجديدة';
            }
        });
    }

    // نافذة مساعدة للأدمن فقط لإعادة تعيين كلمة مرور طبيب أو استقبال عند النسيان
    function openAdminResetModal() {
        const existing = document.getElementById('cf-pass-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'cf-pass-modal';
        modal.setAttribute('dir', 'rtl');
        modal.style.cssText =
            'position:fixed;inset:0;z-index:999998;background:rgba(15,23,42,0.82);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Tajawal,Arial,sans-serif;';

        modal.innerHTML = `
            <div style="background:#1e293b;color:#f8fafc;border:2px solid #3b82f6;border-radius:20px;padding:26px 22px;width:100%;max-width:420px;text-align:center;position:relative;box-shadow:0 20px 50px rgba(0,0,0,0.45);">
                <button id="cf-rm-close" style="position:absolute;top:14px;left:14px;background:#0f172a;color:#fff;border:1px solid #334155;width:32px;height:32px;border-radius:50%;cursor:pointer;font-weight:bold;">✕</button>
                <h3 style="margin:0 0 12px;color:#3b82f6;font-size:1.2rem;">🛠️ تعيين كلمة مرور طبيب أو استقبال</h3>
                <p style="margin:0 0 14px;color:#94a3b8;font-size:0.84rem;font-weight:700;">استخدمها فقط إذا نسي الطبيب أو الممرضة كلمة مرورهم</p>
                <select id="cf-rm-type"
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:0.98rem;margin-bottom:10px;outline:none;font-family:inherit;font-weight:700;">
                    <option value="doctor">🩺 حساب الطبيب</option>
                    <option value="reception">🖥️ حساب مكتب الاستقبال</option>
                </select>
                <input id="cf-rm-slug" type="text" placeholder="رابط الطبيب أو العيادة (مثال: azhar)..."
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1rem;text-align:center;margin-bottom:10px;outline:none;font-family:inherit;">
                <input id="cf-rm-pass" type="password" placeholder="كلمة المرور الجديدة (6 أحرف فأكثر)..."
                    style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#fff;font-size:1rem;text-align:center;margin-bottom:10px;outline:none;font-family:inherit;">
                <div id="cf-rm-msg" style="font-size:0.88rem;font-weight:800;min-height:22px;margin-bottom:10px;"></div>
                <button id="cf-rm-save"
                    style="width:100%;padding:13px;border:none;border-radius:12px;background:#3b82f6;color:#fff;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;">
                    💾 حفظ كلمة المرور
                </button>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('cf-rm-close').onclick = () => modal.remove();
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const saveBtn = document.getElementById('cf-rm-save');
        const msgBox = document.getElementById('cf-rm-msg');

        saveBtn.addEventListener('click', async () => {
            const target_type = document.getElementById('cf-rm-type').value;
            const clinic_slug = document.getElementById('cf-rm-slug').value.trim();
            const new_password = document.getElementById('cf-rm-pass').value;

            if (!clinic_slug || new_password.length < 6) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'أدخل رابط العيادة/الطبيب وكلمة مرور لا تقل عن 6 أحرف.';
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'جاري التحديث...';

            try {
                const res = await originalFetch('/api/admin/reset-staff-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ target_type, clinic_slug, new_password })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    msgBox.style.color = '#34d399';
                    msgBox.textContent = '✔️ ' + (data.message || 'تم التحديث بنجاح');
                    setTimeout(() => modal.remove(), 1400);
                } else {
                    msgBox.style.color = '#f87171';
                    msgBox.textContent = data.error || 'تعذر التحديث.';
                    saveBtn.disabled = false;
                    saveBtn.textContent = '💾 حفظ كلمة المرور';
                }
            } catch (e) {
                msgBox.style.color = '#f87171';
                msgBox.textContent = 'تعذر الاتصال بالخادم.';
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 حفظ كلمة المرور';
            }
        });
    }

    function addSecurityToolbar() {
        if (document.getElementById('cf-sec-toolbar')) return;
        injectPrintStyles();

        const bar = document.createElement('div');
        bar.id = 'cf-sec-toolbar';

        const changeBtn = document.createElement('button');
        changeBtn.className = 'cf-sec-chip pass';
        changeBtn.textContent = '🔑 تغيير كلمة المرور';
        changeBtn.addEventListener('click', openChangePasswordModal);
        bar.appendChild(changeBtn);

        if (isAdminPage) {
            const resetBtn = document.createElement('button');
            resetBtn.className = 'cf-sec-chip reset';
            resetBtn.textContent = '🛠️ كلمة سر طبيب/استقبال';
            resetBtn.addEventListener('click', openAdminResetModal);
            bar.appendChild(resetBtn);
        }

        const lockBtn = document.createElement('button');
        lockBtn.className = 'cf-sec-chip lock';
        lockBtn.textContent = '🔒 قفل الجلسة';
        lockBtn.addEventListener('click', async () => {
            await originalFetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ page: PAGE_TYPE })
            });
            window.location.reload();
        });
        bar.appendChild(lockBtn);

        document.body.appendChild(bar);
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const nextInit = Object.assign({ credentials: 'same-origin' }, init || {});
        const res = await originalFetch(input, nextInit);
        if (res.status === 401) {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (
                !url.includes('/api/admin/login') &&
                !url.includes('/api/auth/') &&
                !url.includes('/api/doctor/verify-password')
            ) {
                verifySessionOnLoad('انتهت الجلسة أو يلزم تسجيل الدخول للمتابعة.');
            }
        }
        return res;
    };

    async function verifySessionOnLoad(reasonMsg) {
        try {
            const slug = getClinicSlug();
            const res = await originalFetch(
                `/api/auth/me?page=${encodeURIComponent(PAGE_TYPE)}&clinic=${encodeURIComponent(slug)}`,
                { credentials: 'same-origin' }
            );
            const data = await res.json();

            if (data.notFound) return;

            if (!data.authorized) {
                showAuthOverlay({
                    needsSetup: Boolean(data.needsSetup),
                    reasonMsg: reasonMsg || ''
                });
            } else {
                addSecurityToolbar();
            }
        } catch (e) {
            showAuthOverlay({ needsSetup: false, reasonMsg: 'تعذر التحقق من الجلسة.' });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => verifySessionOnLoad(''));
    } else {
        verifySessionOnLoad('');
    }
})();