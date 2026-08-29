/* ============================================================
 * mail.js — 邮件查询页
 *   · 多别名管理(最多 5 个同时生效 / 1 小时有效期 / 收藏 / 历史)
 *   · 单一模糊搜索框(发件人·收件人·标题·正文·附件)
 *   · 常规分页(可切换每页条数),不再有「数量上限」输入框
 *   · 进入页面即恢复默认: 当天 00:00 ~ 23:59,不做任何本地缓存
 * ============================================================ */

// 兼容:清理旧版本遗留的查询缓存(曾导致开始/结束时间被固定在某一天)
try {
  localStorage.removeItem('mail_alias_mail_query');
  localStorage.removeItem('mail_alias_mail_results');
} catch { /* ignore */ }

const MailState = {
  page: 1,
  pageSize: 20,
  emails: [],
  truncated: false,
  aliases: [],          // 生效中的别名
  scope: 'all',         // all | a:<aliasId> | mb:<accountId>
  historyOpen: false,
  history: { page: 1, keyword: '', total: 0, totalPages: 1, list: [] },
};

let _mailAutoTimer = null;
let _historySearchTimer = null;
let _mailSearchTimer = null;

/* ============ 页面初始化 ============ */
async function initMailPage() {
  // 每次进入都恢复默认,不做任何条件缓存
  resetMailState();
  await loadAvailableAccounts();
  await loadAliases();
  applyDefaultTimeRange();
  bindSearchBox();
  await fetchMails();
  loadAliasHistory(1, true);   // 预取条数用于标题展示(面板默认折叠)
  if (document.getElementById('qAutoFetch')?.checked) startAutoFetch();
}

function cleanupMailPage() {
  stopAutoFetch();
  if (_historySearchTimer) { clearTimeout(_historySearchTimer); _historySearchTimer = null; }
  if (_mailSearchTimer) { clearTimeout(_mailSearchTimer); _mailSearchTimer = null; }
}

function resetMailState() {
  MailState.page = 1;
  MailState.pageSize = 20;
  MailState.emails = [];
  MailState.truncated = false;
  MailState.scope = 'all';
  MailState.history.page = 1;
  MailState.history.keyword = '';
  const cb = document.getElementById('qAutoFetch');
  if (cb) cb.checked = true;      // 默认开启自动收件
}

/* ============ 时间工具 ============ */
function pad2(n) { return String(n).padStart(2, '0'); }

// 当天 00:00(dt-local 格式)
function todayStartDT() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T00:00`;
}
// 当天 23:59(dt-local 格式)
function todayEndDT() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T23:59`;
}

function applyDefaultTimeRange() {
  const s = document.getElementById('qStart');
  const e = document.getElementById('qEnd');
  if (s) s.value = todayStartDT();
  if (e) e.value = todayEndDT();
  const unread = document.getElementById('qUnread');
  if (unread) unread.checked = false;
  const search = document.getElementById('qSearch');
  if (search) search.value = '';
  const clear = document.getElementById('qSearchClear');
  if (clear) clear.style.display = 'none';
}

/* ============ 搜索框(防抖自动查询) ============ */
function bindSearchBox() {
  const input = document.getElementById('qSearch');
  if (!input) return;
  input.oninput = () => {
    const clear = document.getElementById('qSearchClear');
    if (clear) clear.style.display = input.value ? 'block' : 'none';
    if (_mailSearchTimer) clearTimeout(_mailSearchTimer);
    _mailSearchTimer = setTimeout(() => {
      MailState.page = 1;
      fetchMails();
    }, 450);
  };
}

function clearSearch() {
  const input = document.getElementById('qSearch');
  if (input) input.value = '';
  const clear = document.getElementById('qSearchClear');
  if (clear) clear.style.display = 'none';
  MailState.page = 1;
  fetchMails();
}

