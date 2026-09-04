/* ============================================================
 * webhook.js — Webhook 订阅页 (2026-09 v3 重构)
 * ============================================================
 * - 一订阅多邮箱 (targets[]) + per-target scope (互不影响)
 * - 每个邮箱独立一行: 复选框 + 邮箱 + 该邮箱专属 select
 *   · 自己绑定的: 「别名邮箱」 / 「整个邮箱」 两者皆可选
 *   · 他人公开的: select 物理只显示「别名邮箱」(权限分离硬约束)
 * - 「一键监听」按钮: 「一键别名邮箱」 / 「一键整个邮箱」 两个预设
 * - 删除"每用户仅一个 webhook"约束,支持多个订阅
 * - 加 webhook_deliveries 投递记录,排查"前端显示 success 但飞书没收到"
 * ============================================================ */

const WH_FORMAT_LABEL = {
  card: '卡片消息',
  markdown: 'Markdown',
  text: '纯文本',
  json: '原始 JSON',
};
// 数据库 scope 值 → UI 文案
const WH_SCOPE_LABEL = {
  alias_all: '整个邮箱',
  account: '别名邮箱',
};
// 数据库 scope 值 → UI 详细说明 (用于 option 文本)
const WH_SCOPE_HINT = {
  alias_all: '整个邮箱 (推该邮箱下所有收信)',
  account: '别名邮箱 (仅自己生成的、还活着的别名)',
};

async function initWebhookPage() {
  if (!State.availableAccounts || !State.availableAccounts.length) {
    try { State.availableAccounts = await api('/api/account/mail_accounts/available'); }
    catch { State.availableAccounts = []; }
  }
  renderWhAccountCheckboxes(State.availableAccounts || []);
  updateWhHint();
  // 直接加载最新订阅列表。此前"先渲染 localStorage 缓存"会把旧缓存(可能只存了部分订阅)
  // 显示出来,且 loadWebhooks(true) 失败时被静默吞掉,导致"列表显示不全"(看到 1 个、实际 5 个)。
  await loadWebhooks(false);
}

// 多选邮箱列表(自己 / 他人分组)
// 每行: 复选框 + 邮箱地址 + owner + 该邮箱专属 select (只两个选项)
//   自己绑定的: 「整个邮箱」 / 「别名邮箱」 都可选
//   他人公开的: select 物理只一个 option 「别名邮箱」(disabled)
function renderWhAccountCheckboxes(list) {
  const box = document.getElementById('whAccountList');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty">无可用邮箱</div>';
    return;
  }
  const own = list.filter(a => a.is_own);
  const other = list.filter(a => !a.is_own);

  const renderRow = (a, groupLabel) => {
    const isOwn = !!a.is_own;
    // 自己绑定的两个 option;他人公开的物理只一个
    const scopeOptions = isOwn
      ? `<option value="alias_all">${WH_SCOPE_HINT.alias_all}</option>
         <option value="account">${WH_SCOPE_HINT.account}</option>`
      : `<option value="account">${WH_SCOPE_HINT.account}</option>`;
    // 默认值:自己绑定的默认「整个邮箱」(更常用),他人的默认「别名邮箱」(唯一可选)
    const defaultScope = isOwn ? 'alias_all' : 'account';
    const ownerTag = isOwn ? '' : ` <small style="opacity:.6">· [${esc(a.owner)}]</small>`;
    return `<label class="item" data-is-own="${isOwn ? '1' : '0'}" title="${esc(a.email)}">
      <input type="checkbox" value="${esc(a.id)}" data-is-own="${isOwn ? '1' : '0'}" data-email="${esc(a.email)}" data-scope="${defaultScope}">
      <span class="item-email">${esc(a.email)}${ownerTag} <small style="opacity:.6">(${esc(a.provider)})</small></span>
      <select class="item-scope" data-for="${esc(a.id)}" ${isOwn ? '' : 'disabled'} onchange="onItemScopeChange('${esc(a.id)}', this.value)">
        ${scopeOptions}
      </select>
    </label>`;
  };

  const html = [];
  html.push(`<div class="group">
    <div class="group-label">我自己的 <span class="count">(${own.length})</span></div>`);
  if (!own.length) html.push('<div class="empty">你还没有绑定邮箱</div>');
  for (const a of own) html.push(renderRow(a, 'own'));
  html.push('</div>');
  html.push(`<div class="group">
    <div class="group-label">他人公开 <span class="count">(${other.length})</span></div>`);
  if (!other.length) html.push('<div class="empty">暂无可用的他人公开邮箱</div>');
  for (const a of other) html.push(renderRow(a, 'other'));
  html.push('</div>');
  box.innerHTML = html.join('');

  // change 事件: 选择变化 → 同步 data-scope + 更新 hint
  box.onchange = (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'checkbox') {
      t.setAttribute('data-scope', t.checked ? (t.parentElement.querySelector('.item-scope')?.value || 'alias_all') : t.getAttribute('data-scope'));
      updateWhHint();
    }
  };
}

