// game-platform/frontend/js/ui-kalak.js

(function () {
  'use strict';

  const client = window.socketClient;

  // ─── Team metadata (id → display info) ────────────────────────────────────
  const TEAM_META = {
    red:    { label: 'الأحمر',  emoji: '🔴', color: '#ef4444', bg: 'rgba(239,68,68,0.1)'  },
    blue:   { label: 'الأزرق',  emoji: '🔵', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    green:  { label: 'الأخضر',  emoji: '🟢', color: '#22c55e', bg: 'rgba(34,197,94,0.1)'  },
    yellow: { label: 'الأصفر', emoji: '🟡', color: '#eab308', bg: 'rgba(234,179,8,0.1)'  },
  };

  // ─── Category → Emoji map (single source of truth for all screens) ────────
  const CATEGORY_ICONS = {
    'جغرافيا':       '🌍',
    'حيوانات':       '🦁',
    'علوم':          '🔬',
    'فضاء':          '🚀',
    'تاريخ':         '🏛️',
    'فن':            '🎨',
    'دين':           '🕌',
    'أسئلة غريبة':  '👽',
    'أعلام':         '🏳️',
    'تكنولوجيا':    '💻',
    'كوارث طبيعية': '🌋',
    'أمثال':         '📜',
    'ألغاز':         '🧩',
    'شخصيات':        '👤',
    'لغة وأدب':     '📚',
    'رياضة':         '⚽',
    'طعام':          '🍕',
    'موسيقى':        '🎵',
    'معلومات عامة': '💡',
    'أسئلة عامة':  '🧠',
  };

  let currentRoom = null;
  let isHost = false;
  let isSpectator = false;
  let hasAnswered = false;
  let awaitingFakeAnswer = false;
  let playerMap = new Map();
  let timerInterval = null;
  let currentSettings = { totalRounds: 5, answerTime: 60, categories: [], teamsMode: false, teamsCount: 2, maxPlayers: 8 };
  let myTeamId = null;
  let isInGame = false;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screenJoin = $('#screen-join');
  const screenLobby = $('#screen-lobby');
  const screenCategorySelection = $('#screen-category-selection');
  const screenAnswering = $('#screen-answering');
  const screenVoting = $('#screen-voting');
  const screenReveal = $('#screen-reveal');
  const screenScoreboard = $('#screen-scoreboard');
  const screenGameEnd = $('#screen-game-end');

  function showScreen(screen) {
    $$('.phase-screen').forEach((s) => s.classList.remove('active'));
    screen.classList.add('active');
  }

  async function init() {
    try {
      await client.connect();
      setupEventListeners();
      setupSocketListeners();
      client.tryRestoreSession(); // attempt silent session recovery after listeners are ready
    } catch (err) {
      showToast('تعذّر الاتصال بالخادم. حاول لاحقاً.');
      console.error(err);
    }
  }

  function setupEventListeners() {
    $('#btn-create-room').addEventListener('click', () => {
      const username = $('#input-username').value.trim();
      if (!username) return showToast('يرجى إدخال اسمك');
      isSpectator = $('#input-spectator').checked;
      client.createRoom(username, isSpectator);
    });

    $('#btn-join-room').addEventListener('click', () => {
      const username = $('#input-username').value.trim();
      const code = $('#input-room-code').value.trim().toUpperCase();
      if (!username) return showToast('يرجى إدخال اسمك');
      if (!code) return showToast('يرجى إدخال كود الغرفة');
      isSpectator = $('#input-spectator').checked;
      client.joinRoom(code, username, isSpectator);
    });

    $('#btn-start-game').addEventListener('click', () => client.startGame());
    $('#btn-next-round').addEventListener('click', () => client.nextRound());
    $('#btn-back-lobby').addEventListener('click', () => showScreen(screenLobby));

    $('#btn-copy-code').addEventListener('click', () => {
      if (currentRoom) {
        navigator.clipboard.writeText(currentRoom.code).then(() => {
          $('#btn-copy-code').textContent = 'تم النسخ ✓';
          setTimeout(() => $('#btn-copy-code').textContent = 'نسخ الكود', 2000);
        });
      }
    });

    $('#setting-rounds').addEventListener('change', (e) => client.updateSettings({ totalRounds: Number(e.target.value) }));
    $('#setting-answer-time').addEventListener('change', (e) => client.updateSettings({ answerTime: Number(e.target.value) }));
    $('#select-max-players').addEventListener('change', (e) => client.updateSettings({ maxPlayers: Number(e.target.value) }));

    $('#setting-teams-mode').addEventListener('change', (e) => {
      const teamsMode = e.target.checked;
      $('#setting-teams-count-row').classList.toggle('hidden', !teamsMode);
      client.updateSettings({ teamsMode, teamsCount: Number($('#setting-teams-count').value) });
    });

    $('#setting-teams-count').addEventListener('change', (e) => {
      client.updateSettings({ teamsCount: Number(e.target.value) });
    });

    $$('#setting-categories input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const selectedCategories = Array.from($$('#setting-categories input[type="checkbox"]:checked')).map(cb => cb.value);
        client.updateSettings({ categories: selectedCategories });
      });
    });

    // التحكم الموحد بزر إرسال الإجابات
    $('#btn-submit-answer').addEventListener('click', (e) => {
      e.preventDefault();
      if (hasAnswered) return;

      const answer = $('#input-answer').value.trim();
      if (!answer) return;

      const btn = $('#btn-submit-answer');
      btn.disabled = true;
      btn.textContent = 'جاري الإرسال... ⏳';

      if (awaitingFakeAnswer) {
        client.submitFakeAnswer(answer);
      } else {
        client.submitAnswer(answer);
      }
    });

    $('#input-answer').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-submit-answer').click();
    });
  }

  function setupSocketListeners() {
    client.on('room:update', (room) => {
      currentRoom = room;
      client.roomCode = room.code;
      isHost = room.hostId === client.getMyId();

      const me = room.players.find((p) => p.id === client.getMyId());
      if (me) {
        isSpectator = me.isSpectator;
        if (me.teamId) myTeamId = me.teamId;
      }

      if (room.settings) {
        currentSettings = room.settings;
        renderSettings(currentSettings);
      }

      playerMap.clear();
      room.players.forEach((p) => playerMap.set(p.id, p.username));

      renderLobby(room);
      if (!isInGame) {
        showScreen(screenLobby);
      }
    });

    client.on('game:phase', (payload) => {
      isInGame = true;
      const { phase, data, timeLeft, round, totalRounds } = payload;
      switch (phase) {
        case 'CATEGORY_SELECTION': renderCategorySelection(data, timeLeft, round, totalRounds); break;
        case 'ANSWERING': renderAnswering(data, timeLeft, round, totalRounds); break;
        case 'VOTING': renderVoting(data, timeLeft); break;
        case 'REVEAL': renderReveal(data); break;
        case 'SCOREBOARD': renderScoreboard(data); break;
      }
    });

    // Error specific to category selection — re-enable buttons without hiding the screen
    client.on('game:category_error', ({ message }) => {
      const errEl = $('#catsel-error');
      if (errEl) {
        errEl.textContent = message;
        errEl.classList.remove('hidden');
      }
      $$('#catsel-buttons .catsel-btn').forEach(b => { b.disabled = false; });
    });

    // الاستماع المباشر للإجابة الصحيحة من السيرفر
    client.on('game:correct_guess', ({ message }) => {
      if (window.playSound) window.playSound('audio-correct');

      awaitingFakeAnswer = true;
      hasAnswered = false;

      const btn = $('#btn-submit-answer');
      btn.disabled = false;
      btn.textContent = 'إرسال الإجابة المزيفة ✍️';

      $('#answer-sent').classList.add('hidden');
      $('#answer-form').classList.remove('hidden');

      const inputEl = $('#input-answer');
      inputEl.value = '';
      inputEl.focus();

      let msgEl = $('#correct-guess-inline-msg');
      if (!msgEl) {
        msgEl = document.createElement('div');
        msgEl.id = 'correct-guess-inline-msg';
        $('#answer-form').insertBefore(msgEl, $('#answer-form').firstChild);
      }
      msgEl.textContent = message;
      msgEl.style.color = 'var(--accent-success)';
      msgEl.style.fontWeight = 'bold';
      msgEl.style.marginBottom = '0.75rem';
      msgEl.style.textAlign = 'center';
      msgEl.classList.remove('hidden');
    });

    // الاستماع المباشر لقبول الإجابة من السيرفر
    client.on('game:answer_accepted', ({ message }) => {
      hasAnswered = true;
      awaitingFakeAnswer = false;

      const btn = $('#btn-submit-answer');
      btn.disabled = false;
      btn.textContent = 'إرسال الإجابة ✍️';

      $('#answer-form').classList.add('hidden');
      $('#answer-sent').classList.remove('hidden');
      if (message) showToast(message);
    });

    client.on('game:end', ({ finalScores, teamScores }) => { isInGame = false; renderGameEnd(finalScores, teamScores); });

    client.on('room:kicked', ({ message }) => {
      isInGame = false;
      currentRoom = null;
      client.clearSession();
      showToast(message || 'تم طردك من الغرفة');
      showScreen(screenJoin);
    });

    client.on('room:rejoin_failed', () => {
      client.clearSession();
      showScreen(screenJoin);
    });

    client.on('room:questions_reset', () => {
      client.clearPlayedQuestions();
      showToast('تم تجديد بنك الأسئلة — كل الأسئلة متاحة من جديد! 🔄');
    });

    client.on('game:error', ({ message }) => {
      const btn = $('#btn-submit-answer');
      btn.disabled = false;
      btn.textContent = awaitingFakeAnswer ? 'إرسال الإجابة المزيفة ✍️' : 'إرسال الإجابة ✍️';
      showToast(message);
    });
  }

  function renderLobby(room) {
    $('#lobby-room-code').textContent = room.code;
    const list = $('#lobby-player-list');
    list.innerHTML = '';

    room.players.forEach((player) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const avatar = player.emoji || player.username.charAt(0).toUpperCase();
      let badges = '';
      if (player.id === room.hostId) badges += '<span class="player-host-badge">المضيف</span>';
      if (player.isSpectator) badges += '<span class="player-spectator-badge">مراقب</span>';
      if (player.teamId && TEAM_META[player.teamId]) {
        const m = TEAM_META[player.teamId];
        badges += `<span style="font-size:0.73rem;padding:0.18rem 0.55rem;background:${m.bg};color:${m.color};border:1px solid ${m.color};border-radius:9999px;font-weight:700;">${m.emoji} ${m.label}</span>`;
      }

      li.innerHTML = `
        <div class="player-avatar">${avatar}</div>
        <span class="player-name">${escapeHtml(player.username)}</span>
        ${badges}
      `;
      if (isHost && player.id !== client.getMyId()) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-kick';
        kickBtn.title = 'طرد اللاعب';
        kickBtn.textContent = '❌';
        kickBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:0.85rem;padding:0.2rem 0.3rem;margin-right:auto;opacity:0.55;transition:opacity 0.2s;';
        kickBtn.addEventListener('mouseover', () => { kickBtn.style.opacity = '1'; });
        kickBtn.addEventListener('mouseout', () => { kickBtn.style.opacity = '0.55'; });
        kickBtn.addEventListener('click', () => client.kickPlayer(player.id));
        li.appendChild(kickBtn);
      }
      list.appendChild(li);
    });

    const activePlayers = room.players.filter((p) => !p.isSpectator);
    const startBtn = $('#btn-start-game');

    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = activePlayers.length < 3;
      startBtn.title = activePlayers.length < 3 ? 'يجب أن يكون هناك 3 لاعبين على الأقل' : '';
      $('#lobby-settings').classList.remove('hidden');
      $('#lobby-waiting').classList.add('hidden');
    } else {
      startBtn.classList.add('hidden');
      $('#lobby-settings').classList.add('hidden');
      $('#lobby-waiting').classList.remove('hidden');
    }
    renderTeamPanel(room);
    renderSettingsDisplay(room.settings);
  }

  function renderTeamPanel(room) {
    const panel = $('#team-selection-panel');
    const settings = room.settings || {};

    if (!settings.teamsMode || isSpectator) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    const teamIds = ['red', 'blue', 'green', 'yellow'].slice(0, settings.teamsCount || 2);
    const container = $('#team-buttons');
    container.innerHTML = '';

    teamIds.forEach(tid => {
      const meta = TEAM_META[tid];
      const isSelected = myTeamId === tid;
      const btn = document.createElement('button');
      btn.style.cssText = `flex:1;min-width:80px;padding:0.65rem 0.4rem;border:2px solid ${meta.color};border-radius:var(--radius-md);background:${isSelected ? meta.color : meta.bg};color:${isSelected ? '#fff' : meta.color};font-weight:700;font-size:0.95rem;cursor:pointer;transition:all 0.15s;`;
      btn.textContent = `${meta.emoji} ${meta.label}`;
      btn.addEventListener('click', () => {
        myTeamId = tid;
        client.selectTeam(tid);
        renderTeamPanel(room);
      });
      container.appendChild(btn);
    });
  }

  function renderSettings(settings) {
    currentSettings = settings;
    if (isHost) {
      $('#setting-rounds').value = settings.totalRounds;
      $('#setting-answer-time').value = settings.answerTime;
      const categories = settings.categories || [];
      $$('#setting-categories input[type="checkbox"]').forEach(cb => cb.checked = categories.includes(cb.value));

      const teamsMode = !!settings.teamsMode;
      $('#setting-teams-mode').checked = teamsMode;
      $('#setting-teams-count-row').classList.toggle('hidden', !teamsMode);
      if (settings.teamsCount) $('#setting-teams-count').value = settings.teamsCount;
      if (settings.maxPlayers !== undefined) $('#select-max-players').value = settings.maxPlayers;
    }
    renderSettingsDisplay(settings);
  }

  function renderSettingsDisplay(settings) {
    if (!settings) return;
    const display = $('#settings-display');
    if (isHost) {
      display.classList.add('hidden');
    } else {
      display.classList.remove('hidden');
      const cats = settings.categories && settings.categories.length > 0 ? settings.categories.join('، ') : 'الكل';
      const teamsInfo = settings.teamsMode ? ` · 🏳️ وضع الفرق (${settings.teamsCount} فرق)` : '';
      const maxInfo = settings.maxPlayers > 0 ? ` · 👥 الحد الأقصى ${settings.maxPlayers} لاعبين` : ' · 👥 بلا حد للاعبين';
      display.innerHTML = `<div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.75rem;">⚙️ الإعدادات: ${settings.totalRounds} جولات · ${settings.answerTime} ثانية للإجابة${teamsInfo}${maxInfo}<br>موضوعات الجولات: ${cats}</div>`;
    }
  }

  function renderCategorySelection(data, timeLeft, round, totalRounds) {
    const { chooserId, availableCategories } = data;
    const myId = client.getMyId();
    const isChooser = myId === chooserId;

    $('#catsel-round-badge').textContent = `الجولة ${round} من ${totalRounds}`;
    $('#catsel-error').classList.add('hidden');

    // Hide all sub-views, then show the right one
    $('#catsel-chooser-view').classList.add('hidden');
    $('#catsel-waiting-view').classList.add('hidden');
    $('#catsel-spectator-view').classList.add('hidden');

    if (isSpectator) {
      const chooserName = getPlayerName(chooserId);
      $('#catsel-spectator-text').textContent = `${escapeHtml(chooserName)} يختار التصنيف...`;
      $('#catsel-spectator-view').classList.remove('hidden');

    } else if (isChooser) {
      const grid = $('#catsel-buttons');
      grid.innerHTML = '';
      availableCategories.filter(cat => cat && cat.trim() !== '').forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'catsel-btn';
        btn.innerHTML = `<span class="catsel-icon">${CATEGORY_ICONS[cat] || '❓'}</span><span>${escapeHtml(cat)}</span>`;
        btn.addEventListener('click', () => {
          $$('#catsel-buttons .catsel-btn').forEach(b => { b.disabled = true; });
          $('#catsel-error').classList.add('hidden');
          client.selectCategory(cat);
        });
        grid.appendChild(btn);
      });
      $('#catsel-chooser-view').classList.remove('hidden');

    } else {
      const chooserName = getPlayerName(chooserId);
      $('#catsel-waiting-text').innerHTML =
        `الدور على <strong>${escapeHtml(chooserName)}</strong> لاختيار تصنيف السؤال<span class="waiting-dots"></span>`;
      $('#catsel-waiting-view').classList.remove('hidden');
    }

    startTimerUI('catsel-timer-text', 'catsel-timer-progress', timeLeft, 30);

    // Force skip button (host only)
    let skipBtn = screenCategorySelection.querySelector('.btn-force-skip');
    if (isHost) {
      if (!skipBtn) {
        skipBtn = document.createElement('button');
        skipBtn.className = 'btn-force-skip';
        skipBtn.textContent = 'تخطي واختيار تلقائي ⏩';
        skipBtn.style.cssText = 'margin-top:0.75rem;padding:0.4rem 1rem;background:transparent;border:1px solid var(--text-secondary);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:0.8rem;width:100%;';
        screenCategorySelection.querySelector('.card').appendChild(skipBtn);
        skipBtn.addEventListener('click', () => client.forceSkip());
      }
      skipBtn.style.display = '';
    } else if (skipBtn) {
      skipBtn.style.display = 'none';
    }

    showScreen(screenCategorySelection);
  }

  function renderAnswering(data, timeLeft, round, totalRounds) {
    hasAnswered = false;
    awaitingFakeAnswer = false;

    // Save question ID to localStorage for cross-room question memory
    if (data.questionId) client.savePlayedQuestion(data.questionId);

    $('#answering-round-badge').textContent = `الجولة ${round} من ${totalRounds}`;
    $('#answering-question').textContent = data.question;

    const imgEl = $('#answering-image');
    if (data.imageUrl) {
      imgEl.src = data.imageUrl;
      imgEl.style.display = 'block';
      imgEl.classList.remove('hidden');
    } else {
      imgEl.style.display = 'none';
      imgEl.classList.add('hidden');
    }

    const inlineMsg = $('#correct-guess-inline-msg');
    if (inlineMsg) inlineMsg.classList.add('hidden');

    if (isSpectator) {
      $('#answer-form').classList.add('hidden');
      $('#answer-sent').classList.add('hidden');
      $('#spectator-watching').classList.remove('hidden');
    } else {
      $('#answer-form').classList.remove('hidden');
      $('#answer-sent').classList.add('hidden');
      $('#spectator-watching').classList.add('hidden');
      $('#input-answer').value = '';
    }

    startTimerUI('answering-timer-text', 'answering-timer-progress', timeLeft, currentSettings.answerTime);

    // ─── Final Round Banner ───
    let finalBanner = screenAnswering.querySelector('#final-round-banner');
    if (!finalBanner) {
      finalBanner = document.createElement('div');
      finalBanner.id = 'final-round-banner';
      finalBanner.style.cssText = 'background:linear-gradient(135deg,#ff6b35,#f7931e);color:#fff;text-align:center;padding:0.6rem 1rem;border-radius:8px;font-weight:800;font-size:1rem;margin-bottom:0.75rem;letter-spacing:0.5px;';
      screenAnswering.querySelector('.card').insertBefore(finalBanner, screenAnswering.querySelector('.card').firstChild);
    }
    finalBanner.textContent = '🔥 الجولة الحاسمة: النقاط مضاعفة! 🔥';
    finalBanner.style.display = round === totalRounds ? '' : 'none';

    // ─── Force Skip Button (Host Only) ───
    let skipBtnA = screenAnswering.querySelector('.btn-force-skip');
    if (isHost) {
      if (!skipBtnA) {
        skipBtnA = document.createElement('button');
        skipBtnA.className = 'btn-force-skip';
        skipBtnA.textContent = 'تخطي الوقت ⏩';
        skipBtnA.style.cssText = 'margin-top:0.75rem;padding:0.4rem 1rem;background:transparent;border:1px solid var(--text-secondary);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:0.8rem;width:100%;';
        screenAnswering.querySelector('.card').appendChild(skipBtnA);
        skipBtnA.addEventListener('click', () => client.forceSkip());
      }
      skipBtnA.style.display = '';
    } else if (skipBtnA) {
      skipBtnA.style.display = 'none';
    }

    showScreen(screenAnswering);
  }

  function renderVoting(data, timeLeft) {
    let hasVoted = false;
    $('#voting-question').textContent = data.question;

    const imgEl = $('#voting-image');
    if (data.imageUrl) {
      imgEl.src = data.imageUrl;
      imgEl.style.display = 'block';
      imgEl.classList.remove('hidden');
    } else {
      imgEl.style.display = 'none';
      imgEl.classList.add('hidden');
    }

    const container = $('#voting-options');
    container.innerHTML = '';

    if (isSpectator) {
      data.options.forEach((opt) => {
        const div = document.createElement('div');
        div.className = 'vote-option';
        div.textContent = opt.text;
        div.style.cursor = 'default';
        container.appendChild(div);
      });
    } else {
      data.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'vote-option';
        btn.textContent = opt.text;
        btn.dataset.answerId = opt.id;

        if (opt.id === client.getMyId()) {
          btn.disabled = true;
          btn.title = 'لا يمكنك التصويت لإجابتك';
          btn.style.opacity = '0.4';
        }

        btn.addEventListener('click', () => {
          if (hasVoted) return;
          hasVoted = true;
          client.submitVote(opt.id);

          $$('.vote-option').forEach(b => {
            b.disabled = true;
            b.classList.remove('selected');
          });
          btn.classList.add('selected');
        });
        container.appendChild(btn);
      });
    }

    startTimerUI('voting-timer-text', 'voting-timer-progress', timeLeft, currentSettings.votingTime || 45);

    // ─── Force Skip Button (Host Only) ───
    let skipBtnV = screenVoting.querySelector('.btn-force-skip');
    if (isHost) {
      if (!skipBtnV) {
        skipBtnV = document.createElement('button');
        skipBtnV.className = 'btn-force-skip';
        skipBtnV.textContent = 'تخطي الوقت ⏩';
        skipBtnV.style.cssText = 'margin-top:0.75rem;padding:0.4rem 1rem;background:transparent;border:1px solid var(--text-secondary);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:0.8rem;width:100%;';
        screenVoting.querySelector('.card').appendChild(skipBtnV);
        skipBtnV.addEventListener('click', () => client.forceSkip());
      }
      skipBtnV.style.display = '';
    } else if (skipBtnV) {
      skipBtnV.style.display = 'none';
    }

    showScreen(screenVoting);
  }

  function renderReveal(data) {
    clearTimerUI();
    if (window.playSound) window.playSound('audio-reveal');
    const container = $('#reveal-answers');
    container.innerHTML = '';

    $('#reveal-question').textContent = data.question;
    const imgEl = $('#reveal-image');
    if (data.imageUrl) {
      imgEl.src = data.imageUrl;
      imgEl.style.display = 'block';
      imgEl.classList.remove('hidden');
    } else {
      imgEl.style.display = 'none';
      imgEl.classList.add('hidden');
    }

    $('#reveal-correct-answer').textContent = data.correctAnswer;

    // Build votes map: answerId → [voterId, ...]
    const votesByAnswer = new Map();
    data.votes.forEach((v) => {
      if (!votesByAnswer.has(v.answerId)) votesByAnswer.set(v.answerId, []);
      votesByAnswer.get(v.answerId).push(v.voterId);
    });

    data.answers.forEach((ans, ansIndex) => {
      const voterIds = votesByAnswer.get(ans.id) || [];
      const voteCount = voterIds.length;
      const authorName = ans.author ? getPlayerName(ans.author) : 'الإجابة الصحيحة';

      // Trickster: fake answer that fooled 2+ people
      const isTrickster = !ans.isCorrect && voteCount >= 2;

      const div = document.createElement('div');
      div.className = `reveal-answer ${ans.isCorrect ? 'correct' : 'fake'}${isTrickster ? ' trickster' : ''}`;

      // Build voter names with floating +2 badges for correct-answer voters
      let voterHtml = '';
      if (voterIds.length > 0) {
        const voterTags = voterIds.map((vid, i) => {
          const name = escapeHtml(getPlayerName(vid));
          const pts = ans.isCorrect ? '+2' : '';
          const delay = `${(ansIndex * 3 + i) * 0.18}s`;
          if (pts) {
            return `<span class="voter-tag"><span>${name}</span><span class="float-points pts-correct" style="animation-delay:${delay}">${pts}</span></span>`;
          }
          return `<span>${name}</span>`;
        });
        voterHtml = `صوّت لها: ${voterTags.join('، ')}`;
      } else {
        voterHtml = 'لا أحد صوّت لها';
      }

      // Author earned points badge for fake answers that tricked people
      const authorPtsBadge = (!ans.isCorrect && voteCount > 0)
        ? `<span class="author-pts">+${voteCount}</span>`
        : '';

      // Trickster label
      const tricksterLabel = isTrickster
        ? `<span class="trickster-badge">🦊 خبير الخداع!</span>`
        : '';

      div.innerHTML = `
        <div>
          <div class="answer-text">${escapeHtml(ans.text)} ${authorPtsBadge}</div>
          <div class="answer-label">${ans.isCorrect ? '✅ الإجابة الصحيحة' : `✍️ ${escapeHtml(authorName)} ${tricksterLabel}`}</div>
        </div>
        <div class="voters">${voterHtml}</div>
      `;
      container.appendChild(div);
    });

    showScreen(screenReveal);
  }

  function renderScoreboard(data) {
    clearTimerUI();
    const list = $('#scoreboard-list');
    list.innerHTML = '';

    data.scores.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'score-item';
      li.style.animationDelay = `${index * 0.1}s`;
      const name = getPlayerName(entry.id);
      li.innerHTML = `
        <span class="score-rank">${index + 1}</span>
        <span class="score-name">${escapeHtml(name)}</span>
        <span class="score-points">${entry.score}</span>
      `;
      list.appendChild(li);
    });

    const nextBtn = $('#btn-next-round');
    if (isHost) {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = data.isLastRound ? 'عرض النتائج النهائية 🏆' : 'السؤال التالي ➡️';
    } else {
      nextBtn.classList.add('hidden');
    }
    showScreen(screenScoreboard);
  }

  function renderGameEnd(finalScores, teamScores) {
    clearTimerUI();
    const winner = finalScores[0];

    // Winner header: show winning team if teams mode, else individual winner
    const crownEl = $('.winner-crown');   // class selector — the element has no id
    if (teamScores && teamScores.length > 0) {
      const winTeam = teamScores[0];
      const meta = TEAM_META[winTeam.id] || { label: winTeam.id, emoji: '🏆', color: '#f59e0b' };
      if (crownEl) crownEl.textContent = meta.emoji;
      $('#winner-name').textContent = `فريق ${meta.label}`;
      $('#winner-score').textContent = `${winTeam.score} نقطة`;
    } else {
      if (crownEl) crownEl.textContent = '👑';
      $('#winner-name').textContent = getPlayerName(winner.id);
      $('#winner-score').textContent = `${winner.score} نقطة`;
    }

    const list = $('#final-scores-list');
    list.innerHTML = '';

    // Team scores section
    if (teamScores && teamScores.length > 0) {
      const teamHeader = document.createElement('li');
      teamHeader.style.cssText = 'list-style:none;padding:0.45rem 1rem;font-size:0.82rem;font-weight:700;color:var(--text-secondary);letter-spacing:0.5px;';
      teamHeader.textContent = '🏳️ نتائج الفرق';
      list.appendChild(teamHeader);

      teamScores.forEach((entry, idx) => {
        const meta = TEAM_META[entry.id] || { label: entry.id, emoji: '🏳️', color: '#888', bg: 'rgba(0,0,0,0.05)' };
        const li = document.createElement('li');
        li.className = 'score-item';
        li.style.cssText = `animation-delay:${idx * 0.08}s;background:${meta.bg};border-color:${meta.color};`;
        li.innerHTML = `
          <span class="score-rank" style="background:${meta.color};font-size:1.1rem;">${meta.emoji}</span>
          <span class="score-name" style="color:${meta.color};font-weight:700;">فريق ${escapeHtml(meta.label)}</span>
          <span class="score-points" style="color:${meta.color};">${entry.score}</span>
        `;
        list.appendChild(li);
      });

      const divider = document.createElement('li');
      divider.style.cssText = 'height:1px;background:var(--border-subtle);margin:0.4rem 0;list-style:none;';
      list.appendChild(divider);

      const playerHeader = document.createElement('li');
      playerHeader.style.cssText = 'list-style:none;padding:0.45rem 1rem;font-size:0.82rem;font-weight:700;color:var(--text-secondary);letter-spacing:0.5px;';
      playerHeader.textContent = '👤 ترتيب اللاعبين';
      list.appendChild(playerHeader);
    }

    finalScores.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'score-item';
      li.style.animationDelay = `${index * 0.1}s`;
      const name = getPlayerName(entry.id);
      li.innerHTML = `
        <span class="score-rank">${index + 1}</span>
        <span class="score-name">${escapeHtml(name)}</span>
        <span class="score-points">${entry.score}</span>
      `;
      list.appendChild(li);
    });

    showScreen(screenGameEnd);

    // ─── Confetti Celebration ───
    if (typeof confetti !== 'undefined') {
      const partyColors = ['#7c3aed', '#ec4899', '#f59e0b', '#06b6d4', '#10b981', '#f97316'];
      // Central burst
      confetti({ particleCount: 160, spread: 75, origin: { y: 0.55 }, colors: partyColors });
      // Left + right side bursts
      setTimeout(() => confetti({ particleCount: 90, angle: 55, spread: 60, origin: { x: 0, y: 0.6 }, colors: partyColors }), 350);
      setTimeout(() => confetti({ particleCount: 90, angle: 125, spread: 60, origin: { x: 1, y: 0.6 }, colors: partyColors }), 650);
      // Final small shower
      setTimeout(() => confetti({ particleCount: 60, spread: 100, startVelocity: 20, origin: { y: 0 }, colors: partyColors }), 1100);
    }
  }

  const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 35;

  // ─── Sound Helper ─────────────────────────────────────────────────────────
  function playSound(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => {}); // swallow autoplay policy errors silently
  }
  // Expose globally so inline handlers can also call it
  window.playSound = playSound;

  // ─── Global button-click sound (Event Delegation) ─────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (
      t.tagName === 'BUTTON' ||
      t.closest('button') ||
      t.classList.contains('catsel-btn') ||
      t.classList.contains('category-item')
    ) {
      playSound('audio-button');
    }
  }, { capture: true });

  function startTimerUI(textId, progressId, timeLeft, maxTime) {
    clearTimerUI();
    const textEl = $(`#${textId}`);
    const progressEl = $(`#${progressId}`);
    progressEl.style.strokeDasharray = CIRCLE_CIRCUMFERENCE;
    let remaining = timeLeft;

    function updateTimer() {
      textEl.textContent = remaining;
      const fraction = remaining / maxTime;
      progressEl.style.strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - fraction);
      progressEl.classList.remove('warning', 'danger');
      if (remaining <= 5) {
        progressEl.classList.add('danger');
        if (remaining > 0) playSound('audio-tick'); // tick on each of the last 5 seconds
      } else if (remaining <= 15) {
        progressEl.classList.add('warning');
      }

      remaining--;
      if (remaining < 0) clearTimerUI();
    }
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  }

  function clearTimerUI() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function getPlayerName(id) { return playerMap.get(id) || 'لاعب'; }
  function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

  function showToast(message) {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3500);
  }

  document.addEventListener('DOMContentLoaded', init);
})();