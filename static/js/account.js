/* ============================================================
 * account.js — 我的账户页
 * ============================================================ */

async function initAccountPage() {
  fillAccountInfo();
  await loadMyAccounts();
}

// 填充基本信息(从 State.user 读取)
function fillAccountInfo() {
  const u = State.user;
  if (!u) return;
  document.getElementById('accUsername').textContent = u.username;
  document.getElementById('accRole').innerHTML = u.is_admin
    ? '<span class="badge badge-primary">管理员</span>'
    : '<span class="badge badge-gray">普通用户</span>';
  document.getElementById('accCreatedAt').textContent = fmtTime(u.created_at);
  document.getElementById('apiKeyText').textContent = u.api_key;
  // 复制 API Key 按钮
  const copyBtn = document.getElementById('btnCopyApiKey');
  if (copyBtn) copyBtn.onclick = () => copyText(u.api_key);
  // 别名区域
  const aliasBox = document.getElementById('accAliasSection');
  if (u.alias) {
    aliasBox.innerHTML = `
      <div class="info-item" style="flex-direction:column; align-items:stretch">
        <span class="label" style="margin-bottom:6px">当前别名</span>
        <div class="apikey-box"><span class="mono" style="flex:1">${esc(u.alias.full)}</span><button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(u.alias.full)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></div>
        <div class="form-hint">标签: ${esc(u.alias.label)} · 更新于 ${fmtTime(u.alias.updated_at)}</div>
      </div>`;
  } else {
    aliasBox.innerHTML = '';
  }
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
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

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

function reauthAccount(id, provider) {
  startOAuth(provider);
}

async function togglePublic(id, isPublic) {
  try {
    await api('/api/account/mail_accounts/' + id + '/public', { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开,其他用户可使用此邮箱' : '已设为私有', 'success');
    loadMyAccounts();
    loadAvailableAccounts();
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

async function changeMyPassword() {
  const oldPassword = document.getElementById('oldPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
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

// 统一的授权入口: Gmail / Outlook 都走 Device Code Flow
// (Device Code 不需要在 Google / 微软后台登记回调地址,部署在任意域名都不会
//  出现 redirect_uri_mismatch / invalid_client 之类的跳转报错)
async function startOAuth(provider) {
  if (provider === 'outlook') return startMsDeviceFlow();
  return startGoogleDeviceFlow();
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
    // 未配置凭据时,引导管理员去系统设置页
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
    open_url: data.verification_url,
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