// 单个邮箱的 select 改变时, 同步对应 checkbox 的 data-scope
function onItemScopeChange(mailAccountId, scope) {
  const box = document.getElementById('whAccountList');
  if (!box) return;
  const cb = box.querySelector(`input[type=checkbox][value="${cssEscape(mailAccountId)}"]`);
  if (cb) cb.setAttribute('data-scope', scope);
  updateWhHint();
}

// cssEscape polyfill (避免 ID 含特殊字符时 querySelector 抛错)
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, c => '\\' + c);
}

// 已勾选的目标(含 per-target scope)
function getSelectedTargets() {
  const box = document.getElementById('whAccountList');
  if (!box) return [];
  return Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map(c => ({
    mail_account_id: c.value,
    is_own: c.getAttribute('data-is-own') === '1',
    email: c.getAttribute('data-email'),
    scope: c.getAttribute('data-scope') || (c.getAttribute('data-is-own') === '1' ? 'alias_all' : 'account'),
  }));
}

// 根据勾选情况, 更新底部 hint 文案
function updateWhHint() {
  const hint = document.getElementById('whAccountHint');
  if (!hint) return;
  const tgts = getSelectedTargets();
  if (!tgts.length) {
    hint.innerHTML = '勾选要监听的邮箱,每个邮箱右侧选择监听方式:「别名邮箱」= 仅自己生成的、还活着的别名收信;「整个邮箱」= 该邮箱下所有收信(主邮箱直收 + 所有别名)。他人公开邮箱只能选「别名邮箱」。';
    return;
  }
  const hasOwn = tgts.some(t => t.is_own);
  const hasOther = tgts.some(t => !t.is_own);
  const ownWhole = tgts.filter(t => t.is_own && t.scope === 'alias_all').length;
  const ownAlias = tgts.filter(t => t.is_own && t.scope === 'account').length;
  const otherCount = tgts.filter(t => !t.is_own).length;
  const parts = [];
  if (ownWhole) parts.push(`<b>${ownWhole}</b> 个自己邮箱: 整个邮箱`);
  if (ownAlias) parts.push(`<b>${ownAlias}</b> 个自己邮箱: 别名邮箱`);
  if (otherCount) parts.push(`<b>${otherCount}</b> 个他人公开邮箱: 别名邮箱(强制)`);
  hint.innerHTML = `已选 — ${parts.join(' · ')}`;
}

// ============ 一键监听弹窗 ============
// 提供两个预设:
//   「一键别名邮箱」: 所有可用邮箱(自己的 + 他人公开的)默认勾选,scope 全部 account (别名邮箱)
//   「一键整个邮箱」: 自己绑定的默认勾选 scope=alias_all(整个邮箱),他人公开默认勾选 scope=account
function openQuickListenModal() {
  if (!State.availableAccounts || !State.availableAccounts.length) {
    toast('邮箱列表为空', 'warning');
    return;
  }
  const own = State.availableAccounts.filter(a => a.is_own);
  const other = State.availableAccounts.filter(a => !a.is_own);
  const body = `
    <p class="form-hint" style="margin-bottom:14px">
      选择预设后,会自动勾选所有可用邮箱,并为每个邮箱设置对应的监听方式。<br>
      你可在勾选后再手动调整任一邮箱的选择,创建前完全可改。
    </p>
    <div class="quick-listen-grid">
      <div class="quick-card" data-preset="alias_all">
        <div class="qc-title">一键别名邮箱</div>
        <div class="qc-desc">所有邮箱(自己 + 他人)全部按「别名邮箱」监听 — 仅推自己生成的、还活着的别名收信。</div>
        <div class="qc-stat">自己 ${own.length} 个 · 他人 ${other.length} 个</div>
      </div>
      <div class="quick-card" data-preset="mixed">
        <div class="qc-title">一键整个邮箱</div>
        <div class="qc-desc">自己绑定的全部按「整个邮箱」监听,他人公开的按「别名邮箱」监听 — 自己的全部收信不漏,他人只收别名。</div>
        <div class="qc-stat">自己 ${own.length} 个 (整个邮箱) · 他人 ${other.length} 个 (别名邮箱)</div>
      </div>
    </div>
  `;
  showModal('一键监听', body, '');
  // 事件: 点击 quick-card 应用预设
  document.querySelectorAll('.quick-card').forEach(card => {
    card.onclick = () => {
      const preset = card.getAttribute('data-preset');
      applyQuickListenPreset(preset);
      closeModal();
      toast('已应用预设,请检查邮箱列表', 'success');
    };
  });
}

