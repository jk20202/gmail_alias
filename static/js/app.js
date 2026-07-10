/* ============================================================
 * app.js — 核心: 全局状态、API 封装、会话、路由(Ajax 加载页面)
 * ============================================================ */

const State = {
  user: null,           // 当前登录用户
  token: null,          // session_token
  tab: 'mail',          // 当前标签
  availableAccounts: [], // 可用邮箱缓存(邮件查询用)
  mailAccounts: [],     // 我的邮箱缓存
  oauthTimer: null,     // OAuth 轮询定时器
  deviceTimer: null,    // 微软 Device Code 轮询定时器
};

// localStorage 持久化键
const LS_TOKEN = 'mail_alias_token';
const LS_USER = 'mail_alias_user';

/* ============ 统一 API 封装 ============ */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error('网络请求失败: ' + e.message);
  }
  if (res.status === 401) {
    clearSession();
    showLoginView();
    throw new Error('会话已过期，请重新登录');
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error('响应解析失败'); }
  if (data.code !== 0) {
    throw new Error(data.msg || '请求失败');
  }
  return data.data;
}

// 轻提示
function toast(msg, type = 'info', duration = 2600) {
  const box = document.getElementById('toastBox');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// 转义 HTML,防 XSS
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 格式化时间(显示用)
function fmtTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d).replace(/\//g, '-');
  } catch { return iso; }
}

// 模态框
function showModal(title, bodyHtml, footerHtml = '') {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-mask" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header"><h3>${esc(title)}</h3><button class="close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div></div>`;
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
function confirmDialog(msg, onOk) {
  showModal('确认操作', `<p>${esc(msg)}</p>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button><button class="btn btn-danger" id="confirmOkBtn">确定</button>`);
  document.getElementById('confirmOkBtn').onclick = () => { closeModal(); onOk(); };
}

// 复制文本到剪贴板
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('已复制', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制', 'success'); } catch { toast('复制失败', 'error'); }
    ta.remove();
  }
}

/* ============================================================
 * 会话与登录
 * ============================================================ */
function saveSession(token, user) {
  State.token = token;
  State.user = user;
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}
function clearSession() {
  State.token = null;
  State.user = null;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
}

function showLoginView() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}
function showAppView() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  renderApp();
}

function switchLoginTab(which) {
  const isLogin = which === 'login';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  document.getElementById('loginForm').classList.toggle('hidden', !isLogin);
  document.getElementById('registerForm').classList.toggle('hidden', isLogin);
  document.getElementById('loginError').style.display = 'none';
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function doLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) { showLoginError('请输入用户名和密码'); return false; }
  const btn = document.querySelector('#loginForm button[type=submit]');
  if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    saveSession(data.session_token, data.user);
    toast('登录成功，正在进入系统...', 'success');
    showAppView();
  } catch (err) {
    showLoginError('账户不存在,或是密码不匹配');
    toast('登录失败:账户不存在或密码不匹配', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '登录'; }
  }
  return false;
}

async function doRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!username || username.length < 3) { showLoginError('用户名至少 3 个字符'); return false; }
  if (!password || password.length < 6) { showLoginError('密码至少 6 个字符'); return false; }
  try {
    await api('/api/auth/register', { method: 'POST', body: { username, password } });
    toast('注册成功，请登录', 'success');
    switchLoginTab('login');
    document.getElementById('loginUsername').value = username;
    document.getElementById('loginPassword').focus();
  } catch (err) {
    showLoginError(err.message);
  }
  return false;
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch { /* 忽略登出错误 */ }
  clearSession();
  showLoginView();
}

async function checkRegistrationAllowed() {
  try {
    const data = await api('/api/admin/settings');
    const allowed = data && data.allow_registration;
    document.getElementById('tabRegister').style.display = allowed ? '' : 'none';
  } catch {
    document.getElementById('tabRegister').style.display = 'none';
  }
}

/* ============================================================
 * 主应用渲染 — Ajax 加载页面 HTML
 * ============================================================ */

// 页面初始化函数映射
const PAGE_INIT = {
  mail: () => initMailPage(),
  account: () => initAccountPage(),
  webhook: () => initWebhookPage(),
  docs: () => initDocsPage(),
  users: () => initUsersPage(),
  settings: () => initSettingsPage(),
};

// Ajax 加载页面 HTML 并注入到主区域
async function loadPageHtml(pageName) {
  const resp = await fetch('pages/' + pageName + '.html');
  if (!resp.ok) throw new Error('页面加载失败: ' + resp.status);
  return await resp.text();
}

function renderApp() {
  const u = State.user;
  if (!u) return;
  // 顶部用户信息
  document.getElementById('navUsername').textContent = u.username;
  document.getElementById('navRole').innerHTML = u.is_admin
    ? '<span class="badge badge-primary">管理员</span>'
    : '<span class="badge badge-gray">用户</span>';
  // 导航
  const nav = document.getElementById('appNav');
  const tabs = [
    { key: 'mail', label: '邮件查询' },
    { key: 'account', label: '我的账户' },
    { key: 'webhook', label: 'Webhook 订阅' },
    { key: 'docs', label: 'API 文档' },
  ];
  if (u.is_admin) {
    tabs.push({ key: 'users', label: '用户管理' });
    tabs.push({ key: 'settings', label: '系统设置' });
  }
  nav.innerHTML = tabs.map(t =>
    `<button class="${State.tab === t.key ? 'active' : ''}" onclick="switchTab('${t.key}')">${t.label}</button>`
  ).join('');
  // 异步加载页面
  switchTab(State.tab);
}

async function switchTab(key) {
  // 切换前清理当前页面 (如停止自动收件定时器)
  if (State.tab === 'mail' && typeof cleanupMailPage === 'function') {
    cleanupMailPage();
  }
  State.tab = key;
  // 更新导航高亮
  document.querySelectorAll('#appNav button').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('onclick').includes("'" + key + "'"));
  });
  const main = document.getElementById('appMain');
  main.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  try {
    const html = await loadPageHtml(key);
    main.innerHTML = html;
    // 执行页面初始化
    if (PAGE_INIT[key]) {
      await PAGE_INIT[key]();
    }
  } catch (err) {
    main.innerHTML = '<div class="mail-empty">页面加载失败: ' + esc(err.message) + '</div>';
  }
}

/* ============================================================
 * 启动入口
 * ============================================================ */
(async function init() {
  await checkRegistrationAllowed();
  const token = localStorage.getItem(LS_TOKEN);
  const userJson = localStorage.getItem(LS_USER);
  if (token && userJson) {
    State.token = token;
    try {
      State.user = JSON.parse(userJson);
    } catch { clearSession(); }
    try {
      const me = await api('/api/auth/me');
      State.user = me;
      localStorage.setItem(LS_USER, JSON.stringify(me));
      showAppView();
    } catch {
      clearSession();
      showLoginView();
    }
  } else {
    showLoginView();
  }
})();
