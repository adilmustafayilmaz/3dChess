const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// rooms: { code: { white: socketId, black: socketId } }
const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentColor = null;

  socket.on('create_room', () => {
    const code = generateRoomCode();
    rooms[code] = { white: socket.id, black: null };
    currentRoom = code;
    currentColor = 'white';
    socket.join(code);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code }) => {
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
    currentRoom = code;
    currentColor = 'black';
    socket.join(code);

    // Notify both players
    io.to(room.white).emit('game_start', { color: 'white', code });
    io.to(room.black).emit('game_start', { color: 'black', code });
  });

  socket.on('move', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('move', data);
  });

  socket.on('promotion', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('promotion', data);
  });

  socket.on('new_game_request', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('new_game_request');
  });

  socket.on('new_game_accept', () => {
    if (!currentRoom) return;
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
        if (!room.white && !room.black) {
          delete rooms[currentRoom];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3131;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
