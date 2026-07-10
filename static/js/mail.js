/* ============================================================
 * mail.js — 邮件查询页 (自动收件 + 条件缓存 + 弹窗查看 + 静默更新)
 * ============================================================ */

// localStorage 缓存键
const LS_MAIL_QUERY = 'mail_alias_mail_query';
const LS_MAIL_RESULTS = 'mail_alias_mail_results';

// 自动收件定时器
let _mailAutoTimer = null;
// 标记是否正在查看邮件弹窗 (弹窗打开时静默更新不干扰)
let _mailViewingIndex = -1;

async function initMailPage() {
  await loadAvailableAccounts();
  refreshCurrentAlias();
  // 恢复缓存的查询条件
  restoreMailQuery();
  // 如果没有缓存的时间,设置默认为当天 00:00 ~ 23:59
  const startEl = document.getElementById('qStart');
  const endEl = document.getElementById('qEnd');
  if (startEl && !startEl.value) {
    startEl.value = todayStartDT();
  }
  if (endEl && !endEl.value) {
    endEl.value = todayEndDT();
  }
  // 恢复缓存的邮件结果
  restoreMailResults();
  // 启动自动收件
  const cb = document.getElementById('qAutoFetch');
  if (cb && cb.checked) startAutoFetch();
}

// ============ 时间工具 ============
// 当天 00:00 的 datetime-local 字符串
function todayStartDT() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00`;
}
// 当天 23:59 的 datetime-local 字符串
function todayEndDT() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
}
// Date -> datetime-local 格式
function toLocalDT(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    const trimmed = (emails || []).slice(0, 50);
    localStorage.setItem(LS_MAIL_RESULTS, JSON.stringify(trimmed));
  } catch { /* localStorage 满了就跳过 */ }
}

function restoreMailResults() {
  try {
    const emails = JSON.parse(localStorage.getItem(LS_MAIL_RESULTS) || '[]');
    if (emails.length > 0) {
      renderMailList(emails, true);
    }
  } catch { /* ignore */ }
}

// ============ 重置查询条件 ============
function resetMailQuery() {
  document.getElementById('qSender').value = '';
  document.getElementById('qSubject').value = '';
  document.getElementById('qKeyword').value = '';
  // 默认时间: 当天 00:00 ~ 23:59
  document.getElementById('qStart').value = todayStartDT();
  document.getElementById('qEnd').value = todayEndDT();
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

// ============ 自动收件 ============
function toggleAutoFetch() {
  const cb = document.getElementById('qAutoFetch');
  if (cb.checked) startAutoFetch();
  else stopAutoFetch();
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

function cleanupMailPage() {
  stopAutoFetch();
  _mailViewingIndex = -1;
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
// silent=true: 自动收件,静默更新不干扰用户
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

  // 非静默模式显示 loading
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
    // 静默模式: 合并新邮件,不破坏当前页面状态
    if (silent) {
      silentMergeMails(emails);
    } else {
      renderMailList(emails, false);
      saveMailResults(emails);
    }
  } catch (err) {
    if (!silent) {
      const list = document.getElementById('mailList');
      list.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
    }
  }
}

// 静默合并: 将新邮件插入列表头部,不破坏已有展开状态
function silentMergeMails(newEmails) {
  if (!newEmails || newEmails.length === 0) return;
  const oldMails = State._mails || [];
  // 找出旧列表中没有的新邮件 (按 id 去重)
  const oldIds = new Set(oldMails.map(m => m.id));
  const fresh = newEmails.filter(m => !oldIds.has(m.id));
  if (fresh.length === 0) {
    // 没有新邮件,只更新数量
    document.getElementById('mailCount').textContent = oldMails.length;
    return;
  }
  // 合并: 新邮件在前面
  const merged = [...fresh, ...oldMails];
  // 限制数量
  const limit = parseInt(document.getElementById('qLimit')?.value) || 20;
  const trimmed = merged.slice(0, Math.max(limit, merged.length));
  State._mails = trimmed;
  saveMailResults(trimmed);
  // 重新渲染列表 (但如果有弹窗打开,不关闭弹窗)
  renderMailList(trimmed, true);
  // 提示新邮件
  if (fresh.length > 0) {
    const statusEl = document.getElementById('autoFetchStatus');
    if (statusEl) statusEl.textContent = `自动收件: 新增 ${fresh.length} 封`;
    setTimeout(() => {
      const s = document.getElementById('autoFetchStatus');
      if (s) s.textContent = '自动收件已开启';
    }, 3000);
  }
}

// renderMailList: 渲染邮件列表
// skipBody: true 时只渲染头部 (用于恢复缓存, 避免大量 body 渲染卡顿)
function renderMailList(emails, skipBody = false) {
  const list = document.getElementById('mailList');
  if (!list) return;
  document.getElementById('mailCount').textContent = emails.length;
  if (!emails.length) {
    list.className = '';
    list.innerHTML = '<div class="mail-empty">没有符合条件的邮件</div>';
    State._mails = [];
    return;
  }
  list.className = 'mail-list';
  list.innerHTML = emails.map((m, i) => `
    <div class="mail-item ${m.unread ? 'unread' : ''}" id="mail-${i}">
      <div class="mail-head" onclick="viewMailDetail(${i})">
        ${m.unread ? '<span class="unread-dot"></span>' : ''}
        <span class="from">${esc(m.from || '(未知发件人)')}</span>
        <span class="subject">${esc(m.subject || '(无主题)')}</span>
        <span class="date">${esc(m.date || '')}</span>
      </div>
    </div>`).join('');
  State._mails = emails;
}

// ============ 弹窗查看邮件详情 ============
function viewMailDetail(i) {
  const m = State._mails[i];
  if (!m) return;
  _mailViewingIndex = i;

  // 弹窗展示完整邮件内容
  const bodyContent = m.html
    ? `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html)}" style="width:100%;min-height:400px;border:1px solid var(--border);border-radius:6px"></iframe>`
    : `<div class="mail-detail-body">${esc(m.body || '(无正文)')}</div>`;

  const footer = `
    ${m.html ? `<button class="btn btn-secondary" onclick="toggleMailView(${i})">切换纯文本</button>` : ''}
    <button class="btn btn-secondary" onclick="closeModal()">关闭</button>
  `;

  showModal(
    esc(m.subject || '(无主题)'),
    `<div class="mail-detail">
       <div class="mail-detail-meta">
         <div><strong>发件人:</strong> ${esc(m.from || '-')}</div>
         <div><strong>收件人:</strong> ${esc(m.to || '-')}</div>
         <div><strong>时间:</strong> ${esc(m.date || '-')}</div>
         <div><strong>状态:</strong> ${m.unread ? '<span class="badge badge-primary">未读</span>' : '<span class="badge badge-gray">已读</span>'}</div>
       </div>
       <hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">
       <div id="mailDetailBody">${bodyContent}</div>
     </div>`,
    footer
  );

  // 如果邮件未读,自动标记已读
  if (m.unread) {
    markMailRead(i, true);
  }
}

