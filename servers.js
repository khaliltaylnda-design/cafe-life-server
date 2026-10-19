const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map();
const rooms = new Map();
let nextRoomId = 1;

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function broadcast(o, excludeId = null) {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg);
  });
}

function broadcastRoom(roomId, o) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(o);
  room.players.forEach(pId => {
    wss.clients.forEach(c => {
      if (c.playerId === pId && c.readyState === 1) c.send(msg);
    });
  });
}

wss.on('connection', ws => {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  ws.playerId = id;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  send(ws, { type: 'init', id });
  players.forEach(p => send(ws, { type: 'player:join', player: p }));

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    const player = players.get(id);

    if (d.type === 'join') {
      const p = {
        id,
        name: String(d.name || 'ضيف').slice(0, 14),
        color: String(d.color || '#e74c3c').slice(0, 9),
        x: 0, z: 2, ry: 0, s: 0
      };
      players.set(id, p);
      broadcast({ type: 'player:join', player: p }, id);
    } 
    else if (d.type === 'move') {
      if (!player) return;
      player.x = Math.max(-14, Math.min(14, +d.x || 0));
      player.z = Math.max(-6, Math.min(9, +d.z || 0));
      player.ry = +d.ry || 0;
      player.s = d.s ? 1 : 0;
      broadcast({ type: 'player:move', id, x: player.x, y: 0, z: player.z, ry: player.ry, s: player.s }, id);
    } 
    else if (d.type === 'signal') {
      wss.clients.forEach(c => {
        if (c.playerId === d.to) send(c, { type: 'signal', from: id, data: d.data });
      });
    } 
    else if (d.type === 'chat') {
      const text = String(d.text || '').trim().slice(0, 80);
      if (player && text) broadcast({ type: 'chat', id, name: player.name, text });
    }
    else if (d.type === 'game:create') {
      if (!player) return;
      const roomId = 'r_' + nextRoomId++;
      const gameType = d.game;

      const newRoom = {
        id: roomId,
        type: gameType,
        players: [id],
        status: 'waiting',
        gameState: null
      };

      if (gameType === 'chess') {
        newRoom.chessEngine = new Chess();
        newRoom.gameState = {
          fen: newRoom.chessEngine.fen(),
          turn: 'w',
          whitePlayer: id,
          blackPlayer: null
        };
      }

      rooms.set(roomId, newRoom);
      player.room = roomId;

      send(ws, { type: 'game:created', roomId: roomId, gameState: newRoom.gameState });
    }
    else if (d.type === 'game:join') {
      const room = rooms.get(d.roomId);
      if (room && room.status === 'waiting' && room.players.length < 2) {
        room.players.push(id);
        player.room = d.roomId;

        if (room.type === 'chess') {
          room.gameState.blackPlayer = id;
        }

        room.status = 'playing';

        room.players.forEach(pId => {
          wss.clients.forEach(c => {
            if (c.playerId === pId) {
              send(c, {
                type: 'game:start',
                roomId: room.id,
                gameState: room.gameState,
                yourColor: pId === room.gameState.whitePlayer ? 'w' : 'b'
              });
            }
          });
        });
      } else {
        send(ws, { type: 'error', message: 'Room full or unavailable' });
      }
    }
    else if (d.type === 'game:action') {
      if (!player || !player.room) return;
      const room = rooms.get(player.room);
      if (!room || room.status !== 'playing') return;

      if (room.type === 'chess') {
        const isWhiteTurn = room.chessEngine.turn() === 'w';
        const playerIsWhite = id === room.gameState.whitePlayer;

        if ((isWhiteTurn && !playerIsWhite) || (!isWhiteTurn && playerIsWhite)) {
          send(ws, { type: 'error', message: 'Not your turn' });
          return;
        }

        try {
          const move = room.chessEngine.move({ from: d.from, to: d.to, promotion: 'q' });
          if (move) {
            room.gameState.fen = room.chessEngine.fen();
            room.gameState.turn = room.chessEngine.turn();

            if (room.chessEngine.game_over()) {
              room.status = 'finished';
              room.gameState.result = room.chessEngine.in_checkmate() ? 'Checkmate' : 'Draw';
            }

            broadcastRoom(room.id, {
              type: 'game:update',
              gameState: room.gameState,
              lastMove: { from: d.from, to: d.to }
            });
          } else {
            send(ws, { type: 'error', message: 'Invalid move' });
          }
        } catch (e) {
          send(ws, { type: 'error', message: 'Move error' });
        }
      }
    }
    else if (d.type === 'game:leave') {
      if (player && player.room) {
        const room = rooms.get(player.room);
        if (room) {
          broadcastRoom(room.id, { type: 'game:over', message: 'Opponent left' });
          room.players.forEach(pId => {
            const pClient = [...wss.clients].find(c => c.playerId === pId);
            if (pClient) {
              const pl = players.get(pId);
              if (pl) pl.room = null;
            }
          });
          rooms.delete(room.id);
        }
        player.room = null;
      }
    }
  });

  ws.on('close', () => {
    const player = players.get(id);
    if (player && player.room) {
      const room = rooms.get(player.room);
      if (room) {
        broadcastRoom(room.id, { type: 'game:over', message: 'Opponent disconnected' });
        room.players.forEach(pId => {
          const pl = players.get(pId);
          if (pl) pl.room = null;
        });
        rooms.delete(room.id);
      }
    }
    players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));