function applyQuickListenPreset(preset) {
  const box = document.getElementById('whAccountList');
  if (!box) return;
  const items = box.querySelectorAll('label.item');
  items.forEach(item => {
    const cb = item.querySelector('input[type=checkbox]');
    const sel = item.querySelector('.item-scope');
    if (!cb || !sel) return;
    const isOwn = cb.getAttribute('data-is-own') === '1';
    let scope;
    if (preset === 'alias_all') {
      // 一键别名邮箱: 全部 account
      scope = 'account';
    } else {
      // 一键整个邮箱 (mixed): 自己 = alias_all, 他人 = account
      scope = isOwn ? 'alias_all' : 'account';
    }
    cb.checked = true;
    sel.value = scope;
    cb.setAttribute('data-scope', scope);
  });
  updateWhHint();
}

// ============ 列表加载 / 渲染 ============
async function loadWebhooks(silent) {
  const box = document.getElementById('whList');
  if (!box) return;
  if (!silent) box.innerHTML = '<div class="loading"><span class="spinner"></span> 加载中...</div>';
  try {
    const list = await api('/api/webhooks');
    renderWebhooks(list);
  } catch (err) {
    // 失败时显示可见错误(不再静默吞掉),避免列表静默停在旧状态
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
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
    const targets = w.targets || [];
    const fmtOptions = Object.keys(WH_FORMAT_LABEL)
      .map(k => `<option value="${k}" ${k === fmt ? 'selected' : ''}>${WH_FORMAT_LABEL[k]}</option>`).join('');
    const targetChips = targets.length
      ? targets.map(t => {
          const cls = t.is_own ? 'own' : 'other';
          const scopeText = WH_SCOPE_LABEL[t.scope] || t.scope;
          return `<span class="chip ${cls}" title="${esc(scopeText)}">${esc(t.mail_account_email || t.mail_account_id)}<span class="chip-scope">· ${esc(scopeText)}</span></span>`;
        }).join('')
      : '<span class="chip" style="opacity:.6">（未配置 target,旧数据兼容中）</span>';
    const hasOther = targets.some(t => !t.is_own);
    const wholeCount = targets.filter(t => t.scope === 'alias_all').length;
    const aliasOnlyCount = targets.filter(t => t.scope === 'account').length;
    return `
      <div class="mail-item" style="margin-bottom:10px" data-webhook-id="${esc(w.id)}">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="badge badge-primary">${WH_FORMAT_LABEL[fmt] || fmt}</span>
          <span class="mono" style="font-size:12px; flex:1; min-width:0; word-break:break-all">${esc(w.url)}</span>
          ${hasOther ? '<span class="badge badge-warning" title="此订阅包含他人公开邮箱">含他人</span>' : ''}
          ${wholeCount > 0 ? `<span class="badge badge-info">${wholeCount} 个整个邮箱</span>` : ''}
          ${aliasOnlyCount > 0 ? `<span class="badge" style="background:var(--bg-2, #f1f5f9);color:var(--text-light)">${aliasOnlyCount} 个别名邮箱</span>` : ''}
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>事件: ${esc(w.events)}</span>
            <span>创建: ${fmtTime(w.created_at)}</span>
            <span>ID: <span class="mono">${esc(w.id)}</span></span>
          </div>
          <div style="margin-top:6px">
            <div style="font-size:12px; color:var(--text-muted, #888); margin-bottom:4px">监听邮箱 (${targets.length}):</div>
            <div class="webhook-targets">${targetChips}</div>
          </div>
          <div class="actions" style="margin-top:10px; flex-wrap:wrap; gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-secondary btn-sm" onclick="toggleWebhookActive('${esc(w.id)}', ${!w.is_active})">${w.is_active ? '停用' : '启用'}</button>
            <select class="form-control btn-sm" style="display:inline-block; width:auto; min-width:90px; padding:4px 6px" onchange="setWebhookFormat('${esc(w.id)}', this.value)">
              ${fmtOptions}
            </select>
            <button class="btn btn-secondary btn-sm" onclick="toggleDeliveries(this, '${esc(w.id)}')">查看投递记录</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
          <div class="webhook-deliveries-wrap" data-loaded="0"></div>
        </div>
      </div>`;
  }).join('');
}

