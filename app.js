// Storage wrapper - uses persistent storage if available, falls back to in-memory
const safeStorage = (function() {
  const mem = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; } };
  try {
    const ls = window['local' + 'Storage'];
    ls.setItem('__t', '1');
    ls.removeItem('__t');
    return ls;
  } catch (e) { return mem; }
})();

// ===== THEMES & ACCENTS =====
const ACCENTS = {
  indigo: { primary: '#6366f1', dark: '#4f46e5', light: '#818cf8', glow: 'rgba(99, 102, 241, 0.35)' },
  violet: { primary: '#8b5cf6', dark: '#7c3aed', light: '#a78bfa', glow: 'rgba(139, 92, 246, 0.35)' },
  emerald: { primary: '#10b981', dark: '#059669', light: '#34d399', glow: 'rgba(16, 185, 129, 0.35)' },
  rose: { primary: '#f43f5e', dark: '#e11d48', light: '#fb7185', glow: 'rgba(244, 63, 94, 0.35)' },
  amber: { primary: '#f59e0b', dark: '#d97706', light: '#fbbf24', glow: 'rgba(245, 158, 11, 0.35)' },
  cyan: { primary: '#06b6d4', dark: '#0891b2', light: '#22d3ee', glow: 'rgba(6, 182, 212, 0.35)' }
};

const THEMES = {
  space: { bgDarkest: '#0d0d1a', bgDark: '#131325', bgMedium: '#1a1a30', bgLighter: '#202038', surface: '#252545', surfaceHover: '#2d2d52', border: '#2e2e52' },
  midnight: { bgDarkest: '#000000', bgDark: '#0a0a10', bgMedium: '#12121c', bgLighter: '#181824', surface: '#1e1e2d', surfaceHover: '#27273a', border: '#252538' },
  cyberpunk: { bgDarkest: '#060913', bgDark: '#0a0f1d', bgMedium: '#0f172a', bgLighter: '#1e293b', surface: '#1e293b', surfaceHover: '#334155', border: '#334155' }
};

// ===== GLOBAL STATE =====
let state = {
  token: safeStorage.getItem('token'),
  user: JSON.parse(safeStorage.getItem('user') || 'null'),
  socket: null,
  onlineUsers: new Set(),
  friends: [],
  groups: [],
  servers: [],
  friendRequests: [],
  currentChat: null, // { targetType, targetId, title, avatar, channelId? }
  messages: {},
  replyTo: null,
  editingMessage: null,
  selectedChannel: null,
  currentServer: null,
  currentSettingEntityId: null, // for Group or Server Settings modal
  typingUsers: new Map(), // key -> username
  preferences: {
    accent: 'indigo',
    theme: 'space',
    soundEnabled: true,
    toastEnabled: true,
    enterToSend: true,
    compactMode: false
  }
};

const API_URL = window.location.origin;

// Helper: prefix uploaded asset URLs with API_URL
function assetUrl(url) {
  if (!url) return url;
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  return `${API_URL}${url}`;
}

// ===== SOUND SYNTHESIZER =====
function playNotificationChime() {
  if (state.preferences.soundEnabled === false) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
}

// ===== THEME & ACCENT APPLIERS =====
function applyAccent(accentKey) {
  const acc = ACCENTS[accentKey] || ACCENTS.indigo;
  const root = document.documentElement;
  root.style.setProperty('--primary', acc.primary);
  root.style.setProperty('--primary-dark', acc.dark);
  root.style.setProperty('--primary-light', acc.light);
  root.style.setProperty('--primary-glow', acc.glow);
  state.preferences.accent = accentKey;

  document.querySelectorAll('#accentColorPicker .color-dot').forEach(dot => {
    dot.classList.toggle('active', dot.dataset.accent === accentKey);
  });
}

function applyTheme(themeKey) {
  const th = THEMES[themeKey] || THEMES.space;
  const root = document.documentElement;
  root.style.setProperty('--bg-darkest', th.bgDarkest);
  root.style.setProperty('--bg-dark', th.bgDark);
  root.style.setProperty('--bg-medium', th.bgMedium);
  root.style.setProperty('--bg-lighter', th.bgLighter);
  root.style.setProperty('--surface', th.surface);
  root.style.setProperty('--surface-hover', th.surfaceHover);
  root.style.setProperty('--border', th.border);
  state.preferences.theme = themeKey;

  document.querySelectorAll('.theme-picker-row .theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === themeKey);
  });
}

function applyPreferences(prefs) {
  if (!prefs) return;
  state.preferences = { ...state.preferences, ...prefs };
  if (state.preferences.accent) applyAccent(state.preferences.accent);
  if (state.preferences.theme) applyTheme(state.preferences.theme);

  const soundToggle = document.getElementById('soundToggle');
  if (soundToggle) soundToggle.checked = state.preferences.soundEnabled !== false;

  const toastToggle = document.getElementById('toastToggle');
  if (toastToggle) toastToggle.checked = state.preferences.toastEnabled !== false;

  const enterToggle = document.getElementById('enterSendToggle');
  if (enterToggle) enterToggle.checked = state.preferences.enterToSend !== false;

  const compactToggle = document.getElementById('compactViewToggle');
  if (compactToggle) {
    compactToggle.checked = !!state.preferences.compactMode;
    document.body.classList.toggle('compact-mode', !!state.preferences.compactMode);
  }
}

async function savePreferences() {
  safeStorage.setItem('preferences', JSON.stringify(state.preferences));
  if (state.token) {
    try {
      await apiPut('/api/profile', { preferences: state.preferences });
    } catch (e) {}
  }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  const cachedPrefs = JSON.parse(safeStorage.getItem('preferences') || 'null');
  if (cachedPrefs) applyPreferences(cachedPrefs);

  if (state.token && state.user) {
    showChatScreen();
    initSocket();
    loadAllData();
  } else {
    showAuthScreen();
  }
});

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Auth tabs
  document.querySelectorAll('.auth-tabs .tab').forEach(tab => {
    tab.addEventListener('click', (e) => switchAuthTab(e.target.dataset.tab));
  });

  // Auth forms
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);

  // Nav rail
  document.querySelectorAll('.nav-rail-item').forEach(item => {
    item.addEventListener('click', () => switchPanel(item.dataset.nav));
  });

  // Sidebar buttons
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('addFriendBtn').addEventListener('click', () => openModal('addFriendModal'));
  document.getElementById('createGroupBtn').addEventListener('click', () => openModal('createGroupModal'));
  document.getElementById('createServerBtn').addEventListener('click', () => openModal('createServerModal'));
  document.getElementById('discoverServersBtn').addEventListener('click', openDiscoverServers);

  // Profile
  document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
  document.getElementById('avatarFileInput').addEventListener('change', uploadAvatar);

  // Settings Panel interactions
  document.querySelectorAll('#accentColorPicker .color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      applyAccent(dot.dataset.accent);
      savePreferences();
    });
  });

  document.querySelectorAll('.theme-picker-row .theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      savePreferences();
    });
  });

  const soundToggle = document.getElementById('soundToggle');
  if (soundToggle) {
    soundToggle.addEventListener('change', (e) => {
      state.preferences.soundEnabled = e.target.checked;
      savePreferences();
    });
  }

  const toastToggle = document.getElementById('toastToggle');
  if (toastToggle) {
    toastToggle.addEventListener('change', (e) => {
      state.preferences.toastEnabled = e.target.checked;
      savePreferences();
    });
  }

  const enterSendToggle = document.getElementById('enterSendToggle');
  if (enterSendToggle) {
    enterSendToggle.addEventListener('change', (e) => {
      state.preferences.enterToSend = e.target.checked;
      savePreferences();
    });
  }

  const compactViewToggle = document.getElementById('compactViewToggle');
  if (compactViewToggle) {
    compactViewToggle.addEventListener('change', (e) => {
      state.preferences.compactMode = e.target.checked;
      document.body.classList.toggle('compact-mode', e.target.checked);
      savePreferences();
    });
  }

  const testSoundBtn = document.getElementById('testSoundBtn');
  if (testSoundBtn) {
    testSoundBtn.addEventListener('click', playNotificationChime);
  }

  const changePasswordBtn = document.getElementById('changePasswordBtn');
  if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', handleChangePassword);
  }

  // Modal Settings Tabs switching (Group & Server)
  document.querySelectorAll('.settings-nav-tabs .settings-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const parentModal = tab.closest('.modal');
      const tabTarget = tab.dataset.tab;
      parentModal.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      parentModal.querySelectorAll('.settings-panel-content').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const targetPanel = parentModal.querySelector(`#tab-${tabTarget}`);
      if (targetPanel) targetPanel.classList.add('active');
    });
  });

  // Group Settings Save & Uploads
  document.getElementById('editGroupIconInput').addEventListener('change', (e) => previewIcon(e, 'editGroupIconPreview'));
  document.getElementById('saveGroupSettingsBtn').addEventListener('click', saveGroupSettings);
  document.getElementById('groupSettingsInviteBtn').addEventListener('click', () => {
    closeModal('groupSettingsModal');
    if (state.currentSettingEntityId) openGroupInvite(state.currentSettingEntityId);
  });
  document.getElementById('leaveGroupBtn').addEventListener('click', () => {
    if (state.currentSettingEntityId) leaveGroup(state.currentSettingEntityId);
  });
  document.getElementById('deleteGroupModalBtn').addEventListener('click', () => {
    if (state.currentSettingEntityId) {
      closeModal('groupSettingsModal');
      deleteGroup(state.currentSettingEntityId);
    }
  });

  // Server Settings Save & Uploads
  document.getElementById('editServerIconInput').addEventListener('change', (e) => previewIcon(e, 'editServerIconPreview'));
  document.getElementById('saveServerSettingsBtn').addEventListener('click', saveServerSettings);
  document.getElementById('serverSettingsAddChannelBtn').addEventListener('click', () => {
    closeModal('serverSettingsModal');
    openModal('addChannelModal');
  });
  document.getElementById('leaveServerBtn').addEventListener('click', () => {
    if (state.currentSettingEntityId) leaveServer(state.currentSettingEntityId);
  });
  document.getElementById('deleteServerModalBtn').addEventListener('click', () => {
    if (state.currentSettingEntityId) {
      closeModal('serverSettingsModal');
      deleteServer(state.currentSettingEntityId);
    }
  });

  // Filter server members in settings
  const serverMembersSearch = document.getElementById('serverMembersSearchInput');
  if (serverMembersSearch) {
    serverMembersSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#serverSettingsMembersList .settings-row-item').forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });
  }

  // Message input
  document.getElementById('messageInput').addEventListener('keydown', (e) => {
    const enterToSend = state.preferences.enterToSend !== false;
    if (enterToSend) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (state.editingMessage) confirmEdit();
        else sendMessage();
      }
    } else {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (state.editingMessage) confirmEdit();
        else sendMessage();
      }
    }
  });

  document.getElementById('sendBtn').addEventListener('click', () => {
    if (state.editingMessage) confirmEdit();
    else sendMessage();
  });

  document.getElementById('messageInput').addEventListener('input', () => {
    if (state.currentChat && state.socket) {
      state.socket.emit('typing', state.currentChat);
    }
  });
  document.getElementById('messageInput').addEventListener('blur', () => {
    if (state.currentChat && state.socket) {
      state.socket.emit('stopTyping', state.currentChat);
    }
  });

  // Image upload
  document.getElementById('imageUploadBtn').addEventListener('click', () => {
    document.getElementById('imageFileInput').click();
  });
  document.getElementById('imageFileInput').addEventListener('change', sendImageMessage);

  // Reply/edit cancel
  document.getElementById('cancelReplyBtn').addEventListener('click', cancelReply);
  document.getElementById('cancelEditBtn').addEventListener('click', cancelEdit);

  // Back button (mobile)
  document.getElementById('backBtn').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('mobile-hidden');
    document.querySelector('.main-chat').classList.add('mobile-hidden');
  });

  // Modal closes
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Add friend search
  document.getElementById('friendSearchInput').addEventListener('input', debounce(searchUsers, 300));

  // Create group
  document.getElementById('groupIconInput').addEventListener('change', (e) => previewIcon(e, 'groupIconPreview'));
  document.getElementById('confirmCreateGroupBtn').addEventListener('click', createGroup);

  // Create server
  document.getElementById('serverIconInput').addEventListener('change', (e) => previewIcon(e, 'serverIconPreview'));
  document.getElementById('confirmCreateServerBtn').addEventListener('click', createServer);

  // Add channel in channel bar
  document.getElementById('addChannelBtn').addEventListener('click', () => openModal('addChannelModal'));
  document.getElementById('confirmAddChannelBtn').addEventListener('click', addChannel);

  // Image viewer
  document.getElementById('closeImageViewerBtn').addEventListener('click', () => closeModal('imageViewerModal'));

  // Members panel
  document.getElementById('closeMembersBtn').addEventListener('click', () => {
    document.getElementById('membersPanel').style.display = 'none';
  });
}

