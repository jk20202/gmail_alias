/* ============================================================
 * account.js — 我的账户页
 *   · 基本信息 / API Key
 *   · 修改密码弹窗
 *   · 邮箱绑定弹窗: 跳转授权(推荐) / 设备码 / 应用密码(说明)
 * ============================================================ */

// 统一转发地址(catch-all),所有邮箱都引导转发到这里
let unifiedForward = null;

async function initAccountPage() {
  fillAccountInfo();
  loadCatchallConfig();
  await loadMyAccounts(true);
  // 监听 OAuth 跳转授权成功后子窗口 postMessage
  window.addEventListener('message', onOAuthMessage);
}

async function loadCatchallConfig() {
  try {
    const data = await api('/api/config/catchall');
    unifiedForward = (data && data.forward_address) || null;
    const el = document.getElementById('unifiedForwardAddr');
    if (el) el.textContent = unifiedForward || '(未配置)';
  } catch (e) {
    unifiedForward = null;
  }
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
  const fwdDisplay = unifiedForward || '(加载中...)';
  box.innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr>
      <th>邮箱</th>
      <th title="是否允许为该邮箱生成别名地址（绑定时可开启，默认关闭）">别名支持</th>
      <th title="是否已收到从原邮箱转发过来的邮件">收信状态</th>
      <th>是否公开</th>
      <th>操作</th>
    </tr></thead>
    <tbody>${list.map(a => `
      <tr>
        <td>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px">
            <span class="mono">${esc(a.email)}</span>
            <button class="btn btn-ghost btn-xs" onclick="copyText('${esc(fwdDisplay)}')" title="复制统一转发地址">📋</button>
          </div>
          <div class="row-note">
            转发到：<span class="mono">${esc(fwdDisplay)}</span>
            ${a.notes ? `<span style="margin-left:8px; color:var(--text-light)">· ${esc(a.notes)}</span>` : ''}
          </div>
        </td>
        <td>${aliasSupportBadge(a)}</td>
        <td id="acc-status-${esc(a.id)}"><span class="badge badge-gray">检测中...</span></td>
        <td>
          <label class="switch" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer">
            <input type="checkbox" ${a.is_public ? 'checked' : ''} onchange="togglePublic('${esc(a.id)}', this.checked)">
            <span class="track"></span>
            <span>${a.is_public ? '公开' : '私有'}</span>
          </label>
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditAccount('${esc(a.id)}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAccount('${esc(a.id)}','${esc(a.email)}')">删除</button>
        </td>
      </tr>`).join('')}</tbody>
  </table></div>`;
  list.forEach(a => probeAuthStatus(a.id));
}

// 别名支持徽章:v2 由用户为每个邮箱单独开关(默认关闭)
function aliasSupportBadge(a) {
  return a.supports_alias
    ? '<span class="badge badge-success" title="已开启：可为该邮箱按别名规则生成别名地址">✓ 支持别名</span>'
    : '<span class="badge badge-gray" title="未开启：该邮箱只能被直接选中收信，不能生成别名">— 不支持</span>';
}

function copyText(t) {
  try { navigator.clipboard.writeText(t); toast('已复制', 'success'); }
  catch (e) { /* 剪贴板不可用时忽略 */ }
}

// Plus 寻址(加号别名)状态徽章: 动态反映该邮箱是否支持别名收信
function plusAddrBadge(a) {
  const domain = (a.email.split('@')[1] || '').toLowerCase();
  if (UNSUPPORTED_ALIAS_DOMAINS.includes(domain)) {
    return '<span class="badge badge-danger" title="该域名不支持 + 别名收信，绑定后仅能读取收件箱，无法用于无限别名">✗ 不支持</span>';
  }
  const tpl = a.alias_template || '';
  if (/\{label\}@\{domain\}/.test(tpl) && !/\{local\}\+/.test(tpl)) {
    return '<span class="badge badge-success" title="独立域名通配别名（catch-all），如 标签@域名">✓ 通配别名</span>';
  }
  return '<span class="badge badge-success" title="加号别名（Plus 寻址），如 前缀+标签@域名">✓ 加号别名</span>';
}

// v2: 无需授权,状态改为反映「是否已收到原邮箱转发过来的邮件」,
// 便于用户确认自己在原邮箱里的自动转发设置是否生效。
async function probeAuthStatus(id) {
  const cell = document.getElementById('acc-status-' + id);
  if (!cell) return;
  try {
    const data = await api('/api/account/mail_accounts/' + id + '/status');
    const n = (data && data.received) || 0;
    if (data && data.ok && n > 0) {
      cell.innerHTML = `<span class="badge badge-success" title="已收到 ${n} 封转发邮件">已收 ${n} 封</span>`;
    } else {
      cell.innerHTML = '<span class="badge badge-warning" title="尚未收到转发邮件，请检查原邮箱的自动转发设置是否指向统一转发地址">待配置转发</span>';
    }
  } catch (e) {
    cell.innerHTML = '<span class="badge badge-gray">未知</span>';
  }
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
/* ============ v2: 绑定邮箱(免授权,只需填主邮箱地址) ============
 * 原理:各邮箱(Gmail / Outlook / QQ / 163 …)在自己的设置里开启「自动转发」,
 * 把收到的邮件转发到系统为该邮箱分配的【专属转发地址】,系统即可统一收信。
 * 因此完全不需要 OAuth 授权、也不需要应用密码,不存在授权失败或被审查的问题。
 */
function openBindModal() {
  const fwd = unifiedForward || 'alle@你的域名';
  const body = `
    <p class="form-hint" style="margin:0 0 12px">
      只需填写你的<b>主邮箱地址</b>即可绑定 —— <b>无需授权、无需应用密码</b>。<br>
      绑定后，去原邮箱设置里把收到的邮件<b>自动转发</b>到
      <span class="mono">${esc(fwd)}</span>，就能在这里统一收信。
    </p>
    <div class="form-group">
      <label class="form-label">主邮箱地址</label>
      <input type="email" id="bindEmail" class="form-control" placeholder="you@gmail.com" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">备注（可选）</label>
      <input type="text" id="bindNotes" class="form-control" placeholder="如：工作邮箱 / 主收信箱">
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="bindSupportsAlias">
        <span>支持别名<small class="form-hint" style="margin-left:6px">关闭时该邮箱只能直接选中收信，不能生成别名</small></span>
      </label>
    </div>
    <div class="form-group" id="bindAliasTplWrap" style="display:none">
      ${aliasRuleFieldHTML('bindAliasTpl', '{local}+{label}@{domain}')}
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="bindPublic">
        <span>公开共享<small class="form-hint" style="margin-left:6px">其他用户可使用此邮箱及其别名</small></span>
      </label>
    </div>`;
  showModal('绑定邮箱（邮件转发方式）', body,
    '<button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="bindMailboxBtn" onclick="submitMailboxBind()">绑定</button>');

  // 「支持别名」开启时才展示别名规则模板
  const sa = document.getElementById('bindSupportsAlias');
  const wrap = document.getElementById('bindAliasTplWrap');
  if (sa && wrap) sa.addEventListener('change', () => { wrap.style.display = sa.checked ? '' : 'none'; });
  wireAliasPreview('bindEmail', 'bindAliasTpl', 'bindAliasTplPreview', '');
}

// 提交绑定(免授权)
async function submitMailboxBind() {
  const email = getImapField('bindEmail').toLowerCase();
  const notes = getImapField('bindNotes');
  const saEl = document.getElementById('bindSupportsAlias');
  const pbEl = document.getElementById('bindPublic');
  const supportsAlias = !!(saEl && saEl.checked);
  const isPublic = !!(pbEl && pbEl.checked);
  const aliasTpl = getImapField('bindAliasTpl');

  if (!email) { toast('请填写邮箱地址', 'warning'); return; }
  const btn = document.getElementById('bindMailboxBtn');
  if (btn) { btn.disabled = true; btn.textContent = '绑定中...'; }
  try {
    const res = await api('/api/account/mail_accounts/imap', {
      method: 'POST',
      body: {
        email,
        is_public: isPublic,
        supports_alias: supportsAlias,
        alias_template: aliasTpl || undefined,
        notes: notes || undefined,
      },
    });
    closeModal();
    loadMyAccounts(true);
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
    // 绑定成功后,把统一转发地址醒目展示出来,引导用户去原邮箱配置转发
    showForwardAddressModal(res && res.email);
  } catch (err) {
    toast(err.message, 'error', 6000);
    if (btn) { btn.disabled = false; btn.textContent = '绑定'; }
  }
}

// 展示统一转发地址 + 各邮箱的配置指引
function showForwardAddressModal(email) {
  const display = unifiedForward || 'alle@你的域名';
  const body = `
    <p class="form-hint" style="margin:0 0 12px">
      邮箱 <b>${esc(email || '')}</b> 已绑定成功。最后一步：去这个邮箱的设置里，
      把收到的邮件<b>自动转发</b>到下面的统一地址：
    </p>
    <div class="form-group">
      <label class="form-label">统一转发地址</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="fwdAddr" class="form-control mono" value="${esc(display)}" readonly>
        <button class="btn btn-secondary" onclick="copyForwardAddress()">复制</button>
      </div>
    </div>
    <div class="gp-steps">
      <div class="gp-step"><span class="gp-step-n">1</span><div><b>Gmail</b>：设置 → 查看所有设置 → 转发和 POP/IMAP → 添加转发地址</div></div>
      <div class="gp-step"><span class="gp-step-n">2</span><div><b>Outlook</b>：设置 → 邮件 → 转发 → 启用转发</div></div>
      <div class="gp-step"><span class="gp-step-n">3</span><div><b>QQ / 163 等</b>：设置 → 收信规则 / 自动转发</div></div>
    </div>
    <p class="form-hint" style="margin:12px 0 0">
      配置完成后，发往该邮箱（及其别名）的邮件就会出现在「邮件查询」中。
    </p>`;
  showModal('配置邮件转发', body, '<button class="btn btn-primary" onclick="closeModal()">知道了</button>');
}

function copyForwardAddress() {
  const el = document.getElementById('fwdAddr');
  if (!el) return;
  el.select();
  try { navigator.clipboard.writeText(el.value); } catch (e) { /* ignore */ }
  toast('已复制转发地址', 'success');
}

/* ============ Gmail 应用密码绑定（推荐首选） ============ */
async function openGmailAppPasswordForm() {
  showModal('绑定 Gmail（应用密码 · 推荐）', `
    <p class="form-hint" style="margin:0 0 12px">无需 Google Cloud OAuth、无需品牌验证，直接用一个 <b>16 位应用密码</b> 通过 IMAP 收信。当前仅支持收信，不支持发信。</p>
    <div class="gp-steps">
      <div class="gp-step">
        <span class="gp-step-n">1</span>
        <div><b>开启两步验证</b>（若已开启可跳过）<br>
          <a class="btn btn-ghost" href="https://myaccount.google.com/security" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;margin-top:6px">↗ 打开 Google 安全性</a>
        </div>
      </div>
      <div class="gp-step">
        <span class="gp-step-n">2</span>
        <div><b>生成应用密码</b>：在「应用密码」页输入一个名称（如「邮箱别名」）点生成，复制得到的 16 位密码<br>
          <a class="btn btn-ghost" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;margin-top:6px">↗ 打开应用密码页</a>
        </div>
      </div>
      <div class="gp-step">
        <span class="gp-step-n">3</span>
        <div>把 16 位密码粘贴到下方「应用密码」框（可含空格，会自动去除）</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Gmail 地址 <span class="req">*</span></label>
      <input type="text" id="imapEmail" class="form-control" placeholder="you@gmail.com" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">IMAP 服务器</label>
      <input type="text" id="imapHost" class="form-control" value="imap.gmail.com" readonly>
    </div>
    <div class="form-group">
      <label class="form-label">端口</label>
      <input type="number" id="imapPort" class="form-control" style="max-width:140px" value="993">
    </div>
    <p class="form-hint">IMAP 登录用户名即上方 Gmail 地址，无需单独填写；密码填 16 位应用密码。</p>
    <div class="form-group">
      <label class="form-label">应用密码 <span class="req">*</span></label>
      <input type="password" id="imapPass" class="form-control" placeholder="16 位应用密码" autocomplete="new-password">
    </div>
    ${aliasRuleFieldHTML('imapAliasTpl', '{local}+{label}@gmail.com')}
    <div class="form-group" style="margin-top:4px">
      <label class="switch" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="imapPublic">
        <span class="track"></span>
        <span>设为公开（允许其他用户使用此邮箱）</span>
      </label>
    </div>`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="imapBindBtn">连接并绑定</button>`);
  wireAliasPreview('imapEmail', 'imapAliasTpl', 'imapAliasTplPreview');
  const btn = document.getElementById('imapBindBtn');
  if (btn) btn.onclick = () => submitImapBind();
}

