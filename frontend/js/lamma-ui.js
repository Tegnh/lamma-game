/* ══════════════════════════════════════════
   لمّة — Shared UI Logic (lamma-ui.js)
   ══════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Page detection ── */
  const path = window.location.pathname;
  const isIndex  = path.endsWith('index.html') || path.endsWith('/');
  const isKalak  = path.includes('kalak.html');
  const isTarraq = path.includes('tarraq.html');

  /* ── Persist settings in localStorage ── */
  const STORE = {
    get: (k, def) => {
      try {
        const v = localStorage.getItem('lamma_' + k);
        return v === null ? def : JSON.parse(v);
      } catch { return def; }
    },
    set: (k, v) => {
      try { localStorage.setItem('lamma_' + k, JSON.stringify(v)); } catch {}
    }
  };

  /* ── Apply saved dark mode on load ── */
  if (STORE.get('darkMode', false)) {
    document.body.classList.add('dark-mode');
  }

  /* ── Bottom Nav HTML ── */
  function buildNav() {
    const nav = document.createElement('nav');
    nav.className = 'lamma-bottom-nav';
    nav.setAttribute('aria-label', 'التنقل الرئيسي');
    nav.innerHTML = `
      <button class="lamma-nav-btn nav-profile" id="nav-profile" aria-label="ملفي">
        <span class="lamma-nav-icon">👤</span>
        <span class="lamma-nav-label">ملفي</span>
      </button>

      <button class="lamma-nav-btn nav-news" id="nav-news" aria-label="آخر الأخبار">
        <span class="lamma-nav-icon">📢</span>
        <span class="lamma-nav-label">الأخبار</span>
      </button>

      <a href="index.html" class="lamma-nav-btn nav-home ${isIndex ? 'active' : ''}"
         id="nav-home" aria-label="الصفحة الرئيسية">
        <span class="lamma-nav-icon">🏠</span>
        <span class="lamma-nav-label">الرئيسية</span>
      </a>

      <button class="lamma-nav-btn nav-suggest" id="nav-suggest" aria-label="اقتراحات">
        <span class="lamma-nav-icon">💡</span>
        <span class="lamma-nav-label">اقتراح</span>
      </button>

      <button class="lamma-nav-btn nav-online" id="nav-online" aria-label="غرف أونلاين">
        <span class="lamma-nav-icon">🌐</span>
        <span class="lamma-nav-label">أونلاين</span>
      </button>
    `;
    document.body.appendChild(nav);
  }

  /* ── Settings Button HTML ── */
  function buildSettingsBtn() {
    const btn = document.createElement('button');
    btn.className = 'lamma-settings-btn';
    btn.id = 'lamma-settings-btn';
    btn.setAttribute('aria-label', 'الإعدادات');
    btn.textContent = '⚙️';
    document.body.appendChild(btn);
  }

  /* ── Settings Modal HTML ── */
  function buildSettingsModal() {
    const overlay = document.createElement('div');
    overlay.className = 'lamma-settings-overlay';
    overlay.id = 'settings-overlay';
    overlay.innerHTML = `
      <div class="lamma-settings-modal" role="dialog" aria-label="الإعدادات">
        <div class="lamma-settings-header">
          <span class="lamma-settings-title">⚙️ الإعدادات</span>
          <button class="lamma-settings-close" id="settings-close">✕</button>
        </div>

        <div class="lamma-setting-row">
          <span class="lamma-setting-label">🌙 الوضع الليلي</span>
          <label class="lamma-toggle" aria-label="تفعيل الوضع الليلي">
            <input type="checkbox" id="toggle-dark" ${STORE.get('darkMode', false) ? 'checked' : ''}>
            <span class="lamma-toggle-track"></span>
          </label>
        </div>

        <div class="lamma-setting-row">
          <span class="lamma-setting-label">🔊 الأصوات</span>
          <label class="lamma-toggle" aria-label="تفعيل الأصوات">
            <input type="checkbox" id="toggle-sound" ${STORE.get('sound', true) ? 'checked' : ''}>
            <span class="lamma-toggle-track"></span>
          </label>
        </div>

        <div class="lamma-setting-row">
          <span class="lamma-setting-label">📳 الاهتزاز</span>
          <label class="lamma-toggle" aria-label="تفعيل الاهتزاز">
            <input type="checkbox" id="toggle-vibrate" ${STORE.get('vibrate', true) ? 'checked' : ''}>
            <span class="lamma-toggle-track"></span>
          </label>
        </div>

      </div>
    `;
    document.body.appendChild(overlay);
  }

  /* ── Sheet Modals (News, Profile, Suggest, Online) ── */
  function buildSheets() {
    const sheets = [
      {
        id: 'sheet-news',
        title: '📢 آخر أخبار لمّة',
        content: `
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div style="background:#A8E6CF;border:2px solid #1A1A1A;border-radius:10px;padding:12px;">
              <div style="font-weight:800;font-size:0.9rem;color:#1A1A1A;">🎉 لعبة طرّاق متاحة الآن!</div>
              <div style="font-size:0.8rem;color:#444;margin-top:4px;">اضغط الجرس أول من الجميع وأجب على الأسئلة.</div>
            </div>
            <div style="background:#FFD3B6;border:2px solid #1A1A1A;border-radius:10px;padding:12px;">
              <div style="font-weight:800;font-size:0.9rem;color:#1A1A1A;">⚙️ تحديث الإعدادات</div>
              <div style="font-size:0.8rem;color:#444;margin-top:4px;">الآن يمكنك تخصيص عدد اللاعبين في الغرفة.</div>
            </div>
            <div class="lamma-empty-state">المزيد من التحديثات قريباً! 🚀</div>
          </div>
        `
      },
      {
        id: 'sheet-profile',
        title: '👤 ملفي',
        content: `
          <div class="lamma-empty-state">
            <div style="font-size:2rem;margin-bottom:8px;">🎮</div>
            <div style="font-weight:700;color:#1A1A1A;margin-bottom:4px;">سجّل حسابك</div>
            <div>الملف الشخصي وإحصائيات الألعاب ستكون متاحة قريباً!</div>
          </div>
        `
      },
      {
        id: 'sheet-suggest',
        title: '💡 اقتراحاتك',
        content: `
          <div style="display:flex;flex-direction:column;gap:12px;">
            <textarea
              id="suggest-text"
              placeholder="اكتب اقتراحك أو ملاحظتك هنا..."
              style="width:100%;min-height:100px;padding:12px;
                     border:2px solid #1A1A1A;border-radius:10px;
                     box-shadow:3px 3px 0px #1A1A1A;font-family:inherit;
                     font-size:0.95rem;resize:vertical;direction:rtl;"
            ></textarea>
            <button onclick="lammaSubmitSuggestion()"
              style="background:#A8E6CF;border:3px solid #1A1A1A;
                     box-shadow:4px 4px 0px #1A1A1A;border-radius:12px;
                     padding:12px;font-size:1rem;font-weight:800;
                     cursor:pointer;font-family:inherit;color:#1A1A1A;">
              إرسال الاقتراح 🚀
            </button>
          </div>
        `
      },
      {
        id: 'sheet-online',
        title: '🌐 الغرف المتاحة أونلاين',
        content: `
          <div class="lamma-empty-state">
            <div style="font-size:2rem;margin-bottom:8px;">🔍</div>
            <div style="font-weight:700;color:#1A1A1A;margin-bottom:4px;">جاري التطوير</div>
            <div>سيتمكن قريباً من الانضمام لغرف عشوائية مع لاعبين جدد!</div>
          </div>
        `
      }
    ];

    sheets.forEach(({ id, title, content }) => {
      const overlay = document.createElement('div');
      overlay.className = 'lamma-modal-overlay';
      overlay.id = id + '-overlay';
      overlay.innerHTML = `
        <div class="lamma-modal-sheet">
          <div class="lamma-sheet-header">
            <span class="lamma-sheet-title">${title}</span>
            <button class="lamma-sheet-close" onclick="lammaCloseSheet('${id}')">✕</button>
          </div>
          <div>${content}</div>
        </div>
      `;
      document.body.appendChild(overlay);
    });
  }

  /* ── Event wiring ── */
  function wireEvents() {
    /* Settings button */
    document.getElementById('lamma-settings-btn')
      ?.addEventListener('click', () => {
        document.getElementById('settings-overlay').classList.add('open');
      });

    document.getElementById('settings-close')
      ?.addEventListener('click', () => {
        document.getElementById('settings-overlay').classList.remove('open');
      });

    document.getElementById('settings-overlay')
      ?.addEventListener('click', function (e) {
        if (e.target === this) this.classList.remove('open');
      });

    /* Dark mode toggle */
    document.getElementById('toggle-dark')
      ?.addEventListener('change', function () {
        document.body.classList.toggle('dark-mode', this.checked);
        STORE.set('darkMode', this.checked);
      });

    /* Sound toggle */
    document.getElementById('toggle-sound')
      ?.addEventListener('change', function () {
        STORE.set('sound', this.checked);
        window.lammaSoundEnabled = this.checked;
      });

    /* Vibrate toggle */
    document.getElementById('toggle-vibrate')
      ?.addEventListener('change', function () {
        STORE.set('vibrate', this.checked);
        window.lammaVibrateEnabled = this.checked;
      });

    /* Nav buttons → sheets */
    const navMap = {
      'nav-news':    'sheet-news',
      'nav-profile': 'sheet-profile',
      'nav-suggest': 'sheet-suggest',
      'nav-online':  'sheet-online',
    };

    Object.entries(navMap).forEach(([btnId, sheetId]) => {
      document.getElementById(btnId)
        ?.addEventListener('click', () => lammaOpenSheet(sheetId));
    });

    /* Close sheets on overlay click */
    document.querySelectorAll('.lamma-modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', function (e) {
        if (e.target === this) this.classList.remove('open');
      });
    });
  }

  /* ── Global helpers ── */
  window.lammaOpenSheet = function (id) {
    document.getElementById(id + '-overlay')?.classList.add('open');
  };

  window.lammaCloseSheet = function (id) {
    document.getElementById(id + '-overlay')?.classList.remove('open');
  };

  window.lammaSubmitSuggestion = function () {
    const text = document.getElementById('suggest-text')?.value.trim();
    if (!text) return;
    alert('شكراً على اقتراحك! سنأخذه بعين الاعتبار 🙏');
    document.getElementById('suggest-text').value = '';
    lammaCloseSheet('sheet-suggest');
  };

  /* ── Init on DOM ready ── */
  function init() {
    buildNav();
    buildSettingsBtn();
    buildSettingsModal();
    buildSheets();
    wireEvents();

    /* Expose sound/vibrate state globally */
    window.lammaSoundEnabled   = STORE.get('sound', true);
    window.lammaVibrateEnabled = STORE.get('vibrate', true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
