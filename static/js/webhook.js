/* ============================================================
 * webhook.js — Webhook 订阅页 (2026-09 重构)
 * ============================================================
 * - 一订阅多邮箱 (targets[])
 * - 同一订阅内所有 target 共用同一 scope (alias_all / account)
 * - 权限分离: 他人公开邮箱强制 alias_all, 后端再做最终校验
 * - 删除"每用户仅一个 webhook"约束,支持多个订阅
 * - 加 webhook_deliveries 投递记录,排查"前端显示 success 但飞书没收到"
 * ============================================================ */

const WH_FORMAT_LABEL = {
  card: '卡片消息',
  markdown: 'Markdown',
  text: '纯文本',
  json: '原始 JSON',
};
const WH_SCOPE_LABEL = {
  alias_all: '全部存活别名',
  account: '整个邮箱',
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
  renderWhAccountCheckboxes(State.availableAccounts || []);
  onWhSelectionChange();
  const cached = getCachedWebhooks();
  if (cached) renderWebhooks(cached);
  loadWebhooks(true);
}

// 多选邮箱列表(自己 / 他人分组),绑定 change → onWhSelectionChange
function renderWhAccountCheckboxes(list) {
  const box = document.getElementById('whAccountList');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty">无可用邮箱</div>';
    return;
  }
  const own = list.filter(a => a.is_own);
  const other = list.filter(a => !a.is_own);
  const html = [];
  html.push(`<div class="group">
    <div class="group-label">我自己的 (${own.length})</div>`);
  if (!own.length) html.push('<div class="empty">你还没有绑定邮箱</div>');
  for (const a of own) {
    html.push(`<label class="item" title="${esc(a.email)}">
      <input type="checkbox" value="${esc(a.id)}" data-is-own="1" data-email="${esc(a.email)}">
      <span>${esc(a.email)} <small style="opacity:.6">(${esc(a.provider)})</small></span>
    </label>`);
  }
  html.push('</div>');
  html.push(`<div class="group">
    <div class="group-label">他人公开 (${other.length})</div>`);
  if (!other.length) html.push('<div class="empty">暂无可用的他人公开邮箱</div>');
  for (const a of other) {
    html.push(`<label class="item" title="${esc(a.email)}">
      <input type="checkbox" value="${esc(a.id)}" data-is-own="0" data-email="${esc(a.email)}" data-owner="${esc(a.owner)}">
      <span>[${esc(a.owner)}] ${esc(a.email)} <small style="opacity:.6">(${esc(a.provider)})</small></span>
    </label>`);
  }
  html.push('</div>');
  box.innerHTML = html.join('');
  // change 事件: 选择变化 → 触发 onWhSelectionChange
  box.onchange = onWhSelectionChange;
}

// 已勾选的目标列表
function getSelectedTargets() {
  const box = document.getElementById('whAccountList');
  if (!box) return [];
  return Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map(c => ({
    mail_account_id: c.value,
    is_own: c.getAttribute('data-is-own') === '1',
    email: c.getAttribute('data-email'),
  }));
}

