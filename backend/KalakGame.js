// game-platform/backend/KalakGame.js
const { sanitizeInput, shuffleArray, normalizeArabicText } = require('./utils');
const allQuestions = require('./questions.json');

const PHASES = {
  LOBBY: 'LOBBY',
  CATEGORY_SELECTION: 'CATEGORY_SELECTION',
  ANSWERING: 'ANSWERING',
  VOTING: 'VOTING',
  REVEAL: 'REVEAL',
  SCOREBOARD: 'SCOREBOARD',
};

const TOTAL_ROUNDS = 5;
const MAX_ANSWER_LENGTH = 50;
const DEFAULT_ANSWER = 'إجابة متأخرة';
const CATEGORY_SELECTION_TIME = 30; // seconds before auto-pick

// Pre-compute all unique categories from the question bank
const ALL_CATEGORIES = [...new Set(allQuestions.map(q => q.category))];

class KalakGame {
  constructor(io, roomCode) {
    this.io = io;
    this.roomCode = roomCode;
    this.phase = PHASES.LOBBY;
    this.currentRound = 0;

    this.settings = {
      totalRounds: TOTAL_ROUNDS,
      answerTime: 60,
      votingTime: 45,
      revealTime: 10,
      categories: [],
    };

    this.usedQuestionIds = new Set();
    this.currentQuestion = null;

    this.answers = new Map();
    this.votes = new Map();
    this.scores = new Map();
    this.correctGuessers = new Set();
    this.spectatorIds = new Set();  // maintained by RoomManager
    this.activePlayers = new Set(); // maintained by RoomManager

    // Category-selection turn tracking
    this.chooserPlayerId = null;
    this.currentChooserIndex = 0;

    this.isTransitioning = false;
    this.phaseTimer = null;
    this.timerInterval = null;
    this.timeLeft = 0;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  updateSettings(settings) {
    if (this.phase !== PHASES.LOBBY) return;
    if (settings.totalRounds) {
      const r = Number(settings.totalRounds);
      if ([3, 5, 7, 10, 15].includes(r)) this.settings.totalRounds = r;
    }
    if (settings.answerTime) {
      const t = Number(settings.answerTime);
      if ([30, 45, 60].includes(t)) this.settings.answerTime = t;
    }
    if (settings.categories && Array.isArray(settings.categories)) {
      this.settings.categories = settings.categories;
    }
  }

  initScores(activePlayers) {
    for (const player of activePlayers) {
      if (!this.scores.has(player.id)) {
        this.scores.set(player.id, 0);
      }
    }
  }

  // ─── Category Helpers ─────────────────────────────────────────────────────

  /** Categories the host has enabled (falls back to all if none selected) */
  _getAllowedCategories() {
    return this.settings.categories.length > 0
      ? this.settings.categories
      : ALL_CATEGORIES;
  }

  /**
   * Returns the subset of allowed categories that still have at least one
   * unused question. Falls back to all allowed if all are exhausted
   * (the reset will happen at pick-time in handleCategorySelection).
   */
  _getAvailableCategories() {
    const allowed = this._getAllowedCategories();
    const available = allowed.filter(cat =>
      allQuestions.some(q => q.category === cat && !this.usedQuestionIds.has(q.id))
    );
    return available.length > 0 ? available : allowed;
  }

  // ─── Game Start ───────────────────────────────────────────────────────────

  start(activePlayers, externalUsedIds = []) {
    if (this.phase !== PHASES.LOBBY) return;
    if (this.isTransitioning) return;

    // Merge host's cross-room played questions
    for (const id of externalUsedIds) {
      this.usedQuestionIds.add(id);
    }

    this.initScores(activePlayers);
    this.currentRound = 0;
    this.currentChooserIndex = 0;
    this.nextRound();
  }

  // ─── Round Transition ─────────────────────────────────────────────────────

  nextRound() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;

    try {
      this.currentRound++;
      if (this.currentRound > this.settings.totalRounds) {
        this.endGame();
        return;
      }

      const activePids = Array.from(this.activePlayers);
      if (activePids.length === 0) {
        this.endGame();
        return;
      }

      // Rotate the chooser through active players
      this.chooserPlayerId = activePids[this.currentChooserIndex % activePids.length];
      this.currentChooserIndex++;

      this.setPhase(PHASES.CATEGORY_SELECTION);
    } finally {
      this.isTransitioning = false;
    }
  }

  nextRoundManual() {
    if (this.phase !== PHASES.SCOREBOARD) return false;
    if (this.currentRound >= this.settings.totalRounds) {
      this.endGame();
      return false;
    }
    this.nextRound();
    return true;
  }

  // ─── Category Selection ───────────────────────────────────────────────────