// 重置查询条件(时间回到当天,清空搜索与筛选)
function resetMailQuery() {
  applyDefaultTimeRange();
  MailState.page = 1;
  MailState.emails = [];
  MailState.truncated = false;
  renderMailList();
  renderMailPagination();
  toast('查询条件已重置为当天', 'info');
  fetchMails();
}

/* ============ 可用邮箱 / 查询范围 ============ */
async function loadAvailableAccounts() {
  const sel = document.getElementById('aliasAccount');
  if (!sel) return;
  try {
    const list = await api('/api/account/mail_accounts/available');
    State.availableAccounts = list || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">无可用的邮箱，请先到「我的账户」绑定</option>';
    } else {
      sel.innerHTML = list.map(a =>
        `<option value="${esc(a.id)}">${esc(a.email)} (${esc(a.provider)}${a.is_own ? '' : ' · 公开'})</option>`
      ).join('');
    }
  } catch (err) {
    sel.innerHTML = '<option value="">加载失败</option>';
    toast(err.message, 'error');
  }
}

function onScopeChange() {
  const sel = document.getElementById('qScope');
  if (!sel) return;
  MailState.scope = sel.value;
  MailState.page = 1;
  fetchMails();
}

function rebuildScopeOptions() {
  const sel = document.getElementById('qScope');
  if (!sel) return;
  const opts = [`<option value="all">全部生效别名${MailState.aliases.length ? ` (${MailState.aliases.length})` : ''}</option>`];
  for (const a of MailState.aliases) {
    opts.push(`<option value="a:${esc(a.id)}">${esc(a.full)}</option>`);
  }
  if (State.user && State.user.is_admin) {
    for (const acc of (State.user.mail_accounts || [])) {
      opts.push(`<option value="mb:${esc(acc.id)}">整箱 · ${esc(acc.email)}</option>`);
    }
  }
  // 若当前选择的是某个未生效的别名(从历史列表点「查看收件」进来),补一个临时选项
  if (MailState.scope.indexOf('a:') === 0) {
    const id = MailState.scope.slice(2);
    const inActive = MailState.aliases.some(a => a.id === id);
    const hist = (MailState.history.list || []).find(a => a.id === id);
    if (!inActive && hist) {
      opts.splice(1, 0, `<option value="a:${esc(id)}">${esc(hist.full)}（未启用）</option>`);
    } else if (!inActive && !hist) {
      MailState.scope = 'all';
    }
  }
  sel.innerHTML = opts.join('');
  if (opts.some(o => o.indexOf(`value="${MailState.scope}"`) >= 0)) {
    sel.value = MailState.scope;
  } else {
    sel.value = 'all';
    MailState.scope = 'all';
  }
}