// ===== AUTH =====
function switchAuthTab(tab, event) {
  document.querySelectorAll('.auth-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  (event || window.event).target.classList.add('active');
  document.getElementById(tab + 'Form').classList.add('active');
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  try {
    const res = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Login failed'; return; }
    saveSession(data.token, data.user);
    if (data.user?.preferences) applyPreferences(data.user.preferences);
    showChatScreen();
    initSocket();
    loadAllData();
  } catch (err) {
    errorEl.textContent = 'Connection error. Try again.';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;
  const errorEl = document.getElementById('regError');
  errorEl.textContent = '';

  if (password !== confirm) { errorEl.textContent = 'Passwords do not match'; return; }
  if (password.length < 6) { errorEl.textContent = 'Password must be at least 6 characters'; return; }

  try {
    const res = await fetch(`${API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Registration failed'; return; }
    saveSession(data.token, data.user);
    if (data.user?.preferences) applyPreferences(data.user.preferences);
    showChatScreen();
    initSocket();
    loadAllData();
  } catch (err) {
    errorEl.textContent = 'Connection error. Try again.';
  }
}

async function handleChangePassword() {
  const currentPassword = document.getElementById('currentPassInput').value;
  const newPassword = document.getElementById('newPassInput').value;
  if (!currentPassword || !newPassword) {
    showToast('Please fill in both current and new password', 'error');
    return;
  }
  if (newPassword.length < 6) {
    showToast('New password must be at least 6 characters', 'error');
    return;
  }
  try {
    await apiPost('/api/account/password', { currentPassword, newPassword });
    document.getElementById('currentPassInput').value = '';
    document.getElementById('newPassInput').value = '';
    showToast('Password updated successfully', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  safeStorage.setItem('token', token);
  safeStorage.setItem('user', JSON.stringify(user));
}

function logout() {
  safeStorage.clear();
  if (state.socket) state.socket.disconnect();
  state = {
    token: null, user: null, socket: null, onlineUsers: new Set(),
    friends: [], groups: [], servers: [], friendRequests: [],
    currentChat: null, messages: {}, replyTo: null, editingMessage: null,
    selectedChannel: null, currentServer: null, currentSettingEntityId: null,
    typingUsers: new Map(),
    preferences: {
      accent: 'indigo',
      theme: 'space',
      soundEnabled: true,
      toastEnabled: true,
      enterToSend: true,
      compactMode: false
    }
  };
  showAuthScreen();
}

// ===== UI SCREENS =====
function showAuthScreen() {
  document.getElementById('authScreen').classList.add('active');
  document.getElementById('chatScreen').classList.remove('active');
}

function showChatScreen() {
  document.getElementById('authScreen').classList.remove('active');
  document.getElementById('chatScreen').classList.add('active');
  updateProfileUI();
  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.remove('mobile-hidden');
    document.querySelector('.main-chat').classList.add('mobile-hidden');
  }
}

function switchPanel(nav) {
  document.querySelectorAll('.nav-rail-item').forEach(i => i.classList.remove('active'));
  const navItem = document.querySelector(`.nav-rail-item[data-nav="${nav}"]`);
  if (navItem) navItem.classList.add('active');

  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`panel-${nav}`);
  if (panel) panel.classList.add('active');

  if (window.innerWidth <= 480) {
    document.querySelector('.sidebar').classList.remove('mobile-hidden');
    document.querySelector('.main-chat').classList.add('mobile-hidden');
  }
}

// ===== LOAD DATA =====
async function loadAllData() {
  await Promise.all([loadFriends(), loadGroups(), loadServers(), loadFriendRequests(), loadCurrentUser()]);
}

async function loadCurrentUser() {
  try {
    const res = await apiGet('/api/me');
    if (res) {
      state.user = res;
      safeStorage.setItem('user', JSON.stringify(res));
      if (res.preferences) applyPreferences(res.preferences);
      updateProfileUI();
    }
  } catch (e) { console.error('Failed to load user', e); }
}

async function loadFriends() {
  try {
    state.friends = await apiGet('/api/friends');
    renderFriends();
  } catch (e) { console.error('Failed to load friends', e); }
}

async function loadGroups() {
  try {
    state.groups = await apiGet('/api/groups');
    renderGroups();
  } catch (e) { console.error('Failed to load groups', e); }
}

async function loadServers() {
  try {
    state.servers = await apiGet('/api/servers');
    renderServers();
  } catch (e) { console.error('Failed to load servers', e); }
}

async function loadFriendRequests() {
  try {
    state.friendRequests = await apiGet('/api/friends/requests');
    updateFriendReqBadge();
    if (document.getElementById('addFriendModal').classList.contains('active')) {
      renderFriendRequests();
    }
  } catch (e) { console.error('Failed to load friend requests', e); }
}

// ===== API HELPERS =====
async function apiGet(url) {
  const res = await fetch(`${API_URL}${url}`, {
    headers: { 'Authorization': `Bearer ${state.token}` }
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiPostForm(url, formData) {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.token}` },
    body: formData
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiPut(url, body) {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiPutForm(url, formData) {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${state.token}` },
    body: formData
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${state.token}` }
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

// ===== PROFILE =====
function updateProfileUI() {
  if (!state.user) return;
  document.getElementById('profileAvatar').src = assetUrl(state.user.avatar);
  document.getElementById('navAvatar').src = assetUrl(state.user.avatar);
  document.getElementById('profileUsername').textContent = '@' + state.user.username;
  document.getElementById('profileNickname').textContent = state.user.nickname || state.user.username;
  document.getElementById('editNickname').value = state.user.nickname || '';
  document.getElementById('editDescription').value = state.user.description || '';
  document.getElementById('profileAdminBadge').style.display = state.user.isAdmin ? 'inline-flex' : 'none';
}

async function saveProfile() {
  const nickname = document.getElementById('editNickname').value.trim();
  const description = document.getElementById('editDescription').value.trim();
  try {
    const updated = await apiPut('/api/profile', { nickname, description });
    state.user = updated;
    safeStorage.setItem('user', JSON.stringify(updated));
    updateProfileUI();
    showToast('Profile saved', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function uploadAvatar() {
  const file = document.getElementById('avatarFileInput').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const data = await apiPostForm('/api/profile/avatar', formData);
    state.user = data.user;
    safeStorage.setItem('user', JSON.stringify(data.user));
    updateProfileUI();
    showToast('Avatar updated', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== FRIENDS =====
async function searchUsers() {
  const query = document.getElementById('friendSearchInput').value.trim();
  const resultsEl = document.getElementById('friendSearchResults');
  if (!query) { resultsEl.innerHTML = ''; return; }
  try {
    const results = await apiGet(`/api/users/search/${encodeURIComponent(query)}`);
    resultsEl.innerHTML = results.map(u => `
      <div class="list-item" data-user-id="${u.id}">
        <img class="list-item-avatar" src="${assetUrl(u.avatar)}" alt="">
        <div class="list-item-info">
          <div class="list-item-name">${escapeHtml(u.nickname || u.username)}</div>
          <div class="list-item-sub">@${escapeHtml(u.username)}${u.isAdmin ? ' <i class="fas fa-shield-alt" style="color:var(--warning)"></i>' : ''}</div>
        </div>
        ${u.isFriend ? '<span class="list-item-sub">Friend</span>' :
          u.hasPendingRequest ? '<span class="list-item-sub">Pending</span>' :
          `<button class="btn-primary" style="padding:6px 12px;font-size:12px" onclick="sendFriendRequest('${u.id}')">Add</button>`}
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

async function sendFriendRequest(userId) {
  try {
    const result = await apiPost(`/api/friends/request/${userId}`);
    if (result.status === 'accepted') {
      showToast('You are now friends!', 'success');
      await loadFriends();
    } else {
      showToast('Friend request sent', 'success');
    }
    searchUsers();
  } catch (e) { showToast(e.message, 'error'); }
}

function renderFriendRequests() {
  const section = document.getElementById('friendRequestsSection');
  const list = document.getElementById('friendRequestsList');
  if (state.friendRequests.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  list.innerHTML = state.friendRequests.map(r => `
    <div class="list-item">
      <img class="list-item-avatar" src="${assetUrl(r.fromUser.avatar)}" alt="">
      <div class="list-item-info">
        <div class="list-item-name">${escapeHtml(r.fromUser.nickname || r.fromUser.username)}</div>
        <div class="list-item-sub">@${escapeHtml(r.fromUser.username)}</div>
      </div>
      <button class="btn-primary" style="padding:6px 12px;font-size:12px" onclick="acceptFriendRequest('${r.id}')">Accept</button>
      <button class="btn-icon" onclick="declineFriendRequest('${r.id}')"><i class="fas fa-times"></i></button>
    </div>
  `).join('');
}

async function acceptFriendRequest(requestId) {
  try {
    await apiPost(`/api/friends/accept/${requestId}`);
    showToast('Friend request accepted', 'success');
    await loadFriends();
    await loadFriendRequests();
  } catch (e) { showToast(e.message, 'error'); }
}

async function declineFriendRequest(requestId) {
  try {
    await apiPost(`/api/friends/decline/${requestId}`);
    await loadFriendRequests();
  } catch (e) { showToast(e.message, 'error'); }
}

function updateFriendReqBadge() {
  const badge = document.getElementById('friendReqBadge');
  const count = state.friendRequests.length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
}

function renderFriends() {
  const container = document.getElementById('friendsList');
  if (state.friends.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-user-friends"></i><p>No friends yet.<br>Click + to add friends.</p></div>';
    return;
  }
  container.innerHTML = state.friends.map(f => {
    const isActive = state.currentChat && state.currentChat.targetType === 'dm' && state.currentChat.targetId === f.id;
    const isOnline = state.onlineUsers.has(f.id);
    const avatarUrl = assetUrl(f.avatar);
    return `
      <div class="list-item${isActive ? ' active' : ''}" onclick="selectDM('${f.id}')">
        <img class="list-item-avatar" src="${avatarUrl}" alt="">
        <div class="list-item-info">
          <div class="list-item-name">${escapeHtml(f.nickname || f.username)}</div>
          <div class="list-item-sub">@${escapeHtml(f.username)}</div>
        </div>
        ${isOnline ? '<div class="list-item-badge"></div>' : ''}
      </div>
    `;
  }).join('');
}

// ===== GROUPS =====
async function createGroup() {
  const name = document.getElementById('groupNameInput').value.trim();
  if (!name) { showToast('Group name required', 'error'); return; }
  const fileInput = document.getElementById('groupIconInput');
  const formData = new FormData();
  formData.append('name', name);
  if (fileInput.files[0]) formData.append('icon', fileInput.files[0]);
  try {
    const group = await apiPostForm('/api/groups', formData);
    state.groups.push(group);
    renderGroups();
    closeModal('createGroupModal');
    document.getElementById('groupNameInput').value = '';
    document.getElementById('groupIconInput').value = '';
    document.getElementById('groupIconPreview').src = '';
    showToast('Group created', 'success');
    if (state.socket) state.socket.emit('rejoinRooms');
    selectGroup(group.id);
  } catch (e) { showToast(e.message, 'error'); }
}

function renderGroups() {
  const container = document.getElementById('groupsList');
  if (state.groups.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><p>No groups yet.<br>Click + to create one.</p></div>';
    return;
  }
  container.innerHTML = state.groups.map(g => {
    const isActive = state.currentChat && state.currentChat.targetType === 'group' && state.currentChat.targetId === g.id;
    const iconHtml = g.icon
      ? `<img class="list-item-icon" src="${assetUrl(g.icon)}" alt="">`
      : `<div class="list-item-icon"><i class="fas fa-users"></i></div>`;
    return `
      <div class="list-item${isActive ? ' active' : ''}" onclick="selectGroup('${g.id}')">
        ${iconHtml}
        <div class="list-item-info">
          <div class="list-item-name">${escapeHtml(g.name)}</div>
          <div class="list-item-sub">${g.members.length} members</div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== GROUP SETTINGS =====
async function openGroupSettings(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  state.currentSettingEntityId = groupId;

  // Reset tab to overview
  const modal = document.getElementById('groupSettingsModal');
  modal.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  modal.querySelectorAll('.settings-panel-content').forEach(p => p.classList.remove('active'));
  modal.querySelector('.settings-tab[data-tab="group-overview"]').classList.add('active');
  modal.querySelector('#tab-group-overview').classList.add('active');

  // Populate overview
  document.getElementById('editGroupNameInput').value = group.name || '';
  document.getElementById('editGroupDescInput').value = group.description || '';
  const preview = document.getElementById('editGroupIconPreview');
  if (group.icon) preview.src = assetUrl(group.icon);
  else preview.src = '';

  const isOwner = group.ownerId === state.user.id || state.user.isAdmin;
  document.getElementById('saveGroupSettingsBtn').style.display = isOwner ? 'block' : 'none';
  document.getElementById('deleteGroupSection').style.display = isOwner ? 'flex' : 'none';
  document.getElementById('leaveGroupSection').style.display = isOwner ? 'none' : 'flex';

  // Load members
  loadGroupSettingsMembers(groupId);

  openModal('groupSettingsModal');
}

async function loadGroupSettingsMembers(groupId) {
  const list = document.getElementById('groupSettingsMembersList');
  list.innerHTML = '<div class="empty-state"><p>Loading members...</p></div>';
  try {
    const members = await apiGet(`/api/groups/${groupId}/members`);
    const group = state.groups.find(g => g.id === groupId);
    const isOwner = group && (group.ownerId === state.user.id || state.user.isAdmin);

    list.innerHTML = members.map(m => {
      let roleBadge = m.isOwner
        ? '<span class="member-badge owner">Owner</span>'
        : m.isAdmin ? '<span class="member-badge admin">Admin</span>' : '<span class="member-badge">Member</span>';
      if (m.isVerified) roleBadge += ' <i class="fas fa-check-circle verified-badge verified-badge-sm" title="Verified"></i>';
      let actions = '';
      if (isOwner && !m.isOwner) {
        actions = `
          ${!m.isAdmin
            ? `<button class="btn-primary btn-sm" title="Grant Group Admin" onclick="grantGroupAdmin('${groupId}','${m.id}')"><i class="fas fa-shield-alt"></i></button>`
            : `<button class="btn-secondary btn-sm" title="Revoke Group Admin" onclick="revokeGroupAdmin('${groupId}','${m.id}')"><i class="fas fa-shield-alt"></i></button>`
          }
          <button class="btn-secondary btn-sm" title="Transfer Ownership" onclick="transferGroupOwnership('${groupId}','${m.id}')"><i class="fas fa-crown"></i></button>
          <button class="btn-danger btn-sm" title="Kick" onclick="kickGroupMemberFromSettings('${groupId}','${m.id}')"><i class="fas fa-sign-out-alt"></i></button>
        `;
      }
      return `
        <div class="settings-row-item">
          <div class="settings-row-info">
            <img src="${assetUrl(m.avatar)}" alt="">
            <div>
              <div style="font-weight:600;font-size:13px">${escapeHtml(m.nickname || m.username)} ${roleBadge}</div>
              <div style="font-size:11px;color:var(--text-muted)">@${escapeHtml(m.username)}</div>
            </div>
          </div>
          <div class="settings-row-actions">${actions}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><p>Failed to load members</p></div>';
  }
}

async function saveGroupSettings() {
  const groupId = state.currentSettingEntityId;
  if (!groupId) return;
  const name = document.getElementById('editGroupNameInput').value.trim();
  const description = document.getElementById('editGroupDescInput').value.trim();
  const fileInput = document.getElementById('editGroupIconInput');

  if (!name) { showToast('Group name required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('description', description);
  if (fileInput.files[0]) formData.append('icon', fileInput.files[0]);

  try {
    const updated = await apiPutForm(`/api/groups/${groupId}`, formData);
    const idx = state.groups.findIndex(g => g.id === groupId);
    if (idx !== -1) state.groups[idx] = updated;
    renderGroups();
    if (state.currentChat?.targetType === 'group' && state.currentChat?.targetId === groupId) {
      state.currentChat.title = updated.name;
      state.currentChat.avatar = updated.icon;
      updateChatHeader();
    }
    closeModal('groupSettingsModal');
    showToast('Group settings updated', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function kickGroupMemberFromSettings(groupId, userId) {
  if (!confirm('Kick this member from the group?')) return;
  try {
    await apiPost(`/api/groups/${groupId}/kick/${userId}`);
    const group = state.groups.find(g => g.id === groupId);
    if (group) group.members = group.members.filter(id => id !== userId);
    loadGroupSettingsMembers(groupId);
    renderGroups();
    showToast('Member removed', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function transferGroupOwnership(groupId, userId) {
  if (!confirm('Transfer group ownership to this member?')) return;
  try {
    await apiPost(`/api/groups/${groupId}/transfer/${userId}`);
    const group = state.groups.find(g => g.id === groupId);
    if (group) group.ownerId = userId;
    loadGroupSettingsMembers(groupId);
    renderGroups();
    showToast('Group ownership transferred', 'success');
    closeModal('groupSettingsModal');
  } catch (e) { showToast(e.message, 'error'); }
}

async function leaveGroup(groupId) {
  if (!confirm('Leave this group?')) return;
  try {
    await apiPost(`/api/groups/${groupId}/leave`);
    state.groups = state.groups.filter(g => g.id !== groupId);
    renderGroups();
    closeModal('groupSettingsModal');
    showMainApp();
    showToast('Left group', 'info');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== SERVERS =====
async function createServer() {
  const name = document.getElementById('serverNameInput').value.trim();
  if (!name) { showToast('Server name required', 'error'); return; }
  const fileInput = document.getElementById('serverIconInput');
  const formData = new FormData();
  formData.append('name', name);
  if (fileInput.files[0]) formData.append('icon', fileInput.files[0]);
  try {
    const srv = await apiPostForm('/api/servers', formData);
    state.servers.push(srv);
    renderServers();
    closeModal('createServerModal');
    document.getElementById('serverNameInput').value = '';
    document.getElementById('serverIconInput').value = '';
    document.getElementById('serverIconPreview').src = '';
    showToast('Server created', 'success');
    if (state.socket) state.socket.emit('rejoinRooms');
    selectServer(srv.id);
  } catch (e) { showToast(e.message, 'error'); }
}

function renderServers() {
  const container = document.getElementById('serversList');
  if (state.servers.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><p>No servers yet.<br>Create or discover servers.</p></div>';
    return;
  }
  container.innerHTML = state.servers.map(s => {
    const isActive = state.currentServer === s.id;
    const iconHtml = s.icon
      ? `<img class="list-item-icon" src="${assetUrl(s.icon)}" alt="">`
      : `<div class="list-item-icon"><i class="fas fa-server"></i></div>`;
    return `
      <div class="list-item${isActive ? ' active' : ''}" onclick="selectServer('${s.id}')">
        ${iconHtml}
        <div class="list-item-info">
          <div class="list-item-name">${escapeHtml(s.name)}</div>
          <div class="list-item-sub">${s.members.length} members</div>
        </div>
      </div>
    `;
  }).join('');
}

async function openDiscoverServers() {
  try {
    const allServers = await apiGet('/api/servers/all');
    const container = document.getElementById('discoverServersList');
    const discoverable = allServers.filter(s => !s.members.includes(state.user.id));
    if (discoverable.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No servers to discover.</p></div>';
    } else {
      container.innerHTML = discoverable.map(s => `
        <div class="discover-item" onclick="joinServer('${s.id}')">
          ${s.icon ? `<img src="${assetUrl(s.icon)}" alt="">` : '<div class="discover-item-icon"><i class="fas fa-server"></i></div>'}
          <div class="list-item-info">
            <div class="list-item-name">${escapeHtml(s.name)}</div>
            <div class="list-item-sub">${s.members.length} members</div>
          </div>
          <button class="btn-primary" style="padding:6px 12px;font-size:12px">Join</button>
        </div>
      `).join('');
    }
    openModal('discoverServersModal');
  } catch (e) { showToast(e.message, 'error'); }
}

async function joinServer(serverId) {
  try {
    const srv = await apiPost(`/api/servers/${serverId}/join`);
    state.servers.push(srv);
    renderServers();
    closeModal('discoverServersModal');
    showToast('Joined server', 'success');
    if (state.socket) { state.socket.emit('rejoinRooms'); state.socket.emit('authenticate', state.token); }
    selectServer(srv.id);
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== SERVER SETTINGS =====
async function openServerSettings(serverId) {
  const srv = state.servers.find(s => s.id === serverId);
  if (!srv) return;
  state.currentSettingEntityId = serverId;

  // Reset tab to overview
  const modal = document.getElementById('serverSettingsModal');
  modal.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  modal.querySelectorAll('.settings-panel-content').forEach(p => p.classList.remove('active'));
  modal.querySelector('.settings-tab[data-tab="server-overview"]').classList.add('active');
  modal.querySelector('#tab-server-overview').classList.add('active');

  // Populate overview
  document.getElementById('editServerNameInput').value = srv.name || '';
  document.getElementById('editServerDescInput').value = srv.description || '';
  const preview = document.getElementById('editServerIconPreview');
  if (srv.icon) preview.src = assetUrl(srv.icon);
  else preview.src = '';

  const isOwner = srv.ownerId === state.user.id || state.user.isAdmin;
  document.getElementById('saveServerSettingsBtn').style.display = isOwner ? 'block' : 'none';
  document.getElementById('deleteServerSection').style.display = isOwner ? 'flex' : 'none';
  document.getElementById('leaveServerSection').style.display = isOwner ? 'none' : 'flex';

  // Load channels, members, bans
  loadServerSettingsChannels(serverId);
  loadServerSettingsMembers(serverId);
  loadServerSettingsBans(serverId);

  openModal('serverSettingsModal');
}

function loadServerSettingsChannels(serverId) {
  const list = document.getElementById('serverSettingsChannelsList');
  const srv = state.servers.find(s => s.id === serverId);
  if (!srv) return;
  const isOwner = srv.ownerId === state.user.id || state.user.isAdmin;

  list.innerHTML = (srv.channels || []).map(ch => {
    let actions = '';
    if (isOwner) {
      actions = `
        <button class="btn-secondary btn-sm" title="Rename" onclick="renameChannelPrompt('${serverId}','${ch.id}','${escapeHtml(ch.name)}')"><i class="fas fa-edit"></i></button>
        <button class="btn-danger btn-sm" title="Delete" onclick="deleteChannelFromSettings('${serverId}','${ch.id}')"><i class="fas fa-trash"></i></button>
      `;
    }
    return `
      <div class="settings-row-item">
        <div class="settings-row-info">
          <i class="fas fa-hashtag" style="color:var(--primary-light);font-size:16px"></i>
          <span style="font-weight:600;font-size:13px">${escapeHtml(ch.name)}</span>
        </div>
        <div class="settings-row-actions">${actions}</div>
      </div>
    `;
  }).join('');
}

async function renameChannelPrompt(serverId, channelId, currentName) {
  const newName = prompt('Enter new channel name:', currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    const updated = await apiPut(`/api/servers/${serverId}/channels/${channelId}`, { name: newName.trim() });
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) {
      const ch = srv.channels.find(c => c.id === channelId);
      if (ch) ch.name = updated.name;
      renderChannels(srv);
      loadServerSettingsChannels(serverId);
      if (state.currentChat?.targetType === 'server' && state.selectedChannel === channelId) {
        state.currentChat.title = `#${updated.name}`;
        updateChatHeader();
      }
    }
    showToast('Channel renamed', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteChannelFromSettings(serverId, channelId) {
  if (!confirm('Delete this channel?')) return;
  try {
    await apiDelete(`/api/servers/${serverId}/channels/${channelId}`);
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) {
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      renderChannels(srv);
      loadServerSettingsChannels(serverId);
      if (state.selectedChannel === channelId && srv.channels.length > 0) {
        selectChannel(srv.channels[0].id);
      }
    }
    showToast('Channel deleted', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadServerSettingsMembers(serverId) {
  const list = document.getElementById('serverSettingsMembersList');
  list.innerHTML = '<div class="empty-state"><p>Loading members...</p></div>';
  try {
    const members = await apiGet(`/api/servers/${serverId}/members`);
    const srv = state.servers.find(s => s.id === serverId);
    const isOwner = srv && (srv.ownerId === state.user.id || state.user.isAdmin);

    list.innerHTML = members.map(m => {
      let roleBadge = '';
      if (m.isOwner) roleBadge += '<span class="member-badge owner">Owner</span> ';
      if (m.isAdmin && !m.isOwner) roleBadge += '<span class="member-badge admin">Admin</span> ';
      if (m.isVerified) roleBadge += '<i class="fas fa-check-circle verified-badge verified-badge-sm" title="Verified"></i> ';
      if (m.isMuted) roleBadge += '<span class="member-badge muted">Muted</span> ';

      let actions = '';
      if (isOwner && !m.isOwner) {
        actions = `
          <button class="btn-secondary btn-sm" title="${m.isMuted ? 'Unmute' : 'Mute'}" onclick="muteMemberFromSettings('${serverId}','${m.id}')"><i class="fas fa-${m.isMuted ? 'microphone' : 'microphone-slash'}"></i></button>
          ${!m.isAdmin
            ? `<button class="btn-primary btn-sm" title="Grant Server Admin" onclick="grantServerAdmin('${serverId}','${m.id}')"><i class="fas fa-shield-alt"></i></button>`
            : `<button class="btn-secondary btn-sm" title="Revoke Server Admin" onclick="revokeServerAdmin('${serverId}','${m.id}')"><i class="fas fa-shield-alt"></i></button>`
          }
          <button class="btn-danger btn-sm" title="Kick" onclick="kickServerMemberFromSettings('${serverId}','${m.id}')"><i class="fas fa-sign-out-alt"></i></button>
          <button class="btn-danger btn-sm" title="Ban" onclick="banServerMemberFromSettings('${serverId}','${m.id}')"><i class="fas fa-ban"></i></button>
          <button class="btn-secondary btn-sm" title="Transfer Ownership" onclick="transferServerOwnership('${serverId}','${m.id}')"><i class="fas fa-crown"></i></button>
        `;
      }
      return `
        <div class="settings-row-item">
          <div class="settings-row-info">
            <img src="${assetUrl(m.avatar)}" alt="">
            <div>
              <div style="font-weight:600;font-size:13px">${escapeHtml(m.nickname || m.username)} ${roleBadge}</div>
              <div style="font-size:11px;color:var(--text-muted)">@${escapeHtml(m.username)}</div>
            </div>
          </div>
          <div class="settings-row-actions">${actions}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><p>Failed to load members</p></div>';
  }
}

async function muteMemberFromSettings(serverId, userId) {
  await muteMember(serverId, userId);
  loadServerSettingsMembers(serverId);
}

async function kickServerMemberFromSettings(serverId, userId) {
  if (!confirm('Kick this member from the server?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/kick/${userId}`);
    loadServerSettingsMembers(serverId);
    loadServerMembers(serverId);
    showToast('Member kicked', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function banServerMemberFromSettings(serverId, userId) {
  if (!confirm('Ban this member from the server?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/ban/${userId}`);
    loadServerSettingsMembers(serverId);
    loadServerSettingsBans(serverId);
    loadServerMembers(serverId);
    showToast('Member banned', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadServerSettingsBans(serverId) {
  const list = document.getElementById('serverSettingsBansList');
  list.innerHTML = '<div class="empty-state"><p>Loading bans...</p></div>';
  try {
    const bans = await apiGet(`/api/servers/${serverId}/bans`);
    if (bans.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No banned users.</p></div>';
      return;
    }
    list.innerHTML = bans.map(u => `
      <div class="settings-row-item">
        <div class="settings-row-info">
          <img src="${assetUrl(u.avatar)}" alt="">
          <div>
            <div style="font-weight:600;font-size:13px">${escapeHtml(u.nickname || u.username)}</div>
            <div style="font-size:11px;color:var(--text-muted)">@${escapeHtml(u.username)}</div>
          </div>
        </div>
        <div class="settings-row-actions">
          <button class="btn-primary btn-sm" onclick="unbanMember('${serverId}','${u.id}')">Unban</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><p>No banned users.</p></div>';
  }
}

async function unbanMember(serverId, userId) {
  try {
    await apiPost(`/api/servers/${serverId}/unban/${userId}`);
    loadServerSettingsBans(serverId);
    showToast('User unbanned', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function transferServerOwnership(serverId, userId) {
  if (!confirm('Transfer server ownership to this member?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/transfer/${userId}`);
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) srv.ownerId = userId;
    loadServerSettingsMembers(serverId);
    renderServers();
    showToast('Server ownership transferred', 'success');
    closeModal('serverSettingsModal');
  } catch (e) { showToast(e.message, 'error'); }
}

async function leaveServer(serverId) {
  if (!confirm('Leave this server?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/leave`);
    state.servers = state.servers.filter(s => s.id !== serverId);
    renderServers();
    closeModal('serverSettingsModal');
    showMainApp();
    showToast('Left server', 'info');
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveServerSettings() {
  const serverId = state.currentSettingEntityId;
  if (!serverId) return;
  const name = document.getElementById('editServerNameInput').value.trim();
  const description = document.getElementById('editServerDescInput').value.trim();
  const fileInput = document.getElementById('editServerIconInput');

  if (!name) { showToast('Server name required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('description', description);
  if (fileInput.files[0]) formData.append('icon', fileInput.files[0]);

  try {
    const updated = await apiPutForm(`/api/servers/${serverId}`, formData);
    const idx = state.servers.findIndex(s => s.id === serverId);
    if (idx !== -1) state.servers[idx] = updated;
    renderServers();
    if (state.currentChat?.targetType === 'server' && state.currentChat?.targetId === serverId) {
      state.currentChat.serverName = updated.name;
      state.currentChat.avatar = updated.icon;
      updateChatHeader();
    }
    closeModal('serverSettingsModal');
    showToast('Server settings updated', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== CHANNELS =====
function renderChannels(server) {
  const bar = document.getElementById('channelBar');
  const list = document.getElementById('channelsList');
  const addBtn = document.getElementById('addChannelBtn');

  if (!server || state.currentChat?.targetType !== 'server') {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  addBtn.style.display = server.ownerId === state.user.id ? 'flex' : 'none';

  list.innerHTML = (server.channels || []).map(ch => {
    const isActive = state.selectedChannel === ch.id;
    const canDelete = server.ownerId === state.user.id;
    return `
      <div class="channel-item${isActive ? ' active' : ''}" onclick="selectChannel('${ch.id}')">
        <i class="fas fa-hashtag"></i> ${escapeHtml(ch.name)}
        ${canDelete ? `<button class="channel-delete-btn" onclick="event.stopPropagation(); deleteChannel('${server.id}','${ch.id}')" title="Delete Channel"><i class="fas fa-times"></i></button>` : ''}
      </div>
    `;
  }).join('');
}

function selectChannel(channelId) {
  state.selectedChannel = channelId;
  const srv = state.servers.find(s => s.id === state.currentServer);
  if (!srv) return;
  const channel = srv.channels.find(c => c.id === channelId);
  if (!channel) return;

  state.currentChat = {
    targetType: 'server',
    targetId: srv.id,
    channelId,
    title: `#${channel.name}`,
    avatar: srv.icon,
    serverName: srv.name
  };

  updateChatHeader();
  loadMessages('server', srv.id);
  renderChannels(srv);

  // Mobile
  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.add('mobile-hidden');
    document.querySelector('.main-chat').classList.remove('mobile-hidden');
  }
}

async function addChannel() {
  const name = document.getElementById('channelNameInput').value.trim();
  if (!name) { showToast('Channel name required', 'error'); return; }
  if (!state.currentServer) return;
  try {
    const channel = await apiPost(`/api/servers/${state.currentServer}/channels`, { name });
    const srv = state.servers.find(s => s.id === state.currentServer);
    if (srv) {
      srv.channels.push(channel);
      renderChannels(srv);
    }
    closeModal('addChannelModal');
    document.getElementById('channelNameInput').value = '';
    showToast('Channel created', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== SELECT CONVERSATIONS =====
async function selectDM(userId) {
  const friend = state.friends.find(f => f.id === userId);
  if (!friend) return;

  state.currentChat = {
    targetType: 'dm',
    targetId: userId,
    title: friend.nickname || friend.username,
    avatar: friend.avatar
  };
  state.selectedChannel = null;
  state.currentServer = null;

  updateChatHeader();
  document.getElementById('channelBar').style.display = 'none';
  await loadMessages('dm', userId);
  renderFriends();

  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.add('mobile-hidden');
    document.querySelector('.main-chat').classList.remove('mobile-hidden');
  }
}

async function selectGroup(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;

  state.currentChat = {
    targetType: 'group',
    targetId: groupId,
    title: group.name,
    avatar: group.icon
  };
  state.selectedChannel = null;
  state.currentServer = null;

  updateChatHeader();
  document.getElementById('channelBar').style.display = 'none';
  await loadMessages('group', groupId);
  renderGroups();

  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.add('mobile-hidden');
    document.querySelector('.main-chat').classList.remove('mobile-hidden');
  }
}

async function selectServer(serverId) {
  const srv = state.servers.find(s => s.id === serverId);
  if (!srv) return;
  state.currentServer = serverId;

  // Default to first channel
  const firstChannel = srv.channels?.[0];
  if (firstChannel) {
    selectChannel(firstChannel.id);
  } else {
    state.currentChat = { targetType: 'server', targetId: serverId, title: srv.name, avatar: srv.icon };
    updateChatHeader();
  }
  renderServers();
  renderChannels(srv);

  if (window.innerWidth <= 768) {
    document.querySelector('.sidebar').classList.add('mobile-hidden');
    document.querySelector('.main-chat').classList.remove('mobile-hidden');
  }
}

function updateChatHeader() {
  if (!state.currentChat) return;
  document.getElementById('chatTitle').textContent = state.currentChat.title;
  const avatar = document.getElementById('chatAvatar');
  if (state.currentChat.avatar) {
    avatar.src = assetUrl(state.currentChat.avatar);
    avatar.style.display = 'block';
  } else {
    avatar.style.display = 'none';
  }

  // Subtitle & Header Actions
  if (state.currentChat.targetType === 'dm') {
    const friend = state.friends.find(f => f.id === state.currentChat.targetId);
    const isOnline = friend && state.onlineUsers.has(friend.id);
    document.getElementById('chatSubtitle').textContent = isOnline ? 'Online' : 'Offline';
    document.getElementById('chatAdminBadge').style.display = friend?.isAdmin ? 'inline-flex' : 'none';

    const actionsEl = document.getElementById('chatHeaderActions');
    if (state.user?.isAdmin && !friend?.isAdmin) {
      actionsEl.innerHTML = `<button class="btn-icon" title="Grant Admin" onclick="grantAdmin('${friend.id}')"><i class="fas fa-shield-alt"></i></button>`;
    } else {
      actionsEl.innerHTML = '';
    }
    document.getElementById('membersPanel').style.display = 'none';
  } else if (state.currentChat.targetType === 'group') {
    const group = state.groups.find(g => g.id === state.currentChat.targetId);
    document.getElementById('chatSubtitle').textContent = `${group?.members.length || 0} members`;
    document.getElementById('chatAdminBadge').style.display = 'none';
    const actionsEl = document.getElementById('chatHeaderActions');
    actionsEl.innerHTML = `
      <button class="btn-icon" title="Members" onclick="toggleMembersPanel()"><i class="fas fa-users"></i></button>
      <button class="btn-icon" title="Invite Friends" onclick="openGroupInvite('${group.id}')"><i class="fas fa-user-plus"></i></button>
      <button class="btn-icon" title="Group Settings" onclick="openGroupSettings('${group.id}')"><i class="fas fa-cog"></i></button>
    `;
    loadGroupMembers(group.id);
  } else if (state.currentChat.targetType === 'server') {
    const srv = state.servers.find(s => s.id === state.currentChat.targetId);
    document.getElementById('chatSubtitle').textContent = srv?.name || '';
    document.getElementById('chatAdminBadge').style.display = 'none';
    const actionsEl = document.getElementById('chatHeaderActions');
    actionsEl.innerHTML = `
      <button class="btn-icon" title="Members" onclick="toggleMembersPanel()"><i class="fas fa-users"></i></button>
      <button class="btn-icon" title="Server Settings" onclick="openServerSettings('${srv.id}')"><i class="fas fa-cog"></i></button>
    `;
    if (srv) loadServerMembers(srv.id);
  }

  // Show input
  document.getElementById('messageInputBox').style.display = 'flex';
  document.getElementById('messageInput').disabled = false;
  document.getElementById('sendBtn').disabled = false;
}

// ===== MESSAGES =====
async function loadMessages(targetType, targetId) {
  try {
    const channelId = state.selectedChannel ? `?channelId=${state.selectedChannel}` : '';
    const messages = await apiGet(`/api/messages/${targetType}/${targetId}${channelId}`);
    const key = `${targetType}:${targetId}`;
    state.messages[key] = messages;
    renderMessages();
  } catch (e) {
    console.error('Failed to load messages:', e);
    showToast('Failed to load messages', 'error');
  }
}

function getChatKey() {
  if (!state.currentChat) return null;
  return `${state.currentChat.targetType}:${state.currentChat.targetId}`;
}

function sendMessage() {
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message || !state.currentChat) return;

  state.socket.emit('sendMessage', {
    targetType: state.currentChat.targetType,
    targetId: state.currentChat.targetId,
    message,
    replyTo: state.replyTo?.id || null,
    channelId: state.currentChat.channelId || null
  });

  input.value = '';
  cancelReply();
  hideTypingIndicator();
}

async function sendImageMessage() {
  const file = document.getElementById('imageFileInput').files[0];
  if (!file || !state.currentChat) return;

  const formData = new FormData();
  formData.append('image', file);
  try {
    const data = await apiPostForm('/api/messages/upload', formData);
    state.socket.emit('sendImageMessage', {
      targetType: state.currentChat.targetType,
      targetId: state.currentChat.targetId,
      imageUrl: data.imageUrl,
      replyTo: state.replyTo?.id || null,
      channelId: state.currentChat.channelId || null
    });
    document.getElementById('imageFileInput').value = '';
    cancelReply();
  } catch (e) { showToast(e.message, 'error'); }
}

function renderMessages() {
  const container = document.getElementById('messagesArea');
  const key = getChatKey();
  if (!key) return;
  const messages = state.messages[key] || [];

  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-comment-dots"></i><p>No messages yet. Say hello!</p></div>';
    return;
  }

  container.innerHTML = '';
  let lastSenderId = null;

  messages.forEach(msg => {
    const isMine = msg.senderId === state.user.id;
    const isContinued = msg.senderId === lastSenderId;
    lastSenderId = msg.senderId;

    const row = document.createElement('div');
    row.className = `message-row${isContinued ? ' continued' : ''}`;
    row.dataset.messageId = msg.id;

    let html = '';

    // Avatar or time gutter for continued messages
    if (isContinued) {
      html += `<div class="msg-time-gutter" title="${formatFullDateTime(msg.timestamp)}">${formatTime(msg.timestamp)}</div>`;
    } else {
      html += `<img class="msg-avatar" src="${assetUrl(msg.senderAvatar || '')}" onclick="showUserProfile('${msg.senderId}')" alt="">`;
    }

    // Content
    html += '<div class="msg-content">';

    // Header
    if (!isContinued) {
      html += `<div class="msg-header">
        <span class="msg-name" onclick="showUserProfile('${msg.senderId}')">${escapeHtml(msg.senderNickname || msg.senderUsername)}</span>
        ${msg.senderIsAdmin ? '<i class="fas fa-shield-alt msg-admin-icon" title="Admin"></i>' : ''}
        ${msg.senderIsVerified ? '<i class="fas fa-check-circle verified-badge" title="Verified Account"></i>' : ''}
        <span class="msg-time" title="${formatFullDateTime(msg.timestamp)}">${formatTime(msg.timestamp)}</span>
      </div>`;
    }

    // Reply quote (parent message)
    if (msg.replyTo) {
      const parentMsg = messages.find(m => m.id === msg.replyTo.id);
      const isParentDeleted = msg.replyTo.deleted || (parentMsg && parentMsg.deleted);

      if (isParentDeleted) {
        html += `<div class="msg-reply-quote parent-deleted">
          <div class="msg-reply-author"><i class="fas fa-trash-alt"></i> Parent Message Deleted</div>
          <div class="msg-reply-text">The original referenced message was deleted</div>
        </div>`;
      } else {
        html += `<div class="msg-reply-quote" onclick="scrollToMessage('${msg.replyTo.id}')">
          <div class="msg-reply-header-row">
            <span class="msg-reply-author"><i class="fas fa-reply"></i> ${escapeHtml(msg.replyTo.senderUsername || msg.replyTo.author)}</span>
            <div style="display:flex;gap:4px;align-items:center">
              <span class="msg-reply-jump" title="Jump to message"><i class="fas fa-arrow-up"></i></span>
              ${(isMine || state.user?.isAdmin || (parentMsg && parentMsg.senderId === state.user.id)) ? `<button class="btn-delete-parent" title="Delete Parent Message" onclick="event.stopPropagation(); deleteParentMessage('${msg.replyTo.id}')"><i class="fas fa-trash"></i></button>` : ''}
            </div>
          </div>
          <div class="msg-reply-text">${escapeHtml(msg.replyTo.message)}</div>
        </div>`;
      }
    }

    // Message body
    if (msg.deleted) {
      html += `<div class="msg-deleted"><i class="fas fa-ban"></i> This message was deleted <span class="msg-deleted-time" title="${formatFullDateTime(msg.timestamp)}">${formatTime(msg.timestamp)}</span></div>`;
    } else {
      if (msg.message) {
        html += `<div class="msg-bubble">${escapeHtml(msg.message)}${msg.edited ? ' <span class="msg-edited">(edited)</span>' : ''} <span class="msg-bubble-time" title="${formatFullDateTime(msg.timestamp)}">${formatTime(msg.timestamp)}</span></div>`;
      }
      if (msg.image) {
        const imgUrl = assetUrl(msg.image);
        html += `<div class="msg-image-wrapper">
          <img class="msg-image" src="${imgUrl}" onclick="openImageViewer('${imgUrl}')" alt="Image">
          <span class="msg-image-time" title="${formatFullDateTime(msg.timestamp)}">${formatTime(msg.timestamp)}</span>
        </div>`;
      }
    }

    html += '</div>';

    // Actions
    if (!msg.deleted) {
      html += '<div class="message-actions">';
      html += `<button title="Reply" onclick="startReply('${msg.id}')"><i class="fas fa-reply"></i></button>`;
      if (isMine && msg.message) {
        html += `<button title="Edit" onclick="startEdit('${msg.id}')"><i class="fas fa-edit"></i></button>`;
      }
      if (isMine || state.user?.isAdmin) {
        html += `<button class="danger" title="Delete" onclick="deleteMessage('${msg.id}')"><i class="fas fa-trash"></i></button>`;
      }
      html += '</div>';
    }

    row.innerHTML = html;
    container.appendChild(row);
  });

  container.scrollTop = container.scrollHeight;
}

function startReply(messageId) {
  const key = getChatKey();
  const messages = state.messages[key] || [];
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return;

  state.replyTo = { id: messageId, message: msg.message || (msg.image ? '[Image]' : ''), author: msg.senderNickname || msg.senderUsername };
  state.editingMessage = null;

  document.getElementById('replyPreviewAuthor').textContent = state.replyTo.author;
  document.getElementById('replyPreviewMessage').textContent = state.replyTo.message;
  document.getElementById('replyPreview').style.display = 'flex';
  document.getElementById('editPreview').style.display = 'none';

  document.getElementById('messageInput').focus();
}

function cancelReply() {
  state.replyTo = null;
  document.getElementById('replyPreview').style.display = 'none';
}

function startEdit(messageId) {
  const key = getChatKey();
  const messages = state.messages[key] || [];
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return;

  state.editingMessage = messageId;
  state.replyTo = null;

  document.getElementById('editPreview').style.display = 'flex';
  document.getElementById('replyPreview').style.display = 'none';
  document.getElementById('messageInput').value = msg.message || '';
  document.getElementById('messageInput').focus();
}

function cancelEdit() {
  state.editingMessage = null;
  document.getElementById('editPreview').style.display = 'none';
  document.getElementById('messageInput').value = '';
}

function confirmEdit() {
  const newText = document.getElementById('messageInput').value.trim();
  if (!newText || !state.editingMessage) return;

  state.socket.emit('editMessage', { messageId: state.editingMessage, newText });
  document.getElementById('messageInput').value = '';
  cancelEdit();
}

function deleteMessage(messageId) {
  if (!confirm('Delete this message?')) return;
  state.socket.emit('deleteMessage', { messageId });
}

function deleteParentMessage(parentMessageId) {
  if (!confirm('Delete this referenced parent message?')) return;
  state.socket.emit('deleteMessage', { messageId: parentMessageId });
}

function scrollToMessage(messageId) {
  const el = document.querySelector(`.message-row[data-message-id="${messageId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.background = 'rgba(99,102,241,0.15)';
    setTimeout(() => el.style.background = '', 1500);
  }
}

// ===== IMAGE VIEWER =====
function openImageViewer(url) {
  document.getElementById('fullImageView').src = url;
  document.getElementById('imageViewerModal').classList.add('active');
}

// ===== USER PROFILE =====
async function showUserProfile(userId) {
  try {
    const user = await apiGet(`/api/users/${userId}`);
    const body = document.getElementById('userProfileBody');
    const isFriend = state.friends.find(f => f.id === userId);
    const isMe = userId === state.user?.id;
    const canManage = state.user?.isAdmin && !isMe;

    const verifiedBadge = user.isVerified
      ? `<span class="profile-verified-badge" title="Verified Account"><i class="fas fa-check-circle"></i> Verified</span>`
      : '';

    body.innerHTML = `
      <img class="user-profile-avatar" src="${assetUrl(user.avatar)}" alt="">
      <div class="user-profile-name">${escapeHtml(user.nickname || user.username)} ${verifiedBadge}</div>
      <div class="user-profile-username">@${escapeHtml(user.username)}${user.isAdmin ? ' <i class="fas fa-shield-alt" style="color:var(--warning)"></i>' : ''}</div>
      ${user.description ? `<div class="user-profile-desc">${escapeHtml(user.description)}</div>` : ''}
      <div class="user-profile-actions">
        ${isFriend ? `<button class="btn-icon" title="Message" onclick="closeModal('userProfileModal');selectDM('${userId}')"><i class="fas fa-comment"></i></button>` : ''}
        ${canManage ? `
          <div class="profile-admin-actions">
            ${!user.isAdmin
              ? `<button class="btn-primary profile-action-btn" onclick="grantAdmin('${userId}')"><i class="fas fa-shield-alt"></i> Grant Admin</button>`
              : `<button class="btn-secondary profile-action-btn" onclick="revokeAdmin('${userId}')"><i class="fas fa-shield-alt"></i> Revoke Admin</button>`
            }
            ${!user.isVerified
              ? `<button class="btn-verified profile-action-btn" onclick="verifyUser('${userId}')"><i class="fas fa-check-circle"></i> Verify</button>`
              : `<button class="btn-secondary profile-action-btn" onclick="unverifyUser('${userId}')"><i class="fas fa-times-circle"></i> Unverify</button>`
            }
          </div>
        ` : ''}
      </div>
    `;
    openModal('userProfileModal');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== ADMIN =====
async function grantAdmin(userId) {
  try {
    await apiPost(`/api/admin/grant/${userId}`);
    showToast('Admin access granted ✓', 'success');
    await loadCurrentUser();
    closeModal('userProfileModal');
    // Re-open profile with updated data
    showUserProfile(userId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function revokeAdmin(userId) {
  if (!confirm('Revoke admin privileges from this user?')) return;
  try {
    await apiPost(`/api/admin/revoke/${userId}`);
    showToast('Admin access revoked', 'success');
    closeModal('userProfileModal');
    showUserProfile(userId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function verifyUser(userId) {
  try {
    await apiPost(`/api/admin/verify/${userId}`);
    showToast('User verified ✓', 'success');
    closeModal('userProfileModal');
    showUserProfile(userId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function unverifyUser(userId) {
  if (!confirm('Remove verification from this user?')) return;
  try {
    await apiPost(`/api/admin/unverify/${userId}`);
    showToast('User unverified', 'success');
    closeModal('userProfileModal');
    showUserProfile(userId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function grantServerAdmin(serverId, userId) {
  try {
    await apiPost(`/api/servers/${serverId}/admin/grant/${userId}`);
    showToast('Server admin granted ✓', 'success');
    loadServerSettingsMembers(serverId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function revokeServerAdmin(serverId, userId) {
  if (!confirm('Revoke server admin from this user?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/admin/revoke/${userId}`);
    showToast('Server admin revoked', 'success');
    loadServerSettingsMembers(serverId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function grantGroupAdmin(groupId, userId) {
  try {
    await apiPost(`/api/groups/${groupId}/admin/grant/${userId}`);
    showToast('Group admin granted ✓', 'success');
    loadGroupSettingsMembers(groupId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function revokeGroupAdmin(groupId, userId) {
  if (!confirm('Revoke group admin from this user?')) return;
  try {
    await apiPost(`/api/groups/${groupId}/admin/revoke/${userId}`);
    showToast('Group admin revoked', 'success');
    loadGroupSettingsMembers(groupId);
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== GROUP INVITE =====
async function openGroupInvite(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const friendsNotInGroup = state.friends.filter(f => !group.members.includes(f.id));
  if (friendsNotInGroup.length === 0) {
    showToast('All your friends are already in this group', 'info');
    return;
  }
  const modalHtml = `
    <div class="modal-overlay active" id="groupInviteModal">
      <div class="modal">
        <div class="modal-header">
          <h3>Invite to ${escapeHtml(group.name)}</h3>
          <button class="btn-icon modal-close" onclick="document.getElementById('groupInviteModal').remove()"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          ${friendsNotInGroup.map(f => `
            <div class="list-item">
              <img class="list-item-avatar" src="${assetUrl(f.avatar)}" alt="">
              <div class="list-item-info">
                <div class="list-item-name">${escapeHtml(f.nickname || f.username)}</div>
                <div class="list-item-sub">@${escapeHtml(f.username)}</div>
              </div>
              <button class="btn-primary" style="padding:6px 12px;font-size:12px" onclick="inviteToGroup('${groupId}','${f.id}',this)">Invite</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  document.getElementById('groupInviteModal').addEventListener('click', (e) => {
    if (e.target.id === 'groupInviteModal') e.target.remove();
  });
}

async function inviteToGroup(groupId, userId, btn) {
  try {
    await apiPost(`/api/groups/${groupId}/invite/${userId}`);
    const group = state.groups.find(g => g.id === groupId);
    if (group && !group.members.includes(userId)) group.members.push(userId);
    btn.textContent = 'Invited';
    btn.disabled = true;
    showToast('Friend invited to group', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== MEMBERS PANEL =====
function toggleMembersPanel() {
  const panel = document.getElementById('membersPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

async function loadServerMembers(serverId) {
  try {
    const members = await apiGet(`/api/servers/${serverId}/members`);
    renderMembers(members, 'server', serverId);
  } catch (e) { console.error('Failed to load members', e); }
}

async function loadGroupMembers(groupId) {
  try {
    const members = await apiGet(`/api/groups/${groupId}/members`);
    renderMembers(members, 'group', groupId);
  } catch (e) { console.error('Failed to load members', e); }
}

function renderMembers(members, type, entityId) {
  const list = document.getElementById('membersList');
  const srv = type === 'server' ? state.servers.find(s => s.id === entityId) : null;
  const group = type === 'group' ? state.groups.find(g => g.id === entityId) : null;
  const isOwner = (srv && srv.ownerId === state.user.id) || (group && group.ownerId === state.user.id) || state.user?.isAdmin;

  list.innerHTML = members.map(m => {
    let badges = '';
    if (m.isOwner) badges += '<span class="member-badge owner">Owner</span>';
    if (m.isAdmin && !m.isOwner) badges += '<span class="member-badge admin">Admin</span>';
    if (m.isMuted) badges += '<span class="member-badge muted">Muted</span>';

    let actions = '';
    if (isOwner && !m.isOwner) {
      if (type === 'server') {
        actions = `
          <div class="member-actions">
            <button class="warn" title="${m.isMuted ? 'Unmute' : 'Mute'}" onclick="muteMember('${entityId}','${m.id}')"><i class="fas fa-${m.isMuted ? 'microphone' : 'microphone-slash'}"></i></button>
            <button class="danger" title="Kick" onclick="kickMember('${entityId}','${m.id}','server')"><i class="fas fa-sign-out-alt"></i></button>
            <button class="danger" title="Ban" onclick="banMember('${entityId}','${m.id}')"><i class="fas fa-ban"></i></button>
          </div>`;
      } else {
        actions = `
          <div class="member-actions">
            <button class="danger" title="Kick" onclick="kickMember('${entityId}','${m.id}','group')"><i class="fas fa-sign-out-alt"></i></button>
          </div>`;
      }
    }

    return `
      <div class="member-item">
        <img class="member-item-avatar" src="${assetUrl(m.avatar)}" alt="">
        <div class="member-item-info">
          <div class="member-item-name">${escapeHtml(m.nickname || m.username)} ${badges}</div>
          <div class="member-item-role">@${escapeHtml(m.username)}</div>
        </div>
        ${actions}
      </div>
    `;
  }).join('');
}

// ===== MODERATION =====
async function deleteServer(serverId) {
  if (!confirm('Delete this server? All channels and messages will be lost.')) return;
  try {
    await apiDelete(`/api/servers/${serverId}`);
    state.servers = state.servers.filter(s => s.id !== serverId);
    showToast('Server deleted', 'success');
    switchPanel('servers');
    renderServers();
    showMainApp();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteGroup(groupId) {
  if (!confirm('Delete this group? All messages will be lost.')) return;
  try {
    await apiDelete(`/api/groups/${groupId}`);
    state.groups = state.groups.filter(g => g.id !== groupId);
    showToast('Group deleted', 'success');
    switchPanel('groups');
    renderGroups();
    showMainApp();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteChannel(serverId, channelId) {
  if (!confirm('Delete this channel? Messages will be lost.')) return;
  try {
    await apiDelete(`/api/servers/${serverId}/channels/${channelId}`);
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) srv.channels = srv.channels.filter(c => c.id !== channelId);
    showToast('Channel deleted', 'success');
    if (srv && srv.channels.length > 0) {
      selectChannel(srv.channels[0].id);
    }
  } catch (e) { showToast(e.message, 'error'); }
}

async function kickMember(entityId, userId, type) {
  if (!confirm('Kick this user?')) return;
  try {
    if (type === 'server') {
      await apiPost(`/api/servers/${entityId}/kick/${userId}`);
      loadServerMembers(entityId);
    } else {
      await apiPost(`/api/groups/${entityId}/kick/${userId}`);
      loadGroupMembers(entityId);
    }
    showToast('User kicked', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function banMember(serverId, userId) {
  if (!confirm('Ban this user from the server?')) return;
  try {
    await apiPost(`/api/servers/${serverId}/ban/${userId}`);
    loadServerMembers(serverId);
    showToast('User banned', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function muteMember(serverId, userId) {
  try {
    const srv = state.servers.find(s => s.id === serverId);
    const isMuted = (srv?.mutedUsers || []).includes(userId);
    if (isMuted) {
      await apiPost(`/api/servers/${serverId}/unmute/${userId}`);
      showToast('User unmuted', 'success');
    } else {
      await apiPost(`/api/servers/${serverId}/mute/${userId}`);
      showToast('User muted', 'success');
    }
    loadServerMembers(serverId);
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== SOCKET.IO =====
function initSocket() {
  state.socket = io(API_URL);

  state.socket.on('connect', () => {
    state.socket.emit('authenticate', state.token);
  });

  state.socket.on('onlineUsers', (userIdList) => {
    state.onlineUsers = new Set(userIdList);
    renderFriends();
    if (state.currentChat?.targetType === 'dm') updateChatHeader();
  });

  state.socket.on('userOnline', (data) => {
    state.onlineUsers.add(data.userId);
    renderFriends();
  });

  state.socket.on('userOffline', (data) => {
    state.onlineUsers.delete(data.userId);
    renderFriends();
  });

  state.socket.on('newMessage', (msg) => {
    if (msg.senderId !== state.user.id) {
      playNotificationChime();
    }

    if (!state.currentChat) return;

    // For DMs
    if (msg.targetType === 'dm') {
      const otherId = msg.senderId === state.user.id ? msg.targetId : msg.senderId;
      const key = `dm:${otherId}`;
      if (!state.messages[key]) state.messages[key] = [];
      if (!state.messages[key].find(m => m.id === msg.id)) {
        state.messages[key].push(msg);
      }
      if (state.currentChat.targetType === 'dm' && state.currentChat.targetId === otherId) {
        renderMessages();
      }
      return;
    }

    // For group/server
    if (msg.targetType !== state.currentChat.targetType || msg.targetId !== state.currentChat.targetId) return;
    if (msg.targetType === 'server' && state.currentChat.channelId && msg.channelId !== state.currentChat.channelId) return;

    const key = `${msg.targetType}:${msg.targetId}`;
    if (!state.messages[key]) state.messages[key] = [];
    if (!state.messages[key].find(m => m.id === msg.id)) {
      state.messages[key].push(msg);
    }
    renderMessages();
  });

  state.socket.on('messageUpdated', (data) => {
    const key = getChatKey();
    if (!key) return;
    const messages = state.messages[key] || [];
    const msg = messages.find(m => m.id === data.id);
    if (msg) {
      msg.message = data.message;
      msg.edited = true;
      renderMessages();
    }
  });

  state.socket.on('messageDeleted', (data) => {
    const key = getChatKey();
    if (!key) return;
    const messages = state.messages[key] || [];
    const msg = messages.find(m => m.id === data.id);
    if (msg) {
      msg.deleted = true;
      msg.message = null;
      msg.image = null;
    }
    // Update any messages that replied to this parent message
    messages.forEach(m => {
      if (m.replyTo && m.replyTo.id === data.id) {
        m.replyTo.deleted = true;
        m.replyTo.message = 'Original message was deleted';
      }
    });
    renderMessages();
  });

  state.socket.on('newFriendRequest', (data) => {
    showToast(`Friend request from ${data.fromUser.nickname || data.fromUser.username}`, 'info');
    loadFriendRequests();
    playNotificationChime();
  });

  state.socket.on('friendRequestAccepted', (data) => {
    showToast(`${data.user.nickname || data.user.username} accepted your friend request`, 'success');
    loadFriends();
    playNotificationChime();
  });

  state.socket.on('adminGranted', (data) => {
    showToast('🛡️ You have been granted admin access', 'success');
    loadCurrentUser();
  });

  state.socket.on('adminRevoked', (data) => {
    if (data.userId === state.user?.id) {
      showToast('Your admin access has been revoked', 'info');
      loadCurrentUser();
    }
  });

  state.socket.on('userVerified', (data) => {
    if (data.userId === state.user?.id) {
      showToast('✓ Your account has been verified!', 'success');
      loadCurrentUser();
    }
  });

  state.socket.on('addedToGroup', (data) => {
    showToast(`You were added to group: ${data.group.name}`, 'success');
    loadGroups();
    if (state.socket) state.socket.emit('rejoinRooms');
    playNotificationChime();
  });

  state.socket.on('removedFromServer', (data) => {
    state.servers = state.servers.filter(s => s.id !== data.serverId);
    showToast(data.banned ? `You were banned from ${data.serverName}` : `You were removed from ${data.serverName}`, data.banned ? 'error' : 'info');
    if (state.currentChat?.targetType === 'server' && state.currentChat?.targetId === data.serverId) {
      showMainApp();
    }
    renderServers();
  });

  state.socket.on('mutedInServer', (data) => {
    showToast(`You were muted in ${data.serverName}`, 'info');
  });

  state.socket.on('userTyping', (data) => {
    if (!state.currentChat) return;
    if (data.targetType !== state.currentChat.targetType || data.targetId !== state.currentChat.targetId) return;
    if (data.targetType === 'dm' && data.userId !== state.currentChat.targetId) return;
    showTypingIndicator(data.username);
  });

  state.socket.on('userStoppedTyping', (data) => {
    if (!state.currentChat) return;
    if (data.targetType !== state.currentChat.targetType || data.targetId !== state.currentChat.targetId) return;
    hideTypingIndicator();
  });
}

// ===== TYPING =====
function showTypingIndicator(username) {
  const indicator = document.getElementById('typingIndicator');
  indicator.classList.add('active');
  indicator.innerHTML = `<div class="typing-dots"><span>${escapeHtml(username)} is typing</span><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  indicator.classList.remove('active');
  indicator.innerHTML = '';
}

// ===== MODALS =====
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  if (id === 'addFriendModal') {
    renderFriendRequests();
    document.getElementById('friendSearchInput').focus();
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.opacity = '0';
  const modalBox = el.querySelector('.modal');
  if (modalBox) modalBox.style.transform = 'scale(0.92) translateY(12px)';
  setTimeout(() => {
    el.classList.remove('active');
    el.style.opacity = '';
    if (modalBox) modalBox.style.transform = '';
  }, 220);
}

// ===== HELPERS =====
function previewIcon(e, previewId) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (ev) => { document.getElementById(previewId).src = ev.target.result; };
    reader.readAsDataURL(file);
  }
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function formatFullDateTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function showToast(message, type = 'info') {
  if (state.preferences.toastEnabled === false && type !== 'error') return;
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle';
  toast.innerHTML = `<i class="fas fa-${icon}"></i> ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%) scale(0.9)';
    toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showPanel(nav) {
  switchPanel(nav);
}

function showMainApp() {
  state.currentChat = null;
  state.selectedChannel = null;
  state.currentServer = null;
  const channelBar = document.getElementById('channelBar');
  if (channelBar) channelBar.style.display = 'none';
  const headerAvatar = document.getElementById('chatAvatar');
  if (headerAvatar) headerAvatar.style.display = 'none';
  const chatTitle = document.getElementById('chatTitle');
  if (chatTitle) chatTitle.textContent = 'Select a conversation';
  const chatSubtitle = document.getElementById('chatSubtitle');
  if (chatSubtitle) chatSubtitle.textContent = '';
  const adminBadge = document.getElementById('chatAdminBadge');
  if (adminBadge) adminBadge.style.display = 'none';
  const actionsEl = document.getElementById('chatHeaderActions');
  if (actionsEl) actionsEl.innerHTML = '';
  const inputBox = document.getElementById('messageInputBox');
  if (inputBox) inputBox.style.display = 'none';
  const membersPanel = document.getElementById('membersPanel');
  if (membersPanel) membersPanel.style.display = 'none';
  const messagesArea = document.getElementById('messagesArea');
  if (messagesArea) {
    messagesArea.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><p>Select a friend, group, or server to start messaging</p></div>';
  }
}

function openChat(type, targetId, channelId) {
  if (type === 'server') {
    state.currentServer = targetId;
    if (channelId) selectChannel(channelId);
    else selectServer(targetId);
  } else if (type === 'group') {
    selectGroup(targetId);
  } else if (type === 'dm') {
    selectDM(targetId);
  }
}
