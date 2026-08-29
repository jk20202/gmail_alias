/* ============================================================
 * account.js — 我的账户页
 *   · 基本信息 / API Key
 *   · 修改密码弹窗
 *   · 邮箱绑定弹窗: 跳转授权(推荐) / 设备码 / 应用密码(说明)
 * ============================================================ */

async function initAccountPage() {
  fillAccountInfo();
  await loadMyAccounts();
  // 监听 OAuth 跳转授权成功后子窗口 postMessage
  window.addEventListener('message', onOAuthMessage);
}

function onOAuthMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'oauth_bind_success') {
    toast((e.data.email || '邮箱') + ' 绑定成功', 'success');
    loadMyAccounts();
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
  } else if (e.data.type === 'oauth_bind_failed') {
    toast(e.data.message || '绑定失败', 'error', 5000);
  }
}

// 填充基本信息
function fillAccountInfo() {
  const u = State.user;
  if (!u) return;
  document.getElementById('accUsername').textContent = u.username;
  document.getElementById('accRole').innerHTML = u.is_admin
    ? '<span class="badge badge-primary">管理员</span>'
    : '<span class="badge badge-gray">普通用户</span>';
  document.getElementById('accCreatedAt').textContent = fmtTime(u.created_at);
  document.getElementById('apiKeyText').textContent = u.api_key;
  const copyBtn = document.getElementById('btnCopyApiKey');
  if (copyBtn) copyBtn.onclick = () => copyText(u.api_key);
}

/* ============ 修改密码弹窗 ============ */
function openChangePasswordModal() {
  showModal('修改密码', `
    <div class="form-group">
      <label class="form-label">原密码 <span class="req">*</span></label>
      <input type="password" id="modalOldPassword" class="form-control" placeholder="请输入当前密码">
    </div>
    <div class="form-group">
      <label class="form-label">新密码 <span class="req">*</span></label>
      <input type="password" id="modalNewPassword" class="form-control" placeholder="至少 6 个字符">
    </div>
    <div class="form-group">
      <label class="form-label">确认新密码 <span class="req">*</span></label>
      <input type="password" id="modalConfirmPassword" class="form-control" placeholder="再次输入新密码">
    </div>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="modalSavePasswordBtn">保存修改</button>`);
  const btn = document.getElementById('modalSavePasswordBtn');
  if (btn) btn.onclick = () => doChangePassword();
}

