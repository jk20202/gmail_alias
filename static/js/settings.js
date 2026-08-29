/* ============================================================
 * settings.js — 管理员: 系统设置页
 * ============================================================ */

// ============ Google OAuth 凭据 ============
async function loadOAuthConfig() {
  const statusEl = document.getElementById('oauthStatusText');
  try {
    const data = await api('/api/admin/oauth/config');
    if (statusEl) {
      statusEl.innerHTML = data.configured
        ? `<span class="badge badge-success">已配置</span> <span class="mono" style="font-size:12px">${esc(data.client_id_masked)}</span> <span class="text-lighter">(${esc(data.source === 'db' ? '数据库' : '环境变量')})</span>`
        : '<span class="badge badge-danger">未配置</span> 未配置时绑定 Gmail 会提示缺少凭据';
    }
    const idEl = document.getElementById('googleClientId');
    if (idEl && !idEl.value && data.configured) idEl.placeholder = data.client_id_masked;
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span class="badge badge-danger">读取失败</span>';
    toast(err.message, 'error');
  }
}

async function saveOAuthConfig() {
  const client_id = document.getElementById('googleClientId').value.trim();
  const client_secret = document.getElementById('googleClientSecret').value.trim();
  if (!client_id && !client_secret) { toast('请填写 Client ID 与 Client Secret', 'warning'); return; }
  if (!client_id) { toast('请填写 Client ID', 'warning'); return; }
  if (!/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(client_id)) {
    toast('Client ID 格式不正确，应形如 1234567890-xxxx.apps.googleusercontent.com', 'error', 5000);
    return;
  }
  if (!client_secret) { toast('请填写 Client Secret', 'warning'); return; }
  try {
    await api('/api/admin/oauth/config', { method: 'PUT', body: { client_id, client_secret } });
    document.getElementById('googleClientSecret').value = '';
    toast('Google OAuth 凭据已保存', 'success');
    await loadOAuthConfig();
  } catch (err) { toast(err.message, 'error', 4000); }
}

async function initSettingsPage() {
  await loadOAuthConfig();
  try {
    const s = await api('/api/admin/settings');
    document.getElementById('setAllowReg').checked = s.allow_registration;
    document.getElementById('setAllowRegText').textContent = s.allow_registration ? '已开启' : '已关闭';
  } catch (err) { toast(err.message, 'error'); }
  await loadStats();
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

function jumpLogPage() {
  const input = document.getElementById('logPageInput');
  if (!input) return;
  let page = parseInt(input.value, 10);
  if (!page || page < 1) { toast('请输入有效页码', 'warning'); return; }
  const max = State.logTotalPages || 1;
  if (page > max) { toast('页码超出范围, 最大 ' + max + ' 页', 'warning'); return; }
  loadLogs(page);
}
