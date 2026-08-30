/* ============================================================
 * webhook.js — Webhook 订阅页 (v2: 区分自己/他人公开邮箱)
 * ============================================================ */

const WH_FORMAT_LABEL = {
  card: '卡片消息',
  markdown: 'Markdown',
  text: '纯文本',
  json: '原始 JSON',
};

// ============ 本地缓存 ============
const WH_CACHE_KEY = 'mail_alias_webhooks_v1';
function getCachedWebhooks() {
  try { return JSON.parse(localStorage.getItem(WH_CACHE_KEY) || 'null'); } catch { return null; }
}
function setCachedWebhooks(list) {
  try { localStorage.setItem(WH_CACHE_KEY, JSON.stringify(list || [])); } catch {}
}

async function initWebhookPage() {
  if (!State.availableAccounts || !State.availableAccounts.length) {
    try { State.availableAccounts = await api('/api/account/mail_accounts/available'); }
    catch { State.availableAccounts = []; }
  }
  renderWhAccountOptions(State.availableAccounts || []);
  onWhAccountChange();
  const cached = getCachedWebhooks();
  if (cached) renderWebhooks(cached);
  loadWebhooks(true);
}

function renderWhAccountOptions(list) {
  const sel = document.getElementById('whAccount');
  if (!sel) return;
  if (!list || !list.length) {
    sel.innerHTML = '<option value="">无可用邮箱</option>';
    return;
  }
  // 分组渲染：自己绑定的 + 别人公开的
  const own = list.filter(a => a.is_own);
  const other = list.filter(a => !a.is_own);
  const parts = [];
  if (own.length) {
    parts.push(`<optgroup label="我自己的 (${own.length})">`);
    parts.push(own.map(a => `<option value="${esc(a.id)}">${esc(a.email)} <small style="opacity:.6">(${esc(a.provider)})</small></option>`).join(''));
    parts.push('</optgroup>');
  }
  if (other.length) {
    parts.push(`<optgroup label="他人公开 (${other.length})">`);
    parts.push(other.map(a => `<option value="${esc(a.id)}">[${esc(a.owner)}] ${esc(a.email)} <small style="opacity:.6">(${esc(a.provider)})</small></option>`).join(''));
    parts.push('</optgroup>');
  }
  sel.innerHTML = parts.join('');
  sel.onchange = onWhAccountChange;
}

function onWhAccountChange() {
  const sel = document.getElementById('whAccount');
  const scopeSel = document.getElementById('whScope');
  const aliasWrap = document.getElementById('whAliasWrap');
  const aliasSel = document.getElementById('whAlias');
  if (!sel || !scopeSel) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const acc = (State.availableAccounts || []).find(a => a.id === opt.value);
  const isOwn = acc ? acc.is_own : true;
  // 自己的邮箱: 三种 scope 可选
  // 别人的公开: 只能「指定别名」
  if (isOwn) {
    scopeSel.disabled = false;
    scopeSel.value = 'alias_all';
    onWhScopeChange();
  } else {
    scopeSel.value = 'alias';
    scopeSel.disabled = true;
    aliasWrap.style.display = 'block';
    // 预填当前用户自己的别名
    const myAlias = State.user && State.user.alias ? State.user.alias.full : '';
    aliasSel.innerHTML = myAlias
      ? `<option value="${esc(myAlias)}" selected>${esc(myAlias)} (你已绑定的别名)</option>`
      : '<option value="">你还没有创建别名,请先去「我的别名」页面创建</option>';
  }
}

function onWhScopeChange() {
  const sel = document.getElementById('whScope');
  const aliasWrap = document.getElementById('whAliasWrap');
  const aliasSel = document.getElementById('whAlias');
  if (!sel || !aliasWrap || !aliasSel) return;
  if (sel.value === 'alias') {
    aliasWrap.style.display = 'block';
    loadAliasesForSelect(aliasSel);
  } else {
    aliasWrap.style.display = 'none';
  }
}

async function loadAliasesForSelect(sel) {
  if (!sel) return;
  try {
    const aliases = await api('/api/account/aliases?active_only=true&all_aliases=false');
    sel.innerHTML = aliases.length
      ? aliases.map(a => `<option value="${esc(a.full)}">${esc(a.full)} <small style="opacity:.6">(${esc(a.email)})</small></option>`).join('')
      : '<option value="">暂无活跃别名</option>';
  } catch {
    sel.innerHTML = '<option value="">加载失败</option>';
  }
}

async function loadWebhooks(silent) {
  const box = document.getElementById('whList');
  if (!box) return;
  if (!silent) box.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  try {
    const list = await api('/api/webhooks');
    setCachedWebhooks(list);
    renderWebhooks(list);
  } catch (err) {
    if (!silent) box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

function renderWebhooks(list) {
  const box = document.getElementById('whList');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="mail-empty">暂无订阅</div>';
    return;
  }
  box.innerHTML = list.map(w => {
    const fmt = w.format || 'card';
    const fmtOptions = Object.keys(WH_FORMAT_LABEL)
      .map(k => `<option value="${k}" ${k === fmt ? 'selected' : ''}>${WH_FORMAT_LABEL[k]}</option>`).join('');
    const scopeLabel = w.target_alias
      ? `指定别名: ${esc(w.target_alias)}`
      : '监听整箱';
    const ownerInfo = w.mail_account_id ? ` (ID: ${esc(w.mail_account_id)})` : '';
    return `
      <div class="mail-item" style="margin-bottom:10px">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="badge badge-primary">${WH_FORMAT_LABEL[fmt] || fmt}</span>
          <span class="mono" style="font-size:12px; flex:1; min-width:0; word-break:break-all">${esc(w.url)}</span>
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>范围: ${esc(scopeLabel)}</span>
            <span>事件: ${esc(w.events)}</span>
            ${w.secret ? '<span class="badge badge-primary">已设签名</span>' : ''}
            <span>创建: ${fmtTime(w.created_at)}</span>
          </div>
          <div class="actions" style="margin-top:10px">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function createWebhook() {
  const sel = document.getElementById('whAccount');
  const scopeSel = document.getElementById('whScope');
  const aliasSel = document.getElementById('whAlias');
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  const body = {
    mail_account_id: sel.value,
    scope: scopeSel ? scopeSel.value : 'alias',
    url: document.getElementById('whUrl').value.trim(),
    format: document.getElementById('whFormat').value,
    events: events.join(','),
    target_alias: aliasSel ? aliasSel.value.trim() || undefined : undefined,
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.mail_account_id) { toast('请选择监听的邮箱', 'warning'); return; }
  if (!body.url) { toast('请填写回调 URL', 'warning'); return; }
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  try {
    await api('/api/webhooks', { method: 'POST', body });
    toast('订阅创建成功', 'success');
    ['whUrl', 'whSecret'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    onWhAccountChange();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error'); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    toast(data.success ? '测试推送已发送' : '测试推送失败,请检查回调地址', data.success ? 'success' : 'error');
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteWebhook(id) {
  confirmDialog('确认删除此 Webhook 订阅？', async () => {
    try {
      await api('/api/webhooks/' + id, { method: 'DELETE' });
      toast('已删除', 'success');
      loadWebhooks();
    } catch (err) { toast(err.message, 'error'); }
  });
}
