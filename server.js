const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

const dbPath = path.join(__dirname, 'chat.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL, is_locked INTEGER DEFAULT 0,
    password_hash TEXT, disappearing_minutes INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    username TEXT NOT NULL, avatar_color TEXT DEFAULT '#6c5ce7',
    role TEXT DEFAULT 'member', last_seen INTEGER DEFAULT 0,
    avatar_emoji TEXT DEFAULT '',
    status TEXT DEFAULT 'available',
    joined_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id), UNIQUE(room_id, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    sender TEXT NOT NULL, encrypted_content TEXT NOT NULL, iv TEXT NOT NULL,
    message_type TEXT DEFAULT 'text', is_edited INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0, reply_to INTEGER, expires_at INTEGER DEFAULT 0,
    channel TEXT DEFAULT 'general',
    timestamp INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
    room_id TEXT NOT NULL, username TEXT NOT NULL, emoji TEXT NOT NULL,
    UNIQUE(message_id, username, emoji)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS read_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
    room_id TEXT NOT NULL, username TEXT NOT NULL,
    read_at INTEGER DEFAULT (strftime('%s','now')), UNIQUE(message_id, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    username TEXT NOT NULL, banned_by TEXT NOT NULL,
    banned_at INTEGER DEFAULT (strftime('%s','now')), UNIQUE(room_id, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    action TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, details TEXT,
    timestamp INTEGER DEFAULT (strftime('%s','now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    creator TEXT NOT NULL,
    encrypted_question TEXT NOT NULL, question_iv TEXT NOT NULL,
    encrypted_options TEXT NOT NULL, options_iv TEXT NOT NULL,
    is_closed INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL,
    username TEXT NOT NULL, option_index INTEGER NOT NULL,
    UNIQUE(poll_id, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    sender TEXT NOT NULL, encrypted_content TEXT NOT NULL, iv TEXT NOT NULL,
    message_type TEXT DEFAULT 'text', reply_to INTEGER,
    send_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // Hidden messages (delete for me)
  db.run(`CREATE TABLE IF NOT EXISTS hidden_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL, room_id TEXT NOT NULL, username TEXT NOT NULL,
    UNIQUE(message_id, username)
  )`);

  // Sub-channels
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(room_id, name)
  )`);

  // Direct messages
  db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL, sender TEXT NOT NULL, receiver TEXT NOT NULL,
    encrypted_content TEXT NOT NULL, iv TEXT NOT NULL,
    message_type TEXT DEFAULT 'text', is_read INTEGER DEFAULT 0,
    timestamp INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // Add columns if they don't exist (migration-safe)
  try { db.run('ALTER TABLE members ADD COLUMN avatar_emoji TEXT DEFAULT ""'); } catch(e){}
  try { db.run('ALTER TABLE members ADD COLUMN status TEXT DEFAULT "available"'); } catch(e){}
  try { db.run('ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT "general"'); } catch(e){}

  saveDB();
  console.log('Database initialized');
}

function saveDB() { fs.writeFileSync(dbPath, Buffer.from(db.export())); }
setInterval(() => { if (db) saveDB(); }, 30000);

// Clean expired
setInterval(() => {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  const expired = dbAll('SELECT id, room_id FROM messages WHERE expires_at > 0 AND expires_at <= ?', [now]);
  if (expired.length > 0) {
    dbRun('DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ?', [now]);
    expired.forEach(m => io.to(m.room_id).emit('message-deleted', { messageId: m.id }));
  }
}, 60000);

// Send scheduled messages
setInterval(() => {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  const scheduled = dbAll('SELECT * FROM scheduled_messages WHERE send_at <= ?', [now]);
  scheduled.forEach(sm => {
    const member = dbGet('SELECT 1 FROM members WHERE room_id=? AND username=?', [sm.room_id, sm.sender]);
    if (!member) return;
    const room = dbGet('SELECT disappearing_minutes FROM rooms WHERE id=?', [sm.room_id]);
    let expiresAt = 0;
    if (room && room.disappearing_minutes > 0) expiresAt = now + room.disappearing_minutes * 60;
    try {
      dbRun('INSERT INTO messages (room_id,sender,encrypted_content,iv,message_type,reply_to,expires_at) VALUES(?,?,?,?,?,?,?)',
        [sm.room_id, sm.sender, sm.encrypted_content, sm.iv, sm.message_type || 'text', sm.reply_to || null, expiresAt]);
      const last = dbGet('SELECT last_insert_rowid() as id');
      io.to(sm.room_id).emit('new-message', {
        id: last.id, room_id: sm.room_id, sender: sm.sender,
        encrypted_content: sm.encrypted_content, iv: sm.iv,
        message_type: sm.message_type || 'text', is_edited: 0, is_pinned: 0,
        reply_to: sm.reply_to || null, expires_at: expiresAt,
        channel: 'general',
        timestamp: now, reactions: []
      });
      dbRun('DELETE FROM scheduled_messages WHERE id=?', [sm.id]);
    } catch(e) {}
  });
}, 10000);

function dbGet(sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  let r = null; if (s.step()) r = s.getAsObject(); s.free(); return r;
}
function dbAll(sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows;
}
function dbRun(sql, params = []) { db.run(sql, params); saveDB(); }
function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function logAudit(roomId, action, actor, target, details) {
  dbRun('INSERT INTO audit_log (room_id,action,actor,target,details) VALUES(?,?,?,?,?)',
    [roomId, action, actor, target || null, details || null]);
}

const COLORS = ['#6c5ce7','#00b894','#e17055','#0984e3','#fdcb6e','#e84393','#00cec9','#a29bfe','#fab1a0','#55efc4','#74b9ff','#ff7675'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function hasModPower(role) { return role === 'admin' || role === 'moderator'; }
function canManage(actorRole, targetRole) {
  const levels = { admin: 3, moderator: 2, member: 1 };
  return (levels[actorRole] || 0) > (levels[targetRole] || 0);
}
function getMemberRole(roomId, username) {
  const room = dbGet('SELECT created_by FROM rooms WHERE id=?', [roomId]);
  if (room && room.created_by === username) return 'admin';
  const m = dbGet('SELECT role FROM members WHERE room_id=? AND username=?', [roomId, username]);
  return m ? m.role : 'member';
}

// âââ REST âââ
app.post('/api/rooms', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username) return res.status(400).json({ error: 'name and username required' });
  const id = uuidv4(), inviteCode = crypto.randomBytes(16).toString('hex');
  const pwHash = password ? hashPw(password) : null;
  try {
    dbRun('INSERT INTO rooms (id,name,invite_code,created_by,password_hash) VALUES(?,?,?,?,?)', [id, name.trim(), inviteCode, username.trim(), pwHash]);
    dbRun('INSERT OR IGNORE INTO members (room_id,username,avatar_color,role) VALUES(?,?,?,?)', [id, username.trim(), randomColor(), 'admin']);
    // Create default channel
    try { dbRun('INSERT OR IGNORE INTO channels (room_id,name,created_by) VALUES(?,?,?)', [id, 'Ø¹Ø§Ù', username.trim()]); } catch(e){}
    logAudit(id, 'room_created', username.trim());
    res.json({ roomId: id, inviteCode, hasPassword: !!password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/join', (req, res) => {
  const { inviteCode, username, password } = req.body;
  if (!inviteCode || !username) return res.status(400).json({ error: 'inviteCode and username required' });
  const room = dbGet('SELECT * FROM rooms WHERE invite_code = ?', [inviteCode.trim()]);
  if (!room) return res.status(404).json({ error: 'ÙÙØ¯ Ø§ÙØ¯Ø¹ÙØ© ØºÙØ± ØµØ­ÙØ­' });
  if (room.is_locked) return res.status(403).json({ error: 'Ø§ÙØºØ±ÙØ© ÙÙÙÙØ©' });
  if (dbGet('SELECT 1 FROM bans WHERE room_id=? AND username=?', [room.id, username.trim()]))
    return res.status(403).json({ error: 'Ø£ÙØª ÙØ­Ø¸ÙØ± ÙÙ ÙØ°Ù Ø§ÙØºØ±ÙØ©' });
  if (room.password_hash) {
    if (!password) return res.status(401).json({ error: 'ÙØ°Ù Ø§ÙØºØ±ÙØ© ØªØ­ØªØ§Ø¬ ÙÙÙØ© Ø³Ø±', needsPassword: true });
    if (hashPw(password) !== room.password_hash) return res.status(401).json({ error: 'ÙÙÙØ© Ø§ÙØ³Ø± ØºÙØ·' });
  }
  try {
    dbRun('INSERT OR IGNORE INTO members (room_id,username,avatar_color,role) VALUES(?,?,?,?)', [room.id, username.trim(), randomColor(), 'member']);
    logAudit(room.id, 'member_joined', username.trim());
    res.json({ roomId: room.id, roomName: room.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms/:id', (req, res) => {
  const room = dbGet('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const members = dbAll('SELECT username, joined_at, avatar_color, role, last_seen, avatar_emoji, status FROM members WHERE room_id = ?', [room.id]);
  const bans = dbAll('SELECT username, banned_by, banned_at FROM bans WHERE room_id = ?', [room.id]);
  const channels = dbAll('SELECT * FROM channels WHERE room_id = ? ORDER BY created_at ASC', [room.id]);
  res.json({ ...room, members, bans, channels });
});

app.get('/api/rooms/:id/members', (req, res) => {
  const room = dbGet('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const members = dbAll('SELECT username, joined_at, avatar_color, role, last_seen, avatar_emoji, status FROM members WHERE room_id = ?', [room.id]);
  const bans = dbAll('SELECT username, banned_by, banned_at FROM bans WHERE room_id = ?', [room.id]);
  res.json({ members, bans });
});

app.get('/api/rooms/:id/messages', (req, res) => {
  const room = dbGet('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const channel = req.query.channel || 'Ø¹Ø§Ù';
  const username = req.query.username || '';
  const msgs = dbAll('SELECT * FROM messages WHERE room_id = ? AND channel = ? ORDER BY timestamp ASC LIMIT 200', [room.id, channel]);
  // Filter out hidden messages
  const hiddenIds = username ? dbAll('SELECT message_id FROM hidden_messages WHERE room_id=? AND username=?', [room.id, username]).map(h => h.message_id) : [];
  const filtered = msgs.filter(m => !hiddenIds.includes(m.id));
  const ids = filtered.map(m => m.id);
  let rxns = [];
  if (ids.length) rxns = dbAll(`SELECT * FROM reactions WHERE message_id IN (${ids.join(',')})`);
  const rxnMap = {};
  rxns.forEach(r => { (rxnMap[r.message_id] = rxnMap[r.message_id] || []).push(r); });
  res.json(filtered.map(m => ({ ...m, username: m.sender, timestamp: m.timestamp * 1000, reactions: rxnMap[m.id] || [] })));
});

app.get('/api/rooms/:id/audit', (req, res) => {
  const room = dbGet('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(dbAll('SELECT * FROM audit_log WHERE room_id = ? ORDER BY timestamp DESC LIMIT 100', [room.id]));
});

app.get('/api/rooms/:id/pinned', (req, res) => {
  res.json(dbAll('SELECT * FROM messages WHERE room_id = ? AND is_pinned = 1 ORDER BY timestamp DESC', [req.params.id]));
});

app.get('/api/rooms/:id/polls', (req, res) => {
  const polls = dbAll('SELECT * FROM polls WHERE room_id = ? ORDER BY created_at DESC', [req.params.id]);
  polls.forEach(p => { p.votes = dbAll('SELECT * FROM poll_votes WHERE poll_id = ?', [p.id]); });
  res.json(polls);
});

app.get('/api/rooms/:id/scheduled', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });
  res.json(dbAll('SELECT * FROM scheduled_messages WHERE room_id = ? AND sender = ? ORDER BY send_at ASC', [req.params.id, username]));
});

// DMs endpoints
app.get('/api/rooms/:id/dms', (req, res) => {
  const { username, peer } = req.query;
  if (!username || !peer) return res.status(400).json({ error: 'username and peer required' });
  const dms = dbAll(
    `SELECT * FROM direct_messages WHERE room_id=? AND
     ((sender=? AND receiver=?) OR (sender=? AND receiver=?))
     ORDER BY timestamp ASC LIMIT 200`,
    [req.params.id, username, peer, peer, username]
  );
  res.json(dms);
});

// âââ WebSocket âââ
const activeUsers = new Map();
const userStatuses = new Map(); // roomId_username -> status

// Helper: get username from socket
function getUser(socket) {
  const u = activeUsers.get(socket.id);
  return u ? u.username : null;
}

io.on('connection', (socket) => {

  // âââ JOIN ROOM âââ
  // Client sends: {roomId, username, inviteCode, password}
  // Client expects: 'room-info' {name, role, locked, disappearingMinutes, channels}
  //                 'messages' [array of messages for default channel]
  socket.on('join-room', ({ roomId, username, inviteCode, password }) => {
    if (!roomId || !username) return;
    const uname = username.trim();
    if (!dbGet('SELECT 1 FROM members WHERE room_id=? AND username=?', [roomId, uname])) {
      socket.emit('error', { message: 'Ø£ÙØª ÙÙ Ø¹Ø¶Ù Ø¨ÙØ°Ù Ø§ÙØºØ±ÙØ©' }); return;
    }
    socket.join(roomId);
    activeUsers.set(socket.id, { roomId, username: uname });
    dbRun('UPDATE members SET last_seen=? WHERE room_id=? AND username=?', [Math.floor(Date.now()/1000), roomId, uname]);

    // Emit room-info
    const room = dbGet('SELECT * FROM rooms WHERE id=?', [roomId]);
    const role = getMemberRole(roomId, uname);
    const channels = dbAll('SELECT name FROM channels WHERE room_id=? ORDER BY created_at ASC', [roomId]).map(c => c.name);
    socket.emit('room-info', {
      name: room.name, role, locked: !!room.is_locked,
      disappearingMinutes: room.disappearing_minutes,
      channels: channels.length ? channels : ['Ø¹Ø§Ù']
    });

    // Emit initial messages for default channel 'Ø¹Ø§Ù'
    const msgs = dbAll('SELECT * FROM messages WHERE room_id=? AND channel=? ORDER BY timestamp ASC LIMIT 200', [roomId, 'Ø¹Ø§Ù']);
    const hiddenIds = dbAll('SELECT message_id FROM hidden_messages WHERE room_id=? AND username=?', [roomId, uname]).map(h => h.message_id);
    const filtered = msgs.filter(m => !hiddenIds.includes(m.id));
    const ids = filtered.map(m => m.id);
    let rxns = [];
    if (ids.length) rxns = dbAll(`SELECT * FROM reactions WHERE message_id IN (${ids.join(',')})`);
    const rxnMap = {};
    rxns.forEach(r => { (rxnMap[r.message_id] = rxnMap[r.message_id] || []).push(r); });
    socket.emit('messages', filtered.map(m => ({ ...m, username: m.sender, timestamp: m.timestamp * 1000, reactions: rxnMap[m.id] || [] })));

    // Emit members update
    const members = dbAll('SELECT username, role, avatar_emoji, status, last_seen FROM members WHERE room_id=?', [roomId]);
    socket.emit('members-update', { members });

    io.to(roomId).emit('user-joined', { username: uname, timestamp: Math.floor(Date.now()/1000) });
    broadcastOnline(roomId);
  });

  // âââ SEND MESSAGE âââ
  // Client sends: {roomId, encrypted_content, iv, message_type, reply_to, edit_id, channel}
  // NOTE: no 'sender' â we get it from activeUsers
  socket.on('send-message', ({ roomId, encrypted_content, iv, message_type, reply_to, edit_id, channel }) => {
    const sender = getUser(socket);
    if (!roomId || !sender || !encrypted_content || !iv) return;
    if (!dbGet('SELECT 1 FROM members WHERE room_id=? AND username=?', [roomId, sender])) return;

    // If edit_id is set, this is an edit
    if (edit_id) {
      const msg = dbGet('SELECT * FROM messages WHERE id=? AND room_id=?', [edit_id, roomId]);
      if (!msg || msg.sender !== sender) { socket.emit('error', { message: 'ÙØ§ ØªÙØ¯Ø± ØªØ¹Ø¯Ù ÙØ°Ù Ø§ÙØ±Ø³Ø§ÙØ©' }); return; }
      dbRun('UPDATE messages SET encrypted_content=?, iv=?, is_edited=1 WHERE id=?', [encrypted_content, iv, edit_id]);
      io.to(roomId).emit('message-edited', { messageId: edit_id, encrypted_content, iv });
      return;
    }

    const room = dbGet('SELECT disappearing_minutes FROM rooms WHERE id=?', [roomId]);
    let expiresAt = 0;
    if (room && room.disappearing_minutes > 0) expiresAt = Math.floor(Date.now()/1000) + room.disappearing_minutes * 60;
    const ch = channel || 'Ø¹Ø§Ù';
    try {
      dbRun('INSERT INTO messages (room_id,sender,encrypted_content,iv,message_type,reply_to,expires_at,channel) VALUES(?,?,?,?,?,?,?,?)',
        [roomId, sender, encrypted_content, iv, message_type||'text', reply_to||null, expiresAt, ch]);
      const last = dbGet('SELECT last_insert_rowid() as id');
      io.to(roomId).emit('new-message', {
        id: last.id, room_id: roomId, sender, username: sender,
        encrypted_content, iv,
        message_type: message_type||'text', is_edited: 0, is_pinned: 0,
        reply_to: reply_to||null, expires_at: expiresAt,
        channel: ch,
        timestamp: Date.now(), reactions: []
      });
    } catch (e) { socket.emit('error', { message: 'ÙØ´Ù Ø¥Ø±Ø³Ø§Ù Ø§ÙØ±Ø³Ø§ÙØ©' }); }
  });

  // âââ TOGGLE LOCK âââ
  socket.on('toggle-lock', ({ roomId }) => {
    const username = getUser(socket);
    if (!username) return;
    const role = getMemberRole(roomId, username);
    if (!hasModPower(role)) return;
    const room = dbGet('SELECT * FROM rooms WHERE id=?', [roomId]);
    if (!room) return;
    const nw = room.is_locked ? 0 : 1;
    dbRun('UPDATE rooms SET is_locked=? WHERE id=?', [nw, roomId]);
    io.to(roomId).emit('room-lock-changed', { locked: !!nw, by: username });
    logAudit(roomId, nw ? 'room_locked' : 'room_unlocked', username);
  });

  // âââ DELETE MESSAGE (for everyone) âââ
  socket.on('delete-message', ({ roomId, messageId }) => {
    const username = getUser(socket);
    if (!username) return;
    const msg = dbGet('SELECT * FROM messages WHERE id=? AND room_id=?', [messageId, roomId]);
    if (!msg) return;
    const role = getMemberRole(roomId, username);
    if (msg.sender !== username && !hasModPower(role)) {
      socket.emit('error', { message: 'ÙØ§ ØªÙØ¯Ø± ØªØ­Ø°Ù Ø±Ø³Ø§ÙØ© ØºÙØ±Ù' }); return;
    }
    dbRun('DELETE FROM messages WHERE id=? AND room_id=?', [messageId, roomId]);
    dbRun('DELETE FROM reactions WHERE message_id=?', [messageId]);
    io.to(roomId).emit('message-deleted', { messageId });
    logAudit(roomId, 'message_deleted', username, msg.sender);
  });

  // âââ HIDE MESSAGE (delete for me) âââ
  socket.on('hide-message', ({ roomId, messageId }) => {
    const username = getUser(socket);
    if (!username) return;
    try {
      dbRun('INSERT OR IGNORE INTO hidden_messages (message_id,room_id,username) VALUES(?,?,?)', [messageId, roomId, username]);
      socket.emit('message-hidden', { messageId });
    } catch(e){}
  });

  // âââ PIN MESSAGE âââ
  socket.on('pin-message', ({ roomId, messageId }) => {
    const username = getUser(socket);
    if (!username) return;
    const role = getMemberRole(roomId, username);
    if (!hasModPower(role)) { socket.emit('error', { message: 'ÙÙØ· Ø§ÙØ£Ø¯ÙÙ ÙØ§ÙÙØ´Ø±Ù ÙÙØ¯Ø±ÙÙ ÙØ«Ø¨ØªÙÙ' }); return; }
    const msg = dbGet('SELECT * FROM messages WHERE id=? AND room_id=?', [messageId, roomId]);
    if (!msg) return;
    const np = msg.is_pinned ? 0 : 1;
    dbRun('UPDATE messages SET is_pinned=? WHERE id=?', [np, messageId]);
    io.to(roomId).emit('pinned-updated', { messageId, isPinned: !!np, by: username });
    logAudit(roomId, np ? 'message_pinned' : 'message_unpinned', username);
  });

  // âââ CHANGE ROLE âââ (client emits 'change-role')
  socket.on('change-role', ({ roomId, targetUsername, newRole }) => {
    const username = getUser(socket);
    if (!username) return;
    if (getMemberRole(roomId, username) !== 'admin') { socket.emit('error', { message: 'ÙÙØ· Ø§ÙØ£Ø¯ÙÙ ÙÙØ¯Ø± ÙØºÙØ± Ø§ÙØ£Ø¯ÙØ§Ø±' }); return; }
    if (targetUsername === username) return;
    if (!['moderator', 'member'].includes(newRole)) return;
    dbRun('UPDATE members SET role=? WHERE room_id=? AND username=?', [newRole, roomId, targetUsername]);
    const members = dbAll('SELECT username, role, avatar_emoji, status, last_seen FROM members WHERE room_id=?', [roomId]);
    io.to(roomId).emit('members-update', { members });
    logAudit(roomId, 'role_changed', username, targetUsername, newRole);
  });

  // âââ CREATE POLL âââ
  // Client sends: {roomId, question:{encrypted,iv}, options:[{encrypted,iv}], channel}
  socket.on('create-poll', ({ roomId, question, options, channel }) => {
    const sender = getUser(socket);
    if (!roomId || !sender || !question || !options) return;
    try {
      // Store as JSON since client sends structured objects
      const encQ = question.encrypted;
      const qIv = question.iv;
      const encOpts = JSON.stringify(options);
      dbRun('INSERT INTO polls (room_id,creator,encrypted_question,question_iv,encrypted_options,options_iv) VALUES(?,?,?,?,?,?)',
        [roomId, sender, encQ, qIv, encOpts, '']);
      const last = dbGet('SELECT last_insert_rowid() as id');
      io.to(roomId).emit('poll-created', { id: last.id, room_id: roomId, creator: sender,
        encrypted_question: encQ, question_iv: qIv,
        encrypted_options: encOpts, options_iv: '',
        is_closed: 0, votes: [], channel: channel || 'Ø¹Ø§Ù' });
    } catch(e) { socket.emit('error', { message: 'ÙØ´Ù Ø¥ÙØ´Ø§Ø¡ Ø§ÙØ§Ø³ØªØ·ÙØ§Ø¹' }); }
  });

  // âââ VOTE POLL âââ client sends: {roomId, pollId, optionId}
  socket.on('vote-poll', ({ roomId, pollId, optionId }) => {
    const username = getUser(socket);
    if (!username) return;
    try {
      dbRun('DELETE FROM poll_votes WHERE poll_id=? AND username=?', [pollId, username]);
      dbRun('INSERT INTO poll_votes (poll_id,username,option_index) VALUES(?,?,?)', [pollId, username, optionId]);
      io.to(roomId).emit('poll-updated', { pollId, votes: dbAll('SELECT * FROM poll_votes WHERE poll_id=?', [pollId]) });
    } catch(e) {}
  });

  socket.on('close-poll', ({ roomId, pollId }) => {
    const username = getUser(socket);
    if (!username) return;
    const poll = dbGet('SELECT * FROM polls WHERE id=? AND room_id=?', [pollId, roomId]);
    if (!poll) return;
    const role = getMemberRole(roomId, username);
    if (poll.creator !== username && !hasModPower(role)) return;
    dbRun('UPDATE polls SET is_closed=1 WHERE id=?', [pollId]);
    io.to(roomId).emit('poll-closed', { pollId });
  });

  // âââ SCHEDULE MESSAGE âââ
  // Client sends: {roomId, encrypted_content, iv, send_at, channel}
  socket.on('schedule-message', ({ roomId, encrypted_content, iv, send_at, channel }) => {
    const sender = getUser(socket);
    if (!roomId || !sender || !encrypted_content || !iv || !send_at) return;
    const sendAt = Math.floor(new Date(send_at).getTime() / 1000);
    try {
      dbRun('INSERT INTO scheduled_messages (room_id,sender,encrypted_content,iv,message_type,send_at) VALUES(?,?,?,?,?,?)',
        [roomId, sender, encrypted_content, iv, 'text', sendAt]);
      const last = dbGet('SELECT last_insert_rowid() as id');
      socket.emit('scheduled-sent', { id: last.id, send_at });
    } catch(e) { socket.emit('error', { message: 'ÙØ´Ù Ø¬Ø¯ÙÙØ© Ø§ÙØ±Ø³Ø§ÙØ©' }); }
  });

  socket.on('cancel-scheduled', ({ roomId, scheduledId }) => {
    const username = getUser(socket);
    if (!username) return;
    dbRun('DELETE FROM scheduled_messages WHERE id=? AND room_id=? AND sender=?', [scheduledId, roomId, username]);
    socket.emit('scheduled-cancelled', { id: scheduledId });
  });

  // âââ REACT MESSAGE âââ (client emits 'react-message')
  socket.on('react-message', ({ roomId, messageId, emoji }) => {
    const username = getUser(socket);
    if (!roomId || !messageId || !username || !emoji) return;
    try {
      // Toggle: if already reacted with same emoji, remove it
      const existing = dbGet('SELECT 1 FROM reactions WHERE message_id=? AND username=? AND emoji=?', [messageId, username, emoji]);
      if (existing) {
        dbRun('DELETE FROM reactions WHERE message_id=? AND username=? AND emoji=?', [messageId, username, emoji]);
      } else {
        dbRun('INSERT OR IGNORE INTO reactions (message_id,room_id,username,emoji) VALUES(?,?,?,?)', [messageId, roomId, username, emoji]);
      }
      io.to(roomId).emit('reaction-updated', { messageId, reactions: dbAll('SELECT * FROM reactions WHERE message_id=?', [messageId]) });
    } catch(e){}
  });

  // âââ READ MESSAGE âââ (client emits 'read-message')
  socket.on('read-message', ({ roomId, messageId }) => {
    const username = getUser(socket);
    if (!roomId || !messageId || !username) return;
    try {
      dbRun('INSERT OR IGNORE INTO read_receipts (message_id,room_id,username) VALUES(?,?,?)', [messageId, roomId, username]);
      io.to(roomId).emit('message-read', { messageId, readers: dbAll('SELECT username FROM read_receipts WHERE message_id=?', [messageId]) });
    } catch(e){}
  });

  // âââ SET AVATAR âââ
  socket.on('set-avatar', ({ roomId, emoji }) => {
    const username = getUser(socket);
    if (!username) return;
    dbRun('UPDATE members SET avatar_emoji=? WHERE room_id=? AND username=?', [emoji || '', roomId, username]);
    io.to(roomId).emit('avatar-updated', { username, avatar: emoji });
  });

  // âââ SET STATUS âââ
  socket.on('set-status', ({ roomId, status }) => {
    const username = getUser(socket);
    if (!username) return;
    if (!['available','busy','dnd','away'].includes(status)) return;
    dbRun('UPDATE members SET status=? WHERE room_id=? AND username=?', [status, roomId, username]);
    userStatuses.set(roomId + '_' + username, status);
    io.to(roomId).emit('status-updated', { username, status });
  });

  // âââ CREATE CHANNEL âââ client sends: {roomId, name}
  socket.on('create-channel', ({ roomId, name }) => {
    const username = getUser(socket);
    if (!username) return;
    if (!hasModPower(getMemberRole(roomId, username))) return;
    if (!name || name.length > 30) return;
    try {
      dbRun('INSERT OR IGNORE INTO channels (room_id,name,created_by) VALUES(?,?,?)', [roomId, name.trim(), username]);
      io.to(roomId).emit('channel-created', { name: name.trim() });
    } catch(e){}
  });

  // âââ DELETE CHANNEL âââ client sends: {roomId, name}
  socket.on('delete-channel', ({ roomId, name }) => {
    const username = getUser(socket);
    if (!username) return;
    if (getMemberRole(roomId, username) !== 'admin') return;
    if (name === 'Ø¹Ø§Ù' || name === 'general') return;
    dbRun('DELETE FROM channels WHERE room_id=? AND name=?', [roomId, name]);
    dbRun('DELETE FROM messages WHERE room_id=? AND channel=?', [roomId, name]);
    io.to(roomId).emit('channel-deleted', { name });
  });

  // âââ SEND DM âââ client sends: {roomId, receiver, encrypted_content, iv}
  socket.on('send-dm', ({ roomId, receiver, encrypted_content, iv }) => {
    const sender = getUser(socket);
    if (!roomId || !sender || !receiver || !encrypted_content || !iv) return;
    try {
      dbRun('INSERT INTO direct_messages (room_id,sender,receiver,encrypted_content,iv,message_type) VALUES(?,?,?,?,?,?)',
        [roomId, sender, receiver, encrypted_content, iv, 'text']);
      const last = dbGet('SELECT last_insert_rowid() as id');
      const dm = { id: last.id, room_id: roomId, sender, receiver,
        encrypted_content, iv,
        message_type: 'text', is_read: 0,
        timestamp: Math.floor(Date.now()/1000) };
      // Send to both sender and receiver
      activeUsers.forEach((v, sid) => {
        if (v.roomId === roomId && (v.username === sender || v.username === receiver)) {
          io.sockets.sockets.get(sid)?.emit('dm-message', dm);
        }
      });
    } catch(e){}
  });

  // âââ READ DM âââ
  socket.on('read-dm', ({ roomId, peer }) => {
    const username = getUser(socket);
    if (!username) return;
    dbRun('UPDATE direct_messages SET is_read=1 WHERE room_id=? AND sender=? AND receiver=?', [roomId, peer, username]);
    // Notify the peer
    activeUsers.forEach((v, sid) => {
      if (v.roomId === roomId && v.username === peer) {
        io.sockets.sockets.get(sid)?.emit('dm-read', { peer: username });
      }
    });
  });

  // âââ KICK USER âââ (client emits 'kick-user')
  socket.on('kick-user', ({ roomId, targetUsername }) => {
    const username = getUser(socket);
    if (!username) return;
    const actorRole = getMemberRole(roomId, username);
    const targetRole = getMemberRole(roomId, targetUsername);
    if (!hasModPower(actorRole) || !canManage(actorRole, targetRole) || targetUsername === username) return;
    dbRun('DELETE FROM members WHERE room_id=? AND username=?', [roomId, targetUsername]);
    const members = dbAll('SELECT username, role, avatar_emoji, status, last_seen FROM members WHERE room_id=?', [roomId]);
    io.to(roomId).emit('members-update', { members });
    logAudit(roomId, 'member_kicked', username, targetUsername);
    activeUsers.forEach((v, sid) => {
      if (v.roomId === roomId && v.username === targetUsername) {
        io.sockets.sockets.get(sid)?.emit('kicked', { message: 'ØªÙ Ø·Ø±Ø¯Ù ÙÙ Ø§ÙØºØ±ÙØ©' });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    });
  });

  // âââ BAN USER âââ (client emits 'ban-user')
  socket.on('ban-user', ({ roomId, targetUsername }) => {
    const username = getUser(socket);
    if (!username) return;
    const actorRole = getMemberRole(roomId, username);
    const targetRole = getMemberRole(roomId, targetUsername);
    if (!hasModPower(actorRole) || !canManage(actorRole, targetRole) || targetUsername === username) return;
    dbRun('INSERT OR IGNORE INTO bans (room_id,username,banned_by) VALUES(?,?,?)', [roomId, targetUsername, username]);
    dbRun('DELETE FROM members WHERE room_id=? AND username=?', [roomId, targetUsername]);
    const members = dbAll('SELECT username, role, avatar_emoji, status, last_seen FROM members WHERE room_id=?', [roomId]);
    io.to(roomId).emit('members-update', { members });
    logAudit(roomId, 'member_banned', username, targetUsername);
    activeUsers.forEach((v, sid) => {
      if (v.roomId === roomId && v.username === targetUsername) {
        io.sockets.sockets.get(sid)?.emit('kicked', { message: 'ØªÙ Ø­Ø¸Ø±Ù ÙÙØ§Ø¦ÙØ§Ù' });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    });
  });

  // âââ UNBAN USER âââ (client emits 'unban-user')
  socket.on('unban-user', ({ roomId, targetUsername }) => {
ÛÛÝ\Ù\[YHHÙ]\Ù\ÛØÚÙ]
NÂY
]\Ù\[YJH]\ÂY
Z\Ó[ÙÝÙ\Ù]Y[X\ÛJÛÛRY\Ù\[YJJJH]\Â[	ÑSUHÓH[ÈÒTHÛÛWÚYOÈS\Ù\[YOOÉËÜÛÛRY\Ù]\Ù\[YWJNÂÙÐ]Y]
ÛÛRY	ÛY[X\Ý[[Y	Ë\Ù\[YK\Ù]\Ù\[YJNÂJNÂËÈ8¥ 8¥ 8¥ ÑUTÐTPTSÈ8¥ 8¥ 8¥ ÛØÚÙ]Û	ÜÙ]Y\Ø\X\[ÉË
ÈÛÛRYZ[]\ÈJHOÂÛÛÝ\Ù\[YHHÙ]\Ù\ÛØÚÙ]
NÂY
]\Ù\[YJH]\ÂY
Z\Ó[ÙÝÙ\Ù]Y[X\ÛJÛÛRY\Ù\[YJJJH]\Â[	ÕTUHÛÛ\ÈÑU\Ø\X\[×ÛZ[]\ÏOÈÒTHYOÉËÛZ[]\ËÛÛRYJNÂ[ËÊÛÛRY
K[Z]
	Ù\Ø\X\[ËXÚ[ÙY	ËÈZ[]\ËN\Ù\[YHJNÂÙÐ]Y]
ÛÛRY	Ù\Ø\X\[×ÜÙ]	Ë\Ù\[YK[	ÛZ[]\ßHZ[
NÂJNÂËÈ8¥ 8¥ 8¥ TSÈ8¥ 8¥ 8¥ ÛØÚÙ]Û	Ý\[ÉË
ÈÛÛRYJHOÂÛÛÝ\Ù\[YHHÙ]\Ù\ÛØÚÙ]
NÂY
\Ù\[YJHÛØÚÙ]ÊÛÛRY
K[Z]
	Ý\Ù\]\[ÉËÈ\Ù\[YHJNÂJNÂÛØÚÙ]Û	ÜÝÜ]\[ÉË
ÈÛÛRYJHOÂÛÛÝ\Ù\[YHHÙ]\Ù\ÛØÚÙ]
NÂY
\Ù\[YJHÛØÚÙ]ÊÛÛRY
K[Z]
	Ý\Ù\\ÝÜ]\[ÉËÈ\Ù\[YHJNÂJNÂËÈ8¥ 8¥ 8¥ TÐÓÓPÕ8¥ 8¥ 8¥ ÛØÚÙ]Û	Ù\ØÛÛXÝ	Ë

HOÂÛÛÝHHXÝ]U\Ù\ËÙ]
ÛØÚÙ]Y
NÂY
JHÂ[	ÕTUHY[X\ÈÑU\ÝÜÙY[OÈÒTHÛÛWÚYOÈS\Ù\[YOOÉËÓX]ÛÜ]KÝÊ
KÌL
KKÛÛRYK\Ù\[YWJNÂ[ËÊKÛÛRY
K[Z]
	Ý\Ù\[Y	ËÈ\Ù\[YNK\Ù\[YK[Y\Ý[\X]ÛÜ]KÝÊ
KÌL
HJNÂXÝ]U\Ù\Ë[]JÛØÚÙ]Y
NÂØYØ\ÝÛ[JKÛÛRY
NÂBJNÂJNÂ[Ý[ÛØYØ\ÝÛ[JÛÛRY
HÂÛÛÝÛ[HH×NÂXÝ]U\Ù\ËÜXXÚ
OÈY
ÛÛRYOOHÛÛRY	[Û[K[ÛY\Ê\Ù\[YJJHÛ[K\Ú
\Ù\[YJNÈJNÂ[ËÊÛÛRY
K[Z]
	ÛÛ[K]\Ù\ÉËÛ[JNÂBØÙ\ÜËÛ	ÔÒQÒS	Ë

HOÈY
HØ]Q
NÈØÙ\ÜË^]

NÈJNÂØÙ\ÜËÛ	ÔÒQÕTIË

HOÈY
HØ]Q
NÈØÙ\ÜË^]

NÈJNÂÛÛÝÔHØÙ\ÜË[ÔÌÂ[]
K[

HOÂÙ\\\Ý[Ô

HOÛÛÛÛKÙÊÙ\\[[ÈÛÜ	ÔÔX
JNÂJKØ]Ú
HOÈÛÛÛÛK\Ü	Ñ[]Z[YËJNÈØÙ\ÜË^]
JNÈJNÂ