/* ============ IMAP 绑定（应用密码） ============ */
function openImapForm(prefill) {
  prefill = prefill || {};
  showModal('绑定 IMAP / 应用密码', `
    <p class="form-hint" style="margin:0 0 12px">使用应用密码（App Password）通过 IMAP 协议收信。无需 OAuth，适合 Gmail / Outlook / QQ / 163 等支持 IMAP 的邮箱。当前仅支持收信，不支持发信。注意：QQ / 163 等部分邮箱不支持别名收信（加号地址收不到），绑定后仅能读取该收件箱，无法用于无限别名。</p>
    <div class="form-group">
      <label class="form-label">邮箱地址 <span class="req">*</span></label>
      <input type="text" id="imapEmail" class="form-control" placeholder="you@example.com" value="${esc(prefill.email || '')}" autocomplete="off">
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
      <label class="form-label">应用密码 <span class="req">*</span></label>
      <input type="password" id="imapPass" class="form-control" placeholder="16 位应用密码" autocomplete="new-password">
    </div>
    ${aliasRuleFieldHTML('imapAliasTpl', prefill.alias_template || '{local}+{label}@{domain}')}
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
  wireAliasPreview('imapEmail', 'imapAliasTpl', 'imapAliasTplPreview');
  const btn = document.getElementById('imapBindBtn');
  if (btn) btn.onclick = () => submitImapBind();
}

function getImapField(id) {
  const e = document.getElementById(id);
  return e ? e.value.trim() : '';
}

// ============ 别名规则模板辅助 ============
// 每个邮箱可单独配置别名生成规则(打破全局硬编码 "+" 的限制):
//   {local} 邮箱前缀, {domain} 域名, {label} 别名标签
// 微软 / 2925 用 "{local}+{label}@{domain}";自建域名 catch-all 用 "{label}@{domain}"
// 这些免费邮箱域名的加号子地址 / 通配域名都无法投递到同一收件箱,绑定后只能读信,禁止建别名
const UNSUPPORTED_ALIAS_DOMAINS = ['qq.com','163.com','126.com','yeah.net','foxmail.com','sina.com','sina.cn','sohu.com','aliyun.com','139.com','189.cn','tom.com'];
function aliasRuleFieldHTML(id, defaultTpl) {
  return `
    <div class="form-group">
      <label class="form-label">别名规则模板</label>
      <input type="text" id="${id}" class="form-control" value="${esc(defaultTpl)}" placeholder="{local}+{label}@{domain}">
      <p class="form-hint" style="margin-top:6px">占位符：<code>{local}</code> 邮箱前缀、<code>{domain}</code> 域名、<code>{label}</code> 别名标签。微软 / 2925 用 <code>{local}+{label}@{domain}</code>；自建域名通配用 <code>{label}@{domain}</code>。留空则用默认加号形式。</p>
      <p class="form-hint" id="${id}Preview" style="margin-top:6px"></p>
    </div>`;
}
// 绑定别名规则实时预览。emailId 为空时用 fixedDomain 作为域名(如 Gmail OAuth 绑定前尚不知邮箱)
function wireAliasPreview(emailId, tplId, previewId, fixedDomain) {
  const emailEl = emailId ? document.getElementById(emailId) : null;
  const tplEl = document.getElementById(tplId);
  const prevEl = document.getElementById(previewId);
  const update = () => {
    if (!tplEl || !prevEl) return;
    const email = emailEl ? emailEl.value.trim() : '';
    const tpl = tplEl.value.trim() || '{local}+{label}@{domain}';
    const m = /^(.*)@([^@]+)$/.exec(email);
    const local = m ? m[1] : 'you';
    const domain = m ? m[2] : (fixedDomain || 'domain.com');
    const sample = tpl.replace(/\{local\}/g, local).replace(/\{domain\}/g, domain).replace(/\{label\}/g, '标签');
    let html = '示例别名：<b>' + esc(sample) + '</b>';
    if (UNSUPPORTED_ALIAS_DOMAINS.includes(domain.toLowerCase())) {
      html += ' <span style="color:#dc2626">⚠ 该域名不支持别名收信，绑定后仅可读取收件箱，无法创建别名。</span>';
    }
    prevEl.innerHTML = html;
  };
  if (emailEl) emailEl.addEventListener('input', update);
  if (tplEl) tplEl.addEventListener('input', update);
  update();
}

async function submitImapBind() {
  const email = getImapField('imapEmail');
  const host = getImapField('imapHost');
  const port = getImapField('imapPort');
  // 应用密码常带空格显示(如 abcd efgh ...),登录时须去除所有空白
  // 用户名未单独填写时回退为邮箱(IMAP 登录用户名通常就是完整邮箱)
  const user = (getImapField('imapUser') || email).replace(/\s+/g, '');
  const pass = getImapField('imapPass').replace(/\s+/g, '');
  const isPublic = document.getElementById('imapPublic') && document.getElementById('imapPublic').checked;
  const aliasTpl = getImapField('imapAliasTpl');
  if (!email || !host || !user || !pass) { toast('请填写邮箱、服务器与应用密码', 'warning'); return; }
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
        alias_template: aliasTpl || undefined,
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

/* ============ 编辑已绑定邮箱（合并「编辑」与「重新授权」） ============ */
// 点击「编辑」打开:预填已有别名规则 / 备注,可直接保存(不改连接方式无需重新授权);
// 若修改了连接方式(IMAP 服务器/密码,或重新 OAuth 授权),点「重新授权」走原绑定流程。
async function openEditAccount(id) {
  const acc = (State.mailAccounts || []).find(a => a.id === id);
  if (!acc) { toast('未找到该邮箱', 'error'); return; }
  const domain = (acc.email.split('@')[1] || '').toLowerCase();
  const defaultTpl = acc.alias_template || '{local}+{label}@{domain}';
  const unsupported = UNSUPPORTED_ALIAS_DOMAINS.includes(domain);
  const display = unifiedForward || 'alle@jkf.kdns.fr';
  showModal(`编辑邮箱 · ${esc(acc.email)}`, `
    <div class="form-group">
      <label class="form-label">统一转发地址</label>
      <div style="display:flex;gap:8px">
        <input type="text" class="form-control mono" value="${esc(display)}" readonly>
        <button class="btn btn-secondary" onclick="copyText('${esc(display)}')">复制</button>
      </div>
      <p class="form-hint" style="margin-top:6px">
        所有邮箱都统一转发到这里。系统会按收件地址自动归属到对应邮箱或别名。
      </p>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex; align-items:center; gap:8px">
        <input type="checkbox" id="editSupportsAlias" ${acc.supports_alias ? 'checked' : ''}>
        支持别名（关闭后只能直接选中该邮箱收信）
      </label>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex; align-items:center; gap:8px">
        <input type="checkbox" id="editIsPublic" ${acc.is_public ? 'checked' : ''}>
        公开共享（其他用户可选用它收信）
      </label>
    </div>
    ${aliasRuleFieldHTML('editAliasTpl', defaultTpl)}
    <div class="form-group">
      <label class="form-label">备注</label>
      <input type="text" id="editNotes" class="form-control" value="${esc(acc.notes || '')}" placeholder="如：工作邮箱 / 主收信箱" autocomplete="off">
    </div>
    ${unsupported ? '<p class="form-hint" style="color:#dc2626">⚠ 该域名不支持别名收信，别名规则不生效，仅作记录保存。</p>' : ''}
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">取消</button>
    <button class="btn" id="editSaveBtn">保存</button>
  `);
  wireAliasPreview(null, 'editAliasTpl', 'editAliasTplPreview', domain);
  const saveBtn = document.getElementById('editSaveBtn');
  if (saveBtn) saveBtn.onclick = () => submitEditSave(id);
}

// 保存 v2 邮箱配置:别名开关 / 公开共享 / 别名规则 / 备注
async function submitEditSave(id) {
  const btn = document.getElementById('editSaveBtn');
  const body = {
    supports_alias: document.getElementById('editSupportsAlias')?.checked,
    is_public: document.getElementById('editIsPublic')?.checked,
    alias_template: getImapField('editAliasTpl') || undefined,
    notes: getImapField('editNotes') || undefined,
  };
  if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
  try {
    const data = await api('/api/account/mail_accounts/' + id, { method: 'PATCH', body });
    if (data && data.data && data.data.forward_address_taken) {
      toast('其他设置已保存', 'success');
    } else {
      toast('已保存', 'success');
    }
    closeModal();
    loadMyAccounts(true);
    if (typeof loadAvailableAccounts === 'function') loadAvailableAccounts();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

// 收信自检:验证某个收件地址是否会被系统正确归属
async function probeForwardAddress(inputId) {
  const el = document.getElementById(inputId);
  const addr = el ? el.value.trim() : '';
  if (!addr) { toast('请先填写转发地址', 'error'); return; }
  try {
    const data = await api('/api/web/email/probe', { method: 'POST', body: { addr } });
    const r = data.data || {};
    if (r.matched) {
      toast(`✓ 该地址可正常收信（归属 ${r.accountEmail}）`, 'success');
    } else {
      toast(`✗ ${r.hint || '该地址未登记到任何邮箱'}`, 'error');
    }
  } catch (e) { toast(e.message, 'error'); }
}

// 收信诊断:① 自检某个地址能否归属 ② 查看最近到达 Worker 但没匹配上的收件
// 用途:判断「原邮箱的自动转发到底有没有生效」
//   - 未识别列表里有记录 → Cloudflare Email Routing 已通,只是地址没登记
//   - 列表为空且收信状态仍为 0 → 说明邮件根本没到 Worker(转发未确认 / 路由规则没生效)
async function openForwardDiagnose() {
  showModal('收信诊断', `
    <div class="form-group">
      <label class="form-label">转发自检</label>
      <div style="display:flex; gap:8px">
        <input type="text" id="diagAddr" class="form-control" placeholder="粘贴你在原邮箱里填的转发目标地址">
        <button class="btn btn-secondary" onclick="runDiagProbe()" style="white-space:nowrap">检测</button>
      </div>
      <div id="diagProbeResult" style="margin-top:8px"></div>
    </div>
    <div class="form-group">
      <label class="form-label">最近到达但未识别的收件</label>
      <p class="form-hint" style="margin:0 0 8px">
        只要这里有记录，就说明 Cloudflare Email Routing 已正常把邮件投递到 Worker；
        把对应的「投递到」地址设为某个邮箱的专属转发地址即可正常收下。
      </p>
      <div id="diagUnmatched"><div class="loading"><span class="spinner"></span> 加载中...</div></div>
    </div>
  `, '<button class="btn btn-secondary" onclick="closeModal()">关闭</button>');

  const box = document.getElementById('diagUnmatched');
  try {
    const data = await api('/api/web/email/unmatched', { method: 'POST', body: { limit: 20 } });
    const list = (data.data && data.data.list) || [];
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">暂无记录。若你的邮箱「收信状态」也是 0，说明邮件还没到达 Worker——请检查原邮箱的转发是否已确认生效、以及 Cloudflare 的路由规则是否指向了本 Worker。</div>';
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>投递到</th><th>发件人</th><th>主题</th><th>时间</th></tr></thead>
      <tbody>${list.map(r => `
        <tr>
          <td class="mono">${esc(r.envelope_to || '-')}</td>
          <td class="mono">${esc(r.from_address || '-')}</td>
          <td>${esc(r.subject || '(无主题)')}</td>
          <td>${esc(r.created_at || '-')}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="mail-empty">加载失败：${esc(e.message)}（仅管理员可查看）</div>`;
  }
}

async function runDiagProbe() {
  const el = document.getElementById('diagAddr');
  const out = document.getElementById('diagProbeResult');
  const addr = el ? el.value.trim() : '';
  if (!addr) { out.innerHTML = '<span style="color:#dc2626">请先填写地址</span>'; return; }
  out.innerHTML = '<span class="badge badge-gray">检测中...</span>';
  try {
    const data = await api('/api/web/email/probe', { method: 'POST', body: { addr } });
    const r = data.data || {};
    out.innerHTML = r.matched
      ? `<span class="badge badge-success">✓ 可正常收信</span> 归属邮箱：<span class="mono">${esc(r.accountEmail || r.accountId || '')}</span>${r.matched === 'alias' ? '（命中别名）' : ''}`
      : `<span class="badge badge-danger">✗ 无法归属</span> ${esc(r.hint || '')}<br><span class="form-hint">当前收信域名：<span class="mono">${esc(r.recv_domain || '')}</span></span>`;
  } catch (e) {
    out.innerHTML = `<span style="color:#dc2626">${esc(e.message)}</span>`;
  }
}

// 「重新授权」：按协议走原绑定流程(预填已有信息,避免重填)
function editReauth(acc) {
  closeModal();
  if (acc.provider === 'imap') {
    openImapForm({
      email: acc.email,
      imap_host: acc.imap_host || '',
      imap_port: acc.imap_port || '993',
      alias_template: acc.alias_template || '',
      is_public: acc.is_public,
    });
  } else if (acc.provider === 'gmail') {
    openGoogleBindForm();
  } else if (acc.provider === 'outlook') {
    if (typeof startDeviceAuth === 'function') startDeviceAuth('outlook');
  } else {
    openBindModal(acc.provider);
  }
}

/* ============ 设备码授权 ============ */
// Gmail 绑定:无论是否已经填过凭据,都直接打开可编辑的凭据表单(避免一次填错就被卡死)
async function openGoogleBindForm() {
  let prefill = { client_id: '', has_secret: false };
  try {
    const st = await api('/api/account/oauth/google/status');
    prefill = { client_id: st.client_id || '', has_secret: !!st.has_client_secret };
  } catch (e) { /* 忽略,直接空白表单 */ }
  showModal('绑定 Gmail（填写 Google 客户端凭据）', `
    <p class="form-hint" style="margin:0 0 12px">绑定 Gmail 需要先在 Google Cloud 创建「桌面应用」类型的 OAuth 客户端。填写并保存后即可立即授权。凭据仅保存在<strong>你自己的账号</strong>下，与系统设置无关，可随时回来修改。</p>
    <div style="margin:0 0 12px">
      <a class="btn btn-ghost" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">↗ 打开 Google Cloud 凭据页（新标签页）</a>
    </div>
    <details style="margin:0 0 12px">
      <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text-light)">看不懂步骤？点开查看</summary>
      <ol style="padding-left:18px;color:var(--text-light);font-size:13px;line-height:1.9;margin-top:8px">
        <li>在打开的页面左上，选好对应的 Google 项目（或新建一个）</li>
        <li>「OAuth 同意屏幕」：用户类型选<strong>外部</strong>，填写应用名称与支持邮箱，测试用户里加上你自己的 Gmail</li>
        <li>「凭据 → 创建凭据 → OAuth 客户端 ID」：应用类型务必选<strong>桌面应用</strong>（注意：只有“桌面应用 / 电视等”才支持设备码授权，选“Web 应用”会报 invalid_client）</li>
        <li>复制生成的 <b>Client ID</b> 与 <b>Client Secret</b>，粘贴到下方</li>
      </ol>
    </details>
    <div class="form-group">
      <label class="form-label">Client ID <span class="req">*</span></label>
      <input type="text" id="gcClientId" class="form-control" placeholder="1234567890-xxxx.apps.googleusercontent.com" value="${esc(prefill.client_id)}" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Client Secret <span class="req">*</span></label>
      <input type="password" id="gcClientSecret" class="form-control" placeholder="GOCSPX-..." autocomplete="new-password">
      ${prefill.has_secret ? '<p class="form-hint" style="margin-top:6px">已保存过 Client Secret，若未改动可留空。</p>' : ''}
    </div>
    ${aliasRuleFieldHTML('gcAliasTpl', '{local}+{label}@gmail.com')}`,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="gcBindBtn">获取授权码并绑定</button>`);
  wireAliasPreview(null, 'gcAliasTpl', 'gcAliasTplPreview', 'gmail.com');
  const btn = document.getElementById('gcBindBtn');
  if (btn) btn.onclick = () => submitGoogleBind();
}

