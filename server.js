const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'realchat-secret-token-key-2026-xyz';

// ===== DATA DIRECTORIES & UPLOADS SETUP =====
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const ICONS_DIR = path.join(UPLOADS_DIR, 'icons');
const MESSAGES_DIR = path.join(UPLOADS_DIR, 'messages');

[DATA_DIR, UPLOADS_DIR, AVATARS_DIR, ICONS_DIR, MESSAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ===== DATABASE INITIALIZATION & PERSISTENCE =====
let db = {
  users: [],
  friendRequests: [],
  groups: [],
  servers: [],
  messages: []
};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = {
        users: parsed.users || [],
        friendRequests: parsed.friendRequests || [],
        groups: parsed.groups || [],
        servers: parsed.servers || [],
        messages: parsed.messages || []
      };
      console.log(`Database loaded: ${db.users.length} users, ${db.messages.length} messages`);
    } else {
      saveDatabase();
      console.log('Database initialized empty.');
    }
  } catch (err) {
    console.error('Error loading database, resetting to fallback:', err);
    saveDatabase();
  }
}

let saveTimer = null;
function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDatabase();
  }, 100);
}

loadDatabase();

// ===== MULTER STORAGE CONFIG =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'avatar') cb(null, AVATARS_DIR);
    else if (file.fieldname === 'icon') cb(null, ICONS_DIR);
    else if (file.fieldname === 'image') cb(null, MESSAGES_DIR);
    else cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));
// Serve static client assets
app.use(express.static(__dirname));

