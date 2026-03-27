// game-platform/backend/RoomManager.js
const { generateRoomCode, sanitizeInput } = require('./utils');
const KalakGame = require('./KalakGame');

const MAX_NAME_LENGTH = 15;
const GRACE_PERIOD_MS = 30 * 1000; // 30 seconds to reconnect before permanent removal

const KALAK_EMOJIS = ['🦊', '🦉', '🦁', '🐼', '🐙', '🐸', '🐯', '🐰', '🐻', '🐹'];

function getRandomEmoji() {
  return KALAK_EMOJIS[Math.floor(Math.random() * KALAK_EMOJIS.length)];
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();           // code → room
    this.socketToPlayer = new Map();  // socketId → { code, playerId }
  }

  // ─── Create Room ───────────────────────────────────────────────────────────

  createRoom(socket, username, isSpectator = false, playerId, playedQuestions = []) {
    const sanitizedName = sanitizeInput(username, MAX_NAME_LENGTH);
    if (!sanitizedName) return { error: 'اسم المستخدم غير صالح' };
    if (!playerId || typeof playerId !== 'string') return { error: 'معرّف اللاعب غير صالح' };

    let code;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
      if (attempts > 100) return { error: 'تعذّر إنشاء الغرفة، حاول مرة أخرى' };
    } while (this.rooms.has(code));

    const room = {
      code,
      hostId: playerId,              // playerId (not socketId)
      players: new Map(),            // playerId → player object
      game: new KalakGame(this.io, code),
      createdAt: Date.now(),
      settings: { totalRounds: 5, answerTime: 60, categories: [], teamsMode: false, teamsCount: 2, maxPlayers: 8 },
      maxPlayers: 8,
      playedQuestions: Array.isArray(playedQuestions) ? playedQuestions.filter(Number.isInteger) : [],
    };

    room.players.set(playerId, {
      id: playerId,
      socketId: socket.id,
      username: sanitizedName,
      joinedAt: Date.now(),
      connected: true,
      isSpectator: !!isSpectator,
      emoji: getRandomEmoji(),
      teamId: null,
      gracePeriodTimer: null,
    });

    this.socketToPlayer.set(socket.id, { code, playerId });
    this.syncSpectators(room);
    this.syncActivePlayers(room);

    this.rooms.set(code, room);
    socket.join(code);

    return { success: true, room: this.serializeRoom(room) };
  }

  // ─── Join Room ─────────────────────────────────────────────────────────────

  joinRoom(socket, code, username, isSpectator = false, playerId) {
    const sanitizedName = sanitizeInput(username, MAX_NAME_LENGTH);
    if (!sanitizedName) return { error: 'اسم المستخدم غير صالح' };
    if (!playerId || typeof playerId !== 'string') return { error: 'معرّف اللاعب غير صالح' };

    const normalizedCode = code.toUpperCase().trim();
    const room = this.rooms.get(normalizedCode);
    if (!room) return { error: 'الغرفة غير موجودة' };

    if (room.game.phase !== 'LOBBY') {
      return { error: 'اللعبة بدأت بالفعل' };
    }

    const limit = room.maxPlayers;
    const isFull = limit > 0 && room.players.size >= limit;
    if (isFull) return { error: 'الغرفة ممتلئة' };

    // Reconnect in lobby: player already exists (e.g. refreshed page before game started)
    if (room.players.has(playerId)) {
      return this._restorePlayerSocket(socket, room, playerId, normalizedCode);
    }

    // Check duplicate username
    for (const [, player] of room.players) {
      if (player.username === sanitizedName) {
        return { error: 'الاسم مستخدم بالفعل في هذه الغرفة' };
      }
    }

    room.players.set(playerId, {
      id: playerId,
      socketId: socket.id,
      username: sanitizedName,
      joinedAt: Date.now(),
      connected: true,
      isSpectator: !!isSpectator,
      emoji: getRandomEmoji(),
      teamId: null,
      gracePeriodTimer: null,
    });

    this.socketToPlayer.set(socket.id, { code: normalizedCode, playerId });
    this.syncSpectators(room);
    this.syncActivePlayers(room);
    socket.join(normalizedCode);
    this.broadcastRoomUpdate(room);

    return { success: true, room: this.serializeRoom(room) };
  }

  // ─── Rejoin Room (reconnect mid-game or after refresh) ────────────────────

  rejoinRoom(socket, code, playerId) {
    if (!playerId || typeof playerId !== 'string') {
      return { error: 'معرّف اللاعب غير صالح' };
    }

    const normalizedCode = code.toUpperCase().trim();
    const room = this.rooms.get(normalizedCode);
    if (!room) return { error: 'الغرفة لم تعد موجودة' };

    if (!room.players.has(playerId)) {
      return { error: 'انتهت مهلة الاتصال، يرجى الانضمام من جديد' };
    }

    this._restorePlayerSocket(socket, room, playerId, normalizedCode);

    // Restore game state if a game is in progress
    if (room.game.phase !== 'LOBBY') {
      socket.emit('game:phase', {
        phase: room.game.phase,
        data: room.game.getPhaseData(),
        timeLeft: room.game.timeLeft,
        round: room.game.currentRound,
        totalRounds: room.game.settings.totalRounds,
      });

      // Re-confirm answer if player already submitted this round
      if (room.game.phase === 'ANSWERING' && room.game.answers.has(playerId)) {
        socket.emit('game:answer_accepted', { message: 'إجابتك تم حفظها ✅' });
      }
    }

    return { success: true };
  }

  // Internal: update socket mapping and cancel grace period timer
  _restorePlayerSocket(socket, room, playerId, code) {
    const player = room.players.get(playerId);

    if (player.gracePeriodTimer) {
      clearTimeout(player.gracePeriodTimer);
      player.gracePeriodTimer = null;
    }

    if (player.socketId) this.socketToPlayer.delete(player.socketId);
    player.socketId = socket.id;
    player.connected = true;

    this.socketToPlayer.set(socket.id, { code, playerId });
    socket.join(code);
    this.syncSpectators(room);
    this.syncActivePlayers(room);

    socket.emit('room:update', this.serializeRoom(room));
    socket.emit('room:settings', room.settings);
    this.broadcastRoomUpdate(room);

    return { success: true, room: this.serializeRoom(room) };
  }

  // ─── Start Game ────────────────────────────────────────────────────────────

  startGame(socket, code) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'الغرفة غير موجودة' };

    const playerId = this.getPlayerIdBySocket(socket.id, code);
    if (!playerId || room.hostId !== playerId) {
      return { error: 'فقط المضيف يمكنه بدء اللعبة' };
    }

    const activePlayers = this.getActivePlayers(room);
    if (activePlayers.length < 3) {
      return { error: 'يجب أن يكون هناك 3 لاعبين (غير مراقبين) على الأقل لبدء اللعبة' };
    }

    if (room.settings.teamsMode) {
      const occupiedTeams = new Set(activePlayers.map(p => p.teamId).filter(Boolean));
      if (occupiedTeams.size < 2) {
        return { error: 'في وضع الفرق، يجب توزيع اللاعبين على فريقين مختلفين على الأقل' };
      }
    }

    room.game.start(activePlayers, room.playedQuestions);
    return { success: true };
  }

  // ─── Leave Room (voluntary) ────────────────────────────────────────────────

  leaveRoom(code, playerId) {
    const normalizedCode = code.toUpperCase().trim();
    const room = this.rooms.get(normalizedCode);
    if (!room) return { error: 'الغرفة غير موجودة' };
    if (!room.players.has(playerId)) return { error: 'اللاعب غير موجود في الغرفة' };

    const player = room.players.get(playerId);
    if (player.gracePeriodTimer) clearTimeout(player.gracePeriodTimer);

    if (player.socketId) {
      this.socketToPlayer.delete(player.socketId);
      const sock = this.io.sockets.sockets.get(player.socketId);
      if (sock) sock.leave(normalizedCode);
    }

    room.players.delete(playerId);
    this.syncSpectators(room);
    this.syncActivePlayers(room);

    if (room.players.size === 0) {
      room.game.destroy();
      this.rooms.delete(normalizedCode);
      console.log(`[GC] Room ${normalizedCode} destroyed — last player left.`);
      return { success: true };
    }

    if (room.hostId === playerId) {
      const connected = this.getConnectedPlayers(room);
      if (connected.length > 0) {
        const oldest = connected.sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.hostId = oldest.id;
        this.io.to(normalizedCode).emit('room:host_transferred', {
          newHostId: oldest.id,
          username: oldest.username,
        });
        console.log(`[HOST] Host transferred to ${oldest.username} in room ${normalizedCode}.`);
      }
    }

    this.broadcastRoomUpdate(room);
    return { success: true };
  }

  // ─── Kick Player ───────────────────────────────────────────────────────────

  kickPlayer(socket, code, targetId) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'الغرفة غير موجودة' };

    const playerId = this.getPlayerIdBySocket(socket.id, code);
    if (!playerId || room.hostId !== playerId) return { error: 'فقط المضيف يمكنه طرد اللاعبين' };
    if (targetId === playerId) return { error: 'لا يمكنك طرد نفسك' };
    if (room.game.phase !== 'LOBBY') return { error: 'لا يمكن طرد لاعب أثناء اللعبة' };
    if (!room.players.has(targetId)) return { error: 'اللاعب غير موجود في الغرفة' };

    const target = room.players.get(targetId);
    if (target.gracePeriodTimer) clearTimeout(target.gracePeriodTimer);

    if (target.socketId) {
      this.io.to(target.socketId).emit('room:kicked', { message: 'تم طردك من الغرفة من قبل المضيف' });
      const targetSocket = this.io.sockets.sockets.get(target.socketId);
      if (targetSocket) targetSocket.leave(code);
      this.socketToPlayer.delete(target.socketId);
    }

    room.players.delete(targetId);
    this.syncSpectators(room);
    this.syncActivePlayers(room);
    this.broadcastRoomUpdate(room);
    return { success: true };
  }

  // ─── Select Team ───────────────────────────────────────────────────────────

  selectTeam(socket, code, teamId) {
    const VALID_TEAMS = new Set(['red', 'blue', 'green', 'yellow']);
    const room = this.rooms.get(code);
    if (!room) return { error: 'الغرفة غير موجودة' };
    if (room.game.phase !== 'LOBBY') return { error: 'لا يمكن تغيير الفريق أثناء اللعبة' };
    if (!VALID_TEAMS.has(teamId)) return { error: 'فريق غير صالح' };

    const playerId = this.getPlayerIdBySocket(socket.id, code);
    if (!playerId) return { error: 'أنت لست في هذه الغرفة' };

    const player = room.players.get(playerId);
    if (!player) return { error: 'اللاعب غير موجود' };
    if (player.isSpectator) return { error: 'المراقبون لا يمكنهم اختيار فريق' };

    player.teamId = teamId;
    this.broadcastRoomUpdate(room);
    return { success: true };
  }

  // ─── Update Settings ───────────────────────────────────────────────────────

  updateSettings(socket, code, settings) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'الغرفة غير موجودة' };

    const playerId = this.getPlayerIdBySocket(socket.id, code);
    if (!playerId || room.hostId !== playerId) return { error: 'فقط المضيف يمكنه تغيير الإعدادات' };

    room.game.updateSettings(settings);

    if (settings.maxPlayers !== undefined) {
      const v = Number(settings.maxPlayers);
      if ([0, 2, 4, 6, 8, 10, 12, 16].includes(v)) room.maxPlayers = v;
    }

    room.settings = {
      totalRounds: room.game.settings.totalRounds,
      answerTime: room.game.settings.answerTime,
      categories: room.game.settings.categories,
      teamsMode: room.game.settings.teamsMode,
      teamsCount: room.game.settings.teamsCount,
      maxPlayers: room.maxPlayers,
    };

    this.io.to(room.code).emit('room:settings', room.settings);
    return { success: true };
  }

  // ─── Disconnect (grace period) ─────────────────────────────────────────────

  handleDisconnect(socket) {
    const entry = this.socketToPlayer.get(socket.id);
    if (!entry) return;

    const { code, playerId } = entry;
    this.socketToPlayer.delete(socket.id);
    socket.leave(code);

    const room = this.rooms.get(code);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;

    // Sync active players BEFORE notifying game engine (so counts are correct)
    this.syncActivePlayers(room);
    room.game.handleDisconnect(playerId);

    // Host migration if needed
    const connectedPlayers = this.getConnectedPlayers(room);
    if (connectedPlayers.length > 0 && room.hostId === playerId) {
      const oldest = connectedPlayers.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = oldest.id;
      console.log(`[HOST] Host migrated to ${oldest.username} in room ${code}.`);
    }

    this.broadcastRoomUpdate(room);

    // Grace period: permanent removal after timeout
    player.gracePeriodTimer = setTimeout(() => {
      this._removePlayerPermanently(code, playerId);
    }, GRACE_PERIOD_MS);
  }

  _removePlayerPermanently(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;

    player.gracePeriodTimer = null;
    room.players.delete(playerId);
    this.syncSpectators(room);
    this.syncActivePlayers(room);

    if (room.players.size === 0) {
      room.game.destroy();
      this.rooms.delete(code);
      console.log(`[GC] Room ${code} destroyed — grace period expired, no players remaining.`);
      return;
    }

    this.broadcastRoomUpdate(room);
  }

  // ─── Sync Helpers ──────────────────────────────────────────────────────────

  syncSpectators(room) {
    const spectatorIds = new Set();
    room.players.forEach((player) => {
      if (player.isSpectator && player.connected) spectatorIds.add(player.id);
    });
    room.game.spectatorIds = spectatorIds;
  }

  syncActivePlayers(room) {
    const activePids = new Set();
    room.players.forEach((player) => {
      if (player.connected && !player.isSpectator) activePids.add(player.id);
    });
    room.game.activePlayers = activePids;
  }

  // ─── Lookup Helpers ────────────────────────────────────────────────────────

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  getPlayerIdBySocket(socketId, code) {
    const entry = this.socketToPlayer.get(socketId);
    if (!entry) return null;
    if (code && entry.code !== code) return null;
    return entry.playerId;
  }

  isSpectator(room, playerId) {
    const player = room.players.get(playerId);
    return player ? player.isSpectator : false;
  }

  getConnectedPlayers(room) {
    const connected = [];
    room.players.forEach((player) => {
      if (player.connected) connected.push(player);
    });
    return connected;
  }

  getActivePlayers(room) {
    const active = [];
    room.players.forEach((player) => {
      if (player.connected && !player.isSpectator) active.push(player);
    });
    return active;
  }

  broadcastRoomUpdate(room) {
    this.io.to(room.code).emit('room:update', this.serializeRoom(room));
  }

  serializeRoom(room) {
    const players = [];
    room.players.forEach((player) => {
      if (player.connected) {
        players.push({
          id: player.id,       // playerId — stable across reconnects
          username: player.username,
          isSpectator: player.isSpectator,
          emoji: player.emoji,
          teamId: player.teamId || null,
        });
      }
    });

    return {
      code: room.code,
      hostId: room.hostId,   // playerId
      players,
      settings: room.settings,
    };
  }
}

module.exports = RoomManager;
