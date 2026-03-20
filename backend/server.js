// game-platform/backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const RoomManager = require('./RoomManager');
const TarraqGame = require('./TarraqGame');

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.use('/sounds', express.static(path.join(__dirname, 'public', 'sounds')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ─── Room Events ───────────────────────────────────────────────────────────

  socket.on('room:create', ({ username, isSpectator, playerId, playedQuestions }, callback) => {
    if (!username || typeof username !== 'string') {
      socket.emit('game:error', { message: 'يرجى إدخال اسم صالح' });
      return;
    }

    const result = roomManager.createRoom(socket, username, !!isSpectator, playerId, playedQuestions);
    if (result.error) {
      socket.emit('game:error', { message: result.error });
      return;
    }

    socket.emit('room:update', result.room);
    socket.emit('room:settings', result.room.settings);
    if (typeof callback === 'function') callback(result.room);
  });

  socket.on('room:join', ({ code, username, isSpectator, playerId }, callback) => {
    if (!code || !username || typeof code !== 'string' || typeof username !== 'string') {
      socket.emit('game:error', { message: 'يرجى إدخال كود الغرفة والاسم' });
      return;
    }

    const result = roomManager.joinRoom(socket, code, username, !!isSpectator, playerId);
    if (result.error) {
      socket.emit('game:error', { message: result.error });
      return;
    }

    socket.emit('room:update', result.room);
    socket.emit('room:settings', result.room.settings);
    if (typeof callback === 'function') callback(result.room);
  });

  // Silent rejoin after reconnect or page refresh
  socket.on('room:rejoin', ({ code, playerId }) => {
    if (!code || !playerId) return;

    const result = roomManager.rejoinRoom(socket, code, playerId);
    if (result.error) {
      // Silently signal failure — client will show join screen
      socket.emit('room:rejoin_failed', { message: result.error });
    }
  });

  socket.on('room:start', ({ code }) => {
    if (!code || typeof code !== 'string') {
      socket.emit('game:error', { message: 'كود الغرفة غير صالح' });
      return;
    }

    const result = roomManager.startGame(socket, code);
    if (result.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('room:settings_update', ({ code, settings }) => {
    if (!code || !settings) {
      socket.emit('game:error', { message: 'بيانات الإعدادات غير صالحة' });
      return;
    }

    const result = roomManager.updateSettings(socket, code, settings);
    if (result.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('kalak:team_select', ({ code, teamId }) => {
    if (!code || typeof teamId !== 'string') {
      socket.emit('game:error', { message: 'بيانات الفريق غير صالحة' });
      return;
    }
    const result = roomManager.selectTeam(socket, code, teamId);
    if (result.error) socket.emit('game:error', { message: result.error });
  });

  // ─── Game Events ───────────────────────────────────────────────────────────

  socket.on('game:answer', ({ code, answer }) => {
    if (!code || typeof answer !== 'string') {
      socket.emit('game:error', { message: 'بيانات الإجابة غير صالحة' });
      return;
    }

    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId) { socket.emit('game:error', { message: 'أنت لست في هذه الغرفة' }); return; }

    const isSpectator = roomManager.isSpectator(room, playerId);
    const result = room.game.submitAnswer(playerId, answer, isSpectator);

    if (result.error) { socket.emit('game:error', { message: result.error }); return; }

    if (result.correctGuess) {
      socket.emit('game:correct_guess', {
        message: 'أحسنت! هذه هي الإجابة الصحيحة. لقد كسبت نقطة إضافية. الآن اكتب إجابة مزيفة لخداع البقية!',
      });
    } else {
      socket.emit('game:answer_accepted', { message: 'تم إرسال إجابتك بنجاح! ✅' });
    }
  });

  socket.on('game:fake_answer', ({ code, answer }) => {
    if (!code || typeof answer !== 'string') {
      socket.emit('game:error', { message: 'بيانات الإجابة غير صالحة' });
      return;
    }

    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId) { socket.emit('game:error', { message: 'أنت لست في هذه الغرفة' }); return; }

    const result = room.game.submitFakeAnswer(playerId, answer);
    if (result.error) {
      socket.emit('game:error', { message: result.error });
    } else {
      socket.emit('game:answer_accepted', { message: 'تم إرسال إجابتك المزيفة! ✅' });
    }
  });

  socket.on('game:vote', ({ code, answerId }) => {
    if (!code || !answerId) {
      socket.emit('game:error', { message: 'بيانات التصويت غير صالحة' });
      return;
    }

    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId) { socket.emit('game:error', { message: 'أنت لست في هذه الغرفة' }); return; }

    const isSpectator = roomManager.isSpectator(room, playerId);
    const result = room.game.submitVote(playerId, answerId, isSpectator);
    if (result.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('game:next_round', ({ code }) => {
    if (!code || typeof code !== 'string') {
      socket.emit('game:error', { message: 'كود الغرفة غير صالح' });
      return;
    }

    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId || room.hostId !== playerId) {
      socket.emit('game:error', { message: 'فقط المضيف يمكنه الانتقال للسؤال التالي' });
      return;
    }

    console.log(`[next_round] room=${code} | phase=${room.game.phase} | round=${room.game.currentRound}/${room.game.settings.totalRounds} | transitioning=${room.game.isTransitioning}`);
    room.game.nextRoundManual();
  });

  // ─── Host Controls ─────────────────────────────────────────────────────────

  socket.on('room:kick', ({ code, targetId }) => {
    if (!code || !targetId) {
      socket.emit('game:error', { message: 'بيانات الطرد غير صالحة' });
      return;
    }
    const result = roomManager.kickPlayer(socket, code, targetId);
    if (result.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('game:select_category', ({ code, category }) => {
    if (!code || typeof category !== 'string') {
      socket.emit('game:error', { message: 'بيانات التصنيف غير صالحة' });
      return;
    }

    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId) { socket.emit('game:error', { message: 'أنت لست في هذه الغرفة' }); return; }

    const result = room.game.handleCategorySelection(playerId, category);
    if (result.error) {
      // game:category_error keeps the chooser's buttons active (unlike game:error)
      socket.emit('game:category_error', { message: result.error });
    }
  });

  socket.on('game:force_skip', ({ code }) => {
    if (!code || typeof code !== 'string') {
      socket.emit('game:error', { message: 'كود الغرفة غير صالح' });
      return;
    }
    const room = roomManager.getRoom(code);
    if (!room) { socket.emit('game:error', { message: 'الغرفة غير موجودة' }); return; }

    const playerId = roomManager.getPlayerIdBySocket(socket.id, code);
    if (!playerId || room.hostId !== playerId) {
      socket.emit('game:error', { message: 'فقط المضيف يمكنه تخطي المرحلة' });
      return;
    }
    room.game.forceSkipPhase();
  });

  // ─── Tarraq Events ─────────────────────────────────────────────────────────

  // Helper: resolve room + playerId from socket, verify game type
  function getTarraqContext() {
    const entry = roomManager.socketToPlayer.get(socket.id);
    if (!entry) return null;
    const room = roomManager.getRoom(entry.code);
    if (!room?.game) return null;
    return { room, playerId: entry.playerId };
  }

  socket.on('tarraq:start', (settings) => {
    const ctx = getTarraqContext();
    if (!ctx) return;
    const { room, playerId } = ctx;

    if (room.hostId !== playerId) {
      socket.emit('game:error', { message: 'فقط المضيف يمكنه بدء اللعبة' });
      return;
    }

    const activePlayers = roomManager.getActivePlayers(room);
    if (activePlayers.length < 2) {
      socket.emit('game:error', { message: 'يجب أن يكون هناك لاعبان على الأقل' });
      return;
    }

    room.game.destroy();
    room.game = new TarraqGame(io, room.code);
    roomManager.syncSpectators(room);
    roomManager.syncActivePlayers(room);

    if (settings && typeof settings === 'object') {
      room.game.updateSettings(settings);
    }

    room.game.start(activePlayers, room.playedQuestions || []);
  });

  socket.on('tarraq:buzz', () => {
    const ctx = getTarraqContext();
    if (!ctx || !(ctx.room.game instanceof TarraqGame)) return;

    const result = ctx.room.game.handleBuzz(ctx.playerId);
    if (result?.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('tarraq:answer', ({ text }) => {
    const ctx = getTarraqContext();
    if (!ctx || !(ctx.room.game instanceof TarraqGame)) return;
    if (typeof text !== 'string') return;

    const result = ctx.room.game.handleAnswer(ctx.playerId, text);
    if (result?.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('tarraq:judge', ({ correct }) => {
    const ctx = getTarraqContext();
    if (!ctx || !(ctx.room.game instanceof TarraqGame)) return;
    if (ctx.room.hostId !== ctx.playerId) return;

    const result = ctx.room.game.judgeAnswer(!!correct);
    if (result?.error) socket.emit('game:error', { message: result.error });
  });

  socket.on('tarraq:next', () => {
    const ctx = getTarraqContext();
    if (!ctx || !(ctx.room.game instanceof TarraqGame)) return;
    if (ctx.room.hostId !== ctx.playerId) return;
    if (ctx.room.game.phase !== 'SCORES') return;

    ctx.room.game.clearTimers();
    ctx.room.game._onPhaseTimeout();
  });

  // ─── Disconnection ─────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    roomManager.handleDisconnect(socket);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎮  لمّة (Lamma) Server running on http://localhost:${PORT}\n`);
});