  /**
   * Called when the designated chooser picks a category.
   * Validates, selects a random unused question, and advances to ANSWERING.
   *
   * Edge case: if ALL questions in the chosen category are exhausted,
   * checks whether any other question exists in the bank:
   *   - If no other questions exist globally → full reset then pick
   *   - If other categories still have questions → return error so client
   *     can re-render with updated (non-exhausted) category list
   */
  handleCategorySelection(playerId, category) {
    if (this.phase !== PHASES.CATEGORY_SELECTION) {
      return { error: 'ليس وقت اختيار التصنيف' };
    }
    if (playerId !== this.chooserPlayerId) {
      return { error: 'ليس دورك لاختيار التصنيف' };
    }
    if (typeof category !== 'string' || !category.trim()) {
      return { error: 'تصنيف غير صالح' };
    }

    let available = allQuestions.filter(
      q => q.category === category && !this.usedQuestionIds.has(q.id)
    );

    if (available.length === 0) {
      // Are there any unused questions left at all?
      const anyUnused = allQuestions.some(q => !this.usedQuestionIds.has(q.id));

      if (!anyUnused) {
        // Full bank exhausted — reset and allow any question from the chosen category
        this.usedQuestionIds.clear();
        this.io.to(this.roomCode).emit('room:questions_reset');
        available = allQuestions.filter(q => q.category === category);
      } else {
        // Other categories have questions; tell the chooser to pick another
        // Re-emit CATEGORY_SELECTION with updated available list so buttons refresh
        const updated = this._getAvailableCategories();
        this.io.to(this.roomCode).emit('game:phase', {
          phase: PHASES.CATEGORY_SELECTION,
          data: { chooserId: this.chooserPlayerId, availableCategories: updated },
          timeLeft: this.timeLeft,
          round: this.currentRound,
          totalRounds: this.settings.totalRounds,
        });
        return { error: `نفدت أسئلة تصنيف "${category}"، اختر تصنيفاً آخر` };
      }
    }

    const question = available[Math.floor(Math.random() * available.length)];
    this.currentQuestion = question;
    this.usedQuestionIds.add(question.id);

    this.answers.clear();
    this.votes.clear();
    this.correctGuessers.clear();

    this.clearTimers();
    this.setPhase(PHASES.ANSWERING);
    return { success: true };
  }

  /**
   * Auto-pick a question without player input.
   * Used on: 30-second timeout, chooser disconnect, host force-skip.
   */
  _autoPickQuestion() {
    const allowed = this.settings.categories.length > 0
      ? allQuestions.filter(q => this.settings.categories.includes(q.category))
      : allQuestions;

    let unused = allowed.filter(q => !this.usedQuestionIds.has(q.id));
    if (unused.length === 0) {
      this.usedQuestionIds.clear();
      this.io.to(this.roomCode).emit('room:questions_reset');
      unused = allowed.length > 0 ? allowed : allQuestions;
    }

    const question = unused[Math.floor(Math.random() * unused.length)];
    this.currentQuestion = question;
    this.usedQuestionIds.add(question.id);

    this.answers.clear();
    this.votes.clear();
    this.correctGuessers.clear();

    this.clearTimers();
    this.setPhase(PHASES.ANSWERING);
  }

  // ─── Phase Management ─────────────────────────────────────────────────────

  setPhase(phase) {
    this.phase = phase;
    this.clearTimers();

    let duration = 0;
    if (phase === PHASES.CATEGORY_SELECTION) duration = CATEGORY_SELECTION_TIME;
    else if (phase === PHASES.ANSWERING)  duration = this.settings.answerTime;
    else if (phase === PHASES.VOTING)     duration = this.settings.votingTime;
    else if (phase === PHASES.REVEAL)     duration = this.settings.revealTime;

    if (duration > 0) {
      this.timeLeft = duration;
      this.startTimer(duration, () => this.onPhaseTimeout());
    }

    const data = this.getPhaseData();
    this.io.to(this.roomCode).emit('game:phase', {
      phase: this.phase,
      data,
      timeLeft: this.timeLeft,
      round: this.currentRound,
      totalRounds: this.settings.totalRounds,
    });
  }

  getPhaseData() {
    switch (this.phase) {
      case PHASES.CATEGORY_SELECTION:
        return {
          chooserId: this.chooserPlayerId,
          availableCategories: this._getAvailableCategories(),
        };
      case PHASES.ANSWERING:
        return {
          question: this.currentQuestion.question,
          imageUrl: this.currentQuestion.imageUrl,
          questionId: this.currentQuestion.id,
        };
      case PHASES.VOTING:
        return {
          question: this.currentQuestion.question,
          imageUrl: this.currentQuestion.imageUrl,
          options: this.buildVotingOptions(),
        };
      case PHASES.REVEAL:
        return this.buildRevealData();
      case PHASES.SCOREBOARD:
        return {
          scores: this.getScoresArray(),
          isLastRound: this.currentRound >= this.settings.totalRounds,
        };
      default:
        return {};
    }
  }

