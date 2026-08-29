/* ============================================================
 * mail.js — 邮件查询页(新版)
 *   · 左右分栏: 左侧别名列表, 右侧邮件列表
 *   · 点击别名实时切换收件; 查询范围 = 该别名存活期间(created_at ~ now)
 *   · 动态加载: 默认 10 条, 滚动到底部自动加载更多
 *   · 搜索 / 仅未读 / 自动收件 集中在邮件列表板块标题栏
 *   · 创建别名改为弹窗
 * ============================================================ */

// 兼容:清理旧版本遗留的查询缓存
const CLEANED_LS_KEYS = ['mail_alias_mail_query', 'mail_alias_mail_results'];
try { CLEANED_LS_KEYS.forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }

const MailState = {
  aliases: [],          // 生效中的别名
  selectedAliasId: null,
  emails: [],
  offset: 0,            // 无限滚动偏移
  hasMore: false,
  loadingMore: false,
  q: '',
  unseen: false,
  autoFetch: true,
  historyOpen: false,
  history: { page: 1, keyword: '', total: 0, totalPages: 1, list: [] },
};

let _mailAutoTimer = null;
let _historySearchTimer = null;
let _mailSearchTimer = null;

/* ============ 页面初始化 ============ */
async function initMailPage() {
  resetMailState();
  await loadAvailableAccounts();
  await loadAliases();
  bindSearchBox();
  bindInfiniteScroll();
  // 预取历史条数(面板默认折叠)
  loadAliasHistory(1, true);
  // 默认开启自动收件
  const cb = document.getElementById('qAutoFetch');
  if (cb) cb.checked = true;
  startAutoFetch();
}

function cleanupMailPage() {
  stopAutoFetch();
  if (_historySearchTimer) { clearTimeout(_historySearchTimer); _historySearchTimer = null; }
  if (_mailSearchTimer) { clearTimeout(_mailSearchTimer); _mailSearchTimer = null; }
}

function resetMailState() {
  MailState.selectedAliasId = null;
  MailState.emails = [];
  MailState.offset = 0;
  MailState.hasMore = false;
  MailState.loadingMore = false;
  MailState.q = '';
  MailState.unseen = false;
  MailState.history.page = 1;
  MailState.history.keyword = '';
  MailState.historyOpen = false;
}

/* ============ 可用邮箱 / 创建别名弹窗 ============ */
async function loadAvailableAccounts() {
  try {
    const list = await api('/api/account/mail_accounts/available');
    State.availableAccounts = list || [];
  } catch (err) { console.warn('available accounts', err); }
}

