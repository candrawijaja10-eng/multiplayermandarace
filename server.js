const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===================== CONFIG =====================
const PORT = process.env.PORT || 8080;
const STATIC_DIR = './public'; // Folder containing your HTML file

// ===================== GAME STATE =====================
const rooms = new Map(); // roomCode -> { players: [], status, gameData }
const players = new Map(); // ws -> { id, roomCode, name }

// ===================== HTTP SERVER (SERVE STATIC FILES) =====================
const server = http.createServer((req, res) => {
    let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url);

    // Security: prevent directory traversal
    if (!filePath.startsWith(path.resolve(STATIC_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

// ===================== WEBSOCKET SERVER =====================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New client connected. Total:', wss.clients.size);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (e) {
            console.error('Invalid message:', e.message);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
        console.log('Client disconnected. Total:', wss.clients.size);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

// ===================== MESSAGE HANDLER =====================
function handleMessage(ws, data) {
    switch(data.type) {
        case 'get_rooms':
            sendRoomList(ws);
            break;

        case 'create_room':
            createRoom(ws, data);
            break;

        case 'join_room':
            joinRoom(ws, data);
            break;

        case 'leave_room':
            leaveRoom(ws, data);
            break;

        case 'player_move':
        case 'player_progress':
        case 'player_finished':
        case 'player_shield':
        case 'player_turbo':
            broadcastToRoom(ws, data);
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

// ===================== ROOM MANAGEMENT =====================
function createRoom(ws, data) {
    const roomCode = data.roomCode || generateRoomCode();

    if (rooms.has(roomCode)) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Room already exists' 
        }));
        return;
    }

    const room = {
        code: roomCode,
        players: [{
            id: data.playerId,
            name: data.playerName,
            ws: ws,
            ready: false
        }],
        status: 'waiting',
        createdAt: Date.now()
    };

    rooms.set(roomCode, room);
    players.set(ws, { id: data.playerId, roomCode, name: data.playerName });

    ws.send(JSON.stringify({ 
        type: 'room_created', 
        roomCode: roomCode,
        isHost: true
    }));

    broadcastRoomList();
    console.log(`Room ${roomCode} created by ${data.playerName}`);
}

function joinRoom(ws, data) {
    const room = rooms.get(data.roomCode);

    if (!room) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Room not found' 
        }));
        return;
    }

    if (room.players.length >= 2) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Room is full' 
        }));
        return;
    }

    if (room.status === 'playing') {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Game already in progress' 
        }));
        return;
    }

    room.players.push({
        id: data.playerId,
        name: data.playerName,
        ws: ws,
        ready: false
    });

    players.set(ws, { id: data.playerId, roomCode: data.roomCode, name: data.playerName });

    // Notify the joiner
    ws.send(JSON.stringify({ 
        type: 'room_joined', 
        roomCode: data.roomCode,
        isHost: false
    }));

    // Notify the host that someone joined
    const host = room.players[0];
    host.ws.send(JSON.stringify({
        type: 'player_joined',
        player: { id: data.playerId, name: data.playerName }
    }));

    // If room is now full, start countdown
    if (room.players.length === 2) {
        room.status = 'starting';
        broadcastRoomList();

        // Auto-start after 3 seconds
        setTimeout(() => {
            if (room.players.length === 2) {
                room.status = 'playing';
                room.players.forEach(p => {
                    p.ws.send(JSON.stringify({ type: 'game_start' }));
                });
                console.log(`Game started in room ${data.roomCode}`);
            }
        }, 3000);
    }

    console.log(`${data.playerName} joined room ${data.roomCode}`);
}

function leaveRoom(ws, data) {
    const playerInfo = players.get(ws);
    if (!playerInfo) return;

    const room = rooms.get(playerInfo.roomCode);
    if (!room) return;

    // Remove player from room
    room.players = room.players.filter(p => p.id !== playerInfo.id);

    // Notify remaining player
    room.players.forEach(p => {
        p.ws.send(JSON.stringify({
            type: 'player_disconnect',
            playerId: playerInfo.id
        }));
    });

    // Clean up empty rooms
    if (room.players.length === 0) {
        rooms.delete(playerInfo.roomCode);
        console.log(`Room ${playerInfo.roomCode} deleted (empty)`);
    } else {
        room.status = 'waiting';
    }

    players.delete(ws);
    broadcastRoomList();
}

function handleDisconnect(ws) {
    const playerInfo = players.get(ws);
    if (playerInfo) {
        leaveRoom(ws, { roomCode: playerInfo.roomCode });
    }
}

// ===================== BROADCAST HELPERS =====================
function broadcastToRoom(senderWs, data) {
    const playerInfo = players.get(senderWs);
    if (!playerInfo) return;

    const room = rooms.get(playerInfo.roomCode);
    if (!room) return;

    room.players.forEach(p => {
        if (p.ws !== senderWs && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify(data));
        }
    });
}

function sendRoomList(ws) {
    const roomList = Array.from(rooms.values()).map(r => ({
        code: r.code,
        players: r.players.length,
        status: r.status
    }));

    ws.send(JSON.stringify({
        type: 'rooms_list',
        rooms: roomList
    }));
}

function broadcastRoomList() {
    const roomList = Array.from(rooms.values()).map(r => ({
        code: r.code,
        players: r.players.length,
        status: r.status
    }));

    const message = JSON.stringify({
        type: 'rooms_list',
        rooms: roomList
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ===================== UTILITIES =====================
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // Ensure unique
    if (rooms.has(code)) return generateRoomCode();
    return code;
}

// ===================== START SERVER =====================
server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🎮 学生词 Multiplayer Server');
    console.log('='.repeat(50));
    console.log(`📡 HTTP Server:  http://localhost:${PORT}`);
    console.log(`📡 WebSocket:    ws://localhost:${PORT}`);
    console.log(`📁 Static files: ${path.resolve(STATIC_DIR)}`);
    console.log('='.repeat(50));
    console.log('Ready for connections!');
});