  // ─── Voting Options & Reveal ───────────────────────────────────────────────

  buildVotingOptions() {
    const options = [];
    const correctId = 'correct_' + this.currentQuestion.id;
    options.push({ id: correctId, text: this.currentQuestion.correctAnswer });

    this.answers.forEach((answerObj, socketId) => {
      options.push({ id: socketId, text: answerObj.text });
    });

    return shuffleArray(options);
  }

  buildRevealData() {
    const correctId = 'correct_' + this.currentQuestion.id;
    const roundScores = new Map();

    this.scores.forEach((_, socketId) => roundScores.set(socketId, 0));

    this.correctGuessers.forEach((socketId) => {
      const current = roundScores.get(socketId) || 0;
      roundScores.set(socketId, current + 1);
    });

    this.votes.forEach((answerId, voterId) => {
      if (answerId === correctId) {
        const current = roundScores.get(voterId) || 0;
        roundScores.set(voterId, current + 2);
      } else {
        if (this.answers.has(answerId)) {
          const current = roundScores.get(answerId) || 0;
          roundScores.set(answerId, current + 1);
        }
      }
    });

    const multiplier = this.currentRound === this.settings.totalRounds ? 2 : 1;
    roundScores.forEach((points, socketId) => {
      const currentTotal = this.scores.get(socketId) || 0;
      this.scores.set(socketId, currentTotal + points * multiplier);
    });

    const voteDetails = [];
    this.votes.forEach((answerId, voterId) => voteDetails.push({ voterId, answerId }));

    const answersList = [];
    answersList.push({ id: correctId, text: this.currentQuestion.correctAnswer, isCorrect: true, author: null });
    this.answers.forEach((answerObj, socketId) => {
      answersList.push({ id: socketId, text: answerObj.text, isCorrect: false, author: socketId });
    });

    return {
      correctId,
      correctAnswer: this.currentQuestion.correctAnswer,
      question: this.currentQuestion.question,
      imageUrl: this.currentQuestion.imageUrl,
      answers: answersList,
      votes: voteDetails,
      roundScores: Array.from(roundScores.entries()).map(([id, pts]) => ({ id, points: pts * multiplier })),
      isFinalRound: multiplier === 2,
      scores: this.getScoresArray(),
    };
  }

  // ─── Answer Handling ──────────────────────────────────────────────────────

  _isExactMatch(sanitizedBuffer) {
    const normalizedInput = normalizeArabicText(sanitizedBuffer);
    if (!this.currentQuestion.acceptedAnswers) return false;
    return this.currentQuestion.acceptedAnswers.some(accepted =>
      normalizeArabicText(accepted) === normalizedInput
    );
  }

  submitAnswer(socketId, answer, isSpectator) {
    if (isSpectator) return { error: 'المراقبون لا يمكنهم الإجابة' };
    if (this.phase !== PHASES.ANSWERING) return { error: 'لا يمكنك الإجابة في هذه المرحلة' };
    if (this.answers.has(socketId)) return { error: 'لقد أرسلت إجابتك بالفعل' };

    const sanitized = sanitizeInput(answer, MAX_ANSWER_LENGTH);
    if (!sanitized || sanitized.length === 0) return { error: 'الإجابة فارغة' };

    if (this._isExactMatch(sanitized)) {
      this.correctGuessers.add(socketId);
      return { success: true, correctGuess: true };
    }

    this.answers.set(socketId, { text: sanitized, isCorrect: false });

    const activeCount = this.getActivePlayers().length;
    if (this.answers.size >= activeCount) {
      this.clearTimers();
      this.advanceToVoting();
    }

    return { success: true, correctGuess: false };
  }

  submitFakeAnswer(socketId, answer) {
    if (this.phase !== PHASES.ANSWERING) return { error: 'لا يمكنك الإجابة في هذه المرحلة' };
    if (!this.correctGuessers.has(socketId)) return { error: 'لم تخمن الإجابة الصحيحة' };
    if (this.answers.has(socketId)) return { error: 'لقد أرسلت إجابتك المزيفة بالفعل' };

    const sanitized = sanitizeInput(answer, MAX_ANSWER_LENGTH);
    if (!sanitized || sanitized.length === 0) return { error: 'الإجابة فارغة' };

    if (this._isExactMatch(sanitized)) {
      return { error: 'لا يمكنك كتابة إجابة صحيحة. اكتب إجابة مزيفة!' };
    }

    this.answers.set(socketId, { text: sanitized, isCorrect: false });

    const activeCount = this.getActivePlayers().length;
    if (this.answers.size >= activeCount) {
      this.clearTimers();
      this.advanceToVoting();
    }
    return { success: true };
  }