function openCreateAliasModal() {
  const accounts = State.availableAccounts || [];
  if (!accounts.length) {
    return showModal('创建别名', '<p>暂无可用的主邮箱，请先到「我的账户」绑定邮箱。</p><p>绑定成功后刷新本页即可创建别名。</p>', '<button class="btn btn-secondary" onclick="closeModal()">关闭</button>');
  }
  const listAtQuota = MailState.aliases.length >= (State.aliasMax || 5);
  const body = `
    <div class="form-group">
      <label class="form-label">主邮箱</label>
      <select id="modalAliasAccount" class="form-control" style="height:40px">
        ${accounts.map(a => `<option value="${esc(a.id)}">${esc(a.email)} (${esc(a.provider)})</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">别名标签</label>
      <div style="display:flex; gap:8px">
        <input type="text" id="modalAliasLabel" class="form-control" placeholder="如 newsletter" style="height:40px">
        <button class="dice-btn" title="随机生成" onclick="genRandomLabelForModal()" aria-label="随机生成别名标签">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 3.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM16 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
          </svg>
        </button>
      </div>
    </div>
    ${listAtQuota ? '<p class="text-danger">已到达别名上限，创建前请先停用或删除一个别名。</p>' : '<p class="form-hint">每个别名有效期 1 小时，到期自动停止收件（可在历史列表中恢复）。</p>'}
  `;
  showModal('创建别名', body,
    `<button class="btn btn-secondary" onclick="closeModal()">取消</button>
     <button class="btn" id="modalCreateAliasBtn" ${listAtQuota ? 'disabled' : ''}>创建</button>`);
  const createBtn = document.getElementById('modalCreateAliasBtn');
  if (createBtn) {
    createBtn.onclick = () => {
      const accountId = document.getElementById('modalAliasAccount').value;
      const label = document.getElementById('modalAliasLabel').value.trim();
      doCreateAlias(accountId, label);
    };
  }
}

// 随机别名标签:纯前端生成,不发网络请求(点骰子零延迟)
function genRandomLabelForModal() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去掉易混淆的 l/o/0/1
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  const el = document.getElementById('modalAliasLabel');
  if (el) el.value = s;
}

async function doCreateAlias(mailAccountId, label) {
  if (!mailAccountId) { toast('请选择主邮箱', 'warning'); return; }
  if (!label) { toast('请输入别名标签', 'warning'); return; }
  try {
    const alias = await api('/api/account/aliases', { method: 'POST', body: { mail_account_id: mailAccountId, label } });
    toast('别名创建成功: ' + (alias ? alias.full : ''), 'success');
    closeModal();
    await loadAliases();
    await loadAliasHistory(MailState.history.page);
    // 如果创建后只有 1 个别名，自动选中
    if (MailState.aliases.length === 1) selectAlias(alias.id);
  } catch (err) { toast(err.message, 'error', 3600); }
}

/* ============ 别名: 生效列表(左侧) ============ */
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
    updateUserAliasTag(MailState.aliases.length);
    // 默认选中第一个
    if (!MailState.selectedAliasId && MailState.aliases.length) {
      selectAlias(MailState.aliases[0].id);
    }
  } catch (err) { box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`; }
}

function updateUserAliasTag(count) {
  if (State.user) State.user.active_alias_count = count;
  const tag = document.getElementById('navAliasTag');
  if (tag) tag.textContent = String(count);
}

