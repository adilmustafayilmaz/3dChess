const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// --- Helmet: security headers (also disables X-Powered-By) ---
app.use(helmet({
  contentSecurityPolicy: false, // disabled so inline scripts in index.html work
}));

// --- HTTP rate limiting ---
const httpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // limit each IP to 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
});
app.use(httpLimiter);

app.use(express.static(__dirname));

// --- Socket.IO with explicit CORS configuration ---
const io = new Server(server, {
  cors: {
    origin: '*',          // allow all origins (game is public)
    methods: ['GET', 'POST'],
  },
});

// --- Socket.IO connection rate limiting (per IP) ---
// Track connection timestamps per IP
const connectionTimestamps = {};
const SOCKET_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const SOCKET_RATE_MAX = 10;               // max 10 connections per minute per IP

function isSocketRateLimited(ip) {
  const now = Date.now();
  if (!connectionTimestamps[ip]) {
    connectionTimestamps[ip] = [];
  }
  // Remove timestamps outside the window
  connectionTimestamps[ip] = connectionTimestamps[ip].filter(
    (ts) => now - ts < SOCKET_RATE_WINDOW_MS
  );
  if (connectionTimestamps[ip].length >= SOCKET_RATE_MAX) {
    return true;
  }
  connectionTimestamps[ip].push(now);
  return false;
}

// Periodically clean up stale IP entries from the rate limiter map (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(connectionTimestamps)) {
    connectionTimestamps[ip] = connectionTimestamps[ip].filter(
      (ts) => now - ts < SOCKET_RATE_WINDOW_MS
    );
    if (connectionTimestamps[ip].length === 0) {
      delete connectionTimestamps[ip];
    }
  }
}, 5 * 60 * 1000);

// --- Room constants ---
const MAX_ROOMS = 100;

// rooms: { code: { white: socketId, black: socketId, lastActivity: timestamp } }
const rooms = {};

// --- Input validation helpers ---
function isValidRoomCode(code) {
  return typeof code === 'string' && /^\d{4}$/.test(code);
}

function isValidCoord(val) {
  return Number.isInteger(val) && val >= 0 && val <= 7;
}

function isValidMoveData(data) {
  return (
    data != null &&
    typeof data === 'object' &&
    isValidCoord(data.fromCol) &&
    isValidCoord(data.fromRow) &&
    isValidCoord(data.toCol) &&
    isValidCoord(data.toRow)
  );
}

const VALID_PROMOTION_PIECES = ['queen', 'rook', 'bishop', 'knight'];

function isValidPromotionData(data) {
  return (
    isValidMoveData(data) &&
    typeof data.promoteTo === 'string' &&
    VALID_PROMOTION_PIECES.includes(data.promoteTo)
  );
}

// --- Periodic room cleanup: remove abandoned rooms (both players null > 5 min) ---
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    if (!room.white && !room.black && now - room.lastActivity > 5 * 60 * 1000) {
      delete rooms[code];
    }
  }
}, 60 * 1000); // check every minute

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {
  // --- Socket.IO connection rate limiting ---
  const clientIp =
    socket.handshake.headers['x-forwarded-for'] ||
    socket.handshake.address;
  if (isSocketRateLimited(clientIp)) {
    socket.emit('error_message', { message: 'Too many connections. Try again later.' });
    socket.disconnect(true);
    return;
  }

  let currentRoom = null;
  let currentColor = null;

  socket.on('create_room', () => {
    // --- Max rooms limit ---
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      socket.emit('join_error', { message: 'Server is full. Try again later.' });
      return;
    }
    const code = generateRoomCode();
    rooms[code] = { white: socket.id, black: null, lastActivity: Date.now() };
    currentRoom = code;
    currentColor = 'white';
    socket.join(code);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', (payload) => {
    // --- Input validation: code must be a 4-digit string ---
    if (payload == null || typeof payload !== 'object') return;
    const { code } = payload;
    if (!isValidRoomCode(code)) return;

    const room = rooms[code];
    if (!room) {
      socket.emit('join_error', { message: 'Oda bulunamadı.' });
      return;
    }
    if (room.black) {
      socket.emit('join_error', { message: 'Oda dolu.' });
      return;
    }
    room.black = socket.id;
    room.lastActivity = Date.now();
    currentRoom = code;
    currentColor = 'black';
    socket.join(code);

    // Notify both players
    io.to(room.white).emit('game_start', { color: 'white', code });
    io.to(room.black).emit('game_start', { color: 'black', code });
  });

  socket.on('move', (data) => {
    if (!currentRoom) return;
    // --- Input validation: move coordinates must be integers 0-7 ---
    if (!isValidMoveData(data)) return;
    rooms[currentRoom] && (rooms[currentRoom].lastActivity = Date.now());
    socket.to(currentRoom).emit('move', data);
  });

  socket.on('promotion', (data) => {
    if (!currentRoom) return;
    // --- Input validation: move coords + promoteTo must be valid ---
    if (!isValidPromotionData(data)) return;
    rooms[currentRoom] && (rooms[currentRoom].lastActivity = Date.now());
    socket.to(currentRoom).emit('promotion', data);
  });

  socket.on('new_game_request', () => {
    if (!currentRoom) return;
    rooms[currentRoom] && (rooms[currentRoom].lastActivity = Date.now());
    socket.to(currentRoom).emit('new_game_request');
  });

  socket.on('new_game_accept', () => {
    if (!currentRoom) return;
    rooms[currentRoom] && (rooms[currentRoom].lastActivity = Date.now());
    socket.to(currentRoom).emit('new_game_accept');
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('opponent_disconnected');
      const room = rooms[currentRoom];
      if (room) {
        // If both disconnected or opponent left, clean up
        if (currentColor === 'white') room.white = null;
        else room.black = null;
        room.lastActivity = Date.now();
        if (!room.white && !room.black) {
          // Room will be cleaned up by periodic cleanup if not immediately
          // (keep lastActivity for the 5-minute grace window)
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3131;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
