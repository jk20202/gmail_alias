/* ============================================================
 * users.js — 管理员: 用户管理页
 * ============================================================ */

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

async function adminTogglePublic(id, isPublic) {
  try {
    await api('/api/admin/mail_accounts/' + id, { method: 'PUT', body: { is_public: isPublic } });
    toast(isPublic ? '已设为公开' : '已设为私有', 'success');
    loadAllAccounts();
  } catch (err) { toast(err.message, 'error'); loadAllAccounts(); }
}

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
