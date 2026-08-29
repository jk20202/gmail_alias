/* ============================================================
 * account.js — 我的账户页
 *   · 基本信息 / API Key
 *   · 修改密码弹窗
 *   · 邮箱绑定弹窗: 跳转授权(推荐) / 设备码 / 应用密码(说明)
 * ============================================================ */

async function initAccountPage() {
  fillAccountInfo();
  await loadMyAccounts(true);
  // 监听 OAuth 跳转授权成功后子窗口 postMessage
  window.addEventListener('message', onOAuthMessage);
}

function onOAuthMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'oauth_bind_success') {
    toast((e.data.email || '邮箱') + ' 绑定成功', 'success');
    loadMyAccounts(true);
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
async function loadMyAccounts(silent) {
  const box = document.getElementById('myAccounts');
  if (!box) return;
  const cached = State.mailAccounts || [];
  // 缓存优先: 有旧数据先秒渲染(不转圈);随后后台静默刷新,
  // 确保新增/删除邮箱后,切换 tab 再切回也能看到最新数据(无需强制刷新)
  if (silent && cached.length) {
    renderMyAccounts(cached, box);
  } else if (!silent) {
    box.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  }
  try {
    const list = await api('/api/account/mail_accounts');
    State.mailAccounts = list || [];
    const newIds = (list || []).map(a => a.id).join(',');
    const oldIds = cached.map(a => a.id).join(',');
    // 仅当列表内容(增删)变化时才重渲染,避免无谓闪烁
    if (newIds !== oldIds || !silent) {
      renderMyAccounts(State.mailAccounts, box);
    }
  } catch (err) {
    if (!silent) box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

function renderMyAccounts(list, box) {
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
        <td>${a.provider === 'imap'
          ? '<span class="badge" style="background:#7c3aed;color:#fff">IMAP</span>'
          : `<span class="badge ${a.provider === 'gmail' ? 'badge-primary' : 'badge-warning'}">${esc(a.provider)}</span>`}</td>
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
  if (provider === 'imap') {
    const acc = (State.mailAccounts || []).find(a => a.id === id);
    openImapForm(acc ? { email: acc.email } : {});
    return;
  }
  openBindModal(provider);
}

async function togglePublic(id, isPublic) {
  try {
    await api('/api/account/mail_accounts/' + id + '/public', { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开,其他用户可使用此邮箱' : '已设为私有', 'success');
    loadMyAccounts(true);
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
  } catch (err) { toast(err.message, 'error'); loadMyAccounts(true); }
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
      loadMyAccounts(true);
      if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============ 绑定方式弹窗 ============ */
function openBindModal(provider) {
  if (provider === 'imap') return openImapForm();
  const isGmail = provider === 'gmail';
  const title = isGmail ? '绑定 Gmail' : '绑定 Outlook / Hotmail';
  const body = `
    <div class="bind-options">
      <div class="bind-option" onclick="startDeviceAuth('${provider}')">
        <div class="bind-option-title">⌨️ 设备码授权（推荐）</div>
        <div class="bind-option-desc">复制弹出的授权码，到授权页输入完成绑定。无需在 Google / 微软后台登记任何回调地址，最适配 Cloudflare 部署。${isGmail ? '首次绑定会在弹窗内要求填写一次 Google 客户端凭据（全站共享）。' : ''}</div>
      </div>
      ${isGmail ? `
      <div class="bind-option" onclick="openImapForm()">
        <div class="bind-option-title">🔑 应用密码（IMAP）方式</div>
        <div class="bind-option-desc">若 Google Cloud 强制两步验证导致无法创建 OAuth 凭据，可改用「应用密码 + IMAP」方式收信。需要先在 Google 账号开启两步验证并生成 16 位应用密码。</div>
      </div>` : ''}
    </div>`;
  showModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">取消</button>');
}

/* ============ IMAP 绑定（应用密码） ============ */
function openImapForm(prefill) {
  prefill = prefill || {};
  showModal('绑定 IMAP / 应用密码', `
    <p class="form-hint" style="margin:0 0 12px">使用应用密码（App Password）通过 IMAP 协议收信。无需 OAuth，适合 Gmail / Outlook / QQ / 163 等支持 IMAP 的邮箱。当前仅支持收信，不支持发信。</p>
    <div class="form-group">
      <label class="form-label">邮箱地址 <span class="req">*</span></label>
      <input type="text" id="imapEmail" class="form-control" placeholder="you@example.com" value="${esc(prefill.email || '')}">
    </div>
    <div class="form-group">
      <label class="form-label">IMAP 服务器 <span class="req">*</span></label>
      <input type="text" id="imapHost" class="form-control" placeholder="imap.example.com" value="${esc(prefill.imap_host || '')}">
    </div>
    <div class="form-group">
      <label class="form-label">端口</label>
      <input type="number" id="imapPort" class="form-control" placeholder="993" value="${esc(prefill.imap_port || '993')}">
    </div>
    <div class="form-group">
      <label class="form-label">用户名 <span class="req">*</span></label>
      <input type="text" id="imapUser" class="form-control" placeholder="通常为完整邮箱" value="${esc(prefill.imap_user || '')}">
    </div>
    <div class="form-group">
      <label class="form-label">应用密码 <span class="req">*</span></label>
      <input type="password" id="imapPass" class="form-control" placeholder="16 位应用密码">
    </div>
    <div class="form-group" style="margin-top:4px">
      <label class="switch" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="imapPublic" ${prefill.is_public ? 'checked' : ''}>
        <span class="track"></span>
        <span>设为公开（允许其他用户使用此邮箱）</span>
      </label>
    </div>
    <details style="margin-top:8px">
      <summary style="cursor:pointer;font-size:13px;color:var(--text-light)">常见邮箱 IMAP 设置（点击展开）</summary>
      <ul style="padding-left:18px;color:var(--text-light);font-size:13px;line-height:1.8;margin-top:8px">
        <li>Gmail：imap.gmail.com : 993，需开启两步验证后生成 16 位应用密码</li>
        <li>Outlook / Hotmail：imap-mail.outlook.com : 993</li>
        <li>QQ 邮箱：imap.qq.com : 993，需开启 IMAP 并生成授权码</li>
        <li>163 邮箱：imap.163.com : 993，需开启 IMAP 并生成授权码</li>
      </ul>
    </details>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="imapBindBtn">连接并绑定</button>`);
  const btn = document.getElementById('imapBindBtn');
  if (btn) btn.onclick = () => submitImapBind();
}

function getImapField(id) {
  const e = document.getElementById(id);
  return e ? e.value.trim() : '';
}

async function submitImapBind() {
  const email = getImapField('imapEmail');
  const host = getImapField('imapHost');
  const port = getImapField('imapPort');
  const user = getImapField('imapUser');
  const pass = getImapField('imapPass');
  const isPublic = document.getElementById('imapPublic') && document.getElementById('imapPublic').checked;
  if (!email || !host || !user || !pass) { toast('请填写邮箱、服务器、用户名与应用密码', 'warning'); return; }
  const btn = document.getElementById('imapBindBtn');
  if (btn) { btn.disabled = true; btn.textContent = '连接测试中...'; }
  try {
    await api('/api/account/mail_accounts/imap', {
      method: 'POST',
      body: {
        email,
        imap_host: host,
        imap_port: parseInt(port, 10) || 993,
        imap_user: user,
        imap_pass: pass,
        is_public: !!isPublic,
      },
    });
    toast('IMAP 邮箱绑定成功', 'success');
    closeModal();
    loadMyAccounts(true);
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
  } catch (err) {
    toast(err.message, 'error', 6000);
    if (btn) { btn.disabled = false; btn.textContent = '连接并绑定'; }
  }
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
    <div style="margin:0 0 12px">
      <a class="btn btn-ghost" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">↗ 打开 Google Cloud 凭据页（新标签页）</a>
    </div>
    <details style="margin:0 0 12px">
      <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text-light)">看不懂步骤？点开查看</summary>
      <ol style="padding-left:18px;color:var(--text-light);font-size:13px;line-height:1.9;margin-top:8px">
        <li>在打开的页面左上，选好对应的 Google 项目（或新建一个）</li>
        <li>「OAuth 同意屏幕」：用户类型选<strong>外部</strong>，填写应用名称与支持邮箱，测试用户里加上你自己的 Gmail</li>
        <li>「凭据 → 创建凭据 → OAuth 客户端 ID」：应用类型务必选<strong>桌面应用</strong></li>
        <li>复制生成的 <b>Client ID</b> 与 <b>Client Secret</b>，粘贴到下方保存</li>
      </ol>
    </details>
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
  loadMyAccounts(true);
  if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
}

async function startGoogleDeviceFlow() {
  let data;
  try {
    data = await api('/api/account/oauth/google/device', { method: 'POST' });
  } catch (err) {
    toast(err.message, 'error', 5000);
    setTimeout(() => showModal('Gmail 绑定失败', `
      <p style="margin-bottom:10px">${esc(err.message)}</p>
      <p class="form-hint">若提示缺少凭据或凭据无效，请在「我的账户 → 绑定 Gmail」弹窗内重新填写正确的 Google 客户端 Client ID / Client Secret（普通用户也可在弹窗内填写，无需进系统设置），再重试设备码授权。</p>`,
      `<button class="btn btn-secondary" onclick="closeModal()">知道了</button>`), 400);
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
