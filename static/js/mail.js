/* ============================================================
 * mail.js — 邮件查询页 (含自动收件、条件缓存、重置)
 * ============================================================ */

// localStorage 缓存键
const LS_MAIL_QUERY = 'mail_alias_mail_query';   // 查询条件
const LS_MAIL_RESULTS = 'mail_alias_mail_results'; // 邮件结果

// 自动收件定时器
let _mailAutoTimer = null;

async function initMailPage() {
  await loadAvailableAccounts();
  refreshCurrentAlias();
  // 恢复缓存的查询条件
  restoreMailQuery();
  // 如果没有缓存的时间,设置默认为最近1小时
  const startEl = document.getElementById('qStart');
  const endEl = document.getElementById('qEnd');
  if (startEl && !startEl.value) {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600_000);
    startEl.value = toLocalDT(oneHourAgo);
  }
  if (endEl && !endEl.value) {
    endEl.value = toLocalDT(new Date());
  }
  // 恢复缓存的邮件结果
  restoreMailResults();
  // 启动自动收件
  const cb = document.getElementById('qAutoFetch');
  if (cb && cb.checked) startAutoFetch();
}

// ============ 查询条件缓存 ============
function saveMailQuery() {
  const q = {
    sender: document.getElementById('qSender')?.value || '',
    subject: document.getElementById('qSubject')?.value || '',
    keyword: document.getElementById('qKeyword')?.value || '',
    start: document.getElementById('qStart')?.value || '',
    end: document.getElementById('qEnd')?.value || '',
    limit: document.getElementById('qLimit')?.value || '20',
    unread: document.getElementById('qUnread')?.checked || false,
  };
  localStorage.setItem(LS_MAIL_QUERY, JSON.stringify(q));
}

function restoreMailQuery() {
  try {
    const q = JSON.parse(localStorage.getItem(LS_MAIL_QUERY) || '{}');
    if (q.sender) document.getElementById('qSender').value = q.sender;
    if (q.subject) document.getElementById('qSubject').value = q.subject;
    if (q.keyword) document.getElementById('qKeyword').value = q.keyword;
    if (q.start) document.getElementById('qStart').value = q.start;
    if (q.end) document.getElementById('qEnd').value = q.end;
    if (q.limit) document.getElementById('qLimit').value = q.limit;
    if (q.unread) document.getElementById('qUnread').checked = q.unread;
  } catch { /* ignore */ }
}

// ============ 邮件结果缓存 ============
function saveMailResults(emails) {
  try {
    // 只缓存最近50封,避免 localStorage 溢出
    const trimmed = (emails || []).slice(0, 50);
    localStorage.setItem(LS_MAIL_RESULTS, JSON.stringify(trimmed));
  } catch { /* localStorage 满了就跳过 */ }
}

function restoreMailResults() {
  try {
    const emails = JSON.parse(localStorage.getItem(LS_MAIL_RESULTS) || '[]');
    if (emails.length > 0) {
      renderMailList(emails);
    }
  } catch { /* ignore */ }
}

// ============ 重置查询条件 ============
function resetMailQuery() {
  document.getElementById('qSender').value = '';
  document.getElementById('qSubject').value = '';
  document.getElementById('qKeyword').value = '';
  // 默认时间: 最近1小时
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000);
  document.getElementById('qStart').value = toLocalDT(oneHourAgo);
  document.getElementById('qEnd').value = toLocalDT(now);
  document.getElementById('qLimit').value = '20';
  document.getElementById('qUnread').checked = false;
  // 清除缓存
  localStorage.removeItem(LS_MAIL_QUERY);
  localStorage.removeItem(LS_MAIL_RESULTS);
  // 清空邮件列表
  State._mails = [];
  const list = document.getElementById('mailList');
  list.className = '';
  list.innerHTML = '<div class="mail-empty">已重置查询条件,请点击「查询邮件」</div>';
  document.getElementById('mailCount').textContent = '0';
  toast('查询条件已重置', 'info');
}