  submitVote(socketId, answerId, isSpectator) {
    if (isSpectator) return { error: 'المراقبون لا يمكنهم التصويت' };
    if (this.phase !== PHASES.VOTING) return { error: 'لا يمكنك التصويت في هذه المرحلة' };
    if (this.votes.has(socketId)) return { error: 'لقد صوّتَ بالفعل' };
    if (answerId === socketId) return { error: 'لا يمكنك التصويت لإجابتك الخاصة' };

    const correctId = 'correct_' + this.currentQuestion.id;
    if (answerId !== correctId && !this.answers.has(answerId)) {
      return { error: 'إجابة غير صالحة' };
    }

    this.votes.set(socketId, answerId);

    const activeCount = this.getActivePlayers().length;
    if (this.votes.size >= activeCount) {
      this.clearTimers();
      this.advanceToReveal();
    }
    return { success: true };
  }

  // ─── Timeout & Skip ───────────────────────────────────────────────────────

  onPhaseTimeout() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;

    switch (this.phase) {
      case PHASES.CATEGORY_SELECTION:
        this._autoPickQuestion();
        break;
      case PHASES.ANSWERING:
        this.fillDefaultAnswers();
        this.setPhase(PHASES.VOTING);
        break;
      case PHASES.VOTING:
        this.setPhase(PHASES.REVEAL);
        break;
      case PHASES.REVEAL:
        this.setPhase(PHASES.SCOREBOARD);
        break;
      default:
        break;
    }
    this.isTransitioning = false;
  }

  forceSkipPhase() {
    if (this.phase === PHASES.CATEGORY_SELECTION) {
      this._autoPickQuestion();
      return;
    }
    if (this.phase !== PHASES.ANSWERING && this.phase !== PHASES.VOTING) return;
    this.clearTimers();
    this.onPhaseTimeout();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  getActivePlayers(excludeId = null) {
    const players = Array.from(this.activePlayers);
    return excludeId ? players.filter(pid => pid !== excludeId) : players;
  }

  fillDefaultAnswers() {
    const players = this.getActivePlayers();
    for (const pid of players) {
      if (!this.answers.has(pid)) {
        this.answers.set(pid, { text: DEFAULT_ANSWER, isCorrect: false });
      }
    }
  }

  advanceToVoting() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;
    this.setPhase(PHASES.VOTING);
    this.isTransitioning = false;
  }

  advanceToReveal() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;
    this.setPhase(PHASES.REVEAL);
    this.isTransitioning = false;
  }

  getScoresArray() {
    return Array.from(this.scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }

  // ─── Disconnect Handling ──────────────────────────────────────────────────

  handleDisconnect(playerId) {
    if (this.phase === PHASES.ANSWERING && !this.answers.has(playerId)) {
      this.answers.set(playerId, { text: DEFAULT_ANSWER, isCorrect: false });
    }

    // If the designated chooser disconnects, auto-pick so the game doesn't stall
    if (this.phase === PHASES.CATEGORY_SELECTION && playerId === this.chooserPlayerId) {
      this._autoPickQuestion();
      return;
    }

    // activePlayers was already updated by RoomManager.syncActivePlayers before this call
    const activeAnswered = Array.from(this.activePlayers).filter(pid => this.answers.has(pid)).length;
    const activeVoted   = Array.from(this.activePlayers).filter(pid => this.votes.has(pid)).length;
    const activeCount   = this.activePlayers.size;

    if (this.phase === PHASES.ANSWERING && activeAnswered >= activeCount) {
      this.clearTimers();
      this.advanceToVoting();
    } else if (this.phase === PHASES.VOTING && activeVoted >= activeCount) {
      this.clearTimers();
      this.advanceToReveal();
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  endGame() {
    this.clearTimers();
    this.phase = PHASES.LOBBY;
    const finalScores = this.getScoresArray().sort((a, b) => b.score - a.score);
    this.io.to(this.roomCode).emit('game:end', { finalScores });

    this.currentRound = 0;
    this.chooserPlayerId = null;
    this.currentChooserIndex = 0;
    this.currentQuestion = null;
    this.answers.clear();
    this.votes.clear();
    this.scores.clear();
    this.correctGuessers.clear();
    this.isTransitioning = false;
  }

  destroy() {
    this.clearTimers();
    this.answers.clear();
    this.votes.clear();
    this.scores.clear();
    this.correctGuessers.clear();
    this.currentQuestion = null;
    this.chooserPlayerId = null;
  }

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

module.exports = KalakGame;
