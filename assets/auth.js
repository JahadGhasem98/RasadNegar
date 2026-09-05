/* Auth gate: username/password, first-admin bootstrap, forced password change, admin user management. */
(() => {
  'use strict';

  const AUTH_CONFIG = Object.freeze({
    usersPath: 'auth/users.json',
    servicePath: 'auth/service.json',
    sessionKey: 'atlas_f70_auth_session_v1',
    tokenKey: 'atlas_f70_service_token_v1',
    localUsersKey: 'atlas_f70_users_local_v1',
    pbkdf2Iterations: 120000,
  });

  function storage() {
    if (!window.AtlasStorage) throw new Error('ماژول ذخیره‌سازی بارگذاری نشده است.');
    return window.AtlasStorage;
  }

  const SPECIAL_CHARS = '!@#$%^&*_+';
  const SPECIAL_CHARS_HINT = '(!@#$%^&*_+...)';
  const DEFAULT_NEW_USER_PASSWORD = '12345@Qaz';

  const $ = id => document.getElementById(id);

  let projectId = null;
  let serviceToken = sessionStorage.getItem(AUTH_CONFIG.tokenKey) || '';
  let session = null;
  let usersDoc = null;
  let usersSha = null;
  let serviceSha = null;
  let busy = false;

  function showAuthMessage(text, kind = 'info') {
    const el = $('auth-message');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind;
    el.hidden = !text;
  }

  function showAdminMessage(text, kind = 'info') {
    const el = $('admin-message');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind;
    el.hidden = !text;
  }

  function setBusy(state) {
    busy = !!state;
    document.querySelectorAll('#auth-gate button, #auth-gate input, #auth-gate select').forEach(el => {
      el.disabled = !!state;
    });
  }

  function setAdminBusy(state) {
    busy = !!state;
    document.querySelectorAll('#admin-panel button, #admin-panel input, #admin-panel select').forEach(el => {
      el.disabled = !!state;
    });
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      return 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
    }
    if (!/[a-z]/.test(password)) return 'رمز عبور باید حداقل یک حرف کوچک انگلیسی داشته باشد.';
    if (!/[A-Z]/.test(password)) return 'رمز عبور باید حداقل یک حرف بزرگ انگلیسی داشته باشد.';
    if (!/[0-9]/.test(password)) return 'رمز عبور باید حداقل یک عدد داشته باشد.';
    if (![...SPECIAL_CHARS].some(ch => password.includes(ch))) {
      return `رمز عبور باید حداقل یکی از نویسه‌های ویژه را داشته باشد: ${SPECIAL_CHARS_HINT}`;
    }
    return '';
  }

  function normalizeUsername(value) {
    const username = String(value || '').trim();
    if (username.length < 2 || username.length > 64) {
      throw new Error('نام کاربری باید بین ۲ تا ۶۴ کاراکتر باشد.');
    }
    if (/[\u0000-\u001f\u007f\\/]/.test(username)) {
      throw new Error('نام کاربری نمی‌تواند شامل نویسه‌های کنترلی یا / و \\ باشد.');
    }
    return username;
  }

  function explain(error) {
    try {
      if (window.AtlasStorage) return storage().explain(error);
    } catch { /* ignore */ }
    return (error && error.message) || String(error || 'خطای ناشناخته');
  }

  function isApiError(error) {
    return !!(error && typeof error.status === 'number');
  }

  async function ensureProjectId() {
    if (projectId) return projectId;
    const info = await storage().ensureProject(serviceToken);
    projectId = info.id;
    return projectId;
  }

  async function readRepoFile(path) {
    const file = await storage().readFile(path, serviceToken);
    if (!file) return null;
    return { text: file.text, lastCommitId: file.sha };
  }

  async function writeRepoFile(path, content, commitMessage, lastCommitId) {
    const result = await storage().writeFile(path, content, commitMessage, lastCommitId, serviceToken);
    return { text: content, lastCommitId: result.sha };
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function hashPassword(password, saltBase64) {
    const salt = saltBase64
      ? new Uint8Array(base64ToBuffer(saltBase64))
      : crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: AUTH_CONFIG.pbkdf2Iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    return {
      hash: bufferToBase64(bits),
      salt: bufferToBase64(salt.buffer),
    };
  }

  async function verifyPassword(password, user) {
    const result = await hashPassword(password, user.salt);
    return result.hash === user.passwordHash;
  }

  function emptyUsersDoc() {
    return { schemaVersion: 1, users: [] };
  }

  function loadUsersLocal() {
    try {
      const raw = localStorage.getItem(AUTH_CONFIG.localUsersKey);
      if (!raw) return emptyUsersDoc();
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.users)) return emptyUsersDoc();
      return parsed;
    } catch {
      return emptyUsersDoc();
    }
  }

  function saveUsersLocal() {
    localStorage.setItem(AUTH_CONFIG.localUsersKey, JSON.stringify(usersDoc));
  }

  async function loadUsers() {
    // Always start from local so login works offline / without working remote token.
    const local = loadUsersLocal();
    usersDoc = local;
    usersSha = null;

    if (!serviceToken) {
      return usersDoc;
    }

    try {
      await ensureProjectId();
      const file = await readRepoFile(AUTH_CONFIG.usersPath);
      if (!file) {
        // Remote empty: keep local users (important after first setup before first sync)
        return usersDoc;
      }
      const parsed = JSON.parse(file.text);
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.users)) {
        console.warn('remote users.json invalid; using local');
        return usersDoc;
      }
      // Prefer remote if it has users; otherwise keep local
      if (parsed.users.length) {
        usersDoc = parsed;
        usersSha = file.lastCommitId;
        saveUsersLocal();
      }
      return usersDoc;
    } catch (error) {
      // Remote failure must never block login
      console.warn('loadUsers remote failed', error);
      usersDoc = loadUsersLocal();
      usersSha = null;
      return usersDoc;
    }
  }

  async function saveUsers(message) {
    saveUsersLocal();
    if (!serviceToken) return;
    try {
      const content = `${JSON.stringify(usersDoc, null, 2)}\n`;
      const fresh = await writeRepoFile(AUTH_CONFIG.usersPath, content, message, usersSha);
      usersSha = fresh ? fresh.lastCommitId : null;
    } catch {
      // Keep local copy; sync when token/network is available.
    }
  }

  async function loadServiceTokenFromRepo() {
    await ensureProjectId();
    const file = await readRepoFile(AUTH_CONFIG.servicePath);
    if (!file) {
      serviceSha = null;
      return '';
    }
    const parsed = JSON.parse(file.text);
    serviceSha = file.lastCommitId;
    return typeof parsed.token === 'string' ? parsed.token : '';
  }

  async function saveServiceToken(token) {
    const payload = `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`;
    await writeRepoFile(AUTH_CONFIG.servicePath, payload, 'chore(auth): update service token', serviceSha);
    const fresh = await readRepoFile(AUTH_CONFIG.servicePath);
    serviceSha = fresh ? fresh.lastCommitId : null;
    serviceToken = token;
    sessionStorage.setItem(AUTH_CONFIG.tokenKey, token);
    if (window.AtlasStorage) storage().setToken(token);
  }

  function persistSession(user) {
    session = {
      username: user.username,
      role: user.role,
      mustChangePassword: !!user.mustChangePassword,
    };
    sessionStorage.setItem(AUTH_CONFIG.sessionKey, JSON.stringify(session));
  }

  function clearSession() {
    session = null;
    sessionStorage.removeItem(AUTH_CONFIG.sessionKey);
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(AUTH_CONFIG.sessionKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.username || !data.role) return null;
      return data;
    } catch {
      return null;
    }
  }

  function showPanel(name) {
    $('auth-login-panel').hidden = name !== 'login';
    $('auth-setup-panel').hidden = name !== 'setup';
    $('auth-change-panel').hidden = name !== 'change';
    if ($('auth-service-panel')) $('auth-service-panel').hidden = name !== 'service';
    $('auth-gate').hidden = false;
    $('app-shell').hidden = true;
  }

  function enterApp() {
    $('auth-gate').hidden = true;
    $('app-shell').hidden = false;
    document.dispatchEvent(new CustomEvent('atlas-auth-ready', {
      detail: {
        username: session.username,
        role: session.role,
        token: serviceToken,
      },
    }));
  }

  async function requireServiceToken(candidate) {
    const value = (candidate || serviceToken || '').trim();
    if (!value) throw new Error('توکن سرویس را وارد کنید.');
    serviceToken = value;
    storage().setToken(value);
    sessionStorage.setItem(AUTH_CONFIG.tokenKey, value);
    projectId = null;
    await ensureProjectId();
    return value;
  }

  function requireAdmin() {
    if (!session || session.role !== 'admin') throw new Error('فقط مدیریت به این بخش دسترسی دارد.');
  }

  function publicUser(user) {
    return {
      username: user.username,
      role: user.role,
      active: user.active !== false,
      mustChangePassword: !!user.mustChangePassword,
      createdAt: user.createdAt || '',
      createdBy: user.createdBy || '',
      passwordChangedAt: user.passwordChangedAt || '',
    };
  }

  function countActiveAdmins() {
    return usersDoc.users.filter(u => u.role === 'admin' && u.active !== false).length;
  }

  async function listUsers() {
    requireAdmin();
    await loadUsers();
    return usersDoc.users
      .map(publicUser)
      .sort((a, b) => a.username.localeCompare(b.username, 'en'));
  }

  async function createUser({ username, password, role }) {
    requireAdmin();
    const normalized = normalizeUsername(username);
    const nextRole = role === 'admin' ? 'admin' : 'member';
    const finalPassword = (password && String(password).trim()) || DEFAULT_NEW_USER_PASSWORD;
    const passwordError = validatePassword(finalPassword);
    if (passwordError) throw new Error(passwordError);

    await loadUsers();
    if (usersDoc.users.some(u => u.username === normalized)) {
      throw new Error('این نام کاربری قبلاً ثبت شده است.');
    }

    const hashed = await hashPassword(finalPassword);
    usersDoc.users.push({
      username: normalized,
      passwordHash: hashed.hash,
      salt: hashed.salt,
      role: nextRole,
      mustChangePassword: true,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: session.username,
    });
    await saveUsers(`chore(auth): create ${nextRole} (${normalized})`);
    return publicUser(usersDoc.users.find(u => u.username === normalized));
  }

  async function resetUserPassword(username, newPassword) {
    requireAdmin();
    const normalized = normalizeUsername(username);
    const passwordError = validatePassword(newPassword);
    if (passwordError) throw new Error(passwordError);

    await loadUsers();
    const user = usersDoc.users.find(u => u.username === normalized);
    if (!user) throw new Error('کاربر پیدا نشد.');

    const hashed = await hashPassword(newPassword);
    user.passwordHash = hashed.hash;
    user.salt = hashed.salt;
    user.mustChangePassword = true;
    user.passwordChangedAt = new Date().toISOString();
    await saveUsers(`chore(auth): reset password (${normalized})`);
    return publicUser(user);
  }

  async function setUserActive(username, active) {
    requireAdmin();
    const normalized = normalizeUsername(username);
    await loadUsers();
    const user = usersDoc.users.find(u => u.username === normalized);
    if (!user) throw new Error('کاربر پیدا نشد.');
    if (user.username === session.username && !active) {
      throw new Error('نمی‌توانید حساب خودتان را غیرفعال کنید.');
    }
    if (user.role === 'admin' && user.active !== false && !active && countActiveAdmins() <= 1) {
      throw new Error('حداقل یک ادمین فعال باید باقی بماند.');
    }
    user.active = !!active;
    await saveUsers(`chore(auth): ${active ? 'activate' : 'deactivate'} (${normalized})`);
    return publicUser(user);
  }

  async function setUserRole(username, role) {
    requireAdmin();
    const normalized = normalizeUsername(username);
    const nextRole = role === 'admin' ? 'admin' : 'member';
    await loadUsers();
    const user = usersDoc.users.find(u => u.username === normalized);
    if (!user) throw new Error('کاربر پیدا نشد.');
    if (user.username === session.username && nextRole !== 'admin') {
      throw new Error('نمی‌توانید نقش ادمین خودتان را حذف کنید.');
    }
    if (user.role === 'admin' && nextRole !== 'admin' && user.active !== false && countActiveAdmins() <= 1) {
      throw new Error('حداقل یک ادمین فعال باید باقی بماند.');
    }
    user.role = nextRole;
    await saveUsers(`chore(auth): set role ${nextRole} (${normalized})`);
    return publicUser(user);
  }

  async function deleteUser(username) {
    requireAdmin();
    const normalized = normalizeUsername(username);
    await loadUsers();
    const index = usersDoc.users.findIndex(u => u.username === normalized);
    if (index < 0) throw new Error('کاربر پیدا نشد.');
    const user = usersDoc.users[index];
    if (user.username === session.username) {
      throw new Error('نمی‌توانید حساب خودتان را حذف کنید.');
    }
    if (user.role === 'admin' && user.active !== false && countActiveAdmins() <= 1) {
      throw new Error('حداقل یک ادمین فعال باید باقی بماند.');
    }
    usersDoc.users.splice(index, 1);
    await saveUsers(`chore(auth): delete user (${normalized})`);
    return true;
  }

  async function updateServiceTokenFromAdmin(tokenValue, providerId) {
    requireAdmin();
    const value = String(tokenValue || '').trim();
    if (!value) throw new Error('توکن سرویس را وارد کنید.');
    if (providerId) storage().setProviderId(providerId);
    await requireServiceToken(value);
    await saveServiceToken(value);
    await loadUsers();
    await saveUsers('chore(auth): sync users after service token set');
    document.dispatchEvent(new CustomEvent('atlas-service-token-updated', {
      detail: { token: value, provider: storage().getProviderId() },
    }));
    return true;
  }

  function renderAdminUsers(users) {
    const list = $('admin-user-list');
    const empty = $('admin-user-empty');
    const query = ($('admin-user-search')?.value || '').trim().toLowerCase();
    if (!list) return;
    list.replaceChildren();
    const filtered = (users || []).filter(u => !query || u.username.includes(query) || u.role.includes(query));
    if (empty) empty.hidden = filtered.length > 0;
    for (const user of filtered) {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      row.dataset.username = user.username;

      const main = document.createElement('div');
      main.className = 'admin-user-main';
      const title = document.createElement('strong');
      title.dir = 'ltr';
      title.textContent = user.username;
      const meta = document.createElement('span');
      meta.textContent = [
        user.role === 'admin' ? 'مدیر' : 'عضو',
        user.active ? 'فعال' : 'غیرفعال',
        user.mustChangePassword ? 'نیاز به تغییر رمز' : 'رمز تأییدشده',
      ].join(' · ');
      main.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';

      const roleBtn = document.createElement('button');
      roleBtn.type = 'button';
      roleBtn.className = 'btn-secondary';
      roleBtn.textContent = user.role === 'admin' ? 'تبدیل به عضو' : 'تبدیل به مدیر';
      roleBtn.addEventListener('click', () => {
        withAdminBusy(async () => {
          await setUserRole(user.username, user.role === 'admin' ? 'member' : 'admin');
          showAdminMessage(`نقش «${user.username}» به‌روز شد.`, 'success');
          await refreshAdminPanel();
        });
      });

      const activeBtn = document.createElement('button');
      activeBtn.type = 'button';
      activeBtn.className = 'btn-secondary';
      activeBtn.textContent = user.active ? 'غیرفعال' : 'فعال‌سازی';
      activeBtn.addEventListener('click', () => {
        withAdminBusy(async () => {
          await setUserActive(user.username, !user.active);
          showAdminMessage(`وضعیت «${user.username}» به‌روز شد.`, 'success');
          await refreshAdminPanel();
        });
      });

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn-search';
      resetBtn.textContent = 'ریست رمز';
      resetBtn.addEventListener('click', () => {
        const password = window.prompt(`رمز موقت جدید برای ${user.username}:`);
        if (password == null) return;
        withAdminBusy(async () => {
          await resetUserPassword(user.username, password);
          showAdminMessage(`رمز «${user.username}» ریست شد. در ورود بعدی باید رمز را عوض کند.`, 'success');
          await refreshAdminPanel();
        });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-danger';
      deleteBtn.textContent = 'حذف';
      deleteBtn.addEventListener('click', () => {
        if (!window.confirm(`کاربر «${user.username}» حذف شود؟ این عمل قابل بازگشت نیست.`)) return;
        withAdminBusy(async () => {
          await deleteUser(user.username);
          showAdminMessage(`کاربر «${user.username}» حذف شد.`, 'success');
          await refreshAdminPanel();
        });
      });

      actions.append(roleBtn, activeBtn, resetBtn, deleteBtn);
      row.append(main, actions);
      list.append(row);
    }
  }

  async function refreshAdminPanel() {
    const users = await listUsers();
    renderAdminUsers(users);
    const count = $('admin-user-count');
    if (count) count.textContent = users.length.toLocaleString('fa-IR');
  }

  async function withAdminBusy(action) {
    if (busy) return;
    setAdminBusy(true);
    showAdminMessage('لطفاً صبر کنید…', 'info');
    try {
      await action();
    } catch (error) {
      showAdminMessage(explain(error), 'error');
    } finally {
      setAdminBusy(false);
    }
  }

  function bindAdminPanel() {
    const panel = $('admin-panel');
    if (!panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';

    $('admin-create-form')?.addEventListener('submit', event => {
      event.preventDefault();
      withAdminBusy(async () => {
        const username = $('admin-new-username').value;
        const password = $('admin-new-password').value;
        const role = $('admin-new-role').value;
        await createUser({ username, password, role });
        $('admin-new-username').value = '';
        $('admin-new-password').value = DEFAULT_NEW_USER_PASSWORD;
        $('admin-new-role').value = 'member';
        showAdminMessage('کاربر جدید ساخته شد. رمز پیش‌فرض اعمال شد و در اولین ورود باید تغییر کند.', 'success');
        await refreshAdminPanel();
      });
    });

    $('admin-user-search')?.addEventListener('input', () => {
      if (!usersDoc) return;
      renderAdminUsers(usersDoc.users.map(publicUser));
    });

    $('admin-refresh-users')?.addEventListener('click', () => {
      withAdminBusy(async () => {
        await refreshAdminPanel();
        showAdminMessage('فهرست کاربران به‌روز شد.', 'success');
      });
    });

    $('admin-token-form')?.addEventListener('submit', event => {
      event.preventDefault();
      withAdminBusy(async () => {
        const providerId = $('admin-service-provider')?.value || storage().getProviderId();
        const value = $('admin-service-token').value.trim();
        await updateServiceTokenFromAdmin(value, providerId);
        $('admin-service-token').value = '';
        const label = storage().provider().label;
        showAdminMessage(`سرویس ${label} و توکن ذخیره شد. اعضا بدون دیدن توکن از آن استفاده می‌کنند.`, 'success');
      });
    });
  }

  async function initAdminPanel() {
    if (!session || session.role !== 'admin') {
      if ($('admin-panel')) $('admin-panel').hidden = true;
      return;
    }
    if ($('admin-panel')) $('admin-panel').hidden = false;
    bindAdminPanel();
    if ($('admin-service-provider')) $('admin-service-provider').value = storage().getProviderId();
    if ($('service-provider')) $('service-provider').value = storage().getProviderId();
    await withAdminBusy(async () => {
      await refreshAdminPanel();
      showAdminMessage(`پنل مدیریت آماده است · سرویس فعال: ${storage().provider().label}`, 'success');
    });
  }

  async function bootstrapAdmin() {
    const username = normalizeUsername($('setup-username').value);
    const password = $('setup-password').value;
    const confirm = $('setup-password-confirm').value;
    const tokenInput = ($('setup-token')?.value || '').trim();

    const passwordError = validatePassword(password);
    if (passwordError) throw new Error(passwordError);
    if (password !== confirm) throw new Error('تکرار رمز عبور با رمز واردشده یکسان نیست.');

    // Token is optional for first admin. Without it, users stay in localStorage until token is set later.
    if (tokenInput) {
      await requireServiceToken(tokenInput);
    }

    await loadUsers();
    if (usersDoc.users.length > 0) {
      throw new Error('ادمین اول قبلاً ساخته شده است. از ورود معمولی استفاده کنید.');
    }

    const hashed = await hashPassword(password);
    usersDoc.users.push({
      username,
      passwordHash: hashed.hash,
      salt: hashed.salt,
      role: 'admin',
      mustChangePassword: false,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    });
    await saveUsers(`chore(auth): bootstrap first admin (${username})`);
    if (serviceToken) {
      try { await saveServiceToken(serviceToken); } catch { /* optional */ }
    }
    persistSession(usersDoc.users[0]);
    updateSetupVisibility();
    showAuthMessage(
      serviceToken
        ? 'حساب مدیر با موفقیت ساخته شد.'
        : 'حساب مدیر ساخته شد (بدون توکن). بعداً از پنل مدیریت توکن سرویس را تنظیم کنید.',
      'success'
    );
    enterApp();
  }

  async function login() {
    const username = normalizeUsername($('login-username').value);
    const password = $('login-password').value;

    if (!password) throw new Error('رمز عبور را وارد کنید.');

    // Local-first auth so GitHub/GitLab outage never blocks login
    await loadUsers();

    if (!usersDoc || !Array.isArray(usersDoc.users) || !usersDoc.users.length) {
      showPanel('setup');
      showAuthMessage('هنوز ادمینی تعریف نشده است. ادمین اول را بسازید. توکن فعلاً لازم نیست.', 'info');
      return;
    }

    const user = usersDoc.users.find(item => item.username === username && item.active !== false);
    if (!user) throw new Error('نام کاربری یا رمز عبور نادرست است.');

    const ok = await verifyPassword(password, user);
    if (!ok) throw new Error('نام کاربری یا رمز عبور نادرست است.');

    // Optional remote token refresh; ignore failures
    if (serviceToken) {
      try {
        const repoToken = await loadServiceTokenFromRepo();
        if (repoToken) {
          serviceToken = repoToken;
          sessionStorage.setItem(AUTH_CONFIG.tokenKey, repoToken);
          if (window.AtlasStorage) storage().setToken(repoToken);
        }
      } catch {
        /* keep current token */
      }
    }

    persistSession(user);
    if ($('login-password')) $('login-password').value = '';

    if (user.mustChangePassword) {
      showPanel('change');
      showAuthMessage('برای ادامه باید رمز عبور را تغییر دهید.', 'info');
      return;
    }

    enterApp();
  }

  async function saveServiceTokenFromGate() {
    const providerSelect = $('service-provider');
    if (providerSelect) storage().setProviderId(providerSelect.value);
    const value = $('service-token-input').value.trim();
    if (!value) throw new Error('توکن سرویس را وارد کنید.');
    await requireServiceToken(value);
    try {
      await saveServiceToken(value);
    } catch {
      // Even if repo write fails, keep token in this browser session for login.
      serviceToken = value;
      sessionStorage.setItem(AUTH_CONFIG.tokenKey, value);
    }
    $('service-token-input').value = '';
    showPanel('login');
    showAuthMessage('توکن سرویس ذخیره شد. اکنون با نام کاربری و رمز وارد شوید.', 'success');
  }

  let voluntaryPasswordChange = false;

  async function changePassword() {
    if (!session) throw new Error('نشست معتبر نیست. دوباره وارد شوید.');
    const newPassword = $('change-new-password').value;
    const confirm = $('change-password-confirm').value;

    const passwordError = validatePassword(newPassword);
    if (passwordError) throw new Error(passwordError);
    if (newPassword !== confirm) throw new Error('تکرار رمز جدید یکسان نیست.');

    await loadUsers();
    const user = usersDoc.users.find(item => item.username === session.username);
    if (!user) throw new Error('حساب کاربری پیدا نشد.');

    const hashed = await hashPassword(newPassword);
    user.passwordHash = hashed.hash;
    user.salt = hashed.salt;
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date().toISOString();

    await saveUsers(`chore(auth): password changed (${user.username})`);
    persistSession(user);
    $('change-new-password').value = '';
    $('change-password-confirm').value = '';
    showAuthMessage('رمز عبور با موفقیت تغییر کرد.', 'success');
    voluntaryPasswordChange = false;
    if ($('auth-change-cancel')) $('auth-change-cancel').hidden = true;
    enterApp();
  }

  function openPasswordChange(options = {}) {
    voluntaryPasswordChange = !!options.voluntary;
    if ($('auth-change-cancel')) $('auth-change-cancel').hidden = !voluntaryPasswordChange;
    showPanel('change');
    showAuthMessage(voluntaryPasswordChange ? 'رمز جدید خود را وارد کنید.' : 'برای ادامه باید رمز عبور را تغییر دهید.', 'info');
  }

  async function withBusy(action) {
    if (busy) return;
    setBusy(true);
    showAuthMessage('لطفاً صبر کنید…', 'info');
    try {
      await action();
    } catch (error) {
      console.error(error);
      showAuthMessage(explain(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    clearSession();
    showPanel('login');
    showAuthMessage('از حساب خارج شدید.', 'info');
  }

  async function boot() {
    // Always unlock controls first (previous broken builds could leave disabled=true)
    try { setBusy(false); } catch { /* ignore */ }
    busy = false;

    session = readSession();
    serviceToken = sessionStorage.getItem(AUTH_CONFIG.tokenKey) || (window.AtlasStorage && window.AtlasStorage.getToken()) || '';
    try {
      if ($('service-provider') && window.AtlasStorage) $('service-provider').value = storage().getProviderId();
      if ($('admin-service-provider') && window.AtlasStorage) $('admin-service-provider').value = storage().getProviderId();
    } catch { /* ignore */ }

    // Always show token button; setup button stays available if no local users yet
    if ($('auth-goto-service')) $('auth-goto-service').hidden = false;
    if ($('auth-goto-setup')) $('auth-goto-setup').hidden = false;

    if ($('auth-login-form')) $('auth-login-form').addEventListener('submit', event => {
      event.preventDefault();
      withBusy(login);
    });
    $('auth-setup-form')?.addEventListener('submit', event => {
      event.preventDefault();
      withBusy(bootstrapAdmin);
    });
    $('auth-change-form')?.addEventListener('submit', event => {
      event.preventDefault();
      withBusy(changePassword);
    });
    $('auth-change-cancel')?.addEventListener('click', () => {
      voluntaryPasswordChange = false;
      $('change-new-password').value = '';
      $('change-password-confirm').value = '';
      enterApp();
    });
    $('auth-service-form')?.addEventListener('submit', event => {
      event.preventDefault();
      withBusy(saveServiceTokenFromGate);
    });
    $('auth-goto-setup')?.addEventListener('click', () => {
      showPanel('setup');
      showAuthMessage('اولین حساب را بسازید. بعد از آن کاربران را از پنل مدیریت اضافه کنید.', 'info');
    });
    $('auth-goto-service')?.addEventListener('click', () => {
      showPanel('service');
      showAuthMessage('توکن سرویس را فقط مدیریت وارد کند.', 'info');
    });
    $('auth-service-back')?.addEventListener('click', () => {
      showPanel('login');
      showAuthMessage('');
    });
    $('auth-goto-login')?.addEventListener('click', () => {
      showPanel('login');
      showAuthMessage('');
    });

    try {
      if (serviceToken) {
        try { await requireServiceToken(serviceToken); } catch (e) { console.warn('token check', e); }
      }
      try {
        await loadUsers();
      } catch (e) {
        console.warn('boot loadUsers', e);
        usersDoc = loadUsersLocal();
      }
      updateSetupVisibility();

      if (!usersDoc.users.length) {
        clearSession();
        showPanel('setup');
        showAuthMessage('هنوز حسابی ساخته نشده است. اولین حساب را بسازید (توکن فعلاً لازم نیست).', 'info');
        return;
      }

      if (session) {
        const user = usersDoc.users.find(item => item.username === session.username && item.active !== false);
        if (!user) {
          clearSession();
          showPanel('login');
          showAuthMessage('حساب نشست قبلی معتبر نیست. دوباره وارد شوید.', 'error');
          return;
        }
        persistSession(user);
        if (user.mustChangePassword) {
          showPanel('change');
          showAuthMessage('باید رمز عبور را تغییر دهید.', 'info');
          return;
        }
        enterApp();
        return;
      }

      showPanel('login');
      showAuthMessage(
        serviceToken
          ? 'با نام کاربری و رمز وارد شوید.'
          : 'با نام کاربری و رمز وارد شوید. توکن سرویس بعداً از پنل مدیریت تنظیم می‌شود.',
        'info'
      );
    } catch (error) {
      console.error(error);
      showPanel('login');
      showAuthMessage(explain(error), 'error');
    } finally {
      try { setBusy(false); } catch { /* ignore */ }
      busy = false;
    }
  }

  function updateSetupVisibility() {
    const btn = $('auth-goto-setup');
    if (!btn) return;
    const hasUsers = !!(usersDoc && usersDoc.users && usersDoc.users.length);
    btn.hidden = hasUsers;
  }

  window.AtlasAuth = {
    getSession: () => (session ? { ...session } : null),
    getServiceToken: () => serviceToken,
    logout,
    validatePassword,
    normalizeUsername,
    SPECIAL_CHARS,
    SPECIAL_CHARS_HINT,
    DEFAULT_NEW_USER_PASSWORD,
    initAdminPanel,
    listUsers,
    createUser,
    resetUserPassword,
    setUserActive,
    setUserRole,
    deleteUser,
    updateServiceTokenFromAdmin,
    openPasswordChange,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
