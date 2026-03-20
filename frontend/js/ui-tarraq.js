// game-platform/frontend/js/ui-tarraq.js

(function () {
  'use strict';

  const client = window.socketClient;

  // ─── State ────────────────────────────────────────────────────────────────

  let currentRoom  = null;
  let isHost       = false;
  let isSpectator  = false;
  let isInGame     = false;
  let playerMap    = new Map();   // playerId → username
  let timerInterval = null;

  // Mirrors TarraqGame.settings — kept in sync from lobby form + tarraq:locked
  let currentSettings = {
    totalQuestions: 10,
    answerMode:     'auto',
    wrongPenalty:   true,
    secondChance:   true,
  };

  // ─── DOM Shortcuts ────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screenJoin     = $('#screen-join');
  const screenLobby    = $('#screen-lobby');
  const screenQuestion = $('#screen-question');
  const screenBuzzed   = $('#screen-buzzed');
  const screenReveal   = $('#screen-reveal');
  const screenScores   = $('#screen-scores');
  const screenWinner   = $('#screen-winner');

  function showScreen(screen) {
    $$('.phase-screen').forEach((s) => s.classList.remove('active'));
    screen.classList.add('active');
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  async function init() {
    try {
      await client.connect();
      setupEventListeners();
      setupSocketListeners();
      client.tryRestoreSession();
    } catch (err) {
      showToast('تعذّر الاتصال بالخادم. حاول لاحقاً.');
      console.error(err);
    }
  }

  // ─── DOM Event Listeners ──────────────────────────────────────────────────

  function setupEventListeners() {
    // Join / Create
    $('#btn-create-room').addEventListener('click', () => {
      const username = $('#input-username').value.trim();
      if (!username) return showToast('يرجى إدخال اسمك');
      isSpectator = $('#input-spectator').checked;
      client.createRoom(username, isSpectator);
    });

    $('#btn-join-room').addEventListener('click', () => {
      const username = $('#input-username').value.trim();
      const code     = $('#input-room-code').value.trim().toUpperCase();
      if (!username) return showToast('يرجى إدخال اسمك');
      if (!code)     return showToast('يرجى إدخال كود الغرفة');
      isSpectator = $('#input-spectator').checked;
      client.joinRoom(code, username, isSpectator);
    });

    $('#btn-copy-code').addEventListener('click', () => {
      if (!currentRoom) return;
      navigator.clipboard.writeText(currentRoom.code).then(() => {
        $('#btn-copy-code').textContent = 'تم النسخ ✓';
        setTimeout(() => $('#btn-copy-code').textContent = 'نسخ الكود', 2000);
      });
    });

    // Lobby: Start Game
    $('#btn-start-game').addEventListener('click', () => {
      const settings = collectSettings();
      client.socket.emit('tarraq:start', settings);
    });

    // Question: Buzz Button — lockout on first click
    $('#btn-buzz').addEventListener('click', () => {
      const btn = $('#btn-buzz');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = '0.45';
      btn.style.transform = 'scale(0.92)';
      playSound('audio-buzz');
      client.socket.emit('tarraq:buzz');
    });

    // Buzzed: Answer Submit (auto mode)
    $('#btn-submit-buzz-answer').addEventListener('click', () => {
      const text = $('#input-buzz-answer').value.trim();
      if (!text) return;
      const btn = $('#btn-submit-buzz-answer');
      btn.disabled = true;
      btn.textContent = 'جاري الإرسال... ⏳';
      client.socket.emit('tarraq:answer', { text });
    });

    $('#input-buzz-answer').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-submit-buzz-answer').click();
    });

    // Buzzed: Host Judge (manual mode)
    $('#btn-judge-correct').addEventListener('click', () => {
      $('#btn-judge-correct').disabled = true;
      $('#btn-judge-wrong').disabled   = true;
      client.socket.emit('tarraq:judge', { correct: true });
    });

    $('#btn-judge-wrong').addEventListener('click', () => {
      $('#btn-judge-correct').disabled = true;
      $('#btn-judge-wrong').disabled   = true;
      client.socket.emit('tarraq:judge', { correct: false });
    });

    // Scores: Host skips waiting
    $('#btn-next-question').addEventListener('click', () => {
      client.socket.emit('tarraq:next');
    });

    // Winner: Back to lobby
    $('#btn-back-lobby').addEventListener('click', () => {
      isInGame = false;
      showScreen(screenLobby);
    });

    // Settings: keep local state in sync (used when host clicks Start)
    $('#setting-total-questions').addEventListener('change', (e) => {
      currentSettings.totalQuestions = Number(e.target.value);
    });
    $('#setting-answer-mode').addEventListener('change', (e) => {
      currentSettings.answerMode = e.target.value;
    });
    $('#setting-wrong-penalty').addEventListener('change', (e) => {
      currentSettings.wrongPenalty = e.target.checked;
    });
    $('#setting-second-chance').addEventListener('change', (e) => {
      currentSettings.secondChance = e.target.checked;
    });
  }

  function collectSettings() {
    return {
      totalQuestions: Number($('#setting-total-questions').value),
      answerMode:     $('#setting-answer-mode').value,
      wrongPenalty:   $('#setting-wrong-penalty').checked,
      secondChance:   $('#setting-second-chance').checked,
    };
  }

  // ─── Socket Listeners ─────────────────────────────────────────────────────

  function setupSocketListeners() {

    // Room state (lobby + reconnect)
    client.on('room:update', (room) => {
      currentRoom = room;
      client.roomCode = room.code;
      isHost = room.hostId === client.getMyId();

      const me = room.players.find((p) => p.id === client.getMyId());
      if (me) isSpectator = me.isSpectator;

      playerMap.clear();
      room.players.forEach((p) => playerMap.set(p.id, p.username));

      renderLobby(room);
      if (!isInGame) showScreen(screenLobby);
    });

    // ── Game Events ───────────────────────────────────────────────────────

    client.on('tarraq:question', (data) => {
      isInGame = true;
      renderQuestion(data);
    });

    client.on('tarraq:locked', (data) => {
      // Sync answerMode so all clients render the correct buzzed view
      if (data.answerMode) currentSettings.answerMode = data.answerMode;
      renderBuzzed(data);
    });

    client.on('tarraq:second_chance', (data) => {
      renderSecondChance(data);
    });

    client.on('tarraq:reveal', (data) => {
      renderReveal(data);
    });

    client.on('tarraq:scores', (data) => {
      renderScores(data);
    });

    client.on('tarraq:timeout', (data) => {
      // Server emits tarraq:reveal right after — show a toast for context
      showToast(`⏰ انتهى الوقت! الإجابة: ${data.correctAnswer}`);
    });

    client.on('tarraq:end', (data) => {
      isInGame = false;
      renderWinner(data);
    });

    // ── Room Events ───────────────────────────────────────────────────────

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
      showToast('تم تجديد بنك الأسئلة — كل الأسئلة متاحة من جديد! 🔄');
    });

    client.on('game:error', ({ message }) => {
      // Re-enable judge buttons so the host can try again
      const jc = $('#btn-judge-correct');
      const jw = $('#btn-judge-wrong');
      if (jc) jc.disabled = false;
      if (jw) jw.disabled = false;
      // Re-enable answer submit button
      const as = $('#btn-submit-buzz-answer');
      if (as) { as.disabled = false; as.textContent = 'إرسال الإجابة ✅'; }
      showToast(message);
    });
  }

  // ─── Render: Lobby ────────────────────────────────────────────────────────

  function renderLobby(room) {
    $('#lobby-room-code').textContent = room.code;
    const list = $('#lobby-player-list');
    list.innerHTML = '';

    room.players.forEach((player) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const avatar = player.emoji || player.username.charAt(0).toUpperCase();
      let badges = '';
      if (player.id === room.hostId)  badges += '<span class="player-host-badge">المضيف</span>';
      if (player.isSpectator)         badges += '<span class="player-spectator-badge">مراقب</span>';

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
        kickBtn.addEventListener('mouseout',  () => { kickBtn.style.opacity = '0.55'; });
        kickBtn.addEventListener('click', () => client.kickPlayer(player.id));
        li.appendChild(kickBtn);
      }
      list.appendChild(li);
    });

    const activePlayers = room.players.filter((p) => !p.isSpectator);
    const startBtn = $('#btn-start-game');

    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = activePlayers.length < 2;
      startBtn.title = activePlayers.length < 2 ? 'يجب أن يكون هناك لاعبان على الأقل' : '';
      $('#lobby-settings').classList.remove('hidden');
      $('#lobby-waiting').classList.add('hidden');
    } else {
      startBtn.classList.add('hidden');
      $('#lobby-settings').classList.add('hidden');
      $('#lobby-waiting').classList.remove('hidden');
    }

    renderSettingsDisplay();
  }

  function renderSettingsDisplay() {
    const display = $('#settings-display');
    if (isHost) { display.classList.add('hidden'); return; }

    display.classList.remove('hidden');
    const modeLabel = currentSettings.answerMode === 'manual' ? 'يدوية' : 'تلقائية';
    const parts = [
      `${currentSettings.totalQuestions} أسئلة`,
      `إجابة ${modeLabel}`,
      currentSettings.wrongPenalty ? '⚠️ عقوبة الخطأ' : '',
      currentSettings.secondChance ? '🔄 فرصة ثانية' : '',
    ].filter(Boolean).join(' · ');
    display.innerHTML = `<div style="color:var(--text-secondary);font-size:0.85rem;margin-top:0.75rem;">⚙️ ${parts}</div>`;
  }

  // ─── Render: Question ─────────────────────────────────────────────────────

  function renderQuestion(data) {
    const { question, imageUrl, questionId, timeLeft, questionIndex, totalQuestions } = data;

    $('#question-badge').textContent = `السؤال ${questionIndex} من ${totalQuestions}`;
    $('#question-text').textContent  = question;

    const imgEl = $('#question-image');
    if (imageUrl) { imgEl.src = imageUrl; imgEl.classList.remove('hidden'); }
    else          { imgEl.classList.add('hidden'); }

    if (questionId) client.savePlayedQuestion(questionId);

    // Reset UI: hide second-chance banner
    $('#second-chance-banner').classList.add('hidden');

    // Buzz button: enable for active players, hide for spectators
    const buzzBtn = $('#btn-buzz');
    buzzBtn.disabled      = false;
    buzzBtn.style.opacity = '1';
    buzzBtn.style.transform = 'scale(1)';

    if (isSpectator) {
      buzzBtn.classList.add('hidden');
      $('#question-spectator-msg').classList.remove('hidden');
    } else {
      buzzBtn.classList.remove('hidden');
      $('#question-spectator-msg').classList.add('hidden');
    }

    startTimerUI('question-timer-text', 'question-timer-progress', timeLeft, 15);
    showScreen(screenQuestion);
  }

  // ─── Render: Buzzed ───────────────────────────────────────────────────────

  function renderBuzzed(data) {
    const { buzzedPlayerId, question, imageUrl, timeLeft, questionIndex, totalQuestions, answerMode } = data;
    const mode = answerMode || currentSettings.answerMode;

    // Lockout: disable buzz for everyone
    const buzzBtn = $('#btn-buzz');
    buzzBtn.disabled      = true;
    buzzBtn.style.opacity = '0.4';

    // Populate shared fields
    $('#buzzed-badge').textContent        = `السؤال ${questionIndex} من ${totalQuestions}`;
    $('#buzzed-question-text').textContent = question;
    $('#buzzed-player-name').textContent   = escapeHtml(getPlayerName(buzzedPlayerId));

    const imgEl = $('#buzzed-image');
    if (imageUrl) { imgEl.src = imageUrl; imgEl.classList.remove('hidden'); }
    else          { imgEl.classList.add('hidden'); }

    // Hide all sub-views
    ['#buzzed-self-view', '#buzzed-self-verbal-view',
     '#buzzed-watching-view', '#buzzed-host-view'].forEach((sel) => {
      $(sel).classList.add('hidden');
    });

    const iAmBuzzer = buzzedPlayerId === client.getMyId();
    const isManual  = mode === 'manual';

    if (iAmBuzzer) {
      if (isManual) {
        // I buzzed — answer verbally, host will judge
        $('#buzzed-self-verbal-view').classList.remove('hidden');
      } else {
        // I buzzed — type my answer
        const inputEl = $('#input-buzz-answer');
        const submitBtn = $('#btn-submit-buzz-answer');
        inputEl.value      = '';
        submitBtn.disabled = false;
        submitBtn.textContent = 'إرسال الإجابة ✅';
        $('#buzzed-self-view').classList.remove('hidden');
        setTimeout(() => inputEl.focus(), 80);
      }
    } else if (isHost && isManual) {
      // Host judges another player's answer
      $('#btn-judge-correct').disabled = false;
      $('#btn-judge-wrong').disabled   = false;
      $('#buzzed-host-view').classList.remove('hidden');
    } else {
      // Spectators and other players wait
      $('#buzzed-watching-view').classList.remove('hidden');
    }

    startTimerUI('buzzed-timer-text', 'buzzed-timer-progress', timeLeft, 10);
    showScreen(screenBuzzed);
  }

  // ─── Render: Second Chance ────────────────────────────────────────────────

  function renderSecondChance(data) {
    const { timeLeft, questionIndex, totalQuestions, wrongAnswererId } = data;

    // Show second-chance banner on the question screen
    $('#second-chance-banner').classList.remove('hidden');
    $('#question-badge').textContent = `السؤال ${questionIndex} من ${totalQuestions}`;

    // Re-enable buzz for everyone except the wrong answerer and spectators
    const buzzBtn = $('#btn-buzz');
    const myId    = client.getMyId();
    const blocked = isSpectator || myId === wrongAnswererId;

    buzzBtn.disabled      = blocked;
    buzzBtn.style.opacity = blocked ? '0.4' : '1';
    buzzBtn.style.transform = 'scale(1)';
    buzzBtn.classList.toggle('hidden', isSpectator);
    $('#question-spectator-msg').classList.toggle('hidden', !isSpectator);

    startTimerUI('question-timer-text', 'question-timer-progress', timeLeft, 7);
    showScreen(screenQuestion);
  }

  // ─── Render: Reveal ───────────────────────────────────────────────────────

  function renderReveal(data) {
    clearTimerUI();
    playSound('audio-reveal');

    const { buzzedPlayerId, isCorrect, pointsDelta, correctAnswer, scores } = data;
    const noOneBuzzed = buzzedPlayerId === null;

    // Timeout banner
    $('#reveal-timeout-msg').classList.toggle('hidden', !noOneBuzzed);

    if (noOneBuzzed) {
      $('#reveal-title').textContent        = 'انتهى الوقت ⏰';
      $('#reveal-result-badge').textContent = '⏰';
      $('#reveal-points-delta').textContent = '';
      $('#reveal-player-name').textContent  = '---';
    } else {
      $('#reveal-title').textContent       = 'النتيجة';
      $('#reveal-player-name').textContent = escapeHtml(getPlayerName(buzzedPlayerId));

      if (isCorrect) {
        playSound('audio-correct');
        $('#reveal-result-badge').textContent = '✅';
        const delta = $('#reveal-points-delta');
        delta.textContent = pointsDelta > 0 ? `+${pointsDelta}` : `${pointsDelta}`;
        delta.style.color = 'var(--accent-success)';
      } else {
        $('#reveal-result-badge').textContent = '❌';
        const delta = $('#reveal-points-delta');
        if (pointsDelta < 0) {
          delta.textContent = `${pointsDelta}`;
          delta.style.color = 'var(--accent-danger, #ef4444)';
        } else {
          delta.textContent = '±0';
          delta.style.color = 'var(--text-secondary)';
        }
      }
    }

    $('#reveal-correct-answer').textContent = correctAnswer || '---';
    renderScoresList('#reveal-scores-list', scores || []);

    showScreen(screenReveal);
  }

  // ─── Render: Scores ───────────────────────────────────────────────────────

  function renderScores(data) {
    clearTimerUI();
    const { scores, questionIndex, totalQuestions } = data;

    $('#scores-badge').textContent = `السؤال ${questionIndex} من ${totalQuestions}`;
    renderScoresList('#scores-list', scores || []);

    const nextBtn    = $('#btn-next-question');
    const waitingEl  = $('#scores-waiting');

    if (isHost) {
      nextBtn.classList.remove('hidden');
      waitingEl.classList.add('hidden');
    } else {
      nextBtn.classList.add('hidden');
      waitingEl.classList.remove('hidden');
    }

    showScreen(screenScores);
  }

  // ─── Render: Winner ───────────────────────────────────────────────────────

  function renderWinner(data) {
    clearTimerUI();
    const { finalScores } = data;
    const winner = finalScores[0];

    if (winner) {
      $('#winner-name').textContent  = escapeHtml(getPlayerName(winner.id));
      $('#winner-score').textContent = `${winner.score} نقطة`;
    }

    renderScoresList('#final-scores-list', finalScores);
    showScreen(screenWinner);

    // Confetti celebration
    if (typeof confetti !== 'undefined') {
      const colors = ['#7c3aed', '#ec4899', '#f59e0b', '#06b6d4', '#10b981', '#f97316'];
      confetti({ particleCount: 160, spread: 75, origin: { y: 0.55 }, colors });
      setTimeout(() => confetti({ particleCount: 90, angle:  55, spread: 60, origin: { x: 0, y: 0.6 }, colors }), 350);
      setTimeout(() => confetti({ particleCount: 90, angle: 125, spread: 60, origin: { x: 1, y: 0.6 }, colors }), 650);
      setTimeout(() => confetti({ particleCount: 60, spread: 100, startVelocity: 20, origin: { y: 0 }, colors }), 1100);
    }
  }

  // ─── Shared: Scores List ──────────────────────────────────────────────────

  function renderScoresList(selector, scores) {
    const list = $(selector);
    if (!list) return;
    list.innerHTML = '';
    scores.forEach((entry, idx) => {
      const li = document.createElement('li');
      li.className = 'score-item';
      li.style.animationDelay = `${idx * 0.08}s`;
      li.innerHTML = `
        <span class="score-rank">${idx + 1}</span>
        <span class="score-name">${escapeHtml(getPlayerName(entry.id))}</span>
        <span class="score-points">${entry.score}</span>
      `;
      list.appendChild(li);
    });
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 35; // r=35, matches SVG in tarraq.html

  function startTimerUI(textId, progressId, timeLeft, maxTime) {
    clearTimerUI();
    const textEl     = $(`#${textId}`);
    const progressEl = $(`#${progressId}`);
    if (!textEl || !progressEl) return;

    progressEl.style.strokeDasharray = CIRCLE_CIRCUMFERENCE;
    let remaining = timeLeft;

    function update() {
      textEl.textContent = remaining;
      const fraction = remaining / maxTime;
      progressEl.style.strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - fraction);
      progressEl.classList.remove('warning', 'danger');

      if (remaining <= 5) {
        progressEl.classList.add('danger');
        if (remaining > 0) playSound('audio-tick');
      } else if (remaining <= Math.ceil(maxTime * 0.4)) {
        progressEl.classList.add('warning');
      }

      remaining--;
      if (remaining < 0) clearTimerUI();
    }

    update();
    timerInterval = setInterval(update, 1000);
  }

  function clearTimerUI() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ─── Sound ────────────────────────────────────────────────────────────────

  function playSound(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => {});
  }
  window.playSound = playSound;

  // Global button-click sound
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      playSound('audio-buzz');
    }
  }, { capture: true });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getPlayerName(id) { return playerMap.get(id) || 'لاعب'; }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

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

  // ─── Init ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

})();
