/* ============================================================
 * webhook.js — Webhook 订阅页
 * 重构：支持按「主邮箱 → 存活别名/整箱」粒度选择监听范围
 * ============================================================ */

const WH_FORMAT_LABEL = {
  card: '卡片消息',
  markdown: 'Markdown',
  text: '纯文本',
  json: '原始 JSON',
};

// ============ 本地缓存: 减少重复查库,页面切换瞬时渲染 ============
const WH_CACHE_KEY = 'mail_alias_webhooks_v1';
function getCachedWebhooks() {
  try { return JSON.parse(localStorage.getItem(WH_CACHE_KEY) || 'null'); } catch { return null; }
}
function setCachedWebhooks(list) {
  try { localStorage.setItem(WH_CACHE_KEY, JSON.stringify(list || [])); } catch {}
}

// 已绑定邮箱列表（只包含自己绑定的），key=id, value=account
let myAccounts = {};
// 存活别名列表，key=mail_account_id, value=[{id, full}]
let aliasMap = {};

async function initWebhookPage() {
  // 加载自己的邮箱
  try {
    const accounts = await api('/api/account/mail_accounts');
    myAccounts = {};
    (accounts || []).forEach(a => { myAccounts[a.id] = a; });
  } catch { myAccounts = {}; }
  // 加载存活别名
  try {
    const aliases = await api('/api/account/aliases?all_aliases=true');
    aliasMap = {};
    (aliases || []).forEach(al => {
      if (!aliasMap[al.mail_account_id]) aliasMap[al.mail_account_id] = [];
      aliasMap[al.mail_account_id].push({ id: al.id, full: al.full });
    });
  } catch { aliasMap = {}; }

  renderWhAccountOptions(Object.values(myAccounts));
  onWhAccountChange();
  onWhScopeChange();
  // 先用本地缓存瞬时渲染(无转圈),随后后台静默刷新线上数据
  const cached = getCachedWebhooks();
  if (cached) renderWebhooks(cached);
  loadWebhooks(true);
}

function renderWhAccountOptions(list) {
  const sel = document.getElementById('whAccount');
  if (!sel) return;
  if (!list || !list.length) {
    sel.innerHTML = '<option value="">尚未绑定任何邮箱</option>';
  } else {
    sel.innerHTML = list.map(a =>
      `<option value="${esc(a.id)}">${esc(a.email)}${a.notes ? ' · ' + esc(a.notes) : ''}</option>`
    ).join('');
  }
  sel.onchange = onWhAccountChange;
}

function onWhAccountChange() {
  const sel = document.getElementById('whAccount');
  const scopeSel = document.getElementById('whScope');
  const aliasSel = document.getElementById('whAlias');
  const aliasWrap = document.getElementById('whAliasWrap');
  if (!sel || !scopeSel) return;
  const accountId = sel.value;
  // 别名下拉
  if (aliasSel && aliasWrap) {
    if (!accountId) {
      aliasSel.innerHTML = '<option value="">请先选择主邮箱</option>';
      aliasWrap.style.display = 'none';
    } else {
      const aliases = aliasMap[accountId] || [];
      aliasSel.innerHTML = aliases.length
        ? aliases.map(a => `<option value="${esc(a.id)}">${esc(a.full)}</option>`).join('')
        : '<option value="">无存活别名</option>';
      onWhScopeChange();
    }
  }
}

function onWhScopeChange() {
  const scopeSel = document.getElementById('whScope');
  const aliasWrap = document.getElementById('whAliasWrap');
  if (!scopeSel || !aliasWrap) return;
  aliasWrap.style.display = scopeSel.value === 'alias' ? '' : 'none';
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
    // 解析 scope 展示
    const scopeLabel = w.scope === 'alias_all' ? '全部别名'
      : w.scope === 'account' ? '整箱' : '指定别名';
    const accountInfo = myAccounts[w.mail_account_id]
      ? esc(myAccounts[w.mail_account_id].email)
      : esc(w.mail_account_id);
    const aliasInfo = w.target_alias
      ? `<span>别名: ${esc(w.target_alias)}</span>`
      : w.scope !== 'account'
        ? '<span class="form-hint">全部别名</span>'
        : '';
    return `
      <div class="mail-item" style="margin-bottom:10px">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="badge badge-primary">${WH_FORMAT_LABEL[fmt] || fmt}</span>
          <span class="mono" style="font-size:12px; flex:1; min-width:0; word-break:break-all">${esc(w.url)}</span>
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>邮箱: ${accountInfo}</span>
            <span>范围: ${esc(scopeLabel)}</span>
            ${aliasInfo}
            <span>事件: ${esc(w.events)}</span>
            ${w.secret ? '<span class="badge badge-primary">已设签名</span>' : ''}
            <span>创建: ${fmtTime(w.created_at)}</span>
          </div>
          <div class="actions" style="margin-top:12px">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function createWebhook() {
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  const body = {
    mail_account_id: document.getElementById('whAccount').value,
    scope: document.getElementById('whScope')?.value || 'alias',
    url: document.getElementById('whUrl').value.trim(),
    format: document.getElementById('whFormat').value,
    events: events.join(','),
    target_alias: document.getElementById('whScope')?.value === 'alias'
      ? document.getElementById('whAlias')?.value || undefined
      : undefined,
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.mail_account_id) { toast('请选择监听主邮箱', 'warning'); return; }
  if (!body.url) { toast('请填写回调 URL', 'warning'); return; }
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  try {
    await api('/api/webhooks', { method: 'POST', body });
    toast('订阅创建成功', 'success');
    ['whUrl', 'whSecret'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    onWhAccountChange();
    onWhScopeChange();
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
