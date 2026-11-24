(function () {
  'use strict';

  window.mainContent = document.getElementById('main-content');
  const statusLabels = {
    pending: 'معلق',
    processing: 'قيد المعالجة',
    delivering: 'قيد التوصيل',
    completed: 'مكتمل',
    cancelled: 'ملغي'
  };
  const routes = {
    admin: {
      dashboard: () => AdminApp.showDashboard(),
      orders: () => AdminApp.showOrders(),
      add: () => AdminApp.showAddOrder(),
      marketers: () => ManageApp.showMarketers(),
      products: () => ManageApp.showProducts(),
      reports: () => ChartsApp.showReports()
    },
    marketer: {
      dashboard: () => MarketerApp.showDashboard(),
      orders: () => MarketerApp.showOrders(),
      add: () => MarketerApp.showAddOrder(),
      products: () => ManageApp.showProducts()
    }
  };

  window.escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));
  window.escapeAttr = value => escapeHTML(value).replace(/\n/g, ' ');
  window.formatCurrency = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  window.formatDate = value => {
    try { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch (error) { return '—'; }
  };
  window.statusBadge = status => `<span class="badge ${status}">${statusLabels[status] || status}</span>`;
  window.detail = (name, value) => `<div class="detail-row"><span>${escapeHTML(name)}</span><b>${typeof value === 'string' && value.includes('badge') ? value : escapeHTML(value)}</b></div>`;
  window.orderProductLabel = order => {
    const items = Array.isArray(order?.items) ? order.items : [];
    if (!items.length) return String(order?.productName || '—');
    return items.map(item => `${item.productName || 'منتج'} × ${item.quantity || 1}`).join('، ');
  };
  window.orderItemsMarkup = order => {
    const items = Array.isArray(order?.items) ? order.items : [];
    if (!items.length) return `<div>${escapeHTML(orderProductLabel(order))}</div>`;
    return `<ul class="order-items-list">${items.map(item => `<li><span>${escapeHTML(item.productName || 'منتج')}</span><b>× ${Number(item.quantity || 1)}</b></li>`).join('')}</ul>`;
  };
  window.OrderItemsUI = {
    render(products, item = {}) {
      const selected = String(item.productId || '');
      const options = products.map(product => `<option value="${product.id}" data-price="${product.salePrice}" ${selected === String(product.id) ? 'selected' : ''}>${escapeHTML(product.name)}</option>`).join('');
      return `<div class="order-item-row" data-order-item>
        <div class="form-group"><label>الصنف *</label><select data-item-product required><option value="">اختر الصنف</option>${options}</select></div>
        <div class="form-group"><label>الكمية *</label><input data-item-quantity type="number" min="1" value="${Number(item.quantity || 1)}" required></div>
        <div class="form-group"><label>سعر الوحدة (ج.م) *</label><input data-item-price type="number" min="0" step="0.01" value="${item.salePrice ?? ''}" required></div>
        <button type="button" class="action-btn danger order-item-remove" aria-label="حذف الصنف">🗑️</button>
      </div>`;
    },
    bind(products, options = {}) {
      const list = document.getElementById(options.listId || 'order-items-list');
      const addButton = document.getElementById(options.addButtonId || 'add-order-item');
      const error = document.getElementById(options.errorId || 'order-items-error');
      if (!list || !addButton) return;
      const addRow = item => {
        list.insertAdjacentHTML('beforeend', this.render(products, item));
        const row = list.lastElementChild;
        const select = row.querySelector('[data-item-product]');
        const price = row.querySelector('[data-item-price]');
        select.onchange = () => { price.value = select.selectedOptions[0]?.dataset.price || ''; };
        row.querySelector('.order-item-remove').onclick = () => {
          if (list.children.length === 1) return showToast('يجب إضافة صنف واحد على الأقل','warning');
          row.remove();
        };
      };
      addButton.onclick = () => addRow({});
      if (options.initialItems?.length) options.initialItems.forEach(item => addRow(item));
      else if (!list.children.length) addRow({});
      this.collect = () => {
        const items = [...list.querySelectorAll('[data-order-item]')].map(row => ({
          productId: row.querySelector('[data-item-product]').value,
          quantity: Math.max(1, Number(row.querySelector('[data-item-quantity]').value) || 1),
          salePrice: row.querySelector('[data-item-price]').value
        }));
        const invalid = items.some(item => !item.productId || item.salePrice === '');
        const duplicate = new Set(items.map(item => item.productId).filter(Boolean)).size !== items.filter(item => item.productId).length;
        if (error) error.textContent = invalid ? 'اختر الصنف وأدخل سعره لكل سطر.' : duplicate ? 'لا تضف نفس الصنف مرتين؛ عدّل الكمية في السطر الموجود.' : '';
        return invalid || duplicate ? null : items;
      };
    }
  };
  window.printOrderInvoice = order => {
    if (!order) return;
    const sourceItems = Array.isArray(order.items) && order.items.length
      ? order.items
      : [{ productName: order.productName, quantity: order.quantity, salePrice: order.salePrice }];
    const items = sourceItems.map(item => ({
      productName: String(item.productName || 'منتج'),
      quantity: Math.max(1, Number(item.quantity) || 1),
      salePrice: Number(item.salePrice) || 0
    }));
    const money = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const grandTotal = items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0);
    const popup = window.open('', '_blank', 'width=820,height=920');
    if (!popup) return showToast('اسمح بالنوافذ المنبثقة لطباعة الفاتورة', 'warning');
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فاتورة ${escapeHTML(order.id)}</title><style>
      *{box-sizing:border-box}body{margin:0;padding:32px;font-family:Tahoma,Arial,sans-serif;color:#172b4d;background:#fff}main{max-width:760px;margin:auto}.invoice-head{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #1e3a5f;padding-bottom:18px}.brand{font-size:22px;font-weight:700;color:#1e3a5f}.invoice-title{font-size:25px;font-weight:700}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:22px 0;padding:15px;background:#f5f8fb;border-radius:10px}.meta div{display:flex;justify-content:space-between;gap:10px}.meta span{color:#6b7280}.meta b{font-weight:700}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:12px 10px;border-bottom:1px solid #d9e2ec;text-align:right}th{background:#1e3a5f;color:#fff}td.num,th.num{text-align:center}td.money,th.money{text-align:left;direction:ltr}.total{display:flex;justify-content:space-between;margin-top:20px;padding:16px;background:#fff5df;border:1px solid #f5a623;border-radius:10px;font-size:18px;font-weight:700}.invoice-actions{display:flex;justify-content:center;gap:10px;margin-top:24px}.invoice-actions button{border:0;border-radius:8px;padding:11px 20px;font:inherit;font-weight:700;cursor:pointer}.print-btn{background:#1e3a5f;color:#fff}.close-btn{background:#e2e8f0;color:#172b4d}.footer{text-align:center;margin-top:34px;color:#6b7280;font-size:12px}@media print{body{padding:0}main{max-width:none}.no-print{display:none!important}}
    </style></head><body><main><section class="invoice-head"><div><div class="brand">نظام إدارة الأوردرات</div><div>فاتورة بيع</div></div><div class="invoice-title">فاتورة</div></section><section class="meta"><div><span>رقم الأوردر</span><b>${escapeHTML(order.id)}</b></div><div><span>التاريخ</span><b>${escapeHTML(formatDate(order.createdAt))}</b></div><div><span>اسم العميل</span><b>${escapeHTML(order.clientName)}</b></div>${order.clientAddress ? `<div style="grid-column:1/-1"><span>العنوان</span><b>${escapeHTML(order.clientAddress)}</b></div>` : ''}</section><table><thead><tr><th>#</th><th>المنتج</th><th class="num">الكمية</th><th class="money">سعر البيع</th><th class="money">الإجمالي</th></tr></thead><tbody>${items.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${escapeHTML(item.productName)}</td><td class="num">${item.quantity}</td><td class="money">${money(item.salePrice)} ج.م</td><td class="money">${money(item.salePrice * item.quantity)} ج.م</td></tr>`).join('')}</tbody></table><div class="total"><span>الإجمالي المطلوب</span><span dir="ltr">${money(grandTotal)} ج.م</span></div><div class="invoice-actions no-print"><button class="print-btn" onclick="window.print()">🖨️ طباعة الفاتورة</button><button class="close-btn" onclick="window.close()">إغلاق</button></div><div class="footer">شكرًا لتعاملكم معنا</div></main></body></html>`);
    popup.document.close();
    popup.focus();
  };
  window.printFulfillmentList = orders => {
    const validOrders = (orders || []).filter(Boolean);
    if (!validOrders.length) return showToast('حدد أوردرًا واحدًا على الأقل', 'warning');
    const popup = window.open('', '_blank', 'width=820,height=920');
    if (!popup) return showToast('اسمح بالنوافذ المنبثقة لطباعة كشف التجهيز', 'warning');
    const orderItems = order => {
      const sourceItems = Array.isArray(order.items) && order.items.length
        ? order.items
        : [{ productName: order.productName, quantity: order.quantity }];
      return sourceItems.map(item => `<li><span>${escapeHTML(item.productName || 'منتج')}</span><b>× ${Math.max(1, Number(item.quantity) || 1)}</b></li>`).join('');
    };
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف تجهيز الأوردرات</title><style>
      *{box-sizing:border-box}body{margin:0;padding:30px;font-family:Tahoma,Arial,sans-serif;color:#172b4d;background:#fff}main{max-width:760px;margin:auto}.head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1e3a5f;padding-bottom:16px}.head h1{margin:0;color:#1e3a5f;font-size:24px}.head span{color:#6b7280;font-size:12px}.order{border:1px solid #d9e2ec;border-radius:10px;margin-top:16px;padding:14px;break-inside:avoid}.order-head{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px dashed #d9e2ec;padding-bottom:9px;margin-bottom:8px}.order-head strong{font-size:17px}.order-head span{font-size:11px;color:#6b7280}.items{list-style:none;padding:0;margin:0}.items li{display:flex;justify-content:space-between;gap:12px;padding:8px 2px;border-bottom:1px solid #eef2f6;font-size:14px}.items li:last-child{border-bottom:0}.actions{display:flex;justify-content:center;gap:10px;margin-top:24px}.actions button{border:0;border-radius:8px;padding:11px 20px;font:inherit;font-weight:700;cursor:pointer}.print-btn{background:#1e3a5f;color:#fff}.close-btn{background:#e2e8f0;color:#172b4d}.footer{text-align:center;margin-top:26px;color:#6b7280;font-size:11px}@media print{body{padding:0}.no-print{display:none!important}}
    </style></head><body><main><section class="head"><h1>كشف تجهيز الأوردرات</h1><span>${validOrders.length} أوردر</span></section>${validOrders.map(order => `<section class="order"><div class="order-head"><strong>${escapeHTML(order.clientName)}</strong><span>أوردر ${escapeHTML(order.id)}</span></div><ul class="items">${orderItems(order)}</ul></section>`).join('')}<div class="actions no-print"><button class="print-btn" onclick="window.print()">🖨️ طباعة الكشف</button><button class="close-btn" onclick="window.close()">إغلاق</button></div><div class="footer">كشف تجهيز — المنتجات والكميات فقط</div></main></body></html>`);
    popup.document.close();
    popup.focus();
  };
  window.pagination = (current, pages, prefix) => {
    let html = `<div class="pagination"><button class="page-btn" data-${prefix}="1" ${current === 1 ? 'disabled' : ''}>السابق</button>`;
    for (let page = 1; page <= pages; page += 1) html += `<button class="page-btn ${current === page ? 'active' : ''}" data-${prefix}="${page}">${page}</button>`;
    return `${html}<button class="page-btn" data-${prefix}="${pages}" ${current === pages ? 'disabled' : ''}>التالي</button></div>`;
  };

  let toastTimer;
  window.showToast = (message, type = 'success') => {
    const element = document.getElementById('toast');
    element.textContent = message;
    element.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 3000);
  };
  window.showLoading = visible => document.getElementById('loading').classList.toggle('hidden', !visible);
  window.openModal = (title, content) => {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-content').innerHTML = content;
    document.getElementById('modal-overlay').classList.remove('hidden');
  };
  window.closeModal = () => document.getElementById('modal-overlay').classList.add('hidden');

  window.App = {
    showLogin() {
      document.getElementById('app-screen').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('password').value = '';
      document.getElementById('username').focus();
    },
    showApp(user) {
      if (!user || !user.isActive) return this.showLogin();
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-screen').classList.remove('hidden');
      document.getElementById('nav-user-name').textContent = user.name;
      document.getElementById('nav-user-role').textContent = user.role === 'admin' ? 'مسؤول النظام' : 'مسوّق';
      document.getElementById('nav-avatar').textContent = user.name?.charAt(0) || 'م';
      this.buildNav(user);
      this.route('dashboard');
    },
    buildNav(user) {
      const nav = document.getElementById('main-nav');
      const items = user.role === 'admin'
        ? [['dashboard', '📊', 'لوحة التحكم'], ['orders', '📦', 'الأوردرات'], ['add', '＋', 'إضافة أوردر'], ['marketers', '👥', 'المسوقون'], ['products', '🛍️', 'المنتجات'], ['reports', '📈', 'التقارير']]
        : [['dashboard', '📊', 'لوحة التحكم'], ['orders', '📦', 'الأوردرات'], ['add', '＋', 'إضافة أوردر'], ...(Storage.hasPermission(user, 'add_product') || Storage.hasPermission(user, 'edit_product') || Storage.hasPermission(user, 'delete_product') ? [['products', '🛍️', 'المنتجات']] : [])];
      nav.innerHTML = items.map(([view, icon, label]) => `<a href="#" class="nav-link" data-view="${view}"><span class="nav-icon">${icon}</span>${label}</a>`).join('');
      nav.querySelectorAll('[data-view]').forEach(link => {
        link.onclick = event => { event.preventDefault(); this.route(link.dataset.view); this.closeSidebar(); };
      });
    },
    route(view) {
      const user = Storage.getCurrentUser();
      if (!user || !user.isActive) return this.showLogin();
      document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.view === view));
      const handler = routes[user.role]?.[view] || routes[user.role]?.dashboard;
      try { handler?.(); }
      catch (error) {
        console.error(error);
        mainContent.innerHTML = '<div class="card"><div class="empty-state"><div class="empty-icon">⚠️</div>حدث خطأ غير متوقع. حاول تحديث الصفحة.</div></div>';
      }
    },
    closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-backdrop').classList.remove('show');
    }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    await window.StorageReady;
    const loginForm = document.getElementById('login-form');
    loginForm.onsubmit = async event => {
      event.preventDefault();
      const email = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errorElement = document.getElementById('login-error');
      showLoading(true);
      const result = await AuthApp.login(email, password);
      showLoading(false);
      if (!result.ok) { errorElement.textContent = result.message; return; }
      errorElement.textContent = '';
      App.showApp(result.user);
    };
    document.getElementById('logout-btn').onclick = async () => {
      if (confirm('هل تريد تسجيل الخروج؟')) await AuthApp.logout();
    };
    document.getElementById('modal-close').onclick = closeModal;
    document.getElementById('modal-overlay').onclick = event => { if (event.target.id === 'modal-overlay') closeModal(); };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
    document.getElementById('sidebar-toggle').onclick = () => document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-backdrop').onclick = () => App.closeSidebar();
    document.getElementById('theme-toggle').onclick = () => {
      document.body.classList.toggle('dark');
      localStorage.setItem('oms_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    };
    if (localStorage.getItem('oms_theme') === 'dark') document.body.classList.add('dark');
    const session = Storage.getCurrentUser();
    if (session) App.showApp(session); else App.showLogin();
  });
})();