/* ============ 别名: 生效列表 ============ */
async function loadAliases() {
  const box = document.getElementById('activeAliasList');
  if (!box) return;
  box.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    const data = await api('/api/account/aliases');
    MailState.aliases = data.list || [];
    State.aliasMax = data.max || 5;
    State.aliasTtlMs = data.ttl_ms || 3600000;
    renderActiveAliases();
    rebuildScopeOptions();
    updateUserAliasTag(MailState.aliases.length);
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

function updateUserAliasTag(count) {
  if (State.user) State.user.active_alias_count = count;
  const tag = document.getElementById('navAliasTag');
  if (tag) tag.textContent = String(count);
}

function renderActiveAliases() {
  const box = document.getElementById('activeAliasList');
  if (!box) return;
  const list = MailState.aliases;
  const max = State.aliasMax || 5;
  const quota = document.getElementById('aliasQuota');
  if (quota) {
    quota.innerHTML = `生效中 <strong>${list.length}</strong> / ${max} 个` +
      (list.length >= max ? ' · <span class="text-danger">已达上限</span>' : '');
  }
  if (!list.length) {
    box.innerHTML = '<div class="mail-empty" style="grid-column:1/-1">暂无效中的别名，请选择一个主邮箱并创建别名</div>';
    return;
  }
  box.innerHTML = list.map(a => {
    const pct = Math.max(0, Math.min(100, ((a.remain_ms || 0) / (State.aliasTtlMs || 3600000)) * 100));
    return `
    <div class="alias-card is-active">
      <div class="ac-top">
        <div style="flex:1; min-width:0">
          <div class="ac-addr">${esc(a.full)}</div>
          <div class="ac-sub">主邮箱 ${esc(a.email || '-')} · 剩余 ${fmtRemain(a.remain_ms)}</div>
        </div>
        ${starButton(a.id, a.is_favorite, 'toggleAliasFavorite')}
        <button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(a.full)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <div class="ac-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="ac-actions">
        <button class="btn btn-secondary btn-xs" onclick="focusAlias('${esc(a.id)}')">只看此别名</button>
        <button class="btn btn-secondary btn-xs" onclick="renewAlias('${esc(a.id)}')">续期 1 小时</button>
        <button class="btn btn-secondary btn-xs" onclick="deactivateAlias('${esc(a.id)}')">停用</button>
      </div>
    </div>`;
  }).join('');
}

function starButton(id, on, fnName) {
  return `<button class="star-btn ${on ? 'on' : ''}" title="${on ? '取消收藏' : '收藏'}" onclick="${fnName}('${esc(id)}', ${on ? 'false' : 'true'})" aria-label="收藏">
    <svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
  </button>`;
}

async function genRandomLabel() {
  try {
    const data = await api('/api/account/alias/random_label');
    const el = document.getElementById('aliasLabel');
    if (el) el.value = data.label;
  } catch (err) { toast(err.message, 'error'); }
}

async function createAlias() {
  const mailAccountId = document.getElementById('aliasAccount').value;
  const label = document.getElementById('aliasLabel').value.trim();
  if (!mailAccountId) { toast('请选择主邮箱', 'warning'); return; }
  if (!label) { toast('请输入别名标签', 'warning'); return; }
  try {
    const alias = await api('/api/account/aliases', { method: 'POST', body: { mail_account_id: mailAccountId, label } });
    toast('别名创建成功: ' + (alias ? alias.full : ''), 'success');
    document.getElementById('aliasLabel').value = '';
    await loadAliases();
    await loadAliasHistory(MailState.history.page);
    MailState.page = 1;
    await fetchMails();
  } catch (err) {
    toast(err.message, 'error', 3600);
  }
}

async function renewAlias(id) {
  try {
    await api('/api/account/aliases/' + id + '/renew', { method: 'POST' });
    toast('已续期 1 小时', 'success');
    await loadAliases();
  } catch (err) { toast(err.message, 'error', 3600); }
}

async function deactivateAlias(id) {
  try {
    await api('/api/account/aliases/' + id + '/deactivate', { method: 'POST' });
    toast('已停用该别名,已移入历史列表', 'success');
    await loadAliases();
    await loadAliasHistory(MailState.history.page);
    MailState.page = 1;
    await fetchMails();
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleAliasFavorite(id, favorite) {
  try {
    await api('/api/account/aliases/' + id + '/favorite', { method: 'POST', body: { favorite } });
    toast(favorite ? '已收藏' : '已取消收藏', 'success');
    await loadAliases();
    if (MailState.historyOpen) await loadAliasHistory(MailState.history.page);
  } catch (err) { toast(err.message, 'error'); }
}

function focusAlias(id) {
  MailState.scope = 'a:' + id;
  rebuildScopeOptions();
  MailState.page = 1;
  fetchMails();
}

/* ============ 历史别名(折叠面板) ============ */
function toggleHistoryPanel() {
  MailState.historyOpen = !MailState.historyOpen;
  const head = document.getElementById('historyToggle');
  const body = document.getElementById('historyBody');
  if (head) { head.classList.toggle('open', MailState.historyOpen); head.setAttribute('aria-expanded', String(MailState.historyOpen)); }
  if (body) body.classList.toggle('collapsed', !MailState.historyOpen);
  if (MailState.historyOpen) loadAliasHistory(MailState.history.page);
}

function onHistoryKeywordInput() {
  const input = document.getElementById('historyKeyword');
  const clear = document.getElementById('historyKeywordClear');
  if (clear) clear.style.display = input && input.value ? 'block' : 'none';
  if (_historySearchTimer) clearTimeout(_historySearchTimer);
  _historySearchTimer = setTimeout(() => loadAliasHistory(1), 350);
}

function clearHistoryKeyword() {
  const input = document.getElementById('historyKeyword');
  if (input) input.value = '';
  const clear = document.getElementById('historyKeywordClear');
  if (clear) clear.style.display = 'none';
  loadAliasHistory(1);
}

async function loadAliasHistory(page, silent = false) {
  const box = document.getElementById('historyList');
  if (!box) return;
  if (!silent) box.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  MailState.history.page = page;
  const keywordEl = document.getElementById('historyKeyword');
  const keyword = keywordEl ? keywordEl.value.trim() : (MailState.history.keyword || '');
  MailState.history.keyword = keyword;
  try {
    const data = await api('/api/account/aliases/history?page=' + page + '&keyword=' + encodeURIComponent(keyword));
    MailState.history.list = data.list || [];
    MailState.history.total = data.total || 0;
    MailState.history.totalPages = data.total_pages || 1;
    const cnt = document.getElementById('historyCount');
    if (cnt) cnt.textContent = `共 ${data.total || 0} 个`;
    renderAliasHistory();
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

function renderAliasHistory() {
  const box = document.getElementById('historyList');
  const pager = document.getElementById('historyPagination');
  if (!box) return;
  const list = MailState.history.list;
  if (!list.length) {
    box.innerHTML = '<div class="mail-empty">暂无历史别名</div>';
    if (pager) pager.innerHTML = '';
    return;
  }
  box.innerHTML = '<div class="alias-grid">' + list.map(a => {
    const active = a.status === 'active';
    return `
    <div class="alias-card ${active ? 'is-active' : 'is-expired'}">
      <div class="ac-top">
        <div style="flex:1; min-width:0">
          <div class="ac-addr">${esc(a.full)}</div>
          <div class="ac-sub">${esc(a.email || '-')} · 最后使用 ${fmtTime(a.last_used_at)}</div>
        </div>
        ${starButton(a.id, a.is_favorite, 'toggleHistoryFavorite')}
        <button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(a.full)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <div class="ac-actions">
        <span class="badge ${active ? 'badge-success' : 'badge-gray'}">${active ? '生效中' : (a.status === 'expired' ? '已过期' : '已停用')}</span>
        ${active ? '' : `<button class="btn btn-xs" onclick="restoreAlias('${esc(a.id)}')">恢复启用</button>`}
        ${active ? `<button class="btn btn-secondary btn-xs" onclick="renewAlias('${esc(a.id)}')">续期</button>` : ''}
        <button class="btn btn-secondary btn-xs" onclick="focusAlias('${esc(a.id)}')">查看收件</button>
        <button class="btn btn-danger btn-xs" onclick="deleteAliasItem('${esc(a.id)}')">删除</button>
      </div>
    </div>`;
  }).join('') + '</div>';

  if (pager) {
    pager.innerHTML = pagerHtml(MailState.history.page, MailState.history.totalPages, MailState.history.total, 'loadAliasHistory', '个');
  }
}

async function toggleHistoryFavorite(id, favorite) {
  try {
    await api('/api/account/aliases/' + id + '/favorite', { method: 'POST', body: { favorite } });
    toast(favorite ? '已收藏,该别名将长期保留' : '已取消收藏', 'success');
    await loadAliasHistory(MailState.history.page);
    await loadAliases();
  } catch (err) { toast(err.message, 'error'); }
}

async function restoreAlias(id) {
  try {
    const alias = await api('/api/account/aliases/' + id + '/restore', { method: 'POST' });
    toast('已恢复启用: ' + (alias ? alias.full : ''), 'success');
    await loadAliases();
    await loadAliasHistory(MailState.history.page);
    MailState.page = 1;
    await fetchMails();
  } catch (err) {
    toast(err.message, 'error', 3600);
  }
}

async function deleteAliasItem(id) {
  confirmDialog('确认删除该别名？删除后无法恢复，且不再出现在历史列表中。', async () => {
    try {
      await api('/api/account/aliases/' + id, { method: 'DELETE' });
      toast('已删除', 'success');
      await loadAliases();
      await loadAliasHistory(MailState.history.page);
      MailState.page = 1;
      await fetchMails();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============ 分页组件 ============ */
function pagerHtml(page, totalPages, total, fnName, unit) {
  const u = unit || '封';
  return `<div class="pagination">
    <button class="btn btn-sm" onclick="${fnName}(1)" ${page <= 1 ? 'disabled' : ''}>首页</button>
    <button class="btn btn-sm" onclick="${fnName}(${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${total} ${u}</span>
    <button class="btn btn-sm" onclick="${fnName}(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    <button class="btn btn-sm" onclick="${fnName}(${totalPages})" ${page >= totalPages ? 'disabled' : ''}>末页</button>
    <input type="number" min="1" max="${totalPages}" value="${page}" id="pagerJumpInput" onkeydown="if(event.key==='Enter')pagerJump('${fnName}',${totalPages})">
    <button class="btn btn-sm" onclick="pagerJump('${fnName}',${totalPages})">跳转</button>
  </div>`;
}

function pagerJump(fnName, totalPages) {
  const input = document.getElementById('pagerJumpInput');
  if (!input) return;
  const page = parseInt(input.value, 10);
  if (!page || page < 1) { toast('请输入有效页码', 'warning'); return; }
  if (page > totalPages) { toast('页码超出范围, 最大 ' + totalPages + ' 页', 'warning'); return; }
  if (fnName === 'loadAliasHistory') loadAliasHistory(page);
  else gotoMailPage(page);
}

/* ============ 查询邮件 ============ */
function buildFetchBody(silent) {
  const q = (document.getElementById('qSearch')?.value || '').trim();
  const start = document.getElementById('qStart')?.value;
  const end = document.getElementById('qEnd')?.value;
  const unread = document.getElementById('qUnread')?.checked === true;

  const body = {
    q,
    page: MailState.page,
    page_size: MailState.pageSize,
    silent: silent ? true : undefined,
  };
  if (unread) body.unseen = true;
  if (start) body.start_time = new Date(start).toISOString();
  if (end) {
    // 结束时间补齐到该分钟末尾,避免 23:59 被解释成 23:59:00 漏掉最后一分钟
    body.end_time = new Date(end + ':59').toISOString();
  }

  const scope = MailState.scope || 'all';
  if (scope === 'all') {
    body.all_aliases = true;
  } else if (scope.indexOf('a:') === 0) {
    body.alias_id = scope.slice(2);
  } else if (scope.indexOf('mb:') === 0) {
    body.all_aliases = false;
    body.mail_account_id = scope.slice(3);
  }
  return body;
}

async function fetchMails(silent = false) {
  if (!silent) {
    const list = document.getElementById('mailList');
    if (list) list.innerHTML = '<div class="loading"><span class="spinner"></span> 正在查询...</div>';
  }
  try {
    const data = await api('/api/web/email/fetch', { method: 'POST', body: buildFetchBody(silent) });
    if (silent) silentMergeMails(data.emails || []);
    else {
      MailState.emails = data.emails || [];
      MailState.truncated = !!data.truncated;
      renderMailList();
      renderMailPagination();
    }
    // 同步服务端返回的剩余有效期(用于进度条)
    if (Array.isArray(data.aliases)) {
      const byId = {};
      for (const a of data.aliases) byId[a.id] = a;
      MailState.aliases = MailState.aliases.map(a => (byId[a.id] ? Object.assign({}, a, { remain_ms: byId[a.id].remain_ms }) : a));
      renderActiveAliases();
    }
  } catch (err) {
    if (!silent) {
      const list = document.getElementById('mailList');
      if (list) list.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
      const pager = document.getElementById('mailPagination');
      if (pager) pager.innerHTML = '';
      const cnt = document.getElementById('mailCount');
      if (cnt) cnt.textContent = '0';
    }
  }
}

// 静默合并:按 id 去重后插到前面,保持当前页码不变
function silentMergeMails(newEmails) {
  if (!newEmails || !newEmails.length) return;
  const old = MailState.emails || [];
  const oldIds = new Set(old.map(m => m.id));
  const fresh = newEmails.filter(m => !oldIds.has(m.id));
  if (!fresh.length) {
    renderMailList();
    return;
  }
  MailState.emails = [...fresh, ...old];
  renderMailList();
  renderMailPagination();
  const statusEl = document.getElementById('autoFetchStatus');
  if (statusEl) {
    statusEl.textContent = `自动收件: 新增 ${fresh.length} 封`;
    setTimeout(() => { const s = document.getElementById('autoFetchStatus'); if (s) s.textContent = ''; }, 3000);
  }
}

function renderMailList() {
  const list = document.getElementById('mailList');
  const cnt = document.getElementById('mailCount');
  if (!list) return;
  const all = MailState.emails || [];
  if (cnt) cnt.textContent = String(all.length);
  if (!all.length) {
    list.className = '';
    list.innerHTML = '<div class="mail-empty">没有符合条件的邮件</div>';
    return;
  }
  const size = MailState.pageSize;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  if (MailState.page > totalPages) MailState.page = totalPages;
  const start = (MailState.page - 1) * size;
  const pageItems = all.slice(start, start + size);

  list.className = 'mail-list';
  list.innerHTML = pageItems.map((m, idx) => {
    const i = start + idx;
    const atts = (m.attachments || []).filter(Boolean);
    return `
    <div class="mail-item ${m.unread ? 'unread' : ''}" id="mail-${i}">
      <div class="mail-head" onclick="viewMailDetail(${i})" title="点击查看完整邮件">
        ${m.unread ? '<span class="unread-dot"></span>' : ''}
        <span class="from">${esc(m.from || '(未知发件人)')}</span>
        <span class="subject">${esc(m.subject || '(无主题)')}</span>
        ${m.alias ? `<span class="alias-chip" title="命中别名 ${esc(m.alias)}">${esc(m.alias)}</span>` : ''}
        ${atts.length ? `<span class="att-chip" title="${esc(atts.join('、'))}">📎 ${atts.length}</span>` : ''}
        <span class="date">${esc(m.date || '')}</span>
      </div>
    </div>`;
  }).join('');
}

function renderMailPagination() {
  const pager = document.getElementById('mailPagination');
  if (!pager) return;
  const total = (MailState.emails || []).length;
  if (!total) { pager.innerHTML = ''; return; }
  const totalPages = Math.max(1, Math.ceil(total / MailState.pageSize));
  pager.innerHTML = pagerHtml(MailState.page, totalPages, total, 'gotoMailPage', '封') +
    (MailState.truncated
      ? '<div class="form-hint" style="text-align:center; margin-top:8px">已达单次抓取上限，更早或被过滤的邮件请缩小时间范围或使用搜索词</div>'
      : '');
}

function gotoMailPage(page) {
  MailState.page = Math.max(1, page);
  renderMailList();
  renderMailPagination();
}

function onPageSizeChange() {
  const sel = document.getElementById('pageSizeSel');
  if (!sel) return;
  MailState.pageSize = parseInt(sel.value, 10) || 20;
  MailState.page = 1;
  // 每页条数变化后可能需要更多数据,重新向服务端取一次
  fetchMails();
}

/* ============ 自动收件 ============ */
function toggleAutoFetch() {
  const cb = document.getElementById('qAutoFetch');
  if (cb && cb.checked) startAutoFetch();
  else stopAutoFetch();
}

function startAutoFetch() {
  stopAutoFetch();
  const statusEl = document.getElementById('autoFetchStatus');
  if (statusEl) statusEl.textContent = '自动收件已开启';
  _mailAutoTimer = setInterval(() => fetchMails(true), 15000);
}

function stopAutoFetch() {
  if (_mailAutoTimer) { clearInterval(_mailAutoTimer); _mailAutoTimer = null; }
  const statusEl = document.getElementById('autoFetchStatus');
  if (statusEl) statusEl.textContent = '';
}

/* ============ 邮件详情弹窗 ============ */
function viewMailDetail(i) {
  const m = MailState.emails[i];
  if (!m) return;
  const atts = (m.attachments || []).filter(Boolean);
  const bodyContent = m.html
    ? `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html)}" style="width:100%;min-height:420px;border:1px solid var(--border);border-radius:8px"></iframe>`
    : `<div class="mail-detail-body">${esc(m.body || '(无正文)')}</div>`;

  const footer = `
    ${m.html ? `<button class="btn btn-secondary" onclick="toggleMailView(${i})">切换纯文本</button>` : ''}
    <button class="btn btn-secondary" onclick="closeModal()">关闭</button>
  `;

  showModal(
    m.subject || '(无主题)',
    `<div class="mail-detail">
       <div class="mail-detail-meta">
         <div><strong>发件人:</strong> ${esc(m.from || '-')}</div>
         <div><strong>收件人:</strong> ${esc(m.to || '-')}</div>
         ${m.alias ? `<div><strong>命中别名:</strong> <span class="badge badge-primary">${esc(m.alias)}</span></div>` : ''}
         <div><strong>时间:</strong> ${esc(m.date || '-')}</div>
         <div><strong>附件:</strong> ${atts.length ? esc(atts.join('、')) : '无'}</div>
         <div><strong>状态:</strong> ${m.unread ? '<span class="badge badge-primary">未读</span>' : '<span class="badge badge-gray">已读</span>'}</div>
       </div>
       <hr class="divider">
       <div id="mailDetailBody">${bodyContent}</div>
     </div>`,
    footer,
    true
  );

  // 未读邮件打开即标记已读(静默,不弹提示)
  if (m.unread) markMailRead(i, true);
}

// 标记已读
async function markMailRead(i, autoMark = false) {
  const m = MailState.emails[i];
  if (!m) return;
  let accountId;
  if (MailState.scope.indexOf('mb:') === 0) accountId = MailState.scope.slice(3);
  else if (MailState.scope.indexOf('a:') === 0) {
    const a = (MailState.aliases || []).find(x => x.id === MailState.scope.slice(2));
    accountId = a ? a.mail_account_id : undefined;
  } else {
    const hit = (MailState.aliases || []).find(x => x.full === m.alias);
    accountId = hit ? hit.mail_account_id : undefined;
  }
  try {
    await api('/api/web/email/mark_read', {
      method: 'POST',
      body: { to: m.to, sender: m.from, subject: m.subject, mail_account_id: accountId },
    });
    m.unread = false;
    const item = document.getElementById('mail-' + i);
    if (item) {
      item.classList.remove('unread');
      const dot = item.querySelector('.unread-dot');
      if (dot) dot.remove();
    }
    if (!autoMark) toast('已标记已读', 'success');
  } catch (err) {
    if (!autoMark) toast(err.message, 'error');
  }
}

function toggleMailView(i) {
  const m = MailState.emails[i];
  if (!m) return;
  const bodyEl = document.getElementById('mailDetailBody');
  if (!bodyEl) return;
  if (bodyEl.querySelector('iframe')) {
    bodyEl.innerHTML = `<div class="mail-detail-body">${esc(m.body || '(无正文)')}</div>`;
  } else {
    bodyEl.innerHTML = `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html || '')}" style="width:100%;min-height:420px;border:1px solid var(--border);border-radius:8px"></iframe>`;
  }
}
