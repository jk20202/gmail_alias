/* ============================================================
 * docs.js — API 接入文档页
 * ============================================================ */

// 页面初始化: 用当前用户的 API Key 替换占位符
function initDocsPage() {
  const apiKey = (State.user && State.user.api_key) ? State.user.api_key : 'YOUR_API_KEY';
  if (apiKey !== 'YOUR_API_KEY') {
    // 替换代码块中的 YOUR_API_KEY
    document.querySelectorAll('#appMain pre.code-block code').forEach(el => {
      el.textContent = el.textContent.replace(/YOUR_API_KEY/g, apiKey);
    });
  }
}

// 复制代码到剪贴板
async function copyCode(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  } catch (e) {
    btn.textContent = '复制失败';
    setTimeout(() => btn.textContent = '复制', 2000);
  }
}

// 切换 curl / Python 代码块显隐
function switchCodeTab(btn, type) {
  const wrap = btn.closest('.code-tabs');
  wrap.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  wrap.querySelectorAll('.code-pane').forEach(p => p.style.display = 'none');
  wrap.querySelector('.code-pane.' + type).style.display = 'block';
}

// API 文档左侧导航切换:点击接口名,右侧显示对应面板
function switchDocPanel(name) {
  document.querySelectorAll('.doc-nav-item').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.doc-panel').forEach(p => p.classList.remove('active'));
  const navItem = Array.from(document.querySelectorAll('.doc-nav-item')).find(a => a.getAttribute('onclick').includes(name));
  if (navItem) navItem.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
}
