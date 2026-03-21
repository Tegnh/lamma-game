// game-platform/backend/TarraqGame.js

const { sanitizeInput } = require('./utils');
const allQuestions = require('./questions-tarraq.json');

const PHASES = {
  LOBBY: 'LOBBY',
  QUESTION: 'QUESTION',
  BUZZED: 'BUZZED',
  SECOND_CHANCE: 'SECOND_CHANCE',
  REVEAL: 'REVEAL',
  SCORES: 'SCORES',
};

// Duration in seconds for each phase
const TIMINGS = {
  QUESTION: 15,
  BUZZED: 10,
  SECOND_CHANCE: 7,
  REVEAL: 3,
  SCORES: 3,
};

const POINTS = {
  CORRECT_BASE: 3,
  BUZZ_BONUS: 1,   // speed bonus for first buzz
  WRONG_PENALTY: 1,
};

const MAX_ANSWER_LENGTH = 100;

class TarraqGame {
  constructor(io, roomCode) {
    this.io = io;
    this.roomCode = roomCode;
    this.phase = PHASES.LOBBY;

    this.settings = {
      totalQuestions: 10,
      answerMode: 'auto',   // 'auto' | 'manual'
      wrongPenalty: true,
      secondChance: true,
      maxPlayers: 8,
    };

    // Question management
    this._questionQueue = [];
    this.currentQuestionIndex = 0;
    this.currentQuestion = null;
    this.usedQuestionIds = new Set();

    // Round state
    this.buzzedPlayerId = null;   // playerId of first buzzer; null = open
    this.wrongAnswererId = null;   // excluded from 2nd-chance buzz
    this._revealData = null;   // cached for reconnect restore

    // Scores: playerId → integer
    this.scores = new Map();

    // Maintained by RoomManager (same pattern as KalakGame)
    this.activePlayers = new Set();
    this.spectatorIds = new Set();

    // Race-condition guard
    this.isTransitioning = false;
    this.phaseTimer = null;   // kept for clearTimers compatibility
    this.timerInterval = null;
    this.timeLeft = 0;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  updateSettings(settings) {
    if (this.phase !== PHASES.LOBBY) return;

    if (settings.totalQuestions !== undefined) {
      const q = Number(settings.totalQuestions);
      if ([5, 10, 15, 20].includes(q)) this.settings.totalQuestions = q;
    }
    if (settings.answerMode !== undefined) {
      if (['auto', 'manual'].includes(settings.answerMode)) {
        this.settings.answerMode = settings.answerMode;
      }
    }
    if (typeof settings.wrongPenalty === 'boolean') {
      this.settings.wrongPenalty = settings.wrongPenalty;
    }
    if (typeof settings.secondChance === 'boolean') {
      this.settings.secondChance = settings.secondChance;
    }
    if (settings.maxPlayers !== undefined) {
      const v = Number(settings.maxPlayers);
      if ([0, 2, 4, 6, 8, 10, 12, 16].includes(v)) this.settings.maxPlayers = v;
    }
  }

  // ─── Game Start ───────────────────────────────────────────────────────────

  start(activePlayers, externalUsedIds = []) {
    if (this.phase !== PHASES.LOBBY) return;
    if (this.isTransitioning) return;

    for (const id of externalUsedIds) {
      this.usedQuestionIds.add(id);
    }

    for (const player of activePlayers) {
      this.scores.set(player.id, 0);
    }

    this._buildQuestionQueue();
    this.currentQuestionIndex = 0;
    this._advanceToNextQuestion();
  }

  _buildQuestionQueue() {
    let pool = allQuestions.filter(q => !this.usedQuestionIds.has(q.id));

    if (pool.length < this.settings.totalQuestions) {
      // Not enough unused questions — reset bank
      this.usedQuestionIds.clear();
      this.io.to(this.roomCode).emit('room:questions_reset');
      pool = [...allQuestions];
    }

    // Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    this._questionQueue = pool.slice(0, this.settings.totalQuestions);

    // Mark selected questions as used
    for (const q of this._questionQueue) {
      this.usedQuestionIds.add(q.id);
    }
  }

  // ─── Question Transition ──────────────────────────────────────────────────

  _advanceToNextQuestion() {
    if (this.currentQuestionIndex >= this._questionQueue.length) {
      this._endGame();
      return;
    }

    this.currentQuestion = this._questionQueue[this.currentQuestionIndex];
    this.currentQuestionIndex++;
    this.buzzedPlayerId = null;
    this.wrongAnswererId = null;
    this._revealData = null;

    this._startPhase(PHASES.QUESTION);
  }

  // ─── Phase Engine ─────────────────────────────────────────────────────────

  _startPhase(phase) {
    this.phase = phase;
    this.clearTimers();

    const duration = TIMINGS[phase] || 0;

    if (duration > 0) {
      this.timeLeft = duration;
      this.startTimer(duration, () => this._onPhaseTimeout());
    } else {
      this.timeLeft = 0;
    }

    this._emit(phase);
  }

  _emit(phase) {
    const eventName = {
      [PHASES.QUESTION]: 'tarraq:question',
      [PHASES.BUZZED]: 'tarraq:locked',
      [PHASES.SECOND_CHANCE]: 'tarraq:second_chance',
      [PHASES.REVEAL]: 'tarraq:reveal',
      [PHASES.SCORES]: 'tarraq:scores',
    }[phase];

    if (!eventName) return;

    this.io.to(this.roomCode).emit(eventName, {
      ...this._getPhasePayload(phase),
      timeLeft: this.timeLeft,
      questionIndex: this.currentQuestionIndex,
      totalQuestions: this.settings.totalQuestions,
    });
  }

  _getPhasePayload(phase) {
    switch (phase) {
      case PHASES.QUESTION:
        return {
          question: this.currentQuestion.question,
          imageUrl: this.currentQuestion.imageUrl || null,
          questionId: this.currentQuestion.id,
        };

      case PHASES.SECOND_CHANCE:
        return {
          question: this.currentQuestion.question,
          imageUrl: this.currentQuestion.imageUrl || null,
          questionId: this.currentQuestion.id,
          wrongAnswererId: this.wrongAnswererId,
          penaltyApplied: this.settings.wrongPenalty,
        };

      case PHASES.BUZZED:
        return {
          question: this.currentQuestion.question,
          imageUrl: this.currentQuestion.imageUrl || null,
          buzzedPlayerId: this.buzzedPlayerId,
          answerMode: this.settings.answerMode,
        };

      case PHASES.REVEAL:
        return this._revealData || {};

      case PHASES.SCORES:
        return { scores: this._getScoresArray() };

      default:
        return {};
    }
  }

  // Used by RoomManager to restore state on reconnect
  getPhaseData() {
    return this._getPhasePayload(this.phase);
  }

  // ─── Phase Timeout ────────────────────────────────────────────────────────

  _onPhaseTimeout() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;

    try {
      switch (this.phase) {
        case PHASES.QUESTION:
          // Nobody buzzed — question dropped
          this.io.to(this.roomCode).emit('tarraq:timeout', {
            questionId: this.currentQuestion.id,
            correctAnswer: this.currentQuestion.correctAnswer,
            questionIndex: this.currentQuestionIndex,
            totalQuestions: this.settings.totalQuestions,
          });
          this._buildRevealData(null, false, 0);
          this._startPhase(PHASES.REVEAL);
          break;

        case PHASES.BUZZED:
          // Buzzed player ran out of time — counts as wrong
          this._applyWrongAnswer(this.buzzedPlayerId);
          break;

        case PHASES.SECOND_CHANCE:
          // Nobody buzzed in 2nd chance — reveal with no new correct answer
          this._startPhase(PHASES.REVEAL);
          break;

        case PHASES.REVEAL:
          this._startPhase(PHASES.SCORES);
          break;

        case PHASES.SCORES:
          this._advanceToNextQuestion();
          break;

        default:
          break;
      }
    } finally {
      this.isTransitioning = false;
    }
  }

