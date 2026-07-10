/* ============================================================
 * settings.js — 管理员: 系统设置页
 * ============================================================ */

async function initSettingsPage() {
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