async function createWebhook() {
  const tgt = getSelectedTargets();
  if (!tgt.length) { toast('请至少勾选一个监听邮箱', 'warning'); return; }
  // 每个邮箱的 scope 直接来自 data-scope, 不再 per-target 降级 (前端已禁止他人公开选 alias_all)
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  const body = {
    targets: tgt.map(t => ({ mail_account_id: t.mail_account_id, scope: t.scope })),
    url: document.getElementById('whUrl').value.trim(),
    format: document.getElementById('whFormat').value,
    events: events.join(','),
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.url) { toast('请填写回调 URL', 'warning'); return; }
  try {
    await api('/api/webhooks', { method: 'POST', body });
    toast('订阅创建成功', 'success');
    ['whUrl', 'whSecret'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    // 保留勾选,只清 URL/Secret
    updateWhHint();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error', 4200); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    const detail = data.response ? ` — ${String(data.response).slice(0, 220)}` : '';
    if (data.success) {
      toast(`测试推送成功${data.status ? ' (HTTP ' + data.status + ')' : ''}:${data.hint || ''}`, 'success', 4200);
    } else {
      toast(`推送失败${data.status ? ' (HTTP ' + data.status + ')' : ''}:${detail || (data.hint || '')}`, 'error', 6500);
      const card = document.querySelector(`.mail-item[data-webhook-id="${id}"]`);
      const wrap = card && card.querySelector('.webhook-deliveries-wrap');
      if (wrap) {
        try {
          const d = await api('/api/webhooks/' + id + '/deliveries?limit=5');
          renderDeliveries(wrap, d.deliveries || []);
          wrap.dataset.loaded = '1';
          const btn = card.querySelector('button[onclick^="toggleDeliveries"]');
          if (btn) btn.textContent = '收起投递记录';
        } catch { /* 忽略 */ }
      }
    }
  } catch (err) { toast(err.message, 'error', 3600); }
}

async function toggleWebhookActive(id, target) {
  try {
    await api('/api/webhooks/' + id, { method: 'PATCH', body: { is_active: target } });
    toast('已更新', 'success');
    loadWebhooks();
  } catch (err) { toast(err.message, 'error'); }
}

async function setWebhookFormat(id, format) {
  try {
    await api('/api/webhooks/' + id, { method: 'PATCH', body: { format } });
    toast('已更新', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleDeliveries(btnEl, id) {
  const card = btnEl.closest('.mail-item');
  if (!card) return;
  const wrap = card.querySelector('.webhook-deliveries-wrap');
  if (!wrap) return;
  if (wrap.dataset.loaded === '1') {
    wrap.innerHTML = '';
    wrap.dataset.loaded = '0';
    btnEl.textContent = '查看投递记录';
    return;
  }
  btnEl.textContent = '加载中…';
  try {
    const data = await api('/api/webhooks/' + id + '/deliveries?limit=10');
    const list = data.deliveries || [];
    renderDeliveries(wrap, list);
    wrap.dataset.loaded = '1';
    btnEl.textContent = '收起投递记录';
  } catch (err) {
    btnEl.textContent = '查看投递记录';
    toast(err.message, 'error');
  }
}

function renderDeliveries(wrap, list) {
  if (!list.length) {
    wrap.innerHTML = '<div class="webhook-deliveries" style="padding:8px 10px; color:var(--text-muted, #888)">无投递记录</div>';
    return;
  }
  const rows = list.map(r => {
    const statusText = r.status ? (r.status >= 200 && r.status < 300 ? '✓ ' + r.status : (r.status >= 400 ? '✗ ' + r.status : '⚠ ' + r.status)) : '⚠ 无响应';
    const css = r.success ? 'color:#10b981' : 'color:#ef4444';
    const resp = (r.response || '(空响应)').replace(/</g, '&lt;');
    return `<div class="row">
      <span style="min-width:130px;color:#888;font-size:11px;font-family:monospace">${esc(fmtTime(r.created_at))}</span>
      <span style="${css};font-weight:600;font-family:monospace">${esc(statusText)}</span>
      <span style="flex:1;font-family:monospace;font-size:11px;opacity:.8;word-break:break-all">${resp.slice(0, 240)}</span>
    </div>`;
  }).join('');
  wrap.innerHTML = `<details class="webhook-deliveries" open>
    <summary>投递记录 (最近 ${list.length} 条)</summary>
    ${rows}
    <div style="font-size:11px;color:#888;margin-top:6px">HTTP 200 ≠ 飞书发出消息。飞书通常返回 {"StatusCode":0,"StatusMessage":"success"} 表示真正发出;非 0 表示失败被拒。点击「测试推送」后看这里即可定位。</div>
  </details>`;
}

async function deleteWebhook(id) {
  confirmDialog('确认删除此 Webhook 订阅?该订阅关联的所有监听邮箱与投递记录将一并删除。', async () => {
    try {
      await api('/api/webhooks/' + id, { method: 'DELETE' });
      toast('已删除', 'success');
      loadWebhooks();
    } catch (err) { toast(err.message, 'error'); }
  });
}