function renderActiveAliases() {
  const box = document.getElementById('activeAliasList');
  const quota = document.getElementById('aliasQuota');
  if (!box) return;
  const list = MailState.aliases;
  const max = State.aliasMax || 5;
  if (quota) {
    quota.innerHTML = `生效中 <strong>${list.length}</strong> / ${max}` +
      (list.length >= max ? ' · <span class="text-danger">满</span>' : '');
  }
  if (!list.length) {
    box.innerHTML = '<div class="mail-empty">暂无效中的别名，点击右上角「创建别名」添加。</div>';
    return;
  }
  box.innerHTML = list.map(a => {
    const pct = Math.max(0, Math.min(100, ((a.remain_ms || 0) / (State.aliasTtlMs || 3600000)) * 100));
    const isSel = a.id === MailState.selectedAliasId;
    return `
    <div class="alias-row ${isSel ? 'selected' : ''} ${a.remain_ms <= 0 ? 'expired' : ''}" onclick="selectAlias('${esc(a.id)}')">
      <div class="ar-info">
        <div class="ar-addr">${esc(a.full)}</div>
        <div class="ar-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>
      <div class="ar-actions" onclick="event.stopPropagation()">
        ${starButton(a.id, a.is_favorite, 'toggleAliasFavorite')}
        <button class="copy-icon-btn" title="复制别名地址" onclick="copyText('${esc(a.full)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
        <button class="icon-btn warn" title="停用该别名（保留记录，可恢复）" onclick="deactivateAlias('${esc(a.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
        </button>
        <button class="icon-btn danger" title="删除该别名" onclick="deleteAliasById('${esc(a.id)}','${esc(a.full)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

// 在生效列表中直接停用别名(保留历史,可恢复)
async function deactivateAlias(id) {
  try {
    await api('/api/account/aliases/' + id + '/deactivate', { method: 'POST' });
    toast('别名已停用，可在历史列表恢复', 'success');
    await loadAliases();
    if (MailState.selectedAliasId === id) resetMailView();
    await loadAliasHistory(MailState.history.page);
  } catch (err) { toast(err.message, 'error'); }
}

// 在生效列表中直接删除别名(不可恢复)
async function deleteAliasById(id, full) {
  confirmDialog(`确认删除别名 ${full}？删除后不可恢复`, async () => {
    try {
      await api('/api/account/aliases/' + id, { method: 'DELETE' });
      toast('别名已删除', 'success');
      await loadAliases();
      if (MailState.selectedAliasId === id) resetMailView();
      await loadAliasHistory(MailState.history.page);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// 清空当前选中的邮件视图,回到空状态
function resetMailView() {
  MailState.selectedAliasId = '';
  MailState.emails = [];
  MailState.offset = 0;
  MailState.hasMore = false;
  renderMailList();
  fetchMails();
}

function selectAlias(id) {
  MailState.selectedAliasId = id;
  renderActiveAliases();
  // 滚动到顶部
  const main = document.getElementById('mailMain');
  if (main) main.scrollTop = 0;
  // 重置邮件列表并加载
  MailState.emails = [];
  MailState.offset = 0;
  MailState.hasMore = false;
  renderMailList();
  fetchMails();
}

function starButton(id, on, fnName) {
  return `<button class="star-btn ${on ? 'on' : ''}" title="${on ? '取消收藏' : '收藏'}" onclick="${fnName}('${esc(id)}', ${on ? 'false' : 'true'})" aria-label="收藏">
    <svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
  </button>`;
}

async function renewAlias(id) {
  try {
    await api('/api/account/aliases/' + id + '/renew', { method: 'POST' });
    toast('已续期 1 小时', 'success');
    await loadAliases();
  } catch (err) { toast(err.message, 'error', 3600); }
}

async function deactivateAlias(id) {
  confirmDialog('停用后该别名不再收件，但可在历史列表中恢复。确认停用？', async () => {
    try {
      await api('/api/account/aliases/' + id + '/deactivate', { method: 'POST' });
      toast('已停用该别名', 'success');
      if (MailState.selectedAliasId === id) MailState.selectedAliasId = null;
      await loadAliases();
      await loadAliasHistory(MailState.history.page);
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function toggleAliasFavorite(id, favorite) {
  try {
    await api('/api/account/aliases/' + id + '/favorite', { method: 'POST', body: { favorite } });
    toast(favorite ? '已收藏' : '已取消收藏', 'success');
    await loadAliases();
    if (MailState.historyOpen) await loadAliasHistory(MailState.history.page);
  } catch (err) { toast(err.message, 'error'); }
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
  } catch (err) { box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`; }
}

function renderAliasHistory() {
  const box = document.getElementById('historyList');
  const pager = document.getElementById('historyPagination');
  if (!box) return;
  const list = MailState.history.list;
  if (!list.length) { box.innerHTML = '<div class="mail-empty">暂无历史别名</div>'; if (pager) pager.innerHTML = ''; return; }
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
  if (pager) pager.innerHTML = pagerHtml(MailState.history.page, MailState.history.totalPages, MailState.history.total, 'loadAliasHistory', '个');
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
    selectAlias(alias.id);
  } catch (err) { toast(err.message, 'error', 3600); }
}

async function deleteAliasItem(id) {
  confirmDialog('确认删除该别名？删除后无法恢复，且不再出现在历史列表中。', async () => {
    try {
      await api('/api/account/aliases/' + id, { method: 'DELETE' });
      toast('已删除', 'success');
      if (MailState.selectedAliasId === id) MailState.selectedAliasId = null;
      await loadAliases();
      await loadAliasHistory(MailState.history.page);
    } catch (err) { toast(err.message, 'error'); }
  });
}

function focusAlias(id) {
  // 从历史列表点击「查看收件」:若未生效先恢复
  const hist = (MailState.history.list || []).find(a => a.id === id);
  if (hist && hist.status !== 'active') {
    restoreAlias(id).catch(() => {});
    return;
  }
  selectAlias(id);
}

/* ============ 分页组件(仅历史别名保留) ============ */
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
}