// ISO -> datetime-local 格式
function toLocalDT(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============ 自动收件 ============
function toggleAutoFetch() {
  const cb = document.getElementById('qAutoFetch');
  if (cb.checked) {
    startAutoFetch();
  } else {
    stopAutoFetch();
  }
}

function startAutoFetch() {
  stopAutoFetch();
  const statusEl = document.getElementById('autoFetchStatus');
  if (statusEl) statusEl.textContent = '自动收件已开启';
  // 立即触发一次
  fetchMails(true);
  _mailAutoTimer = setInterval(() => fetchMails(true), 10000);
}

function stopAutoFetch() {
  if (_mailAutoTimer) {
    clearInterval(_mailAutoTimer);
    _mailAutoTimer = null;
  }
  const statusEl = document.getElementById('autoFetchStatus');
  if (statusEl) statusEl.textContent = '';
}

// 切换页面时停止定时器 (由 app.js switchTab 间接调用,因为页面会被替换)
function cleanupMailPage() {
  stopAutoFetch();
}

// ============ 加载可用邮箱 ============
async function loadAvailableAccounts() {
  const sel = document.getElementById('aliasAccount');
  if (!sel) return;
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

function refreshCurrentAlias() {
  const a = State.user.alias;
  const el = document.getElementById('currentAlias');
  if (!el) return;
  if (a) {
    el.innerHTML = `当前别名：<span class="mono">${esc(a.full)}</span> <button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(a.full)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button> <span class="badge badge-success">已设置</span> (更新于 ${fmtTime(a.updated_at)})`;
    const sel = document.getElementById('aliasAccount');
    if (sel && a.mail_account_id) sel.value = a.mail_account_id;
    const lbl = document.getElementById('aliasLabel');
    if (lbl && !lbl.value) lbl.value = a.label;
  } else {
    el.innerHTML = '<span class="badge badge-warning">未设置别名</span> 普通用户查询邮件前需先设置别名';
  }
}

async function genRandomLabel() {
  try {
    const data = await api('/api/account/alias/random_label');
    document.getElementById('aliasLabel').value = data.label;
  } catch (err) { toast(err.message, 'error'); }
}

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

// ============ 查询邮件 ============
// silent=true: 自动收件,不记录日志
async function fetchMails(silent = false) {
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

  // 保存查询条件
  saveMailQuery();

  // 自动收件模式: 静默查询,不显示 loading
  if (!silent) {
    const list = document.getElementById('mailList');
    list.innerHTML = '<div class="loading"><span class="spinner"></span> 正在查询...</div>';
  }
  try {
    const data = await api('/api/web/email/fetch', {
      method: 'POST',
      body: { ...params, silent: silent ? true : undefined },
    });
    const emails = data.emails || [];
    renderMailList(emails);
    saveMailResults(emails);
  } catch (err) {
    if (!silent) {
      const list = document.getElementById('mailList');
      list.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
    }
  }
}

function renderMailList(emails) {
  const list = document.getElementById('mailList');
  if (!list) return;
  document.getElementById('mailCount').textContent = emails.length;
  if (!emails.length) {
    list.className = '';
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
  State._mails = emails;
}

function toggleMail(i) {
  document.getElementById('mail-' + i).classList.toggle('expanded');
}

function viewHtmlMail(i) {
  const m = State._mails[i];
  showModal('HTML 邮件预览',
    `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html || '')}" style="width:100%;min-height:400px;border:1px solid var(--border);border-radius:6px"></iframe>`,
    `<button class="btn btn-secondary" onclick="closeModal()">关闭</button>`);
}

async function markMailRead(i) {
  const m = State._mails[i];
  if (!m) return;
  try {
    const data = await api('/api/email/mark_read?key=' + encodeURIComponent(State.user.api_key), {
      method: 'POST', body: { to: m.to, sender: m.from, subject: m.subject }
    });
    toast('已标记 ' + (data.marked || 0) + ' 封已读', 'success');
    m.unread = false;
    const item = document.getElementById('mail-' + i);
    item.classList.remove('unread');
    item.querySelector('.unread-dot')?.remove();
    const badge = item.querySelector('.badge-primary');
    if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '已读'; }
    const btn = item.querySelector('.btn-success');
    if (btn) btn.remove();
    saveMailResults(State._mails);
  } catch (err) { toast(err.message, 'error'); }
}