// Default Avatar Generator
function defaultAvatar(username) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username || 'user')}`;
}

// User Sanitization (omits password)
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    description: u.description || '',
    avatar: u.avatar || defaultAvatar(u.username),
    isAdmin: !!u.isAdmin,
    isVerified: !!u.isVerified,
    preferences: u.preferences || {},
    createdAt: u.createdAt
  };
}

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = user;
    next();
  });
}

// ===== REST API ROUTES =====

// 1. REGISTER
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const cleanUsername = username.trim();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const isFirstUser = db.users.length === 0;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      username: cleanUsername,
      password: hashedPassword,
      nickname: cleanUsername,
      description: '',
      avatar: defaultAvatar(cleanUsername),
      isAdmin: isFirstUser,
      friends: [],
      preferences: {
        accent: 'indigo',
        theme: 'space',
        soundEnabled: true,
        toastEnabled: true,
        enterToSend: true,
        fontSize: 'medium'
      },
      createdAt: new Date().toISOString()
    };

    db.users.push(newUser);
    saveDatabase();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(201).json({ token, user: sanitizeUser(newUser) });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Server error during registration' });
  }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = db.users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

// 3. CURRENT USER
app.get('/api/me', authenticateToken, (req, res) => {
  return res.json(sanitizeUser(req.user));
});

// 4. UPDATE PROFILE & PREFERENCES
app.put('/api/profile', authenticateToken, (req, res) => {
  const { nickname, description, preferences } = req.body;
  if (nickname !== undefined) req.user.nickname = nickname.trim() || req.user.username;
  if (description !== undefined) req.user.description = description.trim();
  if (preferences !== undefined) req.user.preferences = { ...(req.user.preferences || {}), ...preferences };
  debouncedSave();
  return res.json(sanitizeUser(req.user));
});

// 5. CHANGE PASSWORD
app.post('/api/account/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const match = await bcrypt.compare(currentPassword, req.user.password);
    if (!match) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    req.user.password = await bcrypt.hash(newPassword, 10);
    saveDatabase();
    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update password' });
  }
});

// 6. UPLOAD AVATAR
app.post('/api/profile/avatar', authenticateToken, upload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No avatar image uploaded' });
  }
  req.user.avatar = `/uploads/avatars/${req.file.filename}`;
  saveDatabase();
  return res.json({ user: sanitizeUser(req.user) });
});

// 7. USER SEARCH
app.get('/api/users/search/:query', authenticateToken, (req, res) => {
  const query = (req.params.query || '').trim().toLowerCase();
  if (!query) return res.json([]);

  const results = db.users
    .filter(u => u.id !== req.user.id && (u.username.toLowerCase().includes(query) || (u.nickname && u.nickname.toLowerCase().includes(query))))
    .slice(0, 20)
    .map(u => {
      const isFriend = (req.user.friends || []).includes(u.id);
      const hasPendingRequest = db.friendRequests.some(r =>
        r.status === 'pending' &&
        ((r.fromUserId === req.user.id && r.toUserId === u.id) ||
         (r.fromUserId === u.id && r.toUserId === req.user.id))
      );
      return {
        id: u.id,
        username: u.username,
        nickname: u.nickname || u.username,
        avatar: u.avatar || defaultAvatar(u.username),
        isAdmin: !!u.isAdmin,
        isVerified: !!u.isVerified,
        isFriend,
        hasPendingRequest
      };
    });

  return res.json(results);
});

// 8. GET SPECIFIC USER
app.get('/api/users/:userId', authenticateToken, (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json(sanitizeUser(user));
});

// 9. GET FRIENDS
app.get('/api/friends', authenticateToken, (req, res) => {
  const friendIds = req.user.friends || [];
  const friends = friendIds
    .map(id => db.users.find(u => u.id === id))
    .filter(Boolean)
    .map(sanitizeUser);
  return res.json(friends);
});

// 10. GET FRIEND REQUESTS
app.get('/api/friends/requests', authenticateToken, (req, res) => {
  const requests = db.friendRequests
    .filter(r => r.toUserId === req.user.id && r.status === 'pending')
    .map(r => {
      const fromUser = db.users.find(u => u.id === r.fromUserId);
      return {
        id: r.id,
        fromUser: sanitizeUser(fromUser) || { id: r.fromUserId, username: 'Unknown' },
        toUserId: r.toUserId,
        createdAt: r.createdAt
      };
    });
  return res.json(requests);
});

// 11. SEND FRIEND REQUEST
app.post('/api/friends/request/:userId', authenticateToken, (req, res) => {
  const targetId = req.params.userId;
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot send friend request to yourself' });
  }

  const targetUser = db.users.find(u => u.id === targetId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  if ((req.user.friends || []).includes(targetId)) {
    return res.status(400).json({ error: 'Already friends' });
  }

  const incomingReq = db.friendRequests.find(r => r.fromUserId === targetId && r.toUserId === req.user.id && r.status === 'pending');
  if (incomingReq) {
    incomingReq.status = 'accepted';
    if (!req.user.friends) req.user.friends = [];
    if (!targetUser.friends) targetUser.friends = [];
    if (!req.user.friends.includes(targetId)) req.user.friends.push(targetId);
    if (!targetUser.friends.includes(req.user.id)) targetUser.friends.push(req.user.id);
    saveDatabase();

    io.to(`user:${targetId}`).emit('friendRequestAccepted', { user: sanitizeUser(req.user) });
    io.to(`user:${req.user.id}`).emit('friendRequestAccepted', { user: sanitizeUser(targetUser) });
    return res.json({ status: 'accepted' });
  }

  const existingReq = db.friendRequests.find(r => r.fromUserId === req.user.id && r.toUserId === targetId && r.status === 'pending');
  if (existingReq) {
    return res.json({ status: 'pending' });
  }

  const newReq = {
    id: uuidv4(),
    fromUserId: req.user.id,
    toUserId: targetId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.friendRequests.push(newReq);
  saveDatabase();

  io.to(`user:${targetId}`).emit('newFriendRequest', {
    id: newReq.id,
    fromUser: sanitizeUser(req.user)
  });

  return res.json({ status: 'pending' });
});

// 12. ACCEPT FRIEND REQUEST
app.post('/api/friends/accept/:requestId', authenticateToken, (req, res) => {
  const reqItem = db.friendRequests.find(r => r.id === req.params.requestId && r.toUserId === req.user.id && r.status === 'pending');
  if (!reqItem) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  const fromUser = db.users.find(u => u.id === reqItem.fromUserId);
  if (!fromUser) {
    return res.status(404).json({ error: 'Requesting user not found' });
  }

  reqItem.status = 'accepted';
  if (!req.user.friends) req.user.friends = [];
  if (!fromUser.friends) fromUser.friends = [];
  if (!req.user.friends.includes(fromUser.id)) req.user.friends.push(fromUser.id);
  if (!fromUser.friends.includes(req.user.id)) fromUser.friends.push(req.user.id);
  saveDatabase();

  io.to(`user:${fromUser.id}`).emit('friendRequestAccepted', { user: sanitizeUser(req.user) });
  io.to(`user:${req.user.id}`).emit('friendRequestAccepted', { user: sanitizeUser(fromUser) });

  return res.json({ success: true });
});

// 13. DECLINE FRIEND REQUEST
app.post('/api/friends/decline/:requestId', authenticateToken, (req, res) => {
  const index = db.friendRequests.findIndex(r => r.id === req.params.requestId && r.toUserId === req.user.id);
  if (index !== -1) {
    db.friendRequests.splice(index, 1);
    saveDatabase();
  }
  return res.json({ success: true });
});

// 14. GET GROUPS
app.get('/api/groups', authenticateToken, (req, res) => {
  const groups = db.groups.filter(g => (g.members || []).includes(req.user.id));
  return res.json(groups);
});

// 15. CREATE GROUP
app.post('/api/groups', authenticateToken, upload.single('icon'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name required' });

  const iconUrl = req.file ? `/uploads/icons/${req.file.filename}` : null;
  const newGroup = {
    id: uuidv4(),
    name,
    description: (req.body.description || '').trim(),
    icon: iconUrl,
    ownerId: req.user.id,
    members: [req.user.id],
    createdAt: new Date().toISOString()
  };

  db.groups.push(newGroup);
  saveDatabase();
  return res.status(201).json(newGroup);
});

// 16. UPDATE GROUP (SETTINGS)
app.put('/api/groups/:groupId', authenticateToken, upload.single('icon'), (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only group owner can edit group settings' });
  }

  if (req.body.name) group.name = req.body.name.trim();
  if (req.body.description !== undefined) group.description = req.body.description.trim();
  if (req.file) group.icon = `/uploads/icons/${req.file.filename}`;

  saveDatabase();
  io.to(`group:${group.id}`).emit('groupUpdated', { group });
  return res.json(group);
});

// 17. GET GROUP MEMBERS
app.get('/api/groups/:groupId/members', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.user.id)) return res.status(403).json({ error: 'Access denied' });

  const members = group.members.map(mId => {
    const u = db.users.find(x => x.id === mId);
    if (!u) return null;
    return {
      ...sanitizeUser(u),
      isOwner: group.ownerId === u.id,
      isAdmin: (group.admins || []).includes(u.id)
    };
  }).filter(Boolean);

  return res.json(members);
});

// 17b. GRANT GROUP ADMIN ROLE
app.post('/api/groups/:groupId/admin/grant/:userId', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  if (!group.admins) group.admins = [];
  if (!group.admins.includes(req.params.userId)) group.admins.push(req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});

// 17c. REVOKE GROUP ADMIN ROLE
app.post('/api/groups/:groupId/admin/revoke/:userId', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  group.admins = (group.admins || []).filter(id => id !== req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});

// 18. INVITE TO GROUP
app.post('/api/groups/:groupId/invite/:userId', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.user.id)) return res.status(403).json({ error: 'Access denied' });

  const targetUser = db.users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (!group.members.includes(targetUser.id)) {
    group.members.push(targetUser.id);
    saveDatabase();

    io.to(`user:${targetUser.id}`).emit('addedToGroup', { group });
  }

  return res.json({ success: true, group });
});

// 19. KICK GROUP MEMBER
app.post('/api/groups/:groupId/kick/:userId', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  group.members = group.members.filter(id => id !== req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});

// 20. TRANSFER GROUP OWNERSHIP
app.post('/api/groups/:groupId/transfer/:userId', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });
  if (!group.members.includes(req.params.userId)) return res.status(400).json({ error: 'User not in group' });

  group.ownerId = req.params.userId;
  saveDatabase();
  return res.json({ success: true, ownerId: group.ownerId });
});

// 21. LEAVE GROUP
app.post('/api/groups/:groupId/leave', authenticateToken, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (group.ownerId === req.user.id) {
    const remaining = group.members.filter(id => id !== req.user.id);
    if (remaining.length > 0) {
      group.ownerId = remaining[0];
      group.members = remaining;
      saveDatabase();
      return res.json({ success: true, newOwnerId: group.ownerId });
    } else {
      const idx = db.groups.findIndex(g => g.id === req.params.groupId);
      if (idx !== -1) db.groups.splice(idx, 1);
      saveDatabase();
      return res.json({ success: true, deleted: true });
    }
  } else {
    group.members = group.members.filter(id => id !== req.user.id);
    saveDatabase();
    return res.json({ success: true });
  }
});

// 22. DELETE GROUP
app.delete('/api/groups/:groupId', authenticateToken, (req, res) => {
  const index = db.groups.findIndex(g => g.id === req.params.groupId);
  if (index === -1) return res.status(404).json({ error: 'Group not found' });

  const group = db.groups[index];
  if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  db.groups.splice(index, 1);
  db.messages = db.messages.filter(m => !(m.targetType === 'group' && m.targetId === req.params.groupId));
  saveDatabase();

  return res.json({ success: true });
});

// 23. GET SERVERS
app.get('/api/servers', authenticateToken, (req, res) => {
  const servers = db.servers.filter(s =>
    (s.members || []).includes(req.user.id) &&
    !(s.bannedUsers || []).includes(req.user.id)
  );
  return res.json(servers);
});

// 24. GET ALL SERVERS (DISCOVER)
app.get('/api/servers/all', authenticateToken, (req, res) => {
  const allServers = db.servers.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description || '',
    icon: s.icon,
    ownerId: s.ownerId,
    members: s.members || [],
    channels: s.channels || []
  }));
  return res.json(allServers);
});

// 25. CREATE SERVER
app.post('/api/servers', authenticateToken, upload.single('icon'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Server name required' });

  const iconUrl = req.file ? `/uploads/icons/${req.file.filename}` : null;
  const defaultChannel = {
    id: uuidv4(),
    name: 'general',
    createdAt: new Date().toISOString()
  };

  const newServer = {
    id: uuidv4(),
    name,
    description: (req.body.description || '').trim(),
    icon: iconUrl,
    ownerId: req.user.id,
    members: [req.user.id],
    mutedUsers: [],
    bannedUsers: [],
    channels: [defaultChannel],
    createdAt: new Date().toISOString()
  };

  db.servers.push(newServer);
  saveDatabase();
  return res.status(201).json(newServer);
});

// 26. UPDATE SERVER (SETTINGS)
app.put('/api/servers/:serverId', authenticateToken, upload.single('icon'), (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the server owner can edit server settings' });
  }

  if (req.body.name) serverObj.name = req.body.name.trim();
  if (req.body.description !== undefined) serverObj.description = req.body.description.trim();
  if (req.file) serverObj.icon = `/uploads/icons/${req.file.filename}`;

  saveDatabase();
  return res.json(serverObj);
});

// 27. JOIN SERVER
app.post('/api/servers/:serverId/join', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if ((serverObj.bannedUsers || []).includes(req.user.id)) {
    return res.status(403).json({ error: 'You are banned from this server' });
  }

  if (!serverObj.members.includes(req.user.id)) {
    serverObj.members.push(req.user.id);
    saveDatabase();
  }

  return res.json(serverObj);
});

// 28. LEAVE SERVER
app.post('/api/servers/:serverId/leave', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });

  if (serverObj.ownerId === req.user.id) {
    const remaining = serverObj.members.filter(id => id !== req.user.id);
    if (remaining.length > 0) {
      serverObj.ownerId = remaining[0];
      serverObj.members = remaining;
      saveDatabase();
      return res.json({ success: true, newOwnerId: serverObj.ownerId });
    } else {
      const idx = db.servers.findIndex(s => s.id === req.params.serverId);
      if (idx !== -1) db.servers.splice(idx, 1);
      saveDatabase();
      return res.json({ success: true, deleted: true });
    }
  } else {
    serverObj.members = serverObj.members.filter(id => id !== req.user.id);
    saveDatabase();
    return res.json({ success: true });
  }
});

// 29. TRANSFER SERVER OWNERSHIP
app.post('/api/servers/:serverId/transfer/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });
  if (!serverObj.members.includes(req.params.userId)) return res.status(400).json({ error: 'User not in server' });

  serverObj.ownerId = req.params.userId;
  saveDatabase();
  return res.json({ success: true, ownerId: serverObj.ownerId });
});

// 30. ADD CHANNEL TO SERVER
app.post('/api/servers/:serverId/channels', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the server owner can create channels' });
  }

  const name = (req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return res.status(400).json({ error: 'Channel name required' });

  const newChannel = {
    id: uuidv4(),
    name,
    createdAt: new Date().toISOString()
  };

  if (!serverObj.channels) serverObj.channels = [];
  serverObj.channels.push(newChannel);
  saveDatabase();

  return res.status(201).json(newChannel);
});

// 31. RENAME CHANNEL
app.put('/api/servers/:serverId/channels/:channelId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the server owner can edit channels' });
  }

  const channel = (serverObj.channels || []).find(c => c.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const name = (req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return res.status(400).json({ error: 'Channel name required' });

  channel.name = name;
  saveDatabase();
  return res.json(channel);
});

// 32. DELETE CHANNEL
app.delete('/api/servers/:serverId/channels/:channelId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the server owner can delete channels' });
  }

  serverObj.channels = (serverObj.channels || []).filter(c => c.id !== req.params.channelId);
  db.messages = db.messages.filter(m => !(m.targetType === 'server' && m.targetId === req.params.serverId && m.channelId === req.params.channelId));
  saveDatabase();

  return res.json({ success: true });
});

// 33. GET SERVER MEMBERS
app.get('/api/servers/:serverId/members', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (!serverObj.members.includes(req.user.id)) return res.status(403).json({ error: 'Access denied' });

  const members = serverObj.members.map(mId => {
    const u = db.users.find(x => x.id === mId);
    if (!u) return null;
    return {
      ...sanitizeUser(u),
      isOwner: serverObj.ownerId === u.id,
      isAdmin: (serverObj.admins || []).includes(u.id),
      isMuted: (serverObj.mutedUsers || []).includes(u.id)
    };
  }).filter(Boolean);

  return res.json(members);
});

// 34. GET SERVER BANS
app.get('/api/servers/:serverId/bans', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const banned = (serverObj.bannedUsers || [])
    .map(id => db.users.find(u => u.id === id))
    .filter(Boolean)
    .map(sanitizeUser);
  return res.json(banned);
});

// 35. UNBAN USER FROM SERVER
app.post('/api/servers/:serverId/unban/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  serverObj.bannedUsers = (serverObj.bannedUsers || []).filter(id => id !== req.params.userId);
  saveDatabase();
  return res.json({ success: true });
});

// 36. KICK SERVER MEMBER
app.post('/api/servers/:serverId/kick/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  serverObj.members = serverObj.members.filter(id => id !== req.params.userId);
  saveDatabase();

  io.to(`user:${req.params.userId}`).emit('removedFromServer', {
    serverId: serverObj.id,
    serverName: serverObj.name,
    banned: false
  });

  return res.json({ success: true });
});

// 37. BAN SERVER MEMBER
app.post('/api/servers/:serverId/ban/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  serverObj.members = serverObj.members.filter(id => id !== req.params.userId);
  if (!serverObj.bannedUsers) serverObj.bannedUsers = [];
  if (!serverObj.bannedUsers.includes(req.params.userId)) serverObj.bannedUsers.push(req.params.userId);
  saveDatabase();

  io.to(`user:${req.params.userId}`).emit('removedFromServer', {
    serverId: serverObj.id,
    serverName: serverObj.name,
    banned: true
  });

  return res.json({ success: true });
});

// 38. MUTE SERVER MEMBER
app.post('/api/servers/:serverId/mute/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  if (!serverObj.mutedUsers) serverObj.mutedUsers = [];
  if (!serverObj.mutedUsers.includes(req.params.userId)) {
    serverObj.mutedUsers.push(req.params.userId);
    saveDatabase();
  }

  io.to(`user:${req.params.userId}`).emit('mutedInServer', {
    serverId: serverObj.id,
    serverName: serverObj.name
  });

  return res.json({ success: true });
});

// 39. UNMUTE SERVER MEMBER
app.post('/api/servers/:serverId/unmute/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  serverObj.mutedUsers = (serverObj.mutedUsers || []).filter(id => id !== req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});

// 39b. GRANT SERVER ADMIN ROLE
app.post('/api/servers/:serverId/admin/grant/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  if (!serverObj.admins) serverObj.admins = [];
  if (!serverObj.admins.includes(req.params.userId)) serverObj.admins.push(req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});

// 39c. REVOKE SERVER ADMIN ROLE
app.post('/api/servers/:serverId/admin/revoke/:userId', authenticateToken, (req, res) => {
  const serverObj = db.servers.find(s => s.id === req.params.serverId);
  if (!serverObj) return res.status(404).json({ error: 'Server not found' });
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  serverObj.admins = (serverObj.admins || []).filter(id => id !== req.params.userId);
  saveDatabase();

  return res.json({ success: true });
});


// 40. DELETE SERVER
app.delete('/api/servers/:serverId', authenticateToken, (req, res) => {
  const index = db.servers.findIndex(s => s.id === req.params.serverId);
  if (index === -1) return res.status(404).json({ error: 'Server not found' });

  const serverObj = db.servers[index];
  if (serverObj.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Permission denied' });

  db.servers.splice(index, 1);
  db.messages = db.messages.filter(m => !(m.targetType === 'server' && m.targetId === req.params.serverId));
  saveDatabase();

  return res.json({ success: true });
});

// 41. GRANT ADMIN
app.post('/api/admin/grant/:userId', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });

  const targetUser = db.users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  targetUser.isAdmin = true;
  saveDatabase();

  io.to(`user:${targetUser.id}`).emit('adminGranted', { userId: targetUser.id });

  return res.json({ success: true, user: sanitizeUser(targetUser) });
});

// 41b. REVOKE ADMIN
app.post('/api/admin/revoke/:userId', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });

  const targetUser = db.users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (targetUser.id === req.user.id) return res.status(400).json({ error: 'Cannot revoke your own admin' });

  targetUser.isAdmin = false;
  saveDatabase();

  io.to(`user:${targetUser.id}`).emit('adminRevoked', { userId: targetUser.id });

  return res.json({ success: true, user: sanitizeUser(targetUser) });
});

// 41c. VERIFY USER
app.post('/api/admin/verify/:userId', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });

  const targetUser = db.users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  targetUser.isVerified = true;
  saveDatabase();

  io.to(`user:${targetUser.id}`).emit('userVerified', { userId: targetUser.id });

  return res.json({ success: true, user: sanitizeUser(targetUser) });
});

// 41d. UNVERIFY USER
app.post('/api/admin/unverify/:userId', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });

  const targetUser = db.users.find(u => u.id === req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  targetUser.isVerified = false;
  saveDatabase();

  return res.json({ success: true, user: sanitizeUser(targetUser) });
});

// 42. GET MESSAGES
app.get('/api/messages/:targetType/:targetId', authenticateToken, (req, res) => {
  const { targetType, targetId } = req.params;
  const { channelId } = req.query;

  let messages = [];
  if (targetType === 'dm') {
    messages = db.messages.filter(m =>
      m.targetType === 'dm' &&
      ((m.senderId === req.user.id && m.targetId === targetId) ||
       (m.senderId === targetId && m.targetId === req.user.id))
    );
  } else if (targetType === 'group') {
    const group = db.groups.find(g => g.id === targetId);
    if (!group || !group.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Access denied to group messages' });
    }
    messages = db.messages.filter(m => m.targetType === 'group' && m.targetId === targetId);
  } else if (targetType === 'server') {
    const srv = db.servers.find(s => s.id === targetId);
    if (!srv || !srv.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Access denied to server messages' });
    }
    messages = db.messages.filter(m => {
      if (m.targetType !== 'server' || m.targetId !== targetId) return false;
      if (channelId) return m.channelId === channelId;
      return true;
    });
  }

  messages.sort((a, b) => a.timestamp - b.timestamp);
  return res.json(messages);
});

// 43. UPLOAD MESSAGE IMAGE
app.post('/api/messages/upload', authenticateToken, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  const imageUrl = `/uploads/messages/${req.file.filename}`;
  return res.json({ imageUrl });
});

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== SOCKET.IO REALTIME HANDLER =====
const onlineUsers = new Set();
const userSockets = new Map(); // userId -> Set of socket IDs

function joinAllUserRooms(socket, userId) {
  socket.join(`user:${userId}`);

  // Join user's groups
  db.groups.forEach(g => {
    if (g.members && g.members.includes(userId)) {
      socket.join(`group:${g.id}`);
    }
  });

  // Join user's servers
  db.servers.forEach(s => {
    if (s.members && s.members.includes(userId) && !(s.bannedUsers || []).includes(userId)) {
      socket.join(`server:${s.id}`);
    }
  });
}

io.on('connection', (socket) => {
  let authenticatedUserId = null;

  socket.on('authenticate', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      authenticatedUserId = decoded.id;
      socket.userId = authenticatedUserId;

      if (!userSockets.has(authenticatedUserId)) {
        userSockets.set(authenticatedUserId, new Set());
      }
      userSockets.get(authenticatedUserId).add(socket.id);
      onlineUsers.add(authenticatedUserId);

      joinAllUserRooms(socket, authenticatedUserId);

      // Send online users list to connecting socket
      socket.emit('onlineUsers', Array.from(onlineUsers));

      // Broadcast user online to everyone
      socket.broadcast.emit('userOnline', { userId: authenticatedUserId });
    } catch (err) {
      console.error('Socket authentication failed:', err.message);
    }
  });

  socket.on('rejoinRooms', () => {
    if (!authenticatedUserId) return;
    joinAllUserRooms(socket, authenticatedUserId);
  });

  socket.on('typing', (chatData) => {
    if (!authenticatedUserId || !chatData) return;
    const user = db.users.find(u => u.id === authenticatedUserId);
    if (!user) return;

    const payload = {
      userId: authenticatedUserId,
      username: user.nickname || user.username,
      targetType: chatData.targetType,
      targetId: chatData.targetId,
      channelId: chatData.channelId || null
    };

    if (chatData.targetType === 'dm') {
      io.to(`user:${chatData.targetId}`).emit('userTyping', payload);
    } else if (chatData.targetType === 'group') {
      socket.to(`group:${chatData.targetId}`).emit('userTyping', payload);
    } else if (chatData.targetType === 'server') {
      socket.to(`server:${chatData.targetId}`).emit('userTyping', payload);
    }
  });

  socket.on('stopTyping', (chatData) => {
    if (!authenticatedUserId || !chatData) return;

    const payload = {
      userId: authenticatedUserId,
      targetType: chatData.targetType,
      targetId: chatData.targetId,
      channelId: chatData.channelId || null
    };

    if (chatData.targetType === 'dm') {
      io.to(`user:${chatData.targetId}`).emit('userStoppedTyping', payload);
    } else if (chatData.targetType === 'group') {
      socket.to(`group:${chatData.targetId}`).emit('userStoppedTyping', payload);
    } else if (chatData.targetType === 'server') {
      socket.to(`server:${chatData.targetId}`).emit('userStoppedTyping', payload);
    }
  });

  socket.on('sendMessage', (data) => {
    if (!authenticatedUserId || !data) return;
    const user = db.users.find(u => u.id === authenticatedUserId);
    if (!user) return;

    // Check mute status in server
    if (data.targetType === 'server') {
      const srv = db.servers.find(s => s.id === data.targetId);
      if (srv && (srv.mutedUsers || []).includes(authenticatedUserId)) {
        return;
      }
    }

    let replyInfo = null;
    if (data.replyTo) {
      const origMsg = db.messages.find(m => m.id === data.replyTo);
      if (origMsg) {
        replyInfo = {
          id: origMsg.id,
          message: origMsg.message || (origMsg.image ? '[Image]' : ''),
          senderUsername: origMsg.senderNickname || origMsg.senderUsername
        };
      }
    }

    const newMsg = {
      id: uuidv4(),
      targetType: data.targetType,
      targetId: data.targetId,
      channelId: data.channelId || null,
      senderId: user.id,
      senderUsername: user.username,
      senderNickname: user.nickname || user.username,
      senderAvatar: user.avatar || defaultAvatar(user.username),
      senderIsAdmin: !!user.isAdmin,
      senderIsVerified: !!user.isVerified,
      message: data.message || '',
      image: null,
      replyTo: replyInfo,
      edited: false,
      deleted: false,
      timestamp: Date.now()
    };

    db.messages.push(newMsg);
    debouncedSave();

    if (data.targetType === 'dm') {
      io.to(`user:${data.targetId}`).to(`user:${user.id}`).emit('newMessage', newMsg);
    } else if (data.targetType === 'group') {
      io.to(`group:${data.targetId}`).emit('newMessage', newMsg);
    } else if (data.targetType === 'server') {
      io.to(`server:${data.targetId}`).emit('newMessage', newMsg);
    }
  });

  socket.on('sendImageMessage', (data) => {
    if (!authenticatedUserId || !data) return;
    const user = db.users.find(u => u.id === authenticatedUserId);
    if (!user) return;

    if (data.targetType === 'server') {
      const srv = db.servers.find(s => s.id === data.targetId);
      if (srv && (srv.mutedUsers || []).includes(authenticatedUserId)) {
        return;
      }
    }

    let replyInfo = null;
    if (data.replyTo) {
      const origMsg = db.messages.find(m => m.id === data.replyTo);
      if (origMsg) {
        replyInfo = {
          id: origMsg.id,
          message: origMsg.message || (origMsg.image ? '[Image]' : ''),
          senderUsername: origMsg.senderNickname || origMsg.senderUsername
        };
      }
    }

    const newMsg = {
      id: uuidv4(),
      targetType: data.targetType,
      targetId: data.targetId,
      channelId: data.channelId || null,
      senderId: user.id,
      senderUsername: user.username,
      senderNickname: user.nickname || user.username,
      senderAvatar: user.avatar || defaultAvatar(user.username),
      senderIsAdmin: !!user.isAdmin,
      senderIsVerified: !!user.isVerified,
      message: null,
      image: data.imageUrl,
      replyTo: replyInfo,
      edited: false,
      deleted: false,
      timestamp: Date.now()
    };

    db.messages.push(newMsg);
    debouncedSave();

    if (data.targetType === 'dm') {
      io.to(`user:${data.targetId}`).to(`user:${user.id}`).emit('newMessage', newMsg);
    } else if (data.targetType === 'group') {
      io.to(`group:${data.targetId}`).emit('newMessage', newMsg);
    } else if (data.targetType === 'server') {
      io.to(`server:${data.targetId}`).emit('newMessage', newMsg);
    }
  });

  socket.on('editMessage', (data) => {
    if (!authenticatedUserId || !data || !data.messageId) return;
    const msg = db.messages.find(m => m.id === data.messageId);
    if (!msg) return;
    if (msg.senderId !== authenticatedUserId) return;

    msg.message = data.newText || '';
    msg.edited = true;
    debouncedSave();

    const payload = { id: msg.id, message: msg.message };
    if (msg.targetType === 'dm') {
      io.to(`user:${msg.targetId}`).to(`user:${msg.senderId}`).emit('messageUpdated', payload);
    } else if (msg.targetType === 'group') {
      io.to(`group:${msg.targetId}`).emit('messageUpdated', payload);
    } else if (msg.targetType === 'server') {
      io.to(`server:${msg.targetId}`).emit('messageUpdated', payload);
    }
  });

  socket.on('deleteMessage', (data) => {
    if (!authenticatedUserId || !data || !data.messageId) return;
    const user = db.users.find(u => u.id === authenticatedUserId);
    const msg = db.messages.find(m => m.id === data.messageId);
    if (!msg) return;

    if (msg.senderId !== authenticatedUserId && (!user || !user.isAdmin)) return;

    msg.deleted = true;
    msg.message = null;
    msg.image = null;

    // Update any messages that replied to this parent message
    db.messages.forEach(m => {
      if (m.replyTo && m.replyTo.id === data.messageId) {
        m.replyTo.deleted = true;
        m.replyTo.message = 'Original message was deleted';
      }
    });

    debouncedSave();

    const payload = { id: msg.id, deletedParentId: msg.id };
    if (msg.targetType === 'dm') {
      io.to(`user:${msg.targetId}`).to(`user:${msg.senderId}`).emit('messageDeleted', payload);
    } else if (msg.targetType === 'group') {
      io.to(`group:${msg.targetId}`).emit('messageDeleted', payload);
    } else if (msg.targetType === 'server') {
      io.to(`server:${msg.targetId}`).emit('messageDeleted', payload);
    }
  });

  socket.on('disconnect', () => {
    if (authenticatedUserId) {
      const userSocketsSet = userSockets.get(authenticatedUserId);
      if (userSocketsSet) {
        userSocketsSet.delete(socket.id);
        if (userSocketsSet.size === 0) {
          userSockets.delete(authenticatedUserId);
          onlineUsers.delete(authenticatedUserId);
          socket.broadcast.emit('userOffline', { userId: authenticatedUserId });
        }
      }
    }
  });
});

// ===== START SERVER =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 RealChat Messenger running on:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://0.0.0.0:${PORT}`);
  console.log(`=========================================`);
});