  // ─── Buzz Handling ────────────────────────────────────────────────────────

  handleBuzz(playerId) {
    // Only accept buzz in open phases
    if (this.phase !== PHASES.QUESTION && this.phase !== PHASES.SECOND_CHANCE) {
      return { error: 'ليس وقت الجرس' };
    }

    if (this.spectatorIds.has(playerId)) {
      return { error: 'المراقبون لا يمكنهم المشاركة' };
    }

    // Server is the sole judge — first socketId wins, checked by Date.now() ordering
    if (this.buzzedPlayerId !== null) {
      return { error: 'لاعب آخر سبقك' };
    }

    // Wrong answerer cannot buzz again in 2nd chance
    if (this.phase === PHASES.SECOND_CHANCE && playerId === this.wrongAnswererId) {
      return { error: 'لا يمكنك المحاولة مرة أخرى' };
    }

    if (this.isTransitioning) return { error: 'الخادم مشغول' };
    this.isTransitioning = true;

    try {
      this.buzzedPlayerId = playerId;
      this._startPhase(PHASES.BUZZED);
    } finally {
      this.isTransitioning = false;
    }

    return { success: true };
  }

  // ─── Answer Handling — Auto Mode ──────────────────────────────────────────

  handleAnswer(playerId, answer) {
    if (this.phase !== PHASES.BUZZED) return { error: 'ليس وقت الإجابة' };
    if (playerId !== this.buzzedPlayerId) return { error: 'لم تضغط الجرس' };
    if (this.settings.answerMode !== 'auto') return { error: 'وضع الإجابة يدوي' };
    if (this.isTransitioning) return { error: 'الخادم مشغول' };

    const sanitized = sanitizeInput(answer, MAX_ANSWER_LENGTH);
    if (!sanitized) return { error: 'إجابة فارغة' };

    const isCorrect = this._checkAnswer(sanitized);

    this.isTransitioning = true;
    try {
      this.clearTimers();
      if (isCorrect) {
        this._applyCorrectAnswer(playerId);
      } else {
        this._applyWrongAnswer(playerId);
      }
    } finally {
      this.isTransitioning = false;
    }

    return { success: true, isCorrect };
  }