/* ============ 搜索 / 仅未读 ============ */
function bindSearchBox() {
  const input = document.getElementById('qSearch');
  const clear = document.getElementById('qSearchClear');
  if (!input) return;
  input.oninput = () => {
    if (clear) clear.style.display = input.value ? 'block' : 'none';
    if (_mailSearchTimer) clearTimeout(_mailSearchTimer);
    _mailSearchTimer = setTimeout(() => {
      MailState.q = input.value.trim();
      MailState.offset = 0;
      MailState.emails = [];
      fetchMails();
    }, 450);
  };
}

function clearSearch() {
  const input = document.getElementById('qSearch');
  if (input) input.value = '';
  const clear = document.getElementById('qSearchClear');
  if (clear) clear.style.display = 'none';
  MailState.q = '';
  MailState.offset = 0;
  MailState.emails = [];
  fetchMails();
}

function onUnreadChange() {
  const cb = document.getElementById('qUnread');
  MailState.unseen = cb ? cb.checked : false;
  MailState.offset = 0;
  MailState.emails = [];
  fetchMails();
}

/* ============ 查询邮件(动态加载) ============ */
function buildFetchBody(silent = false, isLoadMore = false) {
  const alias = (MailState.aliases || []).find(a => a.id === MailState.selectedAliasId);
  const body = {
    q: MailState.q,
    offset: MailState.offset,
    limit: 10,
    unseen: MailState.unseen ? true : undefined,
    silent: silent ? true : undefined,
  };
  if (alias) {
    body.alias_id = alias.id;
    // 查询范围: 从别名创建(激活)时间起,一直到当前;续期不改变 created_at,因此旧邮件仍在范围内
    if (alias.created_at) body.start_time = alias.created_at;
  } else {
    body.all_aliases = true;
    // 无选中别名时回退到当天
    const d = new Date();
    body.start_time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00.000Z`;
  }
  return body;
}

async function fetchMails(silent = false) {
  if (!silent && !MailState.loadingMore) {
    const list = document.getElementById('mailList');
    if (list) list.innerHTML = '<div class="loading"><span class="spinner"></span> 正在加载邮件...</div>';
  }
  try {
    const data = await api('/api/web/email/fetch', { method: 'POST', body: buildFetchBody(silent) });
    const newEmails = data.emails || [];
    MailState.hasMore = data.has_more !== false; // 默认认为还有,直到服务端明确没有
    if (silent) {
      silentMergeMails(newEmails);
    } else {
      if (MailState.loadingMore) MailState.emails = MailState.emails.concat(newEmails);
      else MailState.emails = newEmails;
      MailState.offset = MailState.emails.length;
      renderMailList();
      // 内容未撑满容器且有更多数据时自动补载,避免空屏/无滚动条
      setTimeout(maybeLoadMore, 50);
    }
    // 同步服务端返回的剩余有效期
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
      const cnt = document.getElementById('mailCount');
      if (cnt) cnt.textContent = '0';
    }
  } finally {
    MailState.loadingMore = false;
    const loader = document.getElementById('mailLoader');
    if (loader) loader.classList.add('hidden');
  }
}

function silentMergeMails(newEmails) {
  if (!newEmails || !newEmails.length) return;
  const old = MailState.emails || [];
  const oldIds = new Set(old.map(m => m.id));
  const fresh = newEmails.filter(m => !oldIds.has(m.id));
  if (!fresh.length) return;
  // 如果当前是选中别名,且新邮件命中该别名,才合并;否则不干扰
  if (MailState.selectedAliasId) {
    const hit = fresh.filter(m => m.alias_id === MailState.selectedAliasId || m.alias === (MailState.aliases.find(a => a.id === MailState.selectedAliasId)?.full));
    if (!hit.length) return;
  }
  MailState.emails = [...fresh, ...old];
  renderMailList();
  toast(`自动收件: 新增 ${fresh.length} 封`, 'info', 2200);
}

/* ============ 无限滚动 ============ */
function bindInfiniteScroll() {
  const main = document.getElementById('mailMain');
  if (!main) return;
  main.addEventListener('scroll', () => {
    if (MailState.loadingMore || !MailState.hasMore) return;
    const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    if (nearBottom) loadMoreMails();
  });
}

function loadMoreMails() {
  if (MailState.loadingMore || !MailState.hasMore) return;
  MailState.loadingMore = true;
  const loader = document.getElementById('mailLoader');
  if (loader) loader.classList.remove('hidden');
  fetchMails(false);
}

function maybeLoadMore() {
  const main = document.getElementById('mailMain');
  if (!main || !MailState.hasMore || MailState.loadingMore) return;
  const underfilled = main.scrollHeight <= main.clientHeight + 80;
  if (underfilled) loadMoreMails();
}

function renderMailList() {
  const list = document.getElementById('mailList');
  const cnt = document.getElementById('mailCount');
  if (!list) return;
  const all = MailState.emails || [];
  if (cnt) cnt.textContent = String(all.length);
  if (!all.length) {
    list.className = '';
    list.innerHTML = '<div class="mail-empty">该别名暂无邮件</div>';
    return;
  }
  list.className = 'mail-list';
  list.innerHTML = all.map((m, i) => {
    const atts = (m.attachments || []).filter(Boolean);
    return `
    <div class="mail-item ${m.unread ? 'unread' : ''}" id="mail-${i}" onclick="viewMailDetail(${i})">
      <div class="mail-head" title="点击查看完整邮件">
        ${m.unread ? '<span class="unread-dot"></span>' : ''}
        <span class="from">${esc(m.from || '(未知发件人)')}</span>
        <span class="subject">${esc(m.subject || '(无主题)')}</span>
        ${atts.length ? `<span class="att-chip" title="${esc(atts.join('、'))}">📎 ${atts.length}</span>` : ''}
        <span class="date">${esc(m.date || '')}</span>
      </div>
    </div>`;
  }).join('');
}

/* ============ 自动收件 ============ */
function toggleAutoFetch() {
  const cb = document.getElementById('qAutoFetch');
  MailState.autoFetch = cb ? cb.checked : false;
  if (MailState.autoFetch) startAutoFetch();
  else stopAutoFetch();
}

function startAutoFetch() {
  stopAutoFetch();
  _mailAutoTimer = setInterval(() => fetchMails(true), 15000);
}

function stopAutoFetch() {
  if (_mailAutoTimer) { clearInterval(_mailAutoTimer); _mailAutoTimer = null; }
}

/* ============ 邮件详情弹窗 ============ */
function viewMailDetail(i) {
  const m = MailState.emails[i];
  if (!m) return;
  const atts = (m.attachments || []).filter(Boolean);
  const bodyContent = m.html
    ? `<iframe sandbox="allow-same-origin" srcdoc="${esc(m.html)}" style="width:100%;min-height:420px;border:1px solid var(--border);border-radius:8px"></iframe>`
    : `<div class="mail-detail-body">${esc(m.body || '(无正文)')}</div>`;
  const footer = `${m.html ? `<button class="btn btn-secondary" onclick="toggleMailView(${i})">切换纯文本</button>` : ''}<button class="btn btn-secondary" onclick="closeModal()">关闭</button>`;
  showModal(m.subject || '(无主题)', `<div class="mail-detail">
    <div class="mail-detail-meta">
      <div><strong>发件人:</strong> ${esc(m.from || '-')}</div>
      <div><strong>收件人:</strong> ${esc(m.to || '-')}</div>
      <div><strong>时间:</strong> ${esc(m.date || '-')}</div>
      <div><strong>附件:</strong> ${atts.length ? esc(atts.join('、')) : '无'}</div>
      <div><strong>状态:</strong> ${m.unread ? '<span class="badge badge-primary">未读</span>' : '<span class="badge badge-gray">已读</span>'}</div>
    </div><hr class="divider"><div id="mailDetailBody">${bodyContent}</div>
  </div>`, footer, true);
  if (m.unread) markMailRead(i, true);
}

async function markMailRead(i, autoMark = false) {
  const m = MailState.emails[i];
  if (!m) return;
  const alias = (MailState.aliases || []).find(a => a.id === MailState.selectedAliasId);
  const accountId = alias ? alias.mail_account_id : undefined;
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
  } catch (err) { if (!autoMark) toast(err.message, 'error'); }
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
