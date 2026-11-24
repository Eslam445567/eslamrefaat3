(function () {
  'use strict';
  const labels = { pending: 'معلق', processing: 'قيد المعالجة', delivering: 'قيد التوصيل', completed: 'مكتمل', cancelled: 'ملغي' };
  const state = { page: 1, status: '', search: '', selected: new Set() };
  const visibleOrders = () => Storage.getOrdersForMarketerView(Storage.getCurrentUser()?.id);
  const getFiltered = () => visibleOrders().filter(o => (!state.status || o.status === state.status) && (!state.search || [o.id, o.clientName, o.productName, o.marketerName].some(v => String(v || '').toLowerCase().includes(state.search.toLowerCase()))));
  const canEditOrder = order => Storage.can('edit_orders') && (order.marketerId === Storage.getCurrentUser()?.id || Storage.can('view_all_orders'));
  const canDeleteOrder = order => Storage.can('delete_orders') && (order.marketerId === Storage.getCurrentUser()?.id || Storage.can('view_all_orders'));
  const statsCards = s => `<div class="stats-grid">
    <div class="stat-card"><div class="stat-icon">📦</div><div><div class="stat-value">${s.totalOrders}</div><div class="stat-label">إجمالي أوردراتي</div></div></div>
    <div class="stat-card success"><div class="stat-icon">✅</div><div><div class="stat-value">${s.completedOrders}</div><div class="stat-label">أوردرات مكتملة</div></div></div>
    <div class="stat-card warning"><div class="stat-icon">⏳</div><div><div class="stat-value">${s.pendingOrders}</div><div class="stat-label">أوردرات معلقة</div></div></div>
    <div class="stat-card accent"><div class="stat-icon">💰</div><div><div class="stat-value money">${formatCurrency(s.totalRevenue)}</div><div class="stat-label">إجمالي الإيرادات</div></div></div>
  </div>`;
  const orderRow = o => `<tr><td><b>${escapeHTML(o.id)}</b></td><td>${escapeHTML(o.clientName)}</td><td>${escapeHTML(o.productName)}</td><td>${statusBadge(o.status)}</td><td>${formatDate(o.createdAt)}</td><td><button class="action-btn" data-invoice="${o.id}">🧾 فاتورة</button></td></tr>`;
  const updatePrintButton = () => {
    const button = document.getElementById('marketer-print-picking');
    if (!button) return;
    button.disabled = !state.selected.size;
    button.textContent = state.selected.size ? `🧾 طباعة التجهيز (${state.selected.size})` : '🧾 طباعة التجهيز';
  };
  const table = orders => {
    const canPrint = Storage.can('print_picking');
    const selectionHead = canPrint ? '<th>اختيار</th>' : '';
    const rows = orders.length ? orders.map(o => `<tr>${canPrint ? `<td><input type="checkbox" data-marketer-select="${escapeAttr(o.id)}" ${state.selected.has(o.id) ? 'checked' : ''} aria-label="تحديد الأوردر ${escapeAttr(o.id)}"></td>` : ''}<td><b>${escapeHTML(o.id)}</b></td><td>${escapeHTML(o.clientName)}<small class="text-muted" style="display:block">${escapeHTML(o.clientPhone)}</small></td><td>${escapeHTML(o.productName)}</td><td>${o.quantity}</td><td class="money">${formatCurrency(o.saleTotal != null ? o.saleTotal : o.salePrice)}</td><td>${statusBadge(o.status)}</td><td>${escapeHTML(o.marketerName)}</td><td>${formatDate(o.createdAt)}</td><td><div class="actions"><button class="action-btn" data-invoice="${o.id}">🧾 فاتورة</button><button class="action-btn" data-detail="${o.id}">👁️ تفاصيل</button>${canEditOrder(o) ? `<button class="action-btn" data-edit="${o.id}">📝 تعديل كامل</button>` : ''}${canDeleteOrder(o) ? `<button class="action-btn danger" data-delete="${o.id}">🗑️ حذف</button>` : ''}</div></td></tr>`).join('') : `<tr><td colspan="${canPrint ? 10 : 9}"><div class="empty-state"><div class="empty-icon">📭</div>لا توجد أوردرات مطابقة</div></td></tr>`;
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${selectionHead}<th>رقم الأوردر</th><th>العميل</th><th>المنتج</th><th>الكمية</th><th>إجمالي البيع</th><th>الحالة</th><th>المسوّق</th><th>التاريخ</th><th>إجراءات</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const bindTable = () => {
    document.querySelectorAll('[data-invoice]').forEach(b => b.onclick = () => { const order = Storage.getOrderForMarketerView(b.dataset.invoice); if (order) printOrderInvoice(order); });
    document.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => MarketerApp.showOrderDetail(b.dataset.detail));
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => MarketerApp.openEditModal(b.dataset.edit));
    document.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => MarketerApp.removeOrder(b.dataset.delete));
    document.querySelectorAll('[data-marketer-select]').forEach(b => b.onchange = () => {
      if (b.checked) state.selected.add(b.dataset.marketerSelect);
      else state.selected.delete(b.dataset.marketerSelect);
      updatePrintButton();
    });
    updatePrintButton();
  };

  window.MarketerApp = {
    showDashboard() {
      const user = Storage.getCurrentUser(); const s = Storage.getMarketerStats(user.id); const recent = Storage.getOrdersByMarketer(user.id).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5);
      mainContent.innerHTML = `<div class="page-head"><div><h1>مرحبًا، ${escapeHTML(user.name)} 👋</h1><p>إليك ملخص أدائك وأحدث الأوردرات الخاصة بك.</p></div><div class="page-actions"><button class="btn btn-accent" id="quick-add">＋ إضافة أوردر</button></div></div>${statsCards(s)}<div class="card"><div class="card-head"><h2>أحدث أوردراتي</h2><button class="btn btn-outline btn-small" id="view-all-orders">عرض الكل</button></div><div class="table-wrap"><table class="data-table" style="min-width:600px"><thead><tr><th>رقم الأوردر</th><th>العميل</th><th>المنتج</th><th>الحالة</th><th>التاريخ</th><th>إجراء</th></tr></thead><tbody>${recent.length ? recent.map(orderRow).join('') : `<tr><td colspan="6"><div class="empty-state">لم تضف أي أوردر بعد.</div></td></tr>`}</tbody></table></div></div>`;
      document.getElementById('quick-add').onclick = () => this.showAddOrder(); document.getElementById('view-all-orders').onclick = () => this.showOrders(); document.querySelectorAll('[data-invoice]').forEach(b => b.onclick = () => { const order = Storage.getOrderForMarketerView(b.dataset.invoice); if (order) printOrderInvoice(order); });
    },
    showOrders() {
      state.page = 1; const render = () => { const filtered = getFiltered(); const pages = Math.max(1, Math.ceil(filtered.length / 10)); state.page = Math.min(state.page, pages); const current = filtered.slice((state.page-1)*10, state.page*10);
        mainContent.innerHTML = `<div class="page-head"><div><h1>الأوردرات</h1><p>${Storage.can('view_all_orders') ? 'عرض جميع الأوردرات المسموح بها مع إخفاء البيانات المالية الحساسة.' : 'عرض أوردراتك مع إخفاء البيانات المالية الحساسة.'}</p></div><div class="page-actions"><button class="btn btn-accent" id="add-order-btn">＋ إضافة أوردر</button>${Storage.can('print_picking') ? '<button class="btn btn-outline" id="marketer-print-picking">🧾 طباعة التجهيز</button>' : ''}</div></div><div class="card"><div class="filter-bar"><div class="filter-field grow"><label>بحث</label><input id="m-search" class="field-control" placeholder="ابحث بالعميل أو الرقم أو المنتج" value="${escapeHTML(state.search)}"></div><div class="filter-field"><label>الحالة</label><select id="m-status" class="field-control"><option value="">كل الحالات</option>${Object.entries(labels).map(([k,v]) => `<option value="${k}" ${state.status===k?'selected':''}>${v}</option>`).join('')}</select></div></div>${table(current)}${pagination(state.page,pages,'m-page')}</div>`;
        document.getElementById('m-search').oninput = e => { state.search=e.target.value; state.page=1; render(); }; document.getElementById('m-status').onchange = e => { state.status=e.target.value; state.page=1; render(); }; document.getElementById('add-order-btn').onclick=()=>this.showAddOrder(); document.getElementById('marketer-print-picking')?.addEventListener('click',()=>{const selectedOrders=visibleOrders().filter(order=>state.selected.has(order.id));printFulfillmentList(selectedOrders);}); document.querySelectorAll('[data-m-page]').forEach(b=>b.onclick=()=>{state.page=Number(b.dataset.mPage);render()}); bindTable();
      }; render();
    },
    showAddOrder() {
      const products = Storage.getProducts();
      mainContent.innerHTML = `<div class="page-head"><div><h1>إضافة أوردر جديد</h1><p>أضف صنفًا أو أكثر لنفس العميل داخل أوردر واحد.</p></div><button class="btn btn-outline" id="back-orders">← العودة للأوردرات</button></div><div class="card"><form id="add-order-form"><div class="form-grid"><div class="form-group"><label>اسم العميل *</label><input name="clientName" required></div><div class="form-group"><label>رقم الهاتف *</label><input name="clientPhone" type="tel" required></div><div class="form-group full"><label>العنوان *</label><input name="clientAddress" required></div><div class="form-group full"><div class="order-items-head"><h3>أصناف الأوردر</h3><button type="button" class="btn btn-outline btn-small" id="add-order-item">＋ إضافة صنف</button></div><div id="order-items-list"></div><div id="order-items-error" class="form-error" role="alert"></div></div><div class="form-group full"><label>ملاحظات</label><textarea name="notes" placeholder="أي ملاحظات إضافية..."></textarea></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">حفظ الأوردر</button><button class="btn btn-outline" type="button" id="cancel-add">إلغاء</button></div></form></div>`;
      const form=document.getElementById('add-order-form');
      document.getElementById('back-orders').onclick=()=>this.showOrders();
      document.getElementById('cancel-add').onclick=()=>this.showOrders();
      OrderItemsUI.bind(products);
      form.onsubmit = async e => { e.preventDefault(); if (!form.reportValidity()) return; const items=OrderItemsUI.collect(); if (!items) return; const data=Object.fromEntries(new FormData(form)); data.items=items; showLoading(true); try { const order=await Storage.addOrder(data); showToast('تم حفظ الأوردر '+order.id+' بنجاح'); this.showOrders(); } catch (error) { console.error(error); showToast(error?.message||'تعذر حفظ الأوردر','error'); } finally { showLoading(false); } };
    },
    showOrderDetail(orderId) {
      const o=Storage.getOrderForMarketerView(orderId); if(!o)return; openModal('تفاصيل الأوردر '+o.id,`<div class="detail-grid"><div class="detail-section"><h3>بيانات العميل</h3>${detail('الاسم',o.clientName)}${detail('الهاتف',o.clientPhone)}${detail('العنوان',o.clientAddress)}</div><div class="detail-section"><h3>أصناف الأوردر</h3>${orderItemsMarkup(o)}${detail('إجمالي الكمية',o.quantity)}${detail('إجمالي البيع',formatCurrency(o.saleTotal)+' ج.م')}${detail('الحالة',statusBadge(o.status))}${detail('المسوّق',o.marketerName)}${detail('التاريخ',formatDate(o.createdAt))}</div></div><div class="detail-section" style="margin-top:16px"><h3>ملاحظات</h3><p class="muted" style="font-size:12px">${escapeHTML(o.notes||'لا توجد ملاحظات')}</p></div>`);
    },
    openStatusModal(orderId) {
      const o=Storage.getOrderForMarketerView(orderId); if(!o||!canEditOrder(o))return;
      openModal('تعديل حالة الأوردر',`<form id="status-form"><div class="form-group"><label>الحالة</label><select name="status" class="field-control">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${o.status===k?'selected':''}>${v}</option>`).join('')}</select></div><div class="form-actions"><button class="btn btn-primary">حفظ التغيير</button><button type="button" class="btn btn-outline" id="cancel-modal">إلغاء</button></div></form>`);
      document.getElementById('cancel-modal').onclick=closeModal; document.getElementById('status-form').onsubmit=async e=>{e.preventDefault();try { await Storage.updateOrder(orderId,{status:new FormData(e.target).get('status')}); closeModal(); showToast('تم تحديث الحالة'); this.showOrders(); } catch (error) { console.error(error); showToast(error?.message||'تعذر تحديث الحالة','error'); }};
    },
    openEditModal(orderId) {
      const o=Storage.getOrderForMarketerView(orderId); if(!o||!canEditOrder(o))return;
      const products=Storage.getProducts();
      openModal('تعديل الأوردر بالكامل',`<form id="edit-order-form"><div class="form-grid"><div class="form-group"><label>اسم العميل *</label><input name="clientName" value="${escapeAttr(o.clientName)}" required></div><div class="form-group"><label>رقم الهاتف *</label><input name="clientPhone" value="${escapeAttr(o.clientPhone)}" required></div><div class="form-group full"><label>العنوان *</label><input name="clientAddress" value="${escapeAttr(o.clientAddress)}" required></div><div class="form-group full"><div class="order-items-head"><h3>أصناف الأوردر</h3><button type="button" class="btn btn-outline btn-small" id="add-order-item">＋ إضافة صنف</button></div><div id="order-items-list"></div><div id="order-items-error" class="form-error" role="alert"></div></div><div class="form-group"><label>الحالة</label><select name="status" class="field-control">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${o.status===k?'selected':''}>${v}</option>`).join('')}</select></div><div class="form-group full"><label>ملاحظات</label><textarea name="notes">${escapeHTML(o.notes||'')}</textarea></div></div><div class="form-actions"><button class="btn btn-primary">حفظ التعديل</button><button type="button" class="btn btn-outline" id="cancel-edit">إلغاء</button></div></form>`);
      document.getElementById('cancel-edit').onclick=closeModal;
      OrderItemsUI.bind(products,{initialItems:o.items?.length ? o.items : [{productId:o.productId,quantity:o.quantity,salePrice:o.salePrice}]});
      document.getElementById('edit-order-form').onsubmit=async e=>{e.preventDefault();const form=e.target;if(!form.reportValidity())return;const items=OrderItemsUI.collect();if(!items)return;try { await Storage.updateOrder(orderId,{...Object.fromEntries(new FormData(form)),items}); closeModal(); showToast('تم تعديل الأوردر بالكامل'); this.showOrders(); } catch (error) { console.error(error); showToast(error?.message||'تعذر تعديل الأوردر','error'); }};
    },
    async removeOrder(orderId) {
      if (!confirm('هل تريد حذف هذا الأوردر؟ لا يمكن التراجع عن العملية.')) return;
      try { await Storage.deleteOrder(orderId); showToast('تم حذف الأوردر'); this.showOrders(); } catch (error) { console.error(error); showToast(error?.message || 'تعذر حذف الأوردر', 'error'); }
    }
  };
})();
