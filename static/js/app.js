/* ============================================================
 * 全局状态与工具
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

/* ============ 统一 API 封装 ============
 * 自动注入 Authorization 头、解析 JSON、处理 401 跳登录
 * 统一响应格式: { code, msg, data }, code != 0 抛错
 */
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
  // 401: 会话失效,清除并跳登录
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
// 通用确认弹窗
function confirmDialog(msg, onOk) {
  showModal('确认操作', `<p>${esc(msg)}</p>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button><button class="btn btn-danger" id="confirmOkBtn">确定</button>`);
  document.getElementById('confirmOkBtn').onclick = () => { closeModal(); onOk(); };
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

// 登录/注册标签切换
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

// 登录
async function doLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) { showLoginError('请输入用户名和密码'); return false; }
  // 禁用按钮防重复提交,给用户即时反馈
  const btn = document.querySelector('#loginForm button[type=submit]');
  if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    saveSession(data.session_token, data.user);
    // 登录成功即时提示
    toast('登录成功，正在进入系统...', 'success');
    showAppView();
  } catch (err) {
    // 统一提示,不区分"用户不存在"和"密码错误",防止账户枚举
    showLoginError('账户不存在,或是密码不匹配');
    toast('登录失败:账户不存在或密码不匹配', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '登录'; }
  }
  return false;
}

// 注册
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

// 登出
async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch { /* 忽略登出错误 */ }
  clearSession();
  showLoginView();
}

// 启动时检查注册开关(注册按钮显隐)
async function checkRegistrationAllowed() {
  try {
    // adminGetSettings 接口无需鉴权,可读取 allow_registration
    const data = await api('/api/admin/settings');
    const allowed = data && data.allow_registration;
    document.getElementById('tabRegister').style.display = allowed ? '' : 'none';
  } catch {
    // 接口异常默认隐藏注册
    document.getElementById('tabRegister').style.display = 'none';
  }
}

/* ============================================================
 * 主应用渲染
 * ============================================================ */
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
  // 渲染当前页
  const main = document.getElementById('appMain');
  switch (State.tab) {
    case 'mail': main.innerHTML = viewMailHtml(); initMailPage(); break;
    case 'account': main.innerHTML = viewAccountHtml(); initAccountPage(); break;
    case 'webhook': main.innerHTML = viewWebhookHtml(); initWebhookPage(); break;
    case 'docs': main.innerHTML = viewDocsHtml(); break;
    case 'users': main.innerHTML = viewUsersHtml(); initUsersPage(); break;
    case 'settings': main.innerHTML = viewSettingsHtml(); initSettingsPage(); break;
  }
}

function switchTab(key) {
  State.tab = key;
  renderApp();
}

/* ============================================================
 * 1. 邮件查询页
 * ============================================================ */
function viewMailHtml() {
  return `
  <div class="page-title">邮件查询</div>
  <div class="page-desc">选择邮箱并设置别名后，可查询该别名收件箱中的邮件</div>
  <div class="section">
    <div class="card">
      <div class="card-header"><h3>别名设置</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label class="form-label">选择邮箱</label>
            <select id="aliasAccount" class="form-control" style="height:38px;box-sizing:border-box"><option value="">加载中...</option></select>
          </div>
          <div class="form-group" style="flex:2">
            <label class="form-label">别名标签</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="aliasLabel" class="form-control" placeholder="如 newsletter" style="height:38px;box-sizing:border-box">
              <button class="dice-btn" title="随机生成" onclick="genRandomLabel()" aria-label="随机生成">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 3.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM16 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label" style="visibility:hidden">占位</label>
            <button class="btn btn-block" style="height:38px;box-sizing:border-box" onclick="setAlias()">设置别名</button>
          </div>
        </div>
        <div id="currentAlias" class="form-hint"></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="card">
      <div class="card-header"><h3>查询条件</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">发件人</label>
            <input type="text" id="qSender" class="form-control" placeholder="按发件人筛选">
          </div>
          <div class="form-group">
            <label class="form-label">主题</label>
            <input type="text" id="qSubject" class="form-control" placeholder="按主题筛选">
          </div>
          <div class="form-group">
            <label class="form-label">关键词</label>
            <input type="text" id="qKeyword" class="form-control" placeholder="正文关键词">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">开始时间</label>
            <input type="datetime-local" id="qStart" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">结束时间</label>
            <input type="datetime-local" id="qEnd" class="form-control">
          </div>
          <div class="form-group">
            <label class="form-label">数量上限</label>
            <input type="number" id="qLimit" class="form-control" value="20" min="1" max="100">
          </div>
          <div class="form-group">
            <label class="form-label" style="visibility:hidden">占位</label>
            <label class="switch" style="height:38px; display:inline-flex; align-items:center; gap:8px">
              <input type="checkbox" id="qUnread">
              <span class="track"></span>
              <span>仅未读</span>
            </label>
          </div>
        </div>
        <div style="margin-top:8px">
          <button class="btn" onclick="fetchMails()">查询邮件</button>
        </div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="card">
      <div class="card-header"><h3>邮件列表 <span id="mailCount" class="badge badge-gray" style="margin-left:8px">0</span></h3></div>
      <div class="card-body">
        <div id="mailList"><div class="mail-empty">请设置查询条件后点击「查询邮件」</div></div>
      </div>
    </div>
  </div>`;
}

async function initMailPage() {
  await loadAvailableAccounts();
  refreshCurrentAlias();
}

// 加载可用邮箱(自己 + 公开)
async function loadAvailableAccounts() {
  const sel = document.getElementById('aliasAccount');
  try {
    const list = await api('/api/account/mail_accounts/available');
    State.availableAccounts = list || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">无可用的邮箱，请先绑定</option>';
      return;
    }
    sel.innerHTML = list.map(a =>
      `<option value="${esc(a.id)}">${esc(a.email)} (${a.provider}${a.is_own ? '' : ' · 公开'})</option>`
    ).join('');
  } catch (err) {
    sel.innerHTML = '<option value="">加载失败</option>';
    toast(err.message, 'error');
  }
}

// 当前别名展示
function refreshCurrentAlias() {
  const a = State.user.alias;
  const el = document.getElementById('currentAlias');
  if (!el) return;
  if (a) {
    el.innerHTML = `当前别名：<span class="mono">${esc(a.full)}</span> <button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(a.full)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button> <span class="badge badge-success">已设置</span> (更新于 ${fmtTime(a.updated_at)})`;
    // 回填到表单
    const sel = document.getElementById('aliasAccount');
    if (sel && a.mail_account_id) sel.value = a.mail_account_id;
    const lbl = document.getElementById('aliasLabel');
    if (lbl && !lbl.value) lbl.value = a.label;
  } else {
    el.innerHTML = '<span class="badge badge-warning">未设置别名</span> 普通用户查询邮件前需先设置别名';
  }
}

// 随机标签
async function genRandomLabel() {
  try {
    const data = await api('/api/account/alias/random_label');
    document.getElementById('aliasLabel').value = data.label;
  } catch (err) { toast(err.message, 'error'); }
}

