// game-platform/frontend/js/socket-client.js

class SocketClient {
  constructor() {
    this.socket = null;
    this.roomCode = null;
    this._username = null;
    this._isSpectator = false;
    this.playerId = this._getOrCreatePlayerId();
    this.listeners = new Map();
  }

  // ─── Persistent Player ID ─────────────────────────────────────────────────

  _getOrCreatePlayerId() {
    let id = localStorage.getItem('lamma_player_id');
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
      localStorage.setItem('lamma_player_id', id);
    }
    return id;
  }

  // ─── Connect ──────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = io({
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
      });

      this.socket.on('connect', () => {
        console.log('[Socket] Connected. playerId:', this.playerId);
        resolve(this.socket);
      });

      this.socket.on('connect_error', (err) => {
        console.error('[Socket] Connection error:', err.message);
        reject(err);
      });

      this.socket.on('disconnect', (reason) => {
        console.warn('[Socket] Disconnected:', reason);
      });

      // On reconnect: silently restore session if we have saved state
      this.socket.on('reconnect', (attempt) => {
        console.log('[Socket] Reconnected after', attempt, 'attempts');
        const savedCode = localStorage.getItem('lamma_room_code');
        if (savedCode && this._username) {
          console.log('[Socket] Restoring session for room:', savedCode);
          this.socket.emit('room:rejoin', {
            code: savedCode,
            playerId: this.playerId,
          });
        }
      });
    });
  }

  // ─── Session Recovery ─────────────────────────────────────────────────────

  /**
   * Called once after listeners are set up.
   * Tries to silently restore a previous session from localStorage.
   * Returns true if an attempt was made.
   */
  tryRestoreSession() {
    const savedCode     = localStorage.getItem('lamma_room_code');
    const savedUsername = localStorage.getItem('lamma_username');
    const savedSpectator = localStorage.getItem('lamma_is_spectator') === 'true';

    if (savedCode && savedUsername) {
      this._username = savedUsername;
      this._isSpectator = savedSpectator;
      this.roomCode = savedCode;
      this.socket.emit('room:rejoin', {
        code: savedCode,
        playerId: this.playerId,
      });
      return true;
    }
    return false;
  }

  /** Clear saved session (e.g. after being kicked) */
  clearSession() {
    localStorage.removeItem('lamma_room_code');
    this.roomCode = null;
  }

  // ─── Question History (Cross-Room Memory) ────────────────────────────────

  _getPlayedQuestions() {
    try {
      return JSON.parse(localStorage.getItem('lamma_played_questions') || '[]');
    } catch {
      return [];
    }
  }

  savePlayedQuestion(questionId) {
    if (!questionId) return;
    try {
      const played = this._getPlayedQuestions();
      if (!played.includes(questionId)) {
        played.push(questionId);
        localStorage.setItem('lamma_played_questions', JSON.stringify(played));
      }
    } catch { /* ignore storage errors */ }
  }

  clearPlayedQuestions() {
    localStorage.removeItem('lamma_played_questions');
  }

  // ─── Room Actions ─────────────────────────────────────────────────────────

  createRoom(username, isSpectator = false) {
    this._username = username;
    this._isSpectator = isSpectator;
    localStorage.setItem('lamma_username', username);
    localStorage.setItem('lamma_is_spectator', String(isSpectator));
    const playedQuestions = this._getPlayedQuestions();
    this.socket.emit('room:create', { username, isSpectator, playerId: this.playerId, playedQuestions }, (room) => {
      if (room && room.code) {
        this.roomCode = room.code;
        localStorage.setItem('lamma_room_code', room.code);
      }
    });
  }

  joinRoom(code, username, isSpectator = false) {
    this._username = username;
    this._isSpectator = isSpectator;
    localStorage.setItem('lamma_username', username);
    localStorage.setItem('lamma_is_spectator', String(isSpectator));
    localStorage.setItem('lamma_room_code', code.toUpperCase());
    this.socket.emit('room:join', { code, username, isSpectator, playerId: this.playerId }, (room) => {
      if (room && room.code) {
        this.roomCode = room.code;
      }
    });
  }

  startGame() {
    if (!this.roomCode) return;
    this.socket.emit('room:start', { code: this.roomCode });
  }

  // ─── Game Actions ─────────────────────────────────────────────────────────

  submitAnswer(answer) {
    if (!this.roomCode) return;
    this.socket.emit('game:answer', { code: this.roomCode, answer });
  }

  submitFakeAnswer(answer) {
    if (!this.roomCode) return;
    this.socket.emit('game:fake_answer', { code: this.roomCode, answer });
  }

  submitVote(answerId) {
    if (!this.roomCode) return;
    this.socket.emit('game:vote', { code: this.roomCode, answerId });
  }

  nextRound() {
    if (!this.roomCode) return;
    this.socket.emit('game:next_round', { code: this.roomCode });
  }

  leaveRoom() {
    if (!this.roomCode) return;
    const code = this.roomCode;
    this.socket.emit('room:leave', { code, playerId: this.playerId });
    localStorage.removeItem('lamma_room_code');
    this.roomCode = null;
  }

  kickPlayer(targetId) {
    if (!this.roomCode) return;
    this.socket.emit('room:kick', { code: this.roomCode, targetId });
  }

  selectCategory(category) {
    if (!this.roomCode) return;
    this.socket.emit('game:select_category', { code: this.roomCode, category });
  }

  forceSkip() {
    if (!this.roomCode) return;
    this.socket.emit('game:force_skip', { code: this.roomCode });
  }

  selectTeam(teamId) {
    if (!this.roomCode) return;
    this.socket.emit('kalak:team_select', { code: this.roomCode, teamId });
  }

  updateSettings(settings) {
    if (!this.roomCode) return;
    this.socket.emit('room:settings_update', { code: this.roomCode, settings });
  }

  // ─── Event Handling ───────────────────────────────────────────────────────

  on(event, callback) {
    if (!this.socket) return;
    this.socket.on(event, callback);
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  off(event) {
    if (!this.socket) return;
    this.socket.off(event);
    this.listeners.delete(event);
  }

  /** Returns the stable playerId (not socket.id) */
  getMyId() {
    return this.playerId;
  }

  disconnect() {
    if (this.socket) this.socket.disconnect();
  }
}

// Global singleton
window.socketClient = new SocketClient();
