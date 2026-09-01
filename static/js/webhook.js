/* ============================================================
 * webhook.js — Webhook 订阅页
 * ============================================================
 * v3 变更 (2026-09):
 *   - 彻底移除「指定别名（scope=alias）」功能
 *   - 剩余两种 scope: alias_all(全部存活别名) / account(主邮箱直收信)
 *   - 不再区分自己邮箱/他人公开邮箱 —— 任何邮箱都能用这两种 scope
 *   - 旧的 whAliasWrap / whAlias 已不再使用
 * ============================================================ */

const WH_FORMAT_LABEL = {
  card: '卡片消息',
  markdown: 'Markdown',
  text: '纯文本',
  json: '原始 JSON',
};

// 监听范围显示文案
const WH_SCOPE_LABEL = {
  alias_all: '全部存活别名（推送该邮箱下当前所有可用别名的邮件）',
  account: '整个邮箱（推送该主邮箱直接收信，不含别名）',
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
  // 默认选第一项并触发一次 onWhAccountChange,确保 scope 下拉默认选中 alias_all
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

// 选择主邮箱的变化:不再区分自己/他人,统一默认 scope=alias_all
function onWhAccountChange() {
  const sel = document.getElementById('whAccount');
  const scopeSel = document.getElementById('whScope');
  if (!sel || !scopeSel) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  // 默认锁定 alias_all(account 仍可手动选择,但 onWhScopeChange 不会再弹任何别名选择框)
  scopeSel.disabled = false;
  if (scopeSel.value !== 'alias_all' && scopeSel.value !== 'account') {
    scopeSel.value = 'alias_all';
  }
  // 兼容旧 DOM:如果页面残留 whAliasWrap,直接隐藏
  const legacyWrap = document.getElementById('whAliasWrap');
  if (legacyWrap) legacyWrap.style.display = 'none';
}

// scope 切换:当前只剩 alias_all / account 两种,都不再触发别名选择框
function onWhScopeChange() {
  const legacyWrap = document.getElementById('whAliasWrap');
  if (legacyWrap) legacyWrap.style.display = 'none';
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
    const scope = (w.scope || 'alias_all');
    const scopeLabel = WH_SCOPE_LABEL[scope] || scope;
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
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  // 监听范围: alias_all(全部存活别名) 或 account(主邮箱直收信)
  // 旧的 target_alias / whAliasWrap 参数已废弃,不再提交
  const scope = scopeSel ? scopeSel.value : 'alias_all';
  const body = {
    mail_account_id: sel.value,
    scope: scope,
    url: document.getElementById('whUrl').value.trim(),
    format: document.getElementById('whFormat').value,
    events: events.join(','),
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.mail_account_id) { toast('请选择监听的邮箱', 'warning'); return; }
  if (!['alias_all', 'account'].includes(body.scope)) {
    toast('监听范围无效', 'warning'); return;
  }
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