// 切换纯文本/HTML视图
function toggleMailView(i) {
  const m = State._mails[i];
  if (!m) return;
  const bodyEl = document.getElementById('mailDetailBody');
  if (!bodyEl) return;
  // 检查当前显示的是否是 iframe
  const isHtml = bodyEl.querySelector('iframe');
  if (isHtml) {
    bodyEl.innerHTML = `<div class="mail-detail-body">${esc(m.body || '(无正文)')}</div>`;
  } else {
    bodyEl.innerHTML = `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html || '')}" style="width:100%;min-height:400px;border:1px solid var(--border);border-radius:6px"></iframe>`;
  }
}

// ============ 标记已读 ============
// autoMark: 弹窗查看时自动调用,不显示 toast
async function markMailRead(i, autoMark = false) {
  const m = State._mails[i];
  if (!m) return;
  try {
    // 使用 web 端 session 认证的标记已读接口
    const data = await api('/api/web/email/mark_read', {
      method: 'POST',
      body: { to: m.to, sender: m.from, subject: m.subject, mail_account_id: getMailAccountId() }
    });
    if (!autoMark) {
      toast('已标记 ' + (data.marked || 0) + ' 封已读', 'success');
    }
    // 更新本地状态
    m.unread = false;
    // 更新列表中的样式
    const item = document.getElementById('mail-' + i);
    if (item) {
      item.classList.remove('unread');
      item.querySelector('.unread-dot')?.remove();
    }
    // 更新弹窗中的状态标签
    if (_mailViewingIndex === i) {
      const badge = document.querySelector('.modal-body .badge-primary');
      if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '已读'; }
    }
    saveMailResults(State._mails);
  } catch (err) {
    if (!autoMark) toast(err.message, 'error');
  }
}

// 获取当前查询的邮箱账号ID
function getMailAccountId() {
  if (State.user?.alias?.mail_account_id) return State.user.alias.mail_account_id;
  const sel = document.getElementById('aliasAccount');
  return sel?.value || undefined;
}
