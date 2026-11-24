(function () {
  'use strict';

  const client = window.supabaseClient;
  const STATUS = ['pending', 'processing', 'delivering', 'completed', 'cancelled'];
  const PERMISSION_DEFAULTS = {
    view_all_orders: false,
    edit_orders: true,
    delete_orders: false,
    print_picking: false,
    add_product: false,
    edit_product: false,
    delete_product: false
  };
  const PERMISSION_DEFINITIONS = [
    ['view_all_orders', 'عرض كل الأوردرات'],
    ['edit_orders', 'تعديل الأوردرات بالكامل'],
    ['delete_orders', 'حذف الأوردرات'],
    ['print_picking', 'طباعة تجهيز الطلبات'],
    ['add_product', 'إضافة منتجات'],
    ['edit_product', 'تعديل المنتجات'],
    ['delete_product', 'حذف المنتجات']
  ];
  const state = { currentUser: null, users: [], products: [], orders: [], ready: false };
  let initPromise;

  const normalizePermissions = permissions => ({
    ...PERMISSION_DEFAULTS,
    ...(permissions && typeof permissions === 'object' ? permissions : {})
  });
  const can = (user, permission) => user?.role === 'admin' || normalizePermissions(user?.permissions)[permission] === true;

  const orderTotal = order => Number(order.saleTotal != null ? order.saleTotal : Number(order.salePrice || 0) * Number(order.quantity || 1));
  const orderCost = order => Number(order.costTotal != null ? order.costTotal : Number(order.costPrice || 0) * Number(order.quantity || 1));
  const money = value => Number(value || 0);
  const orderDisplayId = row => row.legacy_id || `ORD-${String(row.order_no || '').padStart(4, '0')}`;

  const toUser = row => row ? ({
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    permissions: normalizePermissions(row.permissions),
    createdAt: row.created_at
  }) : null;

  const toProduct = row => row ? ({
    id: row.id,
    legacyId: row.legacy_id,
    name: row.name,
    salePrice: money(row.sale_price),
    costPrice: money(row.cost_price),
    createdAt: row.created_at,
    isActive: row.is_active !== false
  }) : null;

  const toOrderLine = row => {
    if (!row) return null;
    const marketer = state.users.find(user => user.id === row.marketer_id);
    return {
      id: orderDisplayId(row),
      dbId: row.id,
      legacyId: row.legacy_id,
      orderNo: row.order_no,
      clientName: row.client_name,
      clientPhone: row.client_phone,
      clientAddress: row.client_address,
      productId: row.product_id,
      productName: row.product_name || row.product_name_snapshot,
      orderGroupId: row.order_group_id || row.id,
      itemNo: Number(row.order_item_no || 1),
      quantity: Number(row.quantity || 1),
      salePrice: money(row.sale_price),
      costPrice: money(row.cost_price),
      profit: row.total_profit != null
        ? money(row.total_profit) / Math.max(1, Number(row.quantity || 1))
        : money(row.profit),
      status: row.status,
      marketerId: row.marketer_id,
      marketerName: marketer?.name || row.marketer_name || row.marketerName || (state.currentUser?.id === row.marketer_id ? state.currentUser.name : ''),
      notes: row.notes || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  };

  const groupOrders = rows => {
    const groups = new Map();
    rows.map(toOrderLine).filter(Boolean).forEach(line => {
      const key = line.orderGroupId || line.dbId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    });
    return [...groups.values()].map(lines => {
      lines.sort((a, b) => a.itemNo - b.itemNo);
      const first = lines[0];
      const items = lines.map(line => ({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        salePrice: line.salePrice,
        costPrice: line.costPrice,
        profit: line.profit
      }));
      const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const saleTotal = items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0);
      const costTotal = items.reduce((sum, item) => sum + item.costPrice * item.quantity, 0);
      const profitTotal = items.reduce((sum, item) => sum + item.profit * item.quantity, 0);
      return {
        ...first,
        items,
        itemCount: items.length,
        productName: items.map(item => `${item.productName} × ${item.quantity}`).join('، '),
        quantity,
        saleTotal,
        costTotal,
        profitTotal,
        profit: quantity ? profitTotal / quantity : 0
      };
    });
  };

  function setError(error) {
    state.lastError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    console.error('[Supabase]', state.lastError);
  }

  async function getProfile(userId) {
    const { data, error } = await client
      .from('profiles')
      .select('id,name,username,role,is_active,permissions,created_at')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return toUser(data);
  }

  async function loadData() {
    if (!state.currentUser) {
      state.users = [];
      state.products = [];
      state.orders = [];
      return;
    }

    const isAdmin = state.currentUser.role === 'admin';
    const usersRequest = isAdmin
      ? client.from('profiles').select('id,name,username,role,is_active,permissions,created_at').order('created_at')
      : Promise.resolve({ data: [state.currentUser], error: null });
    const productsRequest = client
      .from(isAdmin ? 'products_for_admin' : 'products_for_marketers')
      .select('*')
      .order('name');
    const [usersResult, productsResult] = await Promise.all([usersRequest, productsRequest]);
    if (usersResult.error) throw usersResult.error;
    if (productsResult.error) throw productsResult.error;

    state.users = (usersResult.data || []).map(row => row.id ? toUser(row) : row).filter(Boolean);
    state.products = (productsResult.data || []).map(toProduct).filter(Boolean);

    let orderRows;
    if (!isAdmin && can(state.currentUser, 'view_all_orders')) {
      const allOrdersResult = await client.rpc('get_orders_for_marketer_all');
      if (allOrdersResult.error) throw allOrdersResult.error;
      orderRows = Array.isArray(allOrdersResult.data) ? allOrdersResult.data : [];
    } else {
      const preferredView = isAdmin ? 'orders_for_admin_items' : 'orders_for_marketers_items';
      const fallbackView = isAdmin ? 'orders_for_admin' : 'orders_for_marketers';
      let ordersResult = await client.from(preferredView).select('*').order('created_at', { ascending: false });
      if (ordersResult.error && ['42P01', 'PGRST205'].includes(ordersResult.error.code)) {
        ordersResult = await client.from(fallbackView).select('*').order('created_at', { ascending: false });
      }
      const { data, error: ordersError } = ordersResult;
      if (ordersError) throw ordersError;
      orderRows = data || [];
    }
    state.orders = groupOrders(orderRows || []);
  }

  async function refresh() {
    await loadData();
    state.ready = true;
    return state.currentUser;
  }

  async function ensureReady() {
    if (!state.ready) await (initPromise || init());
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) {
        state.currentUser = await getProfile(data.session.user.id);
        if (!state.currentUser?.isActive) {
          await client.auth.signOut();
          state.currentUser = null;
        }
      }
      await refresh();
      return state.currentUser;
    })().catch(error => {
      setError(error);
      state.ready = true;
      state.currentUser = null;
      state.users = [];
      state.products = [];
      state.orders = [];
      return null;
    });
    return initPromise;
  }

  async function authenticate(email, password) {
    await ensureReady();
    const { data, error } = await client.auth.signInWithPassword({ email: String(email || '').trim(), password });
    if (error || !data.user) return null;
    const profile = await getProfile(data.user.id);
    if (!profile?.isActive) {
      await client.auth.signOut();
      return null;
    }
    state.currentUser = profile;
    await refresh();
    return profile;
  }

  async function clearCurrentUser() {
    await client.auth.signOut();
    state.currentUser = null;
    state.users = [];
    state.products = [];
    state.orders = [];
  }

  async function adminProductAction(action, payload = {}) {
    const rpcResult = await client.rpc('admin_manage_product', {
      p_action: action,
      p_product_id: payload.productId || null,
      p_name: payload.name || null,
      p_sale_price: payload.salePrice ?? 0,
      p_cost_price: payload.costPrice ?? 0,
      p_is_active: payload.isActive !== false
    });
    if (!rpcResult.error) {
      await refresh();
      return rpcResult.data;
    }
    if (!['42883', 'PGRST202'].includes(rpcResult.error.code)) throw rpcResult.error;
    const { data, error } = await client.functions.invoke('admin-manage-product', { body: { action, ...payload } });
    if (error) throw error;
    await refresh();
    return data;
  }

  async function addProduct(data) {
    return adminProductAction('create', {
      name: String(data.name || '').trim(),
      salePrice: money(data.salePrice),
      costPrice: money(data.costPrice)
    });
  }

  async function updateProduct(productId, updates) {
    return adminProductAction('update', {
      productId,
      name: String(updates.name || '').trim(),
      salePrice: money(updates.salePrice),
      costPrice: money(updates.costPrice),
      isActive: updates.isActive !== false
    });
  }

  async function deleteProduct(productId) {
    await adminProductAction('deactivate', { productId });
    return true;
  }

  async function addOrder(data) {
    const items = Array.isArray(data.items) && data.items.length
      ? data.items
      : [{ productId: data.productId, quantity: data.quantity, salePrice: data.salePrice }];
    if (items.length > 1) {
      const { data: groupId, error } = await client.rpc('create_order_with_items', {
        p_client_name: String(data.clientName || '').trim(),
        p_client_phone: String(data.clientPhone || '').trim(),
        p_client_address: String(data.clientAddress || '').trim(),
        p_items: items.map(item => ({
          productId: item.productId,
          quantity: Math.max(1, Number(item.quantity) || 1),
          salePrice: state.currentUser?.role === 'admin' && item.salePrice !== '' && item.salePrice != null ? money(item.salePrice) : null
        })),
        p_notes: String(data.notes || '').trim(),
        p_marketer_id: state.currentUser?.role === 'admin' ? (data.marketerId || null) : null
      });
      if (error) throw error;
      await refresh();
      return state.orders.find(order => order.orderGroupId === groupId) || state.orders[0] || null;
    }
    const { data: row, error } = await client.rpc('create_order', {
      p_client_name: String(data.clientName || '').trim(),
      p_client_phone: String(data.clientPhone || '').trim(),
      p_client_address: String(data.clientAddress || '').trim(),
      p_product_id: items[0].productId,
      p_quantity: Math.max(1, Number(items[0].quantity) || 1),
      p_notes: String(data.notes || '').trim(),
      p_marketer_id: state.currentUser?.role === 'admin' ? (data.marketerId || null) : null,
      p_sale_price: state.currentUser?.role === 'admin' && items[0].salePrice !== '' && items[0].salePrice != null
        ? money(items[0].salePrice)
        : null
    });
    if (error) throw error;
    await refresh();
    return groupOrders([row])[0] || null;
  }

  async function updateOrder(orderId, updates) {
    const current = state.orders.find(order => order.id === orderId || order.dbId === orderId);
    if (!current) return null;
    if (Array.isArray(updates.items)) {
      const { error } = await client.rpc('update_order_with_items', {
        p_order_id: current.dbId,
        p_client_name: updates.clientName ?? current.clientName,
        p_client_phone: updates.clientPhone ?? current.clientPhone,
        p_client_address: updates.clientAddress ?? current.clientAddress,
        p_items: updates.items.map(item => ({
          productId: item.productId,
          quantity: Math.max(1, Number(item.quantity) || 1),
          salePrice: item.salePrice !== '' && item.salePrice != null ? money(item.salePrice) : null
        })),
        p_notes: updates.notes ?? current.notes ?? '',
        p_status: updates.status ?? current.status,
        p_marketer_id: state.currentUser?.role === 'admin' ? (updates.marketerId || null) : null
      });
      if (error) throw error;
      await refresh();
      return state.orders.find(order => order.orderGroupId === current.orderGroupId) || null;
    }
    const { data: row, error } = await client.rpc('update_order', {
      p_order_id: current.dbId,
      p_client_name: updates.clientName ?? null,
      p_client_phone: updates.clientPhone ?? null,
      p_client_address: updates.clientAddress ?? null,
      p_notes: updates.notes ?? null,
      p_status: updates.status ?? null,
      p_product_id: updates.productId ?? null,
      p_quantity: updates.quantity != null ? Number(updates.quantity) : null,
      p_sale_price: updates.salePrice != null ? money(updates.salePrice) : null,
      p_cost_price: updates.costPrice != null ? money(updates.costPrice) : null
    });
    if (error) throw error;
    await refresh();
    return groupOrders([row])[0] || null;
  }

  async function deleteOrder(orderId) {
    const current = state.orders.find(order => order.id === orderId || order.dbId === orderId);
    if (!current) return false;
    const { error } = await client.rpc('delete_order_group', { p_order_group_id: current.orderGroupId || current.dbId });
    if (error) throw error;
    await refresh();
    return true;
  }

  async function adminUserAction(action, payload = {}) {
    const { data, error } = await client.functions.invoke('admin-manage-user', {
      body: { action, ...payload }
    });
    if (error) throw error;
    await refresh();
    return data;
  }

  async function addUser(data) {
    return adminUserAction('create', {
      name: String(data.name || '').trim(),
      username: String(data.username || '').trim(),
      email: String(data.email || '').trim(),
      password: data.password,
      role: 'marketer'
    });
  }

  async function updateUser(userId, updates) {
    return adminUserAction('update', {
      userId,
      name: updates.name,
      username: updates.username,
      isActive: updates.isActive,
      password: updates.password
    });
  }

  async function updateMarketerPermissions(userId, permissions) {
    const { data, error } = await client.rpc('admin_manage_marketer_permissions', {
      p_user_id: userId,
      p_permissions: normalizePermissions(permissions)
    });
    if (error) throw error;
    await refresh();
    return data;
  }

  async function toggleUserStatus(userId) {
    return adminUserAction('toggle', { userId });
  }

  async function deleteUser(userId) {
    return adminUserAction('deactivate', { userId });
  }

  function getUserByUsername(username) {
    return state.users.find(user => user.username?.toLowerCase() === String(username || '').trim().toLowerCase()) || null;
  }

  function getStats() {
    const orders = state.orders;
    return {
      totalOrders: orders.length,
      totalRevenue: orders.reduce((sum, order) => sum + orderTotal(order), 0),
      totalCost: orders.reduce((sum, order) => sum + orderCost(order), 0),
      totalProfit: orders.reduce((sum, order) => sum + Number(order.profit || 0) * Number(order.quantity || 1), 0),
      completedOrders: orders.filter(order => order.status === 'completed').length,
      pendingOrders: orders.filter(order => order.status === 'pending').length,
      cancelledOrders: orders.filter(order => order.status === 'cancelled').length,
      activeMarketers: state.users.filter(user => user.role === 'marketer' && user.isActive).length
    };
  }

  function getMarketerStats(marketerId) {
    const orders = state.orders.filter(order => order.marketerId === marketerId);
    return {
      totalOrders: orders.length,
      completedOrders: orders.filter(order => order.status === 'completed').length,
      pendingOrders: orders.filter(order => order.status === 'pending').length,
      totalRevenue: orders.reduce((sum, order) => sum + orderTotal(order), 0),
      totalProfit: orders.reduce((sum, order) => sum + Number(order.profit || 0) * Number(order.quantity || 1), 0)
    };
  }

  function marketerSafeOrder(order) {
    if (!order) return null;
    const { costPrice, profit, costTotal, profitTotal, dbId, ...visible } = order;
    if (Array.isArray(visible.items)) {
      visible.items = visible.items.map(({ costPrice: itemCost, profit: itemProfit, ...item }) => item);
    }
    return visible;
  }

  window.Storage = {
    STATUS,
    init,
    getCurrentUser: () => state.currentUser,
    setCurrentUser: () => {},
    clearCurrentUser,
    authenticate,
    getUsers: () => state.users,
    getUserByUsername,
    addUser,
    updateUser,
    updateMarketerPermissions,
    toggleUserStatus,
    deleteUser,
    getProducts: () => state.products.filter(product => product.isActive),
    addProduct,
    updateProduct,
    deleteProduct,
    getOrders: () => state.orders,
    getOrdersByMarketer: marketerId => state.orders.filter(order => order.marketerId === marketerId),
    getOrdersForMarketerView: marketerId => state.orders
      .filter(order => can(state.currentUser, 'view_all_orders') || order.marketerId === marketerId)
      .map(marketerSafeOrder),
    getOrderForMarketerView: orderId => {
      const order = state.orders.find(item => item.id === orderId || item.dbId === orderId);
      if (!order || (state.currentUser?.role === 'marketer' && !can(state.currentUser, 'view_all_orders') && order.marketerId !== state.currentUser.id)) return null;
      return marketerSafeOrder(order);
    },
    addOrder,
    updateOrder,
    deleteOrder,
    getStats,
    getMarketerStats
    ,can: permission => can(state.currentUser, permission)
    ,hasPermission: (user, permission) => can(user, permission)
    ,PERMISSION_DEFINITIONS
    ,PERMISSION_DEFAULTS
  };

  window.StorageReady = init();
})();
