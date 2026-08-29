/* ============================================================
 * webhook.js — Webhook 订阅页
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

async function initWebhookPage() {
  // 可用邮箱:优先复用已加载的缓存(邮件查询/账户页已拉取过),避免每次都查库
  if (!State.availableAccounts || !State.availableAccounts.length) {
    try { State.availableAccounts = await api('/api/account/mail_accounts/available'); }
    catch { State.availableAccounts = []; }
  }
  renderWhAccountOptions(State.availableAccounts || []);
  onWhAccountChange();
  // 先用本地缓存瞬时渲染(无转圈),随后后台静默刷新线上数据
  const cached = getCachedWebhooks();
  if (cached) renderWebhooks(cached);
  loadWebhooks(true);
}

function renderWhAccountOptions(list) {
  const sel = document.getElementById('whAccount');
  if (!sel) return;
  if (!list || !list.length) {
    sel.innerHTML = '<option value="">无可用邮箱</option>';
  } else {
    sel.innerHTML = list.map(a => {
      const own = a.is_own;
      const tag = own ? '可监听整箱' : '仅限我的别名';
      return `<option value="${esc(a.id)}" data-own="${own ? 1 : 0}">${esc(a.email)} (${esc(a.provider)} · ${tag})</option>`;
    }).join('');
  }
  sel.onchange = onWhAccountChange;
}

function onWhAccountChange() {
  const sel = document.getElementById('whAccount');
  const aliasInput = document.getElementById('whAlias');
  if (!sel || !aliasInput) return;
  const opt = sel.options[sel.selectedIndex];
  const isOwn = opt && opt.dataset.own === '1';
  const aliasFull = State.user && State.user.alias ? State.user.alias.full : '';
  if (isOwn) {
    aliasInput.disabled = false;
    aliasInput.placeholder = '仅推送命中此别名的邮件,留空表示全部';
  } else {
    aliasInput.value = aliasFull;
    aliasInput.disabled = true;
    aliasInput.placeholder = '已锁定为你的别名';
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
    // 静默刷新失败:保留本地缓存内容,不破坏当前页面
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
    return `
      <div class="mail-item" style="margin-bottom:10px">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="badge badge-primary">${WH_FORMAT_LABEL[fmt] || fmt}</span>
          <span class="mono" style="font-size:12px; flex:1; min-width:0; word-break:break-all">${esc(w.url)}</span>
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>邮箱ID: ${esc(w.mail_account_id)}</span>
            <span>事件: ${esc(w.events)}</span>
            ${w.target_alias ? `<span>别名: ${esc(w.target_alias)}</span>` : ''}
            ${w.secret ? '<span class="badge badge-primary">已设签名</span>' : ''}
            <span>创建: ${fmtTime(w.created_at)}</span>
          </div>
          <div class="row-gap" style="margin-top:12px">
            <label class="form-hint" style="margin:0">推送格式</label>
            <select class="form-control" style="width:auto; padding:4px 8px; height:30px" onchange="changeWebhookFormat('${esc(w.id)}', this.value)">
              ${fmtOptions}
            </select>
          </div>
          <div class="actions">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function changeWebhookFormat(id, format) {
  try {
    await api('/api/webhooks/' + id + '/format', { method: 'POST', body: { format } });
    toast('推送格式已切换为「' + (WH_FORMAT_LABEL[format] || format) + '」', 'success');
    loadWebhooks();
  } catch (err) { toast(err.message, 'error'); loadWebhooks(); }
}

async function createWebhook() {
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  const body = {
    mail_account_id: document.getElementById('whAccount').value,
    url: document.getElementById('whUrl').value.trim(),
    format: document.getElementById('whFormat').value,
    events: events.join(','),
    target_alias: document.getElementById('whAlias').value.trim() || undefined,
    secret: document.getElementById('whSecret').value.trim() || undefined,
  };
  if (!body.mail_account_id) { toast('请选择监听邮箱', 'warning'); return; }
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
