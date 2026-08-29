/* ============================================================
 * app.js — 核心: 全局状态、API 封装、会话、左侧导航路由(Ajax 加载页面)
 * ============================================================ */

const State = {
  user: null,           // 当前登录用户
  token: null,          // session_token
  tab: 'mail',          // 当前标签
  availableAccounts: [], // 可用邮箱缓存(邮件查询用)
  mailAccounts: [],     // 我的邮箱缓存
  oauthTimer: null,     // OAuth 轮询定时器
  deviceTimer: null,    // 微软 Device Code 轮询定时器
  gDeviceTimer: null,   // 谷歌 Device Code 轮询定时器
  aliasMax: 5,          // 别名数量上限(服务端下发)
  aliasTtlMs: 3600000,  // 别名有效期(服务端下发)
};

// localStorage 持久化键
const LS_TOKEN = 'mail_alias_token';
const LS_USER = 'mail_alias_user';

// 导航图标(内联 SVG,避免额外请求)
const NAV_ICONS = {
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  account: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  webhook: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  docs: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

function svgIcon(name, size) {
  const s = size || 17;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[name] || ''}</svg>`;
}

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

/* ============ 通用 UI 工具 ============ */
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

// 剩余时间的人类可读描述
function fmtRemain(ms) {
  if (!ms || ms <= 0) return '已过期';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h} 小时 ${m % 60} 分`;
  }
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function showModal(title, bodyHtml, footerHtml = '', wide = false) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-mask" onclick="if(event.target===this)closeModal()">
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-header"><h3>${esc(title)}</h3><button class="close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div></div>`;
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
function confirmDialog(msg, onOk) {
  showModal('确认操作', `<p>${esc(msg)}</p>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button><button class="btn btn-danger" id="confirmOkBtn">确定</button>`);
  const btn = document.getElementById('confirmOkBtn');
  if (btn) btn.onclick = () => { closeModal(); onOk(); };
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('已复制', 'success'))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('已复制', 'success'); } catch { toast('复制失败', 'error'); }
  ta.remove();
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
  // 后台预加载所有页面 HTML,使随后切换任意页面时无需再等待网络(静态资源,瞬时渲染)
  Object.keys(PAGE_INIT).forEach(p => {
    if (PAGE_HTML_CACHE[p]) return;
    loadPageHtml(p).then(h => { PAGE_HTML_CACHE[p] = h; }).catch(() => {});
  });
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
  } catch {
    showLoginError('账户不存在,或是密码不匹配');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '登录'; }
  }
  return false;
}

async function doRegister(e) {
  if (e) e.preventDefault();
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
 * 主应用渲染 — 左侧导航 + 顶部条 + Ajax 加载页面
 * ============================================================ */

const PAGE_INIT = {
  mail: () => initMailPage(),
  account: () => initAccountPage(),
  webhook: () => initWebhookPage(),
  docs: () => initDocsPage(),
  users: () => initUsersPage(),
  settings: () => initSettingsPage(),
};

// 页面 HTML 本地缓存:首次加载后缓存,后续切换直接渲染,不再有转圈等待
const PAGE_HTML_CACHE = {};

const PAGE_META = {
  mail: { title: '邮件查询', desc: '聚合查询所有生效别名邮箱的收件，支持全文模糊搜索' },
  account: { title: '我的账户', desc: '个人信息、API Key、OAuth 邮箱绑定与登录密码' },
  webhook: { title: 'Webhook 订阅', desc: '新邮件主动推送到飞书 / 钉钉 / 自定义地址' },
  docs: { title: 'API 文档', desc: '接口说明与调用示例' },
  users: { title: '用户管理', desc: '管理系统用户、别名与绑定的邮箱' },
  settings: { title: '系统设置', desc: 'OAuth 凭据、注册开关、运行统计与调用日志' },
};

function toggleSidebar(open) {
  document.getElementById('sidebar').classList.toggle('open', !!open);
  document.getElementById('sidebarMask').classList.toggle('show', !!open);
}

async function loadPageHtml(pageName) {
  const resp = await fetch('pages/' + pageName + '.html');
  if (!resp.ok) throw new Error('页面加载失败: ' + resp.status);
  return await resp.text();
}

function renderApp() {
  const u = State.user;
  if (!u) return;
  // 侧边栏用户信息
  document.getElementById('navUsername').textContent = u.username;
  document.getElementById('navAvatar').textContent = (u.username || 'U').slice(0, 1).toUpperCase();
  document.getElementById('navRole').innerHTML = u.is_admin
    ? '<span class="badge badge-primary">管理员</span>'
    : '<span class="badge badge-gray">普通用户</span>';

  // 导航项
  const groups = [
    {
      label: '邮箱服务',
      items: [
        { key: 'mail', label: '邮件查询', icon: 'mail' },
        { key: 'account', label: '我的账户', icon: 'account' },
        { key: 'webhook', label: 'Webhook 订阅', icon: 'webhook' },
        { key: 'docs', label: 'API 文档', icon: 'docs' },
      ],
    },
  ];
  if (u.is_admin) {
    groups.push({
      label: '系统管理',
      items: [
        { key: 'users', label: '用户管理', icon: 'users' },
        { key: 'settings', label: '系统设置', icon: 'settings' },
      ],
    });
  }

  const nav = document.getElementById('appNav');
  nav.innerHTML = groups.map(g => `
    <div class="nav-group-label">${esc(g.label)}</div>
    ${g.items.map(t => `
      <button class="nav-item ${State.tab === t.key ? 'active' : ''}" data-key="${t.key}" onclick="switchTab('${t.key}')">
        ${svgIcon(t.icon)}
        <span>${esc(t.label)}</span>
        ${t.key === 'mail' ? `<span class="tag" id="navAliasTag">${u.active_alias_count || 0}</span>` : ''}
      </button>`).join('')}
  `).join('');

  switchTab(State.tab);
}

async function switchTab(key) {
  // 切换前清理当前页面(停止自动收件 / 轮询定时器等)
  if (State.tab === 'mail' && typeof cleanupMailPage === 'function') cleanupMailPage();
  if (typeof stopAllDevicePolling === 'function') stopAllDevicePolling();

  State.tab = key;
  toggleSidebar(false);

  // 更新导航高亮
  document.querySelectorAll('#appNav .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-key') === key);
  });
  const meta = PAGE_META[key] || { title: key, desc: '' };
  document.getElementById('topbarTitle').textContent = meta.title;
  document.getElementById('topbarDesc').textContent = meta.desc;
  const actions = document.getElementById('topbarActions');
  if (actions) actions.innerHTML = '';

  const main = document.getElementById('appMain');
  // 命中本地缓存: 直接渲染,零等待(首次加载后所有页面均会被预加载缓存)
  if (PAGE_HTML_CACHE[key]) {
    main.innerHTML = PAGE_HTML_CACHE[key];
    if (PAGE_INIT[key]) await PAGE_INIT[key]();
    return;
  }
  main.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  try {
    const html = await loadPageHtml(key);
    PAGE_HTML_CACHE[key] = html;
    main.innerHTML = html;
    if (PAGE_INIT[key]) await PAGE_INIT[key]();
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
