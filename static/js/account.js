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
  if (provider === 'gmail') {
    openGoogleBindForm();
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
  if (!isGmail) {
    // Outlook / Hotmail 只能走设备码授权(Microsoft 已禁用 Basic Auth)
    const body = `
      <div class="bind-options">
        <div class="bind-option" onclick="startDeviceAuth('outlook')">
          <div class="bind-option-title">⌨️ 设备码授权（推荐）</div>
          <div class="bind-option-desc">复制弹出的授权码，到授权页输入完成绑定。无需在微软后台登记回调地址，最适配 Cloudflare 部署。</div>
        </div>
      </div>`;
    showModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">取消</button>');
    return;
  }
  // Gmail: 「应用密码（IMAP）」作为首选推荐, 设备码 OAuth 作为备选
  const body = `
    <div class="bind-options">
      <div class="bind-option bind-option-recommended" onclick="openGmailAppPasswordForm()">
        <div class="bind-option-title">🔑 应用密码（IMAP）· 推荐</div>
        <div class="bind-option-desc">无需创建 Google Cloud OAuth 客户端、无需品牌验证。在 Google 账号开启两步验证后生成一个 16 位应用密码即可收信，最省事（emails-cloud 等自建项目均用此方式）。</div>
      </div>
      <div class="bind-option" onclick="openGoogleBindForm()">
        <div class="bind-option-title">⌨️ 设备码授权（OAuth）</div>
        <div class="bind-option-desc">需在 Google Cloud 创建「桌面应用」OAuth 客户端并填写 Client ID / Secret。若 Google 强制两步验证导致创建困难，建议用上方应用密码方式。</div>
      </div>
    </div>`;
  showModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">取消</button>');
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
      <input type="text" id="imapEmail" class="form-control" placeholder="you@gmail.com">
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
      <input type="password" id="imapPass" class="form-control" placeholder="16 位应用密码">
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
      <label class="form-label">IMAP 登录用户名 <span class="req">*</span></label>
      <input type="text" id="imapUser" class="form-control" placeholder="通常就是你的完整邮箱" value="${esc(prefill.imap_user || '')}">
      <p class="form-hint" style="margin-top:6px">绝大多数邮箱（含 Gmail / QQ / 163 / Outlook）此处填<strong>完整邮箱地址</strong>即可；仅少数企业邮箱登录 ID 与邮箱不同才需改。</p>
    </div>
    <div class="form-group">
      <label class="form-label">应用密码 <span class="req">*</span></label>
      <input type="password" id="imapPass" class="form-control" placeholder="16 位应用密码">
    </div>
    ${aliasRuleFieldHTML('imapAliasTpl', '{local}+{label}@{domain}')}
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
  // 用户名默认跟随邮箱输入,绝大多数邮箱此处就是完整邮箱,免去单独填写
  const imapEmailEl = document.getElementById('imapEmail');
  const imapUserEl = document.getElementById('imapUser');
  if (imapEmailEl && imapUserEl) {
    imapEmailEl.addEventListener('input', () => {
      if (!imapUserEl.value || imapUserEl.dataset.touched !== '1') {
        imapUserEl.value = imapEmailEl.value.trim();
      }
    });
    imapUserEl.addEventListener('input', () => { imapUserEl.dataset.touched = '1'; });
  }
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
      <input type="text" id="gcClientId" class="form-control" placeholder="1234567890-xxxx.apps.googleusercontent.com" value="${esc(prefill.client_id)}">
    </div>
    <div class="form-group">
      <label class="form-label">Client Secret <span class="req">*</span></label>
      <input type="password" id="gcClientSecret" class="form-control" placeholder="GOCSPX-...">
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
