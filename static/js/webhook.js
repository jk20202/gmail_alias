/* ============================================================
 * webhook.js — Webhook 订阅页
 * ============================================================ */

async function initWebhookPage() {
  try {
    const list = await api('/api/account/mail_accounts/available');
    const sel = document.getElementById('whAccount');
    if (!list || !list.length) {
      sel.innerHTML = '<option value="">无可用邮箱</option>';
    } else {
      sel.innerHTML = list.map(a => {
        const own = a.is_own;
        const tag = own ? '可监听整箱' : '仅限我的别名';
        return `<option value="${esc(a.id)}" data-own="${own ? 1 : 0}">${esc(a.email)} (${esc(a.provider)} · ${tag})</option>`;
      }).join('');
    }
    onWhAccountChange();
    sel.onchange = onWhAccountChange;
  } catch (err) { toast(err.message, 'error'); }
  loadWebhooks();
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

async function loadWebhooks() {
  const box = document.getElementById('whList');
  if (!box) return;
  try {
    const list = await api('/api/webhooks');
    if (!list.length) {
      box.innerHTML = '<div class="mail-empty">暂无订阅</div>';
      return;
    }
    box.innerHTML = list.map(w => `
      <div class="mail-item" style="margin-bottom:10px">
        <div class="mail-head" style="cursor:default; flex-wrap:wrap">
          <span class="badge ${w.is_active ? 'badge-success' : 'badge-gray'}">${w.is_active ? '启用' : '停用'}</span>
          <span class="mono" style="font-size:12px">${esc(w.url)}</span>
        </div>
        <div class="mail-body" style="display:block; border-top:1px solid var(--border)">
          <div class="meta-row">
            <span>邮箱ID: ${esc(w.mail_account_id)}</span>
            <span>事件: ${esc(w.events)}</span>
            ${w.target_alias ? `<span>别名: ${esc(w.target_alias)}</span>` : ''}
            ${w.secret ? '<span class="badge badge-primary">已设签名</span>' : ''}
            <span>创建: ${fmtTime(w.created_at)}</span>
          </div>
          <div class="actions">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook('${esc(w.id)}')">测试推送</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.id)}')">删除</button>
          </div>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="mail-empty">${esc(err.message)}</div>`;
  }
}

async function createWebhook() {
  const events = [];
  if (document.getElementById('whEvNew').checked) events.push('new_mail');
  if (document.getElementById('whEvUnread').checked) events.push('unread');
  const body = {
    mail_account_id: document.getElementById('whAccount').value,
    url: document.getElementById('whUrl').value.trim(),
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
    ['whUrl', 'whSecret'].forEach(id => document.getElementById(id).value = '');
    onWhAccountChange();
    loadWebhooks();
  } catch (err) { toast(err.message, 'error'); }
}

async function testWebhook(id) {
  try {
    const data = await api('/api/webhooks/' + id + '/test', { method: 'POST' });
    toast(data.success ? '测试推送已发送' : '测试推送失败', data.success ? 'success' : 'error');
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