// 选择变化时:动态启用/禁用「整个邮箱」scope,并给出可读提示
// 规则:
//   - 没有任何 own checkbox 被勾选时,直接把"整个邮箱"option 从 DOM 移掉,
//     避免出现"灰色文字但能点"的歧义;相应提示永远写在 hint 上。
//   - 至少一个 own 被勾选时,把它加回来并 enabled。
function onWhSelectionChange() {
  const tgts = getSelectedTargets();
  const hasOwnSel = tgts.some(t => t.is_own);
  const hasOtherSel = tgts.some(t => !t.is_own);
  const scopeSel = document.getElementById('whScope');
  const hint = document.getElementById('whScopeHint');
  if (!scopeSel || !hint) return;
  const rebuildScopeOptions = () => {
    // 先移除可能存在的 account option,再按需加入
    const old = document.getElementById('whScopeAccountOption');
    if (old) old.remove();
    if (!hasOwnSel) return; // 没有 own 不加
    const opt = document.createElement('option');
    opt.value = 'account';
    opt.id = 'whScopeAccountOption';
    opt.textContent = '整个邮箱（推送该主邮箱直接收信，不含别名）';
    scopeSel.appendChild(opt);
    if (scopeSel.value !== 'account') scopeSel.value = 'alias_all';
  };
  rebuildScopeOptions();
  if (!tgts.length) {
    hint.textContent = '请先在「监听主邮箱」至少勾选一个;若勾选了他人公开邮箱,则只支持「全部存活别名」。';
  } else if (!hasOwnSel) {
    hint.innerHTML = '<span style="color:#d97706">⚠ 所选全部为他人公开邮箱,只能监听「全部存活别名」,「整个邮箱」已被移除,你无法选择。</span>';
  } else if (hasOtherSel) {
    hint.innerHTML = '提示: 勾选了他人公开邮箱。「整个邮箱」只对你自己的邮箱生效,他人邮箱始终按「全部存活别名」收件。';
  } else {
    hint.textContent = '已勾选自己绑定的邮箱,可按需选择「整个邮箱」或「全部存活别名」。';
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
    const targets = w.targets || [];
    const fmtOptions = Object.keys(WH_FORMAT_LABEL)
      .map(k => `<option value="${k}" ${k === fmt ? 'selected' : ''}>${WH_FORMAT_LABEL[k]}</option>`).join('');
    const targetChips = targets.length
      ? targets.map(t => {
          const cls = t.is_own ? 'own' : 'other';
          const scopeText = WH_SCOPE_LABEL[t.scope] || t.scope;
          return `<span class="chip ${cls}" title="${esc(scopeText)}">${esc(t.mail_account_email || t.mail_account_id)} · ${esc(scopeText)}</span>`;
        }).join('')
      : '<span class="chip" style="opacity:.6">（未配置 target,旧数据兼容中）</span>';
    const hasOther = targets.some(t => !t.is_own);
    const accountCount = targets.filter(t => t.scope === 'account').length;
    return `
      <div class="mail-item" style="margin-bottom:10px" data-webhook-id="${esc(w.id)}">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="badge badge-primary">${WH_FORMAT_LABEL[fmt] || fmt}</span>
          <span class="mono" style="font-size:12px; flex:1; min-width:0; word-break:break-all">${esc(w.url)}</span>
          ${hasOther ? '<span class="badge badge-warning" title="此订阅包含他人公开邮箱">含他人</span>' : ''}
          ${accountCount > 0 ? `<span class="badge badge-info">${accountCount} 个整箱</span>` : ''}
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
  const scopeSel = document.getElementById('whScope');
  let scope = (scopeSel && scopeSel.value) || 'alias_all';
  const hasMixed = tgt.some(t => t.is_own) && tgt.some(t => !t.is_own);
  // per-target scope 降级,避免后端硬校验 403:
  //  - 全部他人邮箱 → 全部 alias_all
  //  - 混合勾选 + 全局 account → 他人邮箱降级为 alias_all,自己邮箱仍 account
  //  - 单一自己的邮箱 + account → 保持
  const finalizeScope = (t) => {
    if (scope !== 'account') return scope;
    if (t.is_own) return 'account';
    return 'alias_all';
  };
  if (tgt.every(t => !t.is_own)) scope = 'alias_all';
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  const body = {
    targets: tgt.map(t => ({ mail_account_id: t.mail_account_id, scope: finalizeScope(t) })),
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
    onWhSelectionChange();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error', 4200); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    // 后端已做平台级判定:飞书/钉钉「HTTP 200 但业务码非 0」也算失败,
    // 此时 response 里带的是平台真实错误(如 unsupported tag),直接展示便于定位。
    const detail = data.response ? ` — ${String(data.response).slice(0, 220)}` : '';
    if (data.success) {
      toast(`测试推送成功${data.status ? ' (HTTP ' + data.status + ')' : ''}:${data.hint || ''}`, 'success', 4200);
    } else {
      toast(`推送失败${data.status ? ' (HTTP ' + data.status + ')' : ''}:${detail || (data.hint || '')}`, 'error', 6500);
      // 失败时自动展开投递记录,便于看到完整原始响应
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