async function doChangePassword() {
  const oldPassword = document.getElementById('modalOldPassword').value;
  const newPassword = document.getElementById('modalNewPassword').value;
  const confirmPassword = document.getElementById('modalConfirmPassword').value;
  if (!oldPassword) { toast('请输入原密码', 'warning'); return; }
  if (!newPassword || newPassword.length < 6) { toast('新密码至少 6 个字符', 'warning'); return; }
  if (newPassword !== confirmPassword) { toast('两次输入的新密码不一致', 'warning'); return; }
  try {
    await api('/api/auth/change_password', {
      method: 'POST',
      body: { old_password: oldPassword, new_password: newPassword }
    });
    toast('密码修改成功', 'success');
    closeModal();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============ 邮箱列表 ============ */
async function loadMyAccounts() {
  const box = document.getElementById('myAccounts');
  if (!box) return;
  try {
    const list = await api('/api/account/mail_accounts');
    State.mailAccounts = list || [];
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">尚未绑定任何邮箱，点击上方按钮开始绑定</div>';
      return;
    }
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
    list.forEach(a => probeAuthStatus(a.id));
  } catch (err) { box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`; }
}

async function probeAuthStatus(id) {
  const cell = document.getElementById('acc-status-' + id);
  if (!cell) return;
  try {
    const data = await api('/api/account/mail_accounts/' + id + '/status');
    if (data && data.ok) { cell.innerHTML = '<span class="badge badge-success">已授权</span>'; }
    else {
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

function reauthAccount(id, provider) {
  openBindModal(provider);
}

async function togglePublic(id, isPublic) {
  try {
    await api('/api/account/mail_accounts/' + id + '/public', { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开,其他用户可使用此邮箱' : '已设为私有', 'success');
    loadMyAccounts();
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
  } catch (err) { toast(err.message, 'error'); loadMyAccounts(); }
}

async function regenApiKey() {
  confirmDialog('重新生成后旧 API Key 将立即失效，确认操作？', async () => {
    try {
      const updated = await api('/api/account/api_key', { method: 'POST' });
      State.user = updated;
      localStorage.setItem(LS_USER, JSON.stringify(updated));
      fillAccountInfo();
      toast('API Key 已重新生成', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteAccount(id, email) {
  confirmDialog(`确认删除邮箱 ${email}？关联的别名也会被清除`, async () => {
    try {
      await api('/api/account/mail_accounts/' + id, { method: 'DELETE' });
      toast('已删除邮箱', 'success');
      loadMyAccounts();
      if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============ 绑定方式弹窗 ============ */
function openBindModal(provider) {
  const isGmail = provider === 'gmail';
  const title = isGmail ? '绑定 Gmail' : '绑定 Outlook / Hotmail';
  const body = `
    <div class="bind-options">
      <div class="bind-option" onclick="startRedirectAuth('${provider}')">
        <div class="bind-option-title">🌐 跳转授权（推荐）</div>
        <div class="bind-option-desc">自动打开 Google / 微软授权页，授权完成后自动关闭窗口。可重复绑定多个账号。</div>
      </div>
      <div class="bind-option" onclick="startDeviceAuth('${provider}')">
        <div class="bind-option-title">⌨️ 设备码授权</div>
        <div class="bind-option-desc">复制弹出的授权码，到授权页输入完成绑定。适合网络代理不稳定的环境。</div>
      </div>
      ${isGmail ? `
      <div class="bind-option" onclick="showAppPasswordInfo()">
        <div class="bind-option-title">🔑 应用密码 (App Password)</div>
        <div class="bind-option-desc">使用 Gmail 生成的 16 位应用密码。当前版本仅支持 OAuth 方式收取邮件，应用密码方式暂未接入。</div>
      </div>` : ''}
    </div>`;
  showModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">取消</button>');
}

function showAppPasswordInfo() {
  showModal('应用密码绑定（暂不支持）', `
    <p>应用密码（App Password）是 Gmail 为开启两步验证的账号提供的 16 位专用密码，仅用于 <b>IMAP / SMTP</b> 客户端。</p>
    <p class="form-hint" style="margin-top:10px">当前系统通过 <b>Gmail API（OAuth 2.0）</b> 收取邮件，与应用密码走的 IMAP 通道完全不同。要在 Cloudflare Workers 上支持应用密码，需要额外实现一套完整的 IMAP 客户端（含 TLS、命令解析、收件轮询），工作量较大，且与现有 token 刷新机制不兼容。因此现阶段建议直接使用上方的「跳转授权 / 设备码」OAuth 方式绑定，体验一致且无需改代码。</p>`,
    '<button class="btn btn-secondary" onclick="closeModal()">知道了</button>');
}

/* ============ 跳转授权 ============ */
let _oauthPopup = null;
async function startRedirectAuth(provider) {
  if (provider === 'gmail' && !(await ensureGoogleCreds('redirect'))) return;
  try {
    const data = await api('/api/account/oauth/start?provider=' + provider);
    closeModal();
    _oauthPopup = window.open(data.auth_url, 'oauth_' + provider, 'width=600,height=700,scrollbars=yes');
    if (!_oauthPopup) toast('弹窗被浏览器拦截，请允许弹窗后重试', 'error');
  } catch (err) { toast(err.message, 'error', 5000); }
}

/* ============ 设备码授权 ============ */
async function startDeviceAuth(provider) {
  if (provider === 'gmail' && !(await ensureGoogleCreds('device'))) return;
  closeModal();
  if (provider === 'outlook') return startMsDeviceFlow();
  return startGoogleDeviceFlow();
}

// Gmail 绑定前确认凭据:已配置则直接继续;未配置则弹出填写框(普通用户无需进系统设置)
async function ensureGoogleCreds(method) {
  let configured = true;
  try {
    const st = await api('/api/account/oauth/google/status');
    configured = !!st.configured;
  } catch (e) { configured = true; } // 兜底:放行,让原接口给出中文报错
  if (configured) return true;
  showGoogleCredsForm(method);
  return false;
}

function showGoogleCredsForm(method) {
  showModal('填写 Google OAuth 凭据', `
    <p class="form-hint" style="margin:0 0 12px">绑定 Gmail 需要先在 Google Cloud 创建「桌面应用」类型的 OAuth 客户端。填写并保存后即可立即授权（凭据全站共享，只需填一次）。</p>
    <div class="form-group">
      <label class="form-label">Client ID <span class="req">*</span></label>
      <input type="text" id="gcClientId" class="form-control" placeholder="1234567890-xxxx.apps.googleusercontent.com">
    </div>
    <div class="form-group">
      <label class="form-label">Client Secret <span class="req">*</span></label>
      <input type="password" id="gcClientSecret" class="form-control" placeholder="GOCSPX-...">
    </div>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="gcSaveBtn">保存并继续</button>`);
  const btn = document.getElementById('gcSaveBtn');
  if (btn) btn.onclick = () => submitGoogleCreds(method);
}

async function submitGoogleCreds(method) {
  const idEl = document.getElementById('gcClientId');
  const secEl = document.getElementById('gcClientSecret');
  const id = idEl ? idEl.value.trim() : '';
  const secret = secEl ? secEl.value.trim() : '';
  if (!id) { toast('请填写 Client ID', 'warning'); return; }
  if (!secret) { toast('请填写 Client Secret', 'warning'); return; }
  const btn = document.getElementById('gcSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
  try {
    await api('/api/account/oauth/google/creds', { method: 'POST', body: { client_id: id, client_secret: secret } });
    toast('凭据已保存', 'success');
    closeModal();
    if (method === 'redirect') return startRedirectAuth('gmail');
    return startDeviceAuth('gmail');
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '保存并继续'; }
  }
}

// 离开页面时停掉所有轮询
function stopAllDevicePolling() {
  if (State.deviceTimer) { clearInterval(State.deviceTimer); State.deviceTimer = null; }
  if (State.gDeviceTimer) { clearInterval(State.gDeviceTimer); State.gDeviceTimer = null; }
  if (State.oauthTimer) { clearInterval(State.oauthTimer); State.oauthTimer = null; }
}

function renderDeviceModal(opt) {
  showModal(opt.title, `
    <div style="text-align:center; padding:6px 0">
      <p style="margin-bottom:12px; color:var(--text-light)">${opt.tip}</p>
      <div style="font-size:28px; font-weight:700; letter-spacing:3px; padding:14px; background:var(--bg); border:1px dashed var(--border); border-radius:8px; margin-bottom:14px; font-family:monospace; word-break:break-all">${esc(opt.user_code)}</div>
      <a href="${esc(opt.open_url)}" target="_blank" rel="noopener" class="btn" style="display:inline-block; text-decoration:none">打开授权页面</a>
      <p class="form-hint" style="margin-top:14px">代码有效期 ${opt.expires_in || 900} 秒，授权完成后本窗口会自动关闭。授权页面若打不开，请自行开启网络代理后重试。</p>
      <div id="deviceStatus" style="margin-top:10px"><span class="badge badge-gray">等待授权中...</span></div>
    </div>`,
    `<button class="btn btn-secondary" onclick="cancelDevice()">取消</button>`);
}

function bindDevicePolling(statusPath, timerKey, onSuccess) {
  if (State[timerKey]) clearInterval(State[timerKey]);
  State[timerKey] = setInterval(async () => {
    try {
      const st = await api(statusPath);
      const el = document.getElementById('deviceStatus');
      if (st.status === 'success') {
        clearInterval(State[timerKey]); State[timerKey] = null;
        if (el) el.innerHTML = '<span class="badge badge-success">授权成功: ' + esc(st.email || '') + '</span>';
        toast((st.email || '邮箱') + ' 绑定成功', 'success');
        setTimeout(() => { closeModal(); onSuccess(); }, 1500);
      } else if (st.status === 'failed') {
        clearInterval(State[timerKey]); State[timerKey] = null;
        if (el) el.innerHTML = '<span class="badge badge-danger">' + esc(st.reason || '授权失败') + '</span>';
        toast(st.reason || '授权失败', 'error', 5000);
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }, 4000);
}

function afterBindSuccess() {
  loadMyAccounts();
  if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
}

async function startGoogleDeviceFlow() {
  let data;
  try {
    data = await api('/api/account/oauth/google/device', { method: 'POST' });
  } catch (err) {
    toast(err.message, 'error', 5000);
    if (State.user && State.user.is_admin) {
      setTimeout(() => showModal('需要先配置 Google OAuth 凭据', `
        <p style="margin-bottom:10px">绑定 Gmail 前，需要在 Google Cloud 创建「桌面应用」类型的 OAuth 客户端，并把 Client ID / Client Secret 填到系统设置里。</p>
        <ol style="padding-left:18px; color:var(--text-light); font-size:13px; line-height:1.9">
          <li>打开 Google Cloud 控制台 → API 和服务 → 凭据</li>
          <li>创建凭据 → OAuth 客户端 ID → 应用类型选「桌面应用」</li>
          <li>复制 Client ID 与 Client Secret</li>
          <li>回到本系统「系统设置 → Google OAuth 凭据」粘贴保存</li>
        </ol>`,
        `<button class="btn btn-secondary" onclick="closeModal()">稍后配置</button><button class="btn" onclick="closeModal();switchTab('settings')">去配置</button>`), 400);
    }
    return;
  }
  const openUrl = data.verification_url_complete || data.verification_url || 'https://google.com/device';
  renderDeviceModal({
    title: '绑定 Gmail',
    tip: '请在打开的页面中登录谷歌账号，并输入下面的授权码',
    user_code: data.user_code,
    open_url: openUrl,
    expires_in: data.expires_in,
  });
  bindDevicePolling('/api/account/oauth/google/device/status', 'gDeviceTimer', afterBindSuccess);
}

async function startMsDeviceFlow() {
  let data;
  try {
    data = await api('/api/account/oauth/device', { method: 'POST' });
  } catch (err) { toast(err.message, 'error', 5000); return; }
  renderDeviceModal({
    title: '绑定 Outlook / Hotmail',
    tip: '请在打开的页面中登录微软账号，并输入下面的授权码',
    user_code: data.user_code,
    // 微软返回字段是 verification_uri(非 verification_url),容错两者
    open_url: data.verification_uri || data.verification_url,
    expires_in: data.expires_in,
  });
  bindDevicePolling('/api/account/oauth/device/status', 'deviceTimer', afterBindSuccess);
}

function cancelDevice() {
  stopAllDevicePolling();
  closeModal();
}

// 兼容旧命名
function cancelMsDevice() { cancelDevice(); }