  // ─── Answer Handling — Manual Mode ────────────────────────────────────────

  judgeAnswer(isCorrect) {
    if (this.phase !== PHASES.BUZZED) return { error: 'ليس وقت التقييم' };
    if (this.settings.answerMode !== 'manual') return { error: 'وضع الإجابة تلقائي' };
    if (this.isTransitioning) return { error: 'الخادم مشغول' };

    const playerId = this.buzzedPlayerId;
    if (!playerId) return { error: 'لا يوجد لاعب مُجيب' };

    this.isTransitioning = true;
    try {
      this.clearTimers();
      if (isCorrect) {
        this._applyCorrectAnswer(playerId);
      } else {
        this._applyWrongAnswer(playerId);
      }
    } finally {
      this.isTransitioning = false;
    }

    return { success: true };
  }

  // ─── Score Application ────────────────────────────────────────────────────

  _applyCorrectAnswer(playerId) {
    const current = this.scores.get(playerId) || 0;
    const gained = POINTS.CORRECT_BASE + POINTS.BUZZ_BONUS; // +3 +1 = +4
    this.scores.set(playerId, current + gained);

    this._buildRevealData(playerId, true, gained);
    this._startPhase(PHASES.REVEAL);
  }

  _applyWrongAnswer(playerId) {
    let delta = 0;

    if (this.settings.wrongPenalty) {
      const current = this.scores.get(playerId) || 0;
      const newScore = Math.max(0, current - POINTS.WRONG_PENALTY);
      delta = newScore - current; // 0 if already at 0, else -1
      this.scores.set(playerId, newScore);
    }

    this._buildRevealData(playerId, false, delta);

    if (this.settings.secondChance) {
      this.wrongAnswererId = playerId;
      this.buzzedPlayerId = null;
      this._startPhase(PHASES.SECOND_CHANCE);
    } else {
      this._startPhase(PHASES.REVEAL);
    }
  }

  // ─── Answer Checking ──────────────────────────────────────────────────────

  _checkAnswer(input) {
    const normalizedInput = this._normalize(input);

    const candidates = [
      this.currentQuestion.correctAnswer,
      ...(this.currentQuestion.acceptedAnswers || []),
    ];

    return candidates.some(ans => {
      if (!ans) return false;
      const norm = this._normalize(ans);
      // Full match or partial containment = correct
      return (
        normalizedInput === norm ||
        normalizedInput.includes(norm) ||
        norm.includes(normalizedInput)
      );
    });
  }

  _normalize(text) {
    if (!text) return '';
    return text
      .trim()
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670]/g, '') // strip tashkeel & superscript alef
      .replace(/[أإآٱ]/g, 'ا')               // unify alef forms → bare alef
      .replace(/ة/g, 'ه')                    // ta marbuta → ha
      .replace(/ى/g, 'ي')                    // alef maqsura → ya
      .replace(/\s+/g, ' ');
  }

  // ─── Reveal Data ──────────────────────────────────────────────────────────

  _buildRevealData(playerId, isCorrect, pointsDelta) {
    this._revealData = {
      question: this.currentQuestion.question,
      imageUrl: this.currentQuestion.imageUrl || null,
      correctAnswer: this.currentQuestion.correctAnswer,
      buzzedPlayerId: playerId,
      isCorrect,
      pointsDelta,
      scores: this._getScoresArray(),
    };
  }

  // ─── Scores ───────────────────────────────────────────────────────────────

  _getScoresArray() {
    return Array.from(this.scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }

  // ─── Disconnect Handling ──────────────────────────────────────────────────

  handleDisconnect(playerId) {
    // If the locked-in player disconnects, treat as wrong answer immediately
    if (this.phase === PHASES.BUZZED && playerId === this.buzzedPlayerId) {
      if (this.isTransitioning) return;
      this.isTransitioning = true;
      try {
        this.clearTimers();
        this._applyWrongAnswer(playerId);
      } finally {
        this.isTransitioning = false;
      }
    }
  }

  // ─── End Game ─────────────────────────────────────────────────────────────

  _endGame() {
    this.clearTimers();
    this.phase = PHASES.LOBBY;

    this.io.to(this.roomCode).emit('tarraq:end', {
      finalScores: this._getScoresArray(),
    });

    // Reset all round state
    this._questionQueue = [];
    this.currentQuestion = null;
    this.currentQuestionIndex = 0;
    this.buzzedPlayerId = null;
    this.wrongAnswererId = null;
    this._revealData = null;
    this.scores.clear();
    this.isTransitioning = false;
  }

  destroy() {
    this.clearTimers();
    this.scores.clear();
    this._questionQueue = [];
    this.currentQuestion = null;
    this.buzzedPlayerId = null;
  }

  // ─── Timer Management (same pattern as KalakGame) ─────────────────────────

  startTimer(duration, callback) {
    this.clearTimers();
    this.timeLeft = duration;
    this.timerInterval = setInterval(() => {
      this.timeLeft--;
      if (this.timeLeft <= 0) {
        this.clearTimers();
        callback();
      }
    }, 1000);
  }

  clearTimers() {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}

module.exports = TarraqGame;