async function submitGoogleBind() {
  const idEl = document.getElementById('gcClientId');
  const secEl = document.getElementById('gcClientSecret');
  const tplEl = document.getElementById('gcAliasTpl');
  const cid = idEl ? idEl.value.trim() : '';
  const secret = secEl ? secEl.value.trim() : '';
  const tpl = tplEl ? tplEl.value.trim() : '';
  if (!cid) { toast('请填写 Client ID', 'warning'); return; }
  const btn = document.getElementById('gcBindBtn');
  if (btn) { btn.disabled = true; btn.textContent = '获取授权码中...'; }
  // 直接带着本次填写的凭据发起设备码(后端会同时保存到你账号下);别名规则一并带入
  await startGoogleDeviceFlow(cid, secret, tpl);
}

async function startDeviceAuth(provider) {
  closeModal();
  if (provider === 'outlook') return startMsDeviceFlow();
  return openGoogleBindForm();
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

async function startGoogleDeviceFlow(cid, secret, tpl) {
  let data;
  try {
    data = await api('/api/account/oauth/google/device', {
      method: 'POST',
      body: { client_id: cid || undefined, client_secret: secret || undefined, alias_template: tpl || undefined },
    });
  } catch (err) {
    toast(err.message, 'error', 5000);
    setTimeout(() => showModal('Gmail 绑定失败', `
      <p style="margin-bottom:10px">${esc(err.message)}</p>
      <p class="form-hint">请在弹窗内核对并修改 Client ID / Client Secret 后重试。普通用户可直接在「绑定 Gmail」处填写自己的凭据，无需进入系统设置。</p>`,
      `<button class="btn btn-secondary" onclick="closeModal()">知道了</button>
       <button class="btn" onclick="openGoogleBindForm()">返回修改</button>`), 400);
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