// 设置别名
async function setAlias() {
  const mail_account_id = document.getElementById('aliasAccount').value;
  const label = document.getElementById('aliasLabel').value.trim();
  if (!mail_account_id) { toast('请选择邮箱', 'warning'); return; }
  if (!label) { toast('请输入别名标签', 'warning'); return; }
  try {
    const updated = await api('/api/account/alias', { method: 'POST', body: { mail_account_id, label } });
    State.user = updated;
    localStorage.setItem(LS_USER, JSON.stringify(updated));
    refreshCurrentAlias();
    document.getElementById('navUsername').textContent = updated.username;
    toast('别名设置成功: ' + (updated.alias ? updated.alias.full : ''), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// 查询邮件
async function fetchMails() {
  const params = {
    sender: document.getElementById('qSender').value.trim() || undefined,
    subject: document.getElementById('qSubject').value.trim() || undefined,
    keyword: document.getElementById('qKeyword').value.trim() || undefined,
    unseen: document.getElementById('qUnread').checked || undefined,
    limit: parseInt(document.getElementById('qLimit').value) || 20,
  };
  const start = document.getElementById('qStart').value;
  const end = document.getElementById('qEnd').value;
  if (start) params.start_time = new Date(start).toISOString();
  if (end) params.end_time = new Date(end).toISOString();

  const list = document.getElementById('mailList');
  list.innerHTML = '<div class="loading"><span class="spinner"></span> 正在查询...</div>';
  try {
    const data = await api('/api/web/email/fetch', { method: 'POST', body: params });
    renderMailList(data.emails || []);
  } catch (err) {
    list.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

function renderMailList(emails) {
  const list = document.getElementById('mailList');
  document.getElementById('mailCount').textContent = emails.length;
  if (!emails.length) {
    list.innerHTML = '<div class="mail-empty">没有符合条件的邮件</div>';
    return;
  }
  list.className = 'mail-list';
  list.innerHTML = emails.map((m, i) => `
    <div class="mail-item ${m.unread ? 'unread' : ''}" id="mail-${i}">
      <div class="mail-head" onclick="toggleMail(${i})">
        ${m.unread ? '<span class="unread-dot"></span>' : ''}
        <span class="from">${esc(m.from || '(未知发件人)')}</span>
        <span class="subject">${esc(m.subject || '(无主题)')}</span>
        <span class="date">${esc(m.date || '')}</span>
      </div>
      <div class="mail-body">
        <div class="meta-row">
          <span>收件人: ${esc(m.to || '-')}</span>
          <span>时间: ${esc(m.date || '-')}</span>
          ${m.unread ? '<span class="badge badge-primary">未读</span>' : '<span class="badge badge-gray">已读</span>'}
        </div>
        <div class="body-text" id="body-${i}">${esc(m.body || '(无正文)')}</div>
        <div class="actions">
          ${m.html ? `<button class="btn btn-secondary btn-sm" onclick="viewHtmlMail(${i})">查看 HTML</button>` : ''}
          ${m.unread ? `<button class="btn btn-success btn-sm" onclick="markMailRead(${i})">标记已读</button>` : ''}
        </div>
      </div>
    </div>`).join('');
  // 缓存邮件数据供展开/操作使用
  State._mails = emails;
}

function toggleMail(i) {
  document.getElementById('mail-' + i).classList.toggle('expanded');
}

// 在沙箱 iframe 中查看 HTML 邮件(防 XSS)
function viewHtmlMail(i) {
  const m = State._mails[i];
  showModal('HTML 邮件预览',
    `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html || '')}" style="width:100%;min-height:400px;border:1px solid var(--border);border-radius:6px"></iframe>`,
    `<button class="btn btn-secondary" onclick="closeModal()">关闭</button>`);
}

// 标记已读(使用 API Key 端点)
async function markMailRead(i) {
  const m = State._mails[i];
  if (!m) return;
  try {
    const data = await api('/api/email/mark_read?key=' + encodeURIComponent(State.user.api_key), {
      method: 'POST', body: { to: m.to, sender: m.from, subject: m.subject }
    });
    toast('已标记 ' + (data.marked || 0) + ' 封已读', 'success');
    // 局部刷新状态
    m.unread = false;
    const item = document.getElementById('mail-' + i);
    item.classList.remove('unread');
    item.querySelector('.unread-dot')?.remove();
    const badge = item.querySelector('.badge-primary');
    if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '已读'; }
    const btn = item.querySelector('.btn-success');
    if (btn) btn.remove();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
 * 2. 我的账户页
 * ============================================================ */
function viewAccountHtml() {
  const u = State.user;
  return `
  <div class="page-title">我的账户</div>
  <div class="page-desc">管理个人信息、API Key、OAuth 邮箱绑定与登录密码</div>
  <div class="card-stack">
    <div class="card">
      <div class="card-header"><h3>基本信息</h3></div>
      <div class="card-body">
        <div class="info-item">
          <span class="label">用户名</span>
          <span class="value">${esc(u.username)}</span>
        </div>
        <div class="info-item">
          <span class="label">角色</span>
          <span class="value">${u.is_admin ? '<span class="badge badge-primary">管理员</span>' : '<span class="badge badge-gray">普通用户</span>'}</span>
        </div>
        <div class="info-item">
          <span class="label">创建时间</span>
          <span class="value">${fmtTime(u.created_at)}</span>
        </div>
        ${u.alias ? `
        <div class="info-item" style="flex-direction:column; align-items:stretch">
          <span class="label" style="margin-bottom:6px">当前别名</span>
          <div class="apikey-box"><span class="mono" style="flex:1">${esc(u.alias.full)}</span><button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(u.alias.full)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></div>
          <div class="form-hint">标签: ${esc(u.alias.label)} · 更新于 ${fmtTime(u.alias.updated_at)}</div>
        </div>` : ''}
        <div class="info-item" style="flex-direction:column; align-items:stretch">
          <span class="label" style="margin-bottom:6px">API Key <span class="form-hint" style="font-weight:normal">编程调用接口的密钥,重新生成后旧密钥立即失效</span></span>
          <div class="apikey-row">
            <span class="mono" id="apiKeyText">${esc(u.api_key)}</span>
            <button class="btn btn-secondary btn-sm" onclick="copyText('${esc(u.api_key)}')">复制</button>
            <button class="btn btn-danger btn-sm" onclick="regenApiKey()">重新生成</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>修改密码</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">原密码 <span class="req">*</span></label>
            <input type="password" id="oldPassword" class="form-control" placeholder="请输入当前密码">
          </div>
          <div class="form-group">
            <label class="form-label">新密码 <span class="req">*</span></label>
            <input type="password" id="newPassword" class="form-control" placeholder="至少 6 个字符">
          </div>
          <div class="form-group">
            <label class="form-label">确认新密码 <span class="req">*</span></label>
            <input type="password" id="confirmPassword" class="form-control" placeholder="再次输入新密码">
          </div>
        </div>
        <div style="margin-top:8px">
          <button class="btn" onclick="changeMyPassword()">保存修改</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>OAuth 邮箱绑定</h3></div>
      <div class="card-body">
        <p class="form-hint" style="margin-bottom:12px">绑定邮箱后,系统将自动刷新访问令牌并代为查询邮件。Outlook/Hotmail 采用 Device Code 授权,无需配置回调地址即可使用。</p>
        <div style="display:flex; gap:8px; margin-bottom:16px">
          <button class="btn" onclick="startOAuth('gmail')">绑定 Gmail</button>
          <button class="btn" onclick="startOAuth('outlook')">绑定 Outlook/Hotmail</button>
        </div>
        <h4 style="font-size:13px; color:var(--text-light); margin-bottom:8px">已绑定的邮箱</h4>
        <div id="myAccounts"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
      </div>
    </div>
  </div>`;
}

async function initAccountPage() {
  await loadMyAccounts();
}

async function loadMyAccounts() {
  const box = document.getElementById('myAccounts');
  if (!box) return;
  try {
    const list = await api('/api/account/mail_accounts');
    State.mailAccounts = list || [];
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">尚未绑定任何邮箱,点击上方按钮开始绑定</div>';
      return;
    }
    // 渲染表格骨架: 邮箱 / 类型 / Plus寻址 / 授权状态 / 是否公开 / 操作
    // 授权状态先显示"检测中",随后异步探测更新
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>邮箱</th><th>类型</th><th>Plus寻址</th><th>授权状态</th><th>是否公开</th><th>操作</th>
      </tr></thead>
      <tbody>${list.map(a => `
        <tr>
          <td><span class="mono">${esc(a.email)}</span></td>
          <td><span class="badge ${a.provider === 'gmail' ? 'badge-primary' : 'badge-warning'}">${esc(a.provider)}</span></td>
          <td><span class="badge badge-success">✓ 启用</span></td>
          <td id="acc-status-${esc(a.id)}"><span class="badge badge-gray">检测中...</span></td>
          <td>
            <label class="switch" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer">
              <input type="checkbox" ${a.is_public ? 'checked' : ''} onchange="togglePublic('${esc(a.id)}', this.checked)">
              <span class="track"></span>
              <span>${a.is_public ? '公开' : '私有'}</span>
            </label>
          </td>
          <td>
            <button class="btn btn-secondary btn-sm" id="acc-reauth-${esc(a.id)}" onclick="reauthAccount('${esc(a.id)}','${esc(a.provider)}')">重新授权</button>
            <button class="btn btn-danger btn-sm" onclick="deleteAccount('${esc(a.id)}','${esc(a.email)}')">删除</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
    // 并发探测每个邮箱的授权状态(不阻塞渲染)
    list.forEach(a => probeAuthStatus(a.id));
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

// 探测单个邮箱授权状态并更新对应单元格与操作按钮
async function probeAuthStatus(id) {
  const cell = document.getElementById('acc-status-' + id);
  if (!cell) return;
  try {
    const data = await api('/api/account/mail_accounts/' + id + '/status');
    if (data && data.ok) {
      cell.innerHTML = '<span class="badge badge-success">已授权</span>';
    } else {
      cell.innerHTML = '<span class="badge badge-danger">未授权</span>';
      const btn = document.getElementById('acc-reauth-' + id);
      if (btn) btn.textContent = '继续授权';
    }
  } catch (e) {
    cell.innerHTML = '<span class="badge badge-danger">未授权</span>';
    const btn = document.getElementById('acc-reauth-' + id);
    if (btn) btn.textContent = '继续授权';
  }
}

// 重新授权 / 继续授权: 复用 OAuth 流程,回调时按 email upsert 更新 token
function reauthAccount(id, provider) {
  startOAuth(provider);
}

// 切换邮箱公开状态 (是否允许其他用户使用该邮箱查询)
async function togglePublic(id, isPublic) {
  try {
    await api('/api/account/mail_accounts/' + id + '/public', { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开,其他用户可使用此邮箱' : '已设为私有', 'success');
    loadMyAccounts();
    loadAvailableAccounts();
  } catch (err) { toast(err.message, 'error'); loadMyAccounts(); }
}

// 重新生成 API Key
async function regenApiKey() {
  confirmDialog('重新生成后旧 API Key 将立即失效，确认操作？', async () => {
    try {
      const updated = await api('/api/account/api_key', { method: 'POST' });
      State.user = updated;
      localStorage.setItem(LS_USER, JSON.stringify(updated));
      renderApp();
      toast('API Key 已重新生成', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// 用户自助修改密码
async function changeMyPassword() {
  const oldPassword = document.getElementById('oldPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  // 前端校验: 原密码非空、新密码长度≥6、两次输入一致
  if (!oldPassword) { toast('请输入原密码', 'warning'); return; }
  if (!newPassword || newPassword.length < 6) { toast('新密码至少 6 个字符', 'warning'); return; }
  if (newPassword !== confirmPassword) { toast('两次输入的新密码不一致', 'warning'); return; }
  try {
    await api('/api/auth/change_password', {
      method: 'POST',
      body: { old_password: oldPassword, new_password: newPassword }
    });
    toast('密码修改成功', 'success');
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
  } catch (err) { toast(err.message, 'error'); }
}

// 删除邮箱
async function deleteAccount(id, email) {
  confirmDialog(`确认删除邮箱 ${email}？关联的别名也会被清除`, async () => {
    try {
      await api('/api/account/mail_accounts/' + id, { method: 'DELETE' });
      toast('已删除邮箱', 'success');
      loadMyAccounts();
      loadAvailableAccounts();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// 启动 OAuth 绑定
// - gmail: 新窗口打开授权页,主页面轮询直到窗口关闭
// - outlook: 微软改用 Device Code Flow (无需 redirect_uri),弹窗显示 user_code + 链接,轮询状态
async function startOAuth(provider) {
  if (provider === 'outlook') return startMsDeviceFlow();
  try {
    const data = await api('/api/account/oauth/start?provider=' + provider);
    if (!data.auth_url) { toast('未获取到授权地址', 'error'); return; }
    const win = window.open(data.auth_url, '_blank');
    if (!win) { toast('浏览器拦截了弹窗，请允许后重试', 'warning'); return; }
    toast('请在弹出的窗口完成授权', 'info', 4000);
    if (State.oauthTimer) clearInterval(State.oauthTimer);
    State.oauthTimer = setInterval(() => {
      if (win.closed) {
        clearInterval(State.oauthTimer);
        State.oauthTimer = null;
        loadMyAccounts();
        loadAvailableAccounts();
        toast('授权流程结束', 'success');
      }
    }, 2000);
  } catch (err) { toast(err.message, 'error'); }
}

// 微软 Device Code Flow: 弹窗显示 user_code + 验证链接,每 4 秒轮询状态
async function startMsDeviceFlow() {
  let data;
  try {
    data = await api('/api/account/oauth/device', { method: 'POST' });
  } catch (err) { toast(err.message, 'error'); return; }
  showModal('微软邮箱授权', `
    <div style="text-align:center; padding:8px 0">
      <p style="margin-bottom:12px">请在新页面登录微软账号并输入以下代码完成授权:</p>
      <div style="font-size:28px; font-weight:700; letter-spacing:3px; padding:14px; background:var(--bg); border:1px dashed var(--border); border-radius:8px; margin-bottom:14px; font-family:monospace">${esc(data.user_code)}</div>
      <a href="${esc(data.verification_uri)}" target="_blank" class="btn" style="display:inline-block; text-decoration:none">打开授权页面</a>
      <p class="form-hint" style="margin-top:14px">代码有效期 ${data.expires_in || 900} 秒,授权完成后本窗口会自动关闭</p>
      <div id="deviceStatus" style="margin-top:10px"><span class="badge badge-gray">等待授权中...</span></div>
    </div>`,
    `<button class="btn btn-secondary" onclick="cancelMsDevice()">取消</button>`);
  // 轮询授权状态
  if (State.deviceTimer) clearInterval(State.deviceTimer);
  State.deviceTimer = setInterval(async () => {
    try {
      const st = await api('/api/account/oauth/device/status');
      const el = document.getElementById('deviceStatus');
      if (st.status === 'success') {
        clearInterval(State.deviceTimer); State.deviceTimer = null;
        if (el) el.innerHTML = '<span class="badge badge-success">授权成功: ' + esc(st.email || '') + '</span>';
        toast('微软邮箱 ' + (st.email || '') + ' 绑定成功', 'success');
        setTimeout(() => { closeModal(); loadMyAccounts(); loadAvailableAccounts(); }, 1500);
      } else if (st.status === 'failed') {
        clearInterval(State.deviceTimer); State.deviceTimer = null;
        if (el) el.innerHTML = '<span class="badge badge-danger">' + esc(st.reason || '授权失败') + '</span>';
        toast(st.reason || '授权失败', 'error');
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }, 4000);
}

// 取消微软 device 授权
function cancelMsDevice() {
  if (State.deviceTimer) { clearInterval(State.deviceTimer); State.deviceTimer = null; }
  closeModal();
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
 * 3. Webhook 订阅页
 * ============================================================ */
function viewWebhookHtml() {
  return `
  <div class="page-title">Webhook 订阅</div>
  <div class="page-desc">当邮箱收到新邮件时,系统会主动向你的回调 URL 推送邮件数据</div>
  <div class="grid-2">
    <div class="card">
      <div class="card-header"><h3>创建订阅</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">监听邮箱 <span class="req">*</span></label>
          <select id="whAccount" class="form-control"><option value="">加载中...</option></select>
        </div>
        <div class="form-group">
          <label class="form-label">回调 URL <span class="req">*</span></label>
          <input type="text" id="whUrl" class="form-control" placeholder="直接填飞书机器人地址 https://open.feishu.cn/open-apis/bot/v2/hook/xxx">
        </div>
        <div class="form-group">
          <label class="form-label">订阅事件 <span class="req">*</span></label>
          <div style="display:flex; gap:16px; padding-top:6px">
            <label class="switch"><input type="checkbox" id="whEvNew" checked><span class="track"></span><span>new_mail 新邮件</span></label>
            <label class="switch"><input type="checkbox" id="whEvUnread"><span class="track"></span><span>unread 未读</span></label>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">目标别名 (可选)</label>
          <input type="text" id="whAlias" class="form-control" placeholder="仅推送命中此别名的邮件,留空表示全部">
        </div>
        <div class="form-group">
          <label class="form-label">签名密钥 Secret (可选)</label>
          <input type="text" id="whSecret" class="form-control" placeholder="填写后推送将携带 X-Webhook-Signature 签名">
        </div>
        <button class="btn" onclick="createWebhook()">创建订阅</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>已订阅列表</h3></div>
      <div class="card-body">
        <div id="whList"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
      </div>
    </div>
  </div>`;
}

async function initWebhookPage() {
  try {
    // 监听邮箱:自己拥有的邮箱(可监听全部) + 公开邮箱(仅限自己的别名)
    const list = await api('/api/account/mail_accounts/available');
    const sel = document.getElementById('whAccount');
    if (!list || !list.length) {
      sel.innerHTML = '<option value="">无可用邮箱</option>';
    } else {
      sel.innerHTML = list.map(a => {
        const own = a.is_own;
        // 自己的邮箱:可监听整箱;别人的公开邮箱:仅限自己的别名
        const tag = own ? '可监听整箱' : '仅限我的别名';
        return `<option value="${esc(a.id)}" data-own="${own ? 1 : 0}">${esc(a.email)} (${esc(a.provider)} · ${tag})</option>`;
      }).join('');
    }
    onWhAccountChange();
    sel.onchange = onWhAccountChange;
  } catch (err) { toast(err.message, 'error'); }
  loadWebhooks();
}

// 选中监听邮箱后:若是别人的公开邮箱,自动锁定 target_alias 为自己的别名(且禁用编辑)
function onWhAccountChange() {
  const sel = document.getElementById('whAccount');
  const aliasInput = document.getElementById('whAlias');
  if (!sel || !aliasInput) return;
  const opt = sel.options[sel.selectedIndex];
  const isOwn = opt && opt.dataset.own === '1';
  const aliasFull = State.user && State.user.alias ? State.user.alias.full : '';
  if (isOwn) {
    // 自己的邮箱:别名可选
    aliasInput.disabled = false;
    aliasInput.placeholder = '仅推送命中此别名的邮件,留空表示全部';
  } else {
    // 别人的公开邮箱:强制锁定为自己的别名
    aliasInput.value = aliasFull;
    aliasInput.disabled = true;
    aliasInput.placeholder = '已锁定为你的别名';
  }
}

async function loadWebhooks() {
  const box = document.getElementById('whList');
  if (!box) return;
  try {
    const list = await api('/api/webhooks');
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">暂无订阅</div>';
      return;
    }
    box.innerHTML = list.map(w => `
      <div class="mail-item" style="margin-bottom:10px">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="mono" style="font-size:12px">${esc(w.url)}</span>
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>邮箱ID: ${esc(w.mail_account_id)}</span>
            <span>事件: ${esc(w.events)}</span>
            ${w.target_alias ? `<span>别名: ${esc(w.target_alias)}</span>` : ''}
            ${w.secret ? '<span class="badge badge-primary">已设签名</span>' : ''}
            <span>创建: ${fmtTime(w.created_at)}</span>
          </div>
          <div class="actions">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

async function createWebhook() {
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  const body = {
    mail_account_id: document.getElementById('whAccount').value,
    url: document.getElementById('whUrl').value.trim(),
    events: events.join(','),
    target_alias: document.getElementById('whAlias').value.trim() || undefined,
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.mail_account_id) { toast('请选择监听邮箱', 'warning'); return; }
  if (!body.url) { toast('请填写回调 URL', 'warning'); return; }
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  try {
    await api('/api/webhooks', { method: 'POST', body });
    toast('订阅创建成功', 'success');
    // 每用户仅一个 webhook,旧的已被后端清除,刷新列表;别名框按邮箱类型重置
    ['whUrl', 'whSecret'].forEach(id => document.getElementById(id).value = '');
    onWhAccountChange();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error'); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    toast(data.success ? '测试推送已发送' : '测试推送失败', data.success ? 'success' : 'error');
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteWebhook(id) {
  confirmDialog('确认删除此 Webhook 订阅？', async () => {
    try {
      await api('/api/webhooks/' + id, { method: 'DELETE' });
      toast('已删除', 'success');
      loadWebhooks();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============================================================
 * 4. API 接入文档页(消费者视角,含代码示例与一键复制)
 * ============================================================ */

// 复制代码到剪贴板: 复制成功后按钮短暂变为「已复制」
async function copyCode(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  } catch (e) {
    btn.textContent = '复制失败';
    setTimeout(() => btn.textContent = '复制', 2000);
  }
}

// 代码块组件: 右上角复制按钮 + pre/code 结构
// 把代码安全注入到 onclick 属性: 先 JSON 序列化, 再 HTML 转义属性值
function codeBlock(code) {
  const attr = JSON.stringify(code)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  return `<div class="code-block-wrap">
  <button class="copy-btn" onclick="copyCode(this, ${attr})">复制</button>
  <pre class="code-block"><code>${esc(code)}</code></pre>
</div>`;
}

// 代码块切换 tab 容器: curl / Python 两段代码各自带复制按钮, 默认显示 curl
function codeTabs(curlCode, pythonCode) {
  return `<div class="code-tabs">
  <div class="tab-bar">
    <button class="tab active" onclick="switchCodeTab(this, 'curl')">curl</button>
    <button class="tab" onclick="switchCodeTab(this, 'python')">Python</button>
  </div>
  <div class="code-pane curl">${codeBlock(curlCode)}</div>
  <div class="code-pane python" style="display:none">${codeBlock(pythonCode)}</div>
</div>`;
}

// 切换 curl / Python 代码块显隐
function switchCodeTab(btn, type) {
  const wrap = btn.closest('.code-tabs');
  wrap.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  wrap.querySelectorAll('.code-pane').forEach(p => p.style.display = 'none');
  wrap.querySelector('.code-pane.' + type).style.display = 'block';
}

// 端点标题组件: 方法标签 + 路径 + 简短描述
function endpointHeader(method, path, desc) {
  const m = method.toLowerCase();
  return `<div class="endpoint">
    <span class="method m-${m}">${method}</span><span class="path">${esc(path)}</span>
    <div class="desc">${esc(desc)}</div>
  </div>`;
}

// 参数表格组件(四列: 字段/类型/必填/说明)
function paramTable(rows) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="mono">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// 字段说明表格(三列: 字段/类型/说明)
function fieldTable(rows) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="mono">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function viewDocsHtml() {
  // 动态读取当前登录用户的 API Key, 未登录用占位符; 每次切换到文档页都会重新渲染
  const apiKey = (State.user && State.user.api_key) ? State.user.api_key : 'YOUR_API_KEY';
  const API_BASE = 'https://your-worker.workers.dev';

  // A. 查询邮件 — curl / Python / 响应示例
  const curlFetch = `curl -X POST "${API_BASE}/api/email/fetch?key=${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "user+site@gmail.com",
    "unseen": true,
    "limit": 20
  }'`;

  const pyFetch = `import requests

API_BASE = "${API_BASE}"
API_KEY = "${apiKey}"

# 查询别名邮箱的未读邮件
resp = requests.post(
    f"{API_BASE}/api/email/fetch",
    params={"key": API_KEY},
    json={
        "to": "user+site@gmail.com",     # 别名邮箱地址
        "sender": "",                    # 可选: 按发件人筛选
        "subject": "",                   # 可选: 按主题筛选
        "keyword": "验证码",              # 可选: 全文搜索
        "unseen": True,                  # 可选: 仅未读邮件
        "limit": 20,                     # 可选: 返回数量, 默认 50, 上限 100
        # "start_time": "2026-01-01T00:00:00Z",
        # "end_time":   "2026-07-08T00:00:00Z",
    },
    timeout=30,
)
data = resp.json()
if data["code"] != 0:
    raise RuntimeError(data["msg"])

result = data["data"]
print(f"共 {result['total']} 封邮件")
for mail in result["emails"]:
    print(f"- [{mail['date']}] {mail['subject']}  from {mail['from']}")
    print(f"  正文: {mail['body'][:200]}")`;

  const respFetch = `{
  "code": 0,
  "msg": "ok",
  "data": {
    "total": 1,
    "emails": [
      {
        "id": "msg-abc123",
        "from": "noreply@example.com",
        "to": "user+site@gmail.com",
        "subject": "您的验证码",
        "date": "2026-07-08 14:30:00",
        "date_iso": "2026-07-08T06:30:00.000Z",
        "body": "您的验证码是 884213,5 分钟内有效。",
        "html": "<p>您的验证码是 <b>884213</b>,5 分钟内有效。</p>",
        "unread": true,
        "provider": "gmail"
      }
    ],
    "query": {
      "to": "user+site@gmail.com",
      "unseen": true,
      "limit": 20
    }
  }
}`;

  // B. 标记邮件已读 — curl / Python / 响应示例
  const curlMarkRead = `curl -X POST "${API_BASE}/api/email/mark_read?key=${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "user+site@gmail.com",
    "sender": "noreply@example.com"
  }'`;

  const pyMarkRead = `import requests

API_BASE = "${API_BASE}"
API_KEY = "${apiKey}"

# 把指定发件人发来的邮件标记为已读
resp = requests.post(
    f"{API_BASE}/api/email/mark_read",
    params={"key": API_KEY},
    json={
        "to": "user+site@gmail.com",       # 必填: 别名邮箱
        "sender": "noreply@example.com",   # 可选: 仅标记该发件人
        # "subject": "验证码",             # 可选: 仅标记含该主题的邮件
    },
    timeout=30,
)
data = resp.json()
if data["code"] != 0:
    raise RuntimeError(data["msg"])

print(f"已标记 {data['data']['marked']} 封邮件为已读")`;

  const respMarkRead = `{
  "code": 0,
  "msg": "ok",
  "data": {
    "marked": 3
  }
}`;

  // C. 触发 Webhook 推送 — curl / Python / 响应示例
  const curlPoll = `curl "${API_BASE}/api/webhook/poll?key=${apiKey}&account_id=ACCOUNT_ID"`;

  const pyPoll = `import requests

API_BASE = "${API_BASE}"
API_KEY = "${apiKey}"
ACCOUNT_ID = "your-account-id"   # 在「我的账户」页可查看

# 主动触发一次轮询: 系统会拉取最近 10 分钟邮件并推送到订阅的回调 URL
resp = requests.get(
    f"{API_BASE}/api/webhook/poll",
    params={"key": API_KEY, "account_id": ACCOUNT_ID},
    timeout=30,
)
data = resp.json()
if data["code"] != 0:
    raise RuntimeError(data["msg"])

result = data["data"]
print(f"本次推送 {result['pushed']} 个订阅, 失败 {len(result['errors'])} 个")`;

  const respPoll = `{
  "code": 0,
  "msg": "ok",
  "data": {
    "pushed": 2,
    "errors": []
  }
}`;

  // D. 接收 Webhook 推送的 Python 示例(Flask + 飞书推送, 不含验签)
  const pyFlask = `import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# 飞书群机器人 webhook 地址(替换为你自己的)
FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"


def push_to_feishu(text: str):
    """把消息推送到飞书群机器人"""
    requests.post(
        FEISHU_WEBHOOK,
        json={"msg_type": "text", "content": {"text": text}},
        timeout=10,
    )


@app.route("/webhook", methods=["POST"])
def receive_webhook():
    payload = request.get_json(force=True)
    event = payload.get("event")
    emails = payload.get("emails", [])
    alias = payload.get("to_alias", "无别名")

    # 拼接飞书消息内容
    lines = [f"收到新邮件通知 ({event})"]
    lines.append(f"主邮箱: {payload.get('email')}  别名: {alias}")
    lines.append(f"共 {payload.get('count', 0)} 封邮件:")
    for mail in emails:
        lines.append(
            f"- [{mail.get('date')}] {mail.get('subject')}"
            f"  from {mail.get('from')}"
        )
        body = mail.get("body", "")
        if body:
            lines.append(f"  正文: {body[:200]}")

    push_to_feishu("\\n".join(lines))
    return jsonify({"ok": True}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)`;

  return `
  <style>
    .code-block-wrap { position: relative; margin: 12px 0; }
    .copy-btn { position: absolute; top: 8px; right: 8px; padding: 4px 10px; font-size: 12px; background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; transition: all 0.2s; z-index: 1; }
    .copy-btn:hover { background: rgba(255,255,255,0.2); }
    .copy-btn.copied { background: #16a34a; border-color: #16a34a; }
    .code-block { background: #1e293b; color: #e2e8f0; padding: 16px; padding-top: 40px; border-radius: 8px; overflow-x: auto; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; line-height: 1.6; }
    .code-block code { background: none; padding: 0; font: inherit; color: inherit; }
    /* API 文档左右布局 */
    .doc-layout { display: flex; gap: 20px; align-items: flex-start; }
    .doc-nav { width: 220px; flex-shrink: 0; position: sticky; top: 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 6px; max-height: calc(100vh - 100px); overflow-y: auto; }
    .doc-nav-item { display: block; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text-light); transition: all 0.15s; margin-bottom: 2px; text-decoration: none; }
    .doc-nav-item:hover { background: var(--bg-hover, #f1f5f9); color: var(--text); }
    .doc-nav-item.active { background: var(--primary); color: #fff; font-weight: 500; }
    .doc-nav-item .method-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-right: 5px; font-family: monospace; }
    .doc-content { flex: 1; min-width: 0; }
    .doc-panel { display: none; }
    .doc-panel.active { display: block; animation: fadeIn 0.2s; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @media (max-width: 768px) { .doc-layout { flex-direction: column; } .doc-nav { width: 100%; position: static; max-height: none; } }
  </style>
  <div class="page-title">API 接入文档</div>
  <div class="page-desc">本页面面向开发者,介绍如何通过 API Key 调用邮件查询接口与 Webhook 推送。所有接口统一返回 <code class="mono">{ code, msg, data }</code>,<code class="mono">code=0</code> 表示成功。</div>

  <div class="doc-layout">
    <nav class="doc-nav" id="docNav">
      <a class="doc-nav-item active" onclick="switchDocPanel('auth')">鉴权方式</a>
      <a class="doc-nav-item" onclick="switchDocPanel('fetch')"><span class="method-tag" style="background:#0ea5e9;color:#fff">POST</span>查询邮件</a>
      <a class="doc-nav-item" onclick="switchDocPanel('markread')"><span class="method-tag" style="background:#0ea5e9;color:#fff">POST</span>标记已读</a>
      <a class="doc-nav-item" onclick="switchDocPanel('poll')"><span class="method-tag" style="background:#16a34a;color:#fff">GET</span>触发推送</a>
      <a class="doc-nav-item" onclick="switchDocPanel('payload')">推送载荷</a>
      <a class="doc-nav-item" onclick="switchDocPanel('fields')">emails 字段</a>
    </nav>
    <div class="doc-content">

    <div class="doc-panel active" id="panel-auth">
      <div class="doc-section">
        <h4>鉴权方式</h4>
        <div class="card card-body">
          <p style="margin-bottom:0"><strong>API Key 认证</strong> — 编程调用时在 URL 上携带查询参数 <code class="mono">?key=&lt;your_api_key&gt;</code>。当前账号的 API Key 可在「我的账户」页重新生成。</p>
        </div>
      </div>
    </div>

    <div class="doc-panel" id="panel-fetch">
      <div class="doc-section">
        <h4>查询邮件</h4>
        ${endpointHeader('POST', '/api/email/fetch?key=YOUR_API_KEY', '按收件地址(含别名)查询邮件,支持多维筛选与全文搜索')}
        <h5>请求参数</h5>
        ${paramTable([
          ['to', 'string', '是', '查询邮箱地址(含别名,如 user+site@gmail.com)'],
          ['sender', 'string', '否', '按发件人邮箱筛选'],
          ['subject', 'string', '否', '按主题关键字筛选'],
          ['keyword', 'string', '否', '全文搜索(自动匹配 from/to/subject/body)'],
          ['unseen', 'boolean', '否', 'true=仅未读邮件'],
          ['start_time', 'string', '否', '开始时间 ISO 8601'],
          ['end_time', 'string', '否', '结束时间 ISO 8601'],
          ['limit', 'number', '否', '返回数量,默认 50,上限 100'],
        ])}
        <h5>请求示例(curl / Python)</h5>
        ${codeTabs(curlFetch, pyFetch)}
        <h5>响应示例</h5>
        ${codeBlock(respFetch)}
      </div>
    </div>

    <div class="doc-panel" id="panel-markread">
      <div class="doc-section">
        <h4>标记邮件已读</h4>
        ${endpointHeader('POST', '/api/email/mark_read?key=YOUR_API_KEY', '把符合条件的邮件标记为已读')}
        <h5>请求参数</h5>
        ${paramTable([
          ['to', 'string', '是', '查询邮箱地址(含别名)'],
          ['sender', 'string', '否', '按发件人筛选,限定标记范围'],
          ['subject', 'string', '否', '按主题筛选,限定标记范围'],
        ])}
        <h5>请求示例(curl / Python)</h5>
        ${codeTabs(curlMarkRead, pyMarkRead)}
        <h5>响应示例</h5>
        ${codeBlock(respMarkRead)}
      </div>
    </div>

    <div class="doc-panel" id="panel-poll">
      <div class="doc-section">
        <h4>触发 Webhook 推送</h4>
        ${endpointHeader('GET', '/api/webhook/poll?key=YOUR_API_KEY&account_id=ACCOUNT_ID', '主动触发一次轮询:系统会拉取该邮箱最近 10 分钟邮件并推送到订阅的回调 URL')}
        <h5>请求参数</h5>
        ${paramTable([
          ['key', 'string', '是', 'API Key(URL 查询参数)'],
          ['account_id', 'string', '是', '邮箱账号 ID(在「我的账户」页可查看)'],
        ])}
        <h5>请求示例(curl / Python)</h5>
        ${codeTabs(curlPoll, pyPoll)}
        <h5>响应示例</h5>
        ${codeBlock(respPoll)}
      </div>
    </div>

    <div class="doc-panel" id="panel-payload">
      <div class="doc-section">
        <h4>Webhook 推送载荷说明</h4>
        <p class="form-hint" style="margin-bottom:12px">系统支持两种推送模式:<br>① <strong>直接推送飞书/钉钉</strong>:回调 URL 填飞书机器人地址(<code class="mono">https://open.feishu.cn/open-apis/bot/v2/hook/xxx</code>),系统自动按飞书消息格式推送,无需中转服务。<br>② <strong>原始 JSON 推送</strong>:回调 URL 填其他地址时,以 POST application/json 推送完整邮件数据。</p>
        <h5>载荷字段(原始 JSON 模式)</h5>
        ${fieldTable([
          ['event', 'string', '事件类型: new_mail / unread / test'],
          ['delivered_at', 'string', '推送时间 ISO 8601'],
          ['mail_account_id', 'string', '邮箱账号 ID'],
          ['email', 'string', '主邮箱地址'],
          ['to_alias', 'string?', '命中的别名(未指定时不存在)'],
          ['count', 'number', '本次推送邮件数量'],
          ['emails', 'array', '邮件数组(字段同查询接口返回)'],
        ])}
        <h5>接收 Webhook 推送的 Python 示例(Flask + 飞书推送)</h5>
        ${codeBlock(pyFlask)}
      </div>
    </div>

    <div class="doc-panel" id="panel-fields">
      <div class="doc-section">
        <h4>邮件对象 emails[] 字段说明</h4>
        ${fieldTable([
          ['id', 'string', '邮件唯一 ID'],
          ['from', 'string', '发件人'],
          ['to', 'string', '收件人(别名地址)'],
          ['subject', 'string', '主题'],
          ['date', 'string', '显示用时间 YYYY-MM-DD HH:MM:SS'],
          ['date_iso', 'string', 'ISO 8601 时间'],
          ['body', 'string', '纯文本正文'],
          ['html', 'string', 'HTML 正文'],
          ['unread', 'boolean', '是否未读'],
          ['provider', 'string', '邮箱提供方 gmail/outlook'],
        ])}
      </div>
    </div>

    </div>
  </div>
  <script>
    // API 文档左侧导航切换:点击接口名,右侧显示对应面板
    function switchDocPanel(name) {
      document.querySelectorAll('.doc-nav-item').forEach(a => a.classList.remove('active'));
      document.querySelectorAll('.doc-panel').forEach(p => p.classList.remove('active'));
      const navItem = Array.from(document.querySelectorAll('.doc-nav-item')).find(a => a.getAttribute('onclick').includes(name));
      if (navItem) navItem.classList.add('active');
      const panel = document.getElementById('panel-' + name);
      if (panel) panel.classList.add('active');
    }
  </script>`;
}

// 代码块语法高亮辅助函数(轻量级,仅做注释/字符串着色)
function escPy(code) { return esc(code); }
function escJs(code) { return esc(code); }

/* ============================================================
 * 5. 管理员 - 用户管理页
 * ============================================================ */
function viewUsersHtml() {
  return `
  <div class="page-title">用户管理</div>
  <div class="page-desc">创建、编辑用户、设置别名、改密、禁用,以及管理所有用户认证的邮箱</div>
  <div class="section">
    <div class="card">
      <div class="card-header" style="display:flex; justify-content:space-between; align-items:center">
        <h3>用户列表</h3>
        <button class="btn btn-sm" onclick="showCreateUserModal()">新建用户</button>
      </div>
      <div class="card-body">
        <div id="usersList" class="table-wrap"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="card">
      <div class="card-header"><h3>所有用户认证邮箱管理</h3></div>
      <div class="card-body">
        <p class="form-hint" style="margin-bottom:12px">在此可统一管理全系统所有用户绑定的邮箱,切换公开状态或删除</p>
        <div id="allAccountsList" class="table-wrap"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
      </div>
    </div>
  </div>`;
}

async function initUsersPage() {
  await loadUsers();
  await loadAllAccounts();
}

async function loadUsers() {
  const box = document.getElementById('usersList');
  if (!box) return;
  try {
    const list = await api('/api/admin/users');
    State.adminUsers = list || [];
    box.innerHTML = `<table class="table">
      <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>API Key</th><th>邮箱数</th><th>别名</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${list.map(u => `
        <tr>
          <td><strong>${esc(u.username)}</strong></td>
          <td>${u.is_admin ? '<span class="badge badge-primary">管理员</span>' : '<span class="badge badge-gray">用户</span>'}</td>
          <td>${u.disabled ? '<span class="badge badge-danger">已禁用</span>' : '<span class="badge badge-success">正常</span>'}</td>
          <td class="mono" style="font-size:12px">${esc(u.api_key)}</td>
          <td>${u.mail_accounts ? u.mail_accounts.length : 0}</td>
          <td>${u.alias ? '<span class="badge badge-success">' + esc(u.alias.full) + '</span>' : '-'}</td>
          <td>${fmtTime(u.created_at)}</td>
          <td>
            <button class="btn btn-sm" onclick="showEditUserModal('${esc(u.id)}')">编辑</button>
            ${u.is_admin ? '' : `<button class="btn ${u.disabled ? 'btn-secondary' : 'btn-warning'} btn-sm" onclick="toggleDisableUser('${esc(u.id)}', ${!u.disabled})">${u.disabled ? '启用' : '禁用'}</button>`}
            ${u.is_admin ? '' : `<button class="btn btn-danger btn-sm" onclick="deleteUser('${esc(u.id)}','${esc(u.username)}')">删除</button>`}
          </td>
        </tr>`).join('')}</tbody>
    </table>`;
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

// 加载所有用户邮箱(管理员邮箱管理板块)
async function loadAllAccounts() {
  const box = document.getElementById('allAccountsList');
  if (!box) return;
  try {
    const list = await api('/api/admin/mail_accounts');
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">暂无任何用户绑定的邮箱</div>';
      return;
    }
    box.innerHTML = `<table class="table">
      <thead><tr><th>邮箱</th><th>类型</th><th>归属用户</th><th>是否公开</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${list.map(a => `
        <tr>
          <td><span class="mono">${esc(a.email)}</span></td>
          <td><span class="badge ${a.provider === 'gmail' ? 'badge-primary' : 'badge-warning'}">${esc(a.provider)}</span></td>
          <td>${esc(a.owner_username || '-')}</td>
          <td>
            <label class="switch" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer">
              <input type="checkbox" ${a.is_public ? 'checked' : ''} onchange="adminTogglePublic('${esc(a.id)}', this.checked)">
              <span class="track"></span>
              <span>${a.is_public ? '公开' : '私有'}</span>
            </label>
          </td>
          <td>${fmtTime(a.created_at)}</td>
          <td><button class="btn btn-danger btn-sm" onclick="adminDeleteAccount('${esc(a.id)}','${esc(a.email)}')">删除</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

// 管理员切换邮箱公开状态
async function adminTogglePublic(id, isPublic) {
  try {
    await api('/api/admin/mail_accounts/' + id, { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开' : '已设为私有', 'success');
    loadAllAccounts();
  } catch (err) { toast(err.message, 'error'); loadAllAccounts(); }
}

// 管理员删除邮箱
async function adminDeleteAccount(id, email) {
  confirmDialog(`确认删除邮箱 ${email}？`, async () => {
    try {
      await api('/api/admin/mail_accounts/' + id, { method: 'DELETE' });
      toast('邮箱已删除', 'success');
      loadAllAccounts();
      loadUsers();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function showCreateUserModal() {
  showModal('新建用户', `
    <div class="form-group">
      <label class="form-label">用户名 <span class="req">*</span></label>
      <input type="text" id="newUsername" class="form-control" placeholder="至少 3 个字符">
    </div>
    <div class="form-group">
      <label class="form-label">密码 <span class="req">*</span></label>
      <input type="password" id="newPassword" class="form-control" placeholder="至少 6 个字符">
    </div>
    <div class="form-group">
      <label class="switch"><input type="checkbox" id="newIsAdmin"><span class="track"></span><span>设为管理员</span></label>
    </div>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button><button class="btn" onclick="createUser()">创建</button>`);
  setTimeout(() => document.getElementById('newUsername').focus(), 50);
}

async function createUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const is_admin = document.getElementById('newIsAdmin').checked;
  if (!username || username.length < 3) { toast('用户名至少 3 个字符', 'warning'); return; }
  if (!password || password.length < 6) { toast('密码至少 6 个字符', 'warning'); return; }
  try {
    await api('/api/admin/users', { method: 'POST', body: { username, password, is_admin } });
    toast('用户创建成功', 'success');
    closeModal();
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

// 编辑用户弹窗: 用户名 / 角色 / 重置密码 / 设置别名 (改密整合进编辑)
function showEditUserModal(id) {
  const u = (State.adminUsers || []).find(x => x.id === id);
  if (!u) return;
  const aliasMailId = u.alias ? u.alias.mail_account_id : (u.mail_accounts[0] ? u.mail_accounts[0].id : '');
  const mailOpts = (u.mail_accounts || []).map(a =>
    `<option value="${esc(a.id)}" ${a.id === aliasMailId ? 'selected' : ''}>${esc(a.email)}</option>`
  ).join('');
  showModal('编辑用户 - ' + u.username, `
    <div class="form-group">
      <label class="form-label">用户名 <span class="req">*</span></label>
      <input type="text" id="editUsername" class="form-control" value="${esc(u.username)}">
    </div>
    <div class="form-group">
      <label class="form-label">新密码 <span class="form-hint" style="font-weight:normal">(留空则不修改)</span></label>
      <input type="password" id="editPassword" class="form-control" placeholder="至少 6 个字符">
    </div>
    <div class="form-group">
      <label class="switch"><input type="checkbox" id="editIsAdmin" ${u.is_admin ? 'checked' : ''}><span class="track"></span><span>管理员</span></label>
    </div>
    <hr style="border:none; border-top:1px solid var(--border); margin:16px 0">
    <div class="form-group">
      <label class="form-label">设置别名 (选择该用户的邮箱 + 标签)</label>
      <div style="display:flex; gap:8px">
        <select id="editAliasMail" class="form-control" style="flex:2">${mailOpts || '<option value="">无邮箱</option>'}</select>
        <input type="text" id="editAliasLabel" class="form-control" style="flex:2" placeholder="别名标签" value="${esc(u.alias ? u.alias.label : '')}">
      </div>
    </div>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button><button class="btn" onclick="saveEditUser('${esc(id)}')">保存</button>`);
}

// 保存编辑: 用户名/密码/角色走 PUT, 别名走 POST alias
async function saveEditUser(id) {
  const username = document.getElementById('editUsername').value.trim();
  const password = document.getElementById('editPassword').value;
  const is_admin = document.getElementById('editIsAdmin').checked;
  if (!username || username.length < 3) { toast('用户名至少 3 个字符', 'warning'); return; }
  if (password && password.length < 6) { toast('新密码至少 6 个字符', 'warning'); return; }
  const body = { username, is_admin };
  if (password) body.password = password;
  try {
    await api('/api/admin/users/' + id, { method: 'PUT', body });
    // 设置别名 (仅当选择了邮箱且填了标签)
    const mailId = document.getElementById('editAliasMail').value;
    const label = document.getElementById('editAliasLabel').value.trim();
    if (mailId && label) {
      await api('/api/admin/users/' + id + '/alias', { method: 'POST', body: { mail_account_id: mailId, label } });
    }
    toast('用户信息已更新', 'success');
    closeModal();
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

// 禁用 / 启用用户
async function toggleDisableUser(id, disable) {
  try {
    await api('/api/admin/users/' + id, { method: 'PUT', body: { disabled: disable } });
    toast(disable ? '用户已禁用' : '用户已启用', 'success');
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteUser(id, username) {
  confirmDialog(`确认删除用户 ${username}？此操作不可恢复`, async () => {
    try {
      await api('/api/admin/users/' + id, { method: 'DELETE' });
      toast('用户已删除', 'success');
      loadUsers();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============================================================
 * 6. 管理员 - 系统设置页
 * ============================================================ */
function viewSettingsHtml() {
  return `
  <div class="page-title">系统设置</div>
  <div class="page-desc">管理系统级开关与查看运行统计</div>
  <div class="grid-2">
    <div class="card">
      <div class="card-header"><h3>基础设置</h3></div>
      <div class="card-body">
        <div class="info-item">
          <span class="label">允许注册</span>
          <label class="switch">
            <input type="checkbox" id="setAllowReg" onchange="saveSettings()">
            <span class="track"></span>
            <span id="setAllowRegText"></span>
          </label>
        </div>
        <p class="form-hint">关闭后,注册接口将拒绝新用户注册</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>系统统计</h3></div>
      <div class="card-body">
        <div class="grid-3" id="statsCards"><div class="loading"><span class="spinner"></span></div></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="card">
      <div class="card-header"><h3>调用日志</h3></div>
      <div class="card-body">
        <div id="logsBox" class="table-wrap"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
      </div>
    </div>
  </div>`;
}

async function initSettingsPage() {
  // 读取注册开关
  try {
    const s = await api('/api/admin/settings');
    document.getElementById('setAllowReg').checked = s.allow_registration;
    document.getElementById('setAllowRegText').textContent = s.allow_registration ? '已开启' : '已关闭';
  } catch (err) { toast(err.message, 'error'); }
  await loadStats();
  // 日志改分页加载, 默认拉取第 1 页
  await loadLogs(1);
}

async function saveSettings() {
  const allow_registration = document.getElementById('setAllowReg').checked;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { allow_registration } });
    document.getElementById('setAllowRegText').textContent = allow_registration ? '已开启' : '已关闭';
    toast('设置已保存', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadStats() {
  try {
    const data = await api('/api/admin/stats');
    const s = data.summary || {};
    const userCount = Object.keys(s.by_user || {}).length;
    const aliasCount = Object.keys(s.by_alias || {}).length;
    document.getElementById('statsCards').innerHTML = `
      <div class="stat-card"><div class="num">${s.total_calls || 0}</div><div class="lbl">总调用次数</div></div>
      <div class="stat-card"><div class="num">${userCount}</div><div class="lbl">活跃用户数</div></div>
      <div class="stat-card"><div class="num">${s.mail_account_count || 0}</div><div class="lbl">邮箱账号数</div></div>`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 分页加载调用日志, 仅刷新日志表格区域, 不动整页
async function loadLogs(page) {
  page = Math.max(1, parseInt(page, 10) || 1);
  const box = document.getElementById('logsBox');
  if (!box) return;
  box.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  try {
    const data = await api('/api/admin/logs?page=' + page);
    const logs = (data && data.logs) || [];
    const total = (data && data.total) || 0;
    const totalPages = (data && data.total_pages) || 1;
    const currentPage = (data && data.page) || page;
    // 缓存当前页与总页数, 供跳转按钮校验
    State.logPage = currentPage;
    State.logTotalPages = totalPages;
    if (!logs.length) {
      box.innerHTML = '<div class="mail-empty">暂无日志</div>';
      return;
    }
    const rows = logs.map(l => `
        <tr>
          <td>${fmtTime(l.created_at)}</td>
          <td>${esc(l.username)}</td>
          <td class="mono" style="font-size:12px">${esc(l.target || '-')}</td>
          <td><span class="badge badge-gray">${esc(l.action)}</span></td>
          <td>${esc(l.detail || '-')}</td>
        </tr>`).join('');
    box.innerHTML = `<table class="table">
      <thead><tr><th>时间</th><th>用户</th><th>目标</th><th>动作</th><th>详情</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="pagination">
      <button class="btn btn-sm" onclick="loadLogs(1)">首页</button>
      <button class="btn btn-sm" onclick="loadLogs(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="page-info">第 ${currentPage} / ${totalPages} 页 (共 ${total} 条)</span>
      <button class="btn btn-sm" onclick="loadLogs(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
      <input type="number" min="1" max="${totalPages}" value="${currentPage}" id="logPageInput">
      <button class="btn btn-sm" onclick="jumpLogPage()">跳转</button>
    </div>`;
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

// 跳转到指定页码日志
function jumpLogPage() {
  const input = document.getElementById('logPageInput');
  if (!input) return;
  let page = parseInt(input.value, 10);
  if (!page || page < 1) { toast('请输入有效页码', 'warning'); return; }
  const max = State.logTotalPages || 1;
  if (page > max) { toast('页码超出范围, 最大 ' + max + ' 页', 'warning'); return; }
  loadLogs(page);
}

/* ============================================================
 * 启动入口
 * ============================================================ */
(async function init() {
  // 检查注册开关
  await checkRegistrationAllowed();
  // 尝试恢复会话
  const token = localStorage.getItem(LS_TOKEN);
  const userJson = localStorage.getItem(LS_USER);
  if (token && userJson) {
    State.token = token;
    try {
      State.user = JSON.parse(userJson);
    } catch { clearSession(); }
    // 用 /api/auth/me 校验 token 是否仍有效
    try {
      const me = await api('/api/auth/me');
      State.user = me;
      localStorage.setItem(LS_USER, JSON.stringify(me));
      showAppView();
    } catch {
      // token 失效,留在登录页
      clearSession();
      showLoginView();
    }
  } else {
    showLoginView();
  }
})();
