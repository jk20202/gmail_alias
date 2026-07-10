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

function cancelMsDevice() {
  if (State.deviceTimer) { clearInterval(State.deviceTimer); State.deviceTimer = null; }
  closeModal();
}
