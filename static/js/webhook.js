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

// 编辑状态: 非空表示正在编辑某订阅(id),提交走 PATCH 而非 POST
let editingWebhookId = null;
// 最近一次渲染的订阅列表缓存(编辑回填用)
let webhookListCache = [];

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
  const countEl = document.getElementById('whCount');
  webhookListCache = list || [];
  if (countEl) countEl.textContent = String(webhookListCache.length);
  if (!box) return;
  if (!webhookListCache.length) {
    box.innerHTML = '<div class="mail-empty" style="padding:24px 16px">暂无订阅</div>';
    return;
  }
  box.innerHTML = webhookListCache.map(w => {
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
      : '<span class="chip" style="opacity:.6">（未配置 target）</span>';
    return `
      <div class="wh-card" data-webhook-id="${esc(w.id)}">
        <div class="wh-row-link">
          <span class="wh-link" title="${esc(w.url)}&#10;双击全选复制" ondblclick="selectWhLink(this)">${esc(w.url)}</span>
          <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试</button>
          <button class="btn btn-secondary btn-sm" onclick="toggleDeliveries(this, '${esc(w.id)}')">记录</button>
        </div>
        <div class="wh-row-mail">
          <span class="wh-mail-label">监听邮箱</span>
          <div class="webhook-targets">${targetChips}</div>
        </div>
        <div class="wh-actions">
          <label class="switch" title="启用/停用该订阅">
            <input type="checkbox" ${w.is_active ? 'checked' : ''} onchange="toggleWebhookActive('${esc(w.id)}', this.checked)">
            <span class="track"></span>
            <span class="wh-toggle-label">${w.is_active ? '启用' : '停用'}</span>
          </label>
          <select class="form-control btn-sm wh-fmt-select" title="推送格式" onchange="setWebhookFormat('${esc(w.id)}', this.value)">${fmtOptions}</select>
          <span class="spacer"></span>
          <button class="btn btn-outline btn-sm" onclick="editWebhook('${esc(w.id)}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
        </div>
        <div class="webhook-deliveries-wrap" data-loaded="0"></div>
      </div>`;
  }).join('');
}

// 提交(创建或保存)。编辑模式(editingWebhookId 非空)走 PATCH 更新,否则 POST 新建。
async function submitWebhook() {
  const tgt = getSelectedTargets();
  if (!tgt.length) { toast('请至少勾选一个监听邮箱', 'warning'); return; }
  // 每个邮箱的 scope 直接来自 data-scope, 不再 per-target 降级 (前端已禁止他人公开选 alias_all)
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  if (!events.length) { toast('请至少选择一个事件', 'warning'); return; }
  const url = document.getElementById('whUrl').value.trim();
  if (!url) { toast('请填写回调 URL', 'warning'); return; }
  const body = {
    targets: tgt.map(t => ({ mail_account_id: t.mail_account_id, scope: t.scope })),
    url,
    format: document.getElementById('whFormat').value,
    events: events.join(','),
  };
  // secret: 编辑回填时用 '***' 占位(后端不返回真实 secret),值仍是 '***' 说明未修改 → 不提交该字段(保留原值)
  const secretRaw = document.getElementById('whSecret').value.trim();
  if (secretRaw !== '***') body.secret = secretRaw; // 空串 → 后端转为 null(清空)
  try {
    if (editingWebhookId) {
      await api('/api/webhooks/' + editingWebhookId, { method: 'PATCH', body });
      toast('订阅已保存', 'success');
    } else {
      await api('/api/webhooks', { method: 'POST', body });
      toast('订阅创建成功', 'success');
    }
    resetWhForm();
    updateWhHint();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error', 4200); }
}

// 编辑: 把该订阅信息回填到左侧表单,按钮变「保存订阅」
function editWebhook(id) {
  const w = webhookListCache.find(x => x.id === id);
  if (!w) { toast('未找到该订阅', 'error'); return; }
  editingWebhookId = id;
  // 回填 URL / 格式 / 事件 / secret
  document.getElementById('whUrl').value = w.url || '';
  document.getElementById('whFormat').value = w.format || 'card';
  document.getElementById('whEvNew').checked = String(w.events || '').includes('new_mail');
  document.getElementById('whEvUnread').checked = String(w.events || '').includes('unread');
  document.getElementById('whSecret').value = w.secret ? '***' : '';
  // 回填监听邮箱: 勾选对应 checkbox + 设置每个邮箱的 scope
  const box = document.getElementById('whAccountList');
  if (box) {
    box.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    for (const t of (w.targets || [])) {
      const cb = box.querySelector(`input[type=checkbox][value="${cssEscape(t.mail_account_id)}"]`);
      if (!cb) continue;
      cb.checked = true;
      const scope = t.scope === 'account' ? 'account' : 'alias_all';
      cb.setAttribute('data-scope', scope);
      const sel = cb.parentElement.querySelector('.item-scope');
      if (sel && !sel.disabled) sel.value = scope;
    }
  }
  updateWhHint();
  // 切换按钮状态 + 高亮正在编辑的卡片
  const submitBtn = document.getElementById('whSubmitBtn');
  if (submitBtn) submitBtn.textContent = '保存订阅';
  const cancelBtn = document.getElementById('whCancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'inline-block';
  document.querySelectorAll('.wh-card').forEach(c => c.classList.remove('editing'));
  const card = document.querySelector(`.wh-card[data-webhook-id="${cssEscape(id)}"]`);
  if (card) card.classList.add('editing');
  // 滚动到表单顶部
  const formCard = submitBtn && submitBtn.closest('.card');
  if (formCard && formCard.scrollIntoView) formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('已回填订阅信息,修改后点「保存订阅」', 'info');
}

// 取消编辑: 清空表单,按钮恢复「创建订阅」
function cancelEditWebhook() {
  resetWhForm();
  const box = document.getElementById('whAccountList');
  if (box) box.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  document.getElementById('whEvNew').checked = true;
  document.getElementById('whEvUnread').checked = false;
  document.getElementById('whFormat').value = 'card';
  document.querySelectorAll('.wh-card').forEach(c => c.classList.remove('editing'));
  updateWhHint();
  toast('已取消编辑', 'info');
}

// 恢复表单到「创建订阅」默认态
function resetWhForm() {
  editingWebhookId = null;
  ['whUrl', 'whSecret'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const submitBtn = document.getElementById('whSubmitBtn');
  if (submitBtn) submitBtn.textContent = '创建订阅';
  const cancelBtn = document.getElementById('whCancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}

// 双击链接全选,方便完整复制超长 URL
function selectWhLink(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    const detail = data.response ? ` — ${String(data.response).slice(0, 220)}` : '';
    if (data.success) {
      toast(`测试推送成功${data.status ? ' (HTTP ' + data.status + ')' : ''}:${data.hint || ''}`, 'success', 4200);
    } else {
      toast(`推送失败${data.status ? ' (HTTP ' + data.status + ')' : ''}:${detail || (data.hint || '')}`, 'error', 6500);
      const card = document.querySelector(`.wh-card[data-webhook-id="${id}"]`);
      const wrap = card && card.querySelector('.webhook-deliveries-wrap');
      if (wrap) {
        try {
          const d = await api('/api/webhooks/' + id + '/deliveries?limit=5');
          renderDeliveries(wrap, d.deliveries || []);
          wrap.dataset.loaded = '1';
          const btn = card.querySelector('button[onclick^="toggleDeliveries"]');
          if (btn) btn.textContent = '收起';
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
  const card = btnEl.closest('.wh-card');
  if (!card) return;
  const wrap = card.querySelector('.webhook-deliveries-wrap');
  if (!wrap) return;
  if (wrap.dataset.loaded === '1') {
    wrap.innerHTML = '';
    wrap.dataset.loaded = '0';
    btnEl.textContent = '记录';
    return;
  }
  btnEl.textContent = '加载中…';
  try {
    const data = await api('/api/webhooks/' + id + '/deliveries?limit=10');
    const list = data.deliveries || [];
    renderDeliveries(wrap, list);
    wrap.dataset.loaded = '1';
    btnEl.textContent = '收起';
  } catch (err) {
    btnEl.textContent = '记录';
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
