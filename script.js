const REFRESH_INTERVAL_MS = 5000;
const SALES_LOOKBACK_DAYS = 30;

const supabaseConfig = window.SUPABASE_CONFIG || {};
const supabaseUrl = supabaseConfig.url;
const supabaseAnonKey = supabaseConfig.anonKey;
const supabaseClient =
  supabaseUrl && supabaseAnonKey ? window.supabase.createClient(supabaseUrl, supabaseAnonKey) : null;

const state = {
  inventory: [],
  variants: [],
  sales: [],
  returns: [],
  role: "staff",
  userEmail: "Not signed in",
  currentInventoryEditProduct: null,
  filters: { from: "", to: "", product: "", status: "" }
};

const ids = (id) => document.getElementById(id);

const menuMap = {
  dashboard: { button: ids("menuDashboard"), section: ids("dashboardSection") },
  add: { button: ids("menuAddSale"), section: ids("addSaleSection") },
  delete: { button: ids("menuDeleteSale"), section: ids("deleteSaleSection") },
  returns: { button: ids("menuReturns"), section: ids("returnsSection") },
  filters: { button: ids("menuSalesFilters"), section: ids("salesFiltersSection") },
  inventory: { button: ids("menuInventory"), section: ids("inventorySection") },
  security: { button: ids("menuSecurity"), section: ids("securitySection") }
};

let qrScanInterval = null;
let qrStream = null;

function formatMoney(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value || 0));
}

function showSection(sectionName) {
  Object.values(menuMap).forEach(({ button, section }) => {
    section.classList.add("hidden-section");
    button.classList.remove("active-menu");
  });
  menuMap[sectionName].section.classList.remove("hidden-section");
  menuMap[sectionName].button.classList.add("active-menu");
}

function enforceRoleUI() {
  const canDelete = state.role === "admin";
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.disabled = !canDelete;
    btn.title = canDelete ? "" : "Admin only";
  });
}

function calculateTotals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.totalOrders += Number(row.quantity);
      acc.totalRevenue += Number(row.priceInr) * Number(row.quantity);
      acc.totalProfit += (Number(row.priceInr) - Number(row.costInr)) * Number(row.quantity);
      return acc;
    },
    { totalOrders: 0, totalRevenue: 0, totalProfit: 0 }
  );
}

function getBestSellers(rows, topCount = 5) {
  const map = {};
  rows.forEach((row) => {
    map[row.product] = (map[row.product] || 0) + Number(row.quantity);
  });
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topCount);
}

function getDailySummary(rows) {
  if (!rows.length) return "No sales data available.";
  const day = rows.map((r) => r.date).sort().pop();
  const t = calculateTotals(rows.filter((r) => r.date === day));
  return `${day}: ${t.totalOrders} items sold, ${formatMoney(t.totalRevenue)} revenue, ${formatMoney(
    t.totalProfit
  )} profit`;
}

function getWeeklySummary(rows) {
  if (!rows.length) return "No sales data available.";
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const last = dates.slice(-7);
  const t = calculateTotals(rows.filter((r) => last.includes(r.date)));
  return `Last ${last.length} days: ${t.totalOrders} items sold, ${formatMoney(t.totalRevenue)} revenue, ${formatMoney(
    t.totalProfit
  )} profit`;
}

function updateSaleProductStockHint() {
  const product = ids("saleProduct").value;
  const size = ids("saleSize").value;
  const item = state.inventory.find((i) => i.product === product);
  if (!item || item.stockQty <= 0) {
    ids("selectedStockInfo").textContent = "Out of Stock";
    return;
  }
  if (!size) {
    ids("selectedStockInfo").textContent = `${item.product}: ${item.stockQty} remaining`;
    return;
  }
  const variant = state.variants.find((v) => v.product === product && v.size === size);
  ids("selectedStockInfo").textContent =
    variant && variant.stockQty > 0 ? `${item.product} (${size}): ${variant.stockQty} remaining` : `Out of Stock (${size})`;
}

function renderInventoryOptions() {
  const select = ids("saleProduct");
  const sizeSelect = ids("saleSize");
  const filterProduct = ids("filterProduct");
  const previousSaleProduct = select.value;
  const previousSize = sizeSelect.value;
  const previousFilterProduct = filterProduct.value;

  select.innerHTML = "";
  filterProduct.innerHTML = '<option value="">All products</option>';
  if (!state.inventory.length) {
    select.innerHTML = '<option value="">No products</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  state.inventory.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.product;
    option.textContent = item.product;
    select.appendChild(option);

    const f = document.createElement("option");
    f.value = item.product;
    f.textContent = item.product;
    filterProduct.appendChild(f);
  });

  if (previousSaleProduct && state.inventory.some((item) => item.product === previousSaleProduct)) {
    select.value = previousSaleProduct;
  }
  renderSaleSizeOptions(previousSize);
  if (previousFilterProduct && state.inventory.some((item) => item.product === previousFilterProduct)) {
    filterProduct.value = previousFilterProduct;
  }

  updateSaleProductStockHint();
}

function renderSaleSizeOptions(previousSize = "") {
  const product = ids("saleProduct").value;
  const sizeSelect = ids("saleSize");
  const variants = state.variants.filter((v) => v.product === product);
  sizeSelect.innerHTML = "";

  if (!variants.length) {
    sizeSelect.innerHTML = '<option value="">No sizes</option>';
    sizeSelect.disabled = true;
    return;
  }

  sizeSelect.disabled = false;
  variants.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.size;
    opt.textContent = `${v.size} (${v.stockQty})`;
    sizeSelect.appendChild(opt);
  });

  if (previousSize && variants.some((v) => v.size === previousSize)) {
    sizeSelect.value = previousSize;
  }
}

function parseVariantsInput(raw) {
  if (!raw.trim()) return [];
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const [size, qtyRaw] = token.split(":").map((x) => (x || "").trim());
    const qty = Number(qtyRaw);
    if (!size || Number.isNaN(qty) || qty < 0) {
      return null;
    }
    out.push({ size, stockQty: qty });
  }
  return out;
}

function syncTotalStockFromVariants() {
  const parsed = parseVariantsInput(ids("inventoryVariants").value);
  if (!parsed) {
    ids("inventoryStockQty").value = "0";
    return;
  }
  ids("inventoryStockQty").value = String(parsed.reduce((sum, v) => sum + v.stockQty, 0));
}

function renderSalesList() {
  const list = ids("salesRecordsList");
  list.innerHTML = "";
  if (!state.sales.length) {
    list.innerHTML = '<li><span class="record-label">No sales rows found.</span></li>';
    return;
  }
  state.sales.slice().reverse().slice(0, 10).forEach((row) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="record-label">${row.date} | ${row.product}${row.size ? ` (${row.size})` : ""} | Qty ${row.quantity} | ${
      row.status
    } | ${formatMoney(
      row.priceInr
    )}</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "delete-btn";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => deleteSale(row.id));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderRemainingStock() {
  const list = ids("remainingStockList");
  list.innerHTML = "";
  if (!state.inventory.length) {
    list.innerHTML = '<li><span class="record-label">No stock items found.</span></li>';
    return;
  }
  state.inventory.forEach((item) => {
    const low = item.stockQty <= item.reorderLevel;
    const status = item.stockQty <= 0 ? "Out of Stock" : `${item.stockQty} left`;
    const marker = low ? " (Low stock)" : "";
    const li = document.createElement("li");
    li.innerHTML = `<span class="record-label">${item.product} | ${status}${marker}</span>`;
    list.appendChild(li);
  });
}

function renderReturnsUI() {
  const select = ids("returnSaleId");
  const previousSaleId = select.value;
  select.innerHTML = "";
  const returnableSales = state.sales.filter((s) => s.status !== "returned").slice().reverse();

  if (!returnableSales.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No returnable sales";
    select.appendChild(o);
    select.disabled = true;
  } else {
    select.disabled = false;
    returnableSales.forEach((s) => {
      const o = document.createElement("option");
      o.value = String(s.id);
      o.textContent = `${s.date} | ${s.product}${s.size ? ` (${s.size})` : ""} | Qty ${s.quantity}`;
      select.appendChild(o);
    });
  }

  if (previousSaleId && returnableSales.some((s) => String(s.id) === previousSaleId)) {
    select.value = previousSaleId;
  }

  const list = ids("returnsRecordsList");
  list.innerHTML = "";
  if (!state.returns.length) {
    list.innerHTML = '<li><span class="record-label">No returns yet.</span></li>';
    return;
  }
  state.returns.slice().reverse().slice(0, 10).forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="record-label">${r.returnDate} | ${r.product} | Qty ${r.quantity} | Refund ${formatMoney(
      r.refundAmount
    )}</span>`;
    list.appendChild(li);
  });
}

function getFilteredSales() {
  return state.sales.filter((s) => {
    if (state.filters.from && s.date < state.filters.from) return false;
    if (state.filters.to && s.date > state.filters.to) return false;
    if (state.filters.product && s.product !== state.filters.product) return false;
    if (state.filters.status && s.status !== state.filters.status) return false;
    return true;
  });
}

function renderFilteredSales() {
  const list = ids("filteredSalesList");
  const rows = getFilteredSales();
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = '<li><span class="record-label">No sales in selected filter.</span></li>';
    return;
  }
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="record-label">${r.date} | ${r.product}${r.size ? ` (${r.size})` : ""} | Qty ${r.quantity} | ${r.status} | ${formatMoney(
      r.priceInr
    )}</span>`;
    list.appendChild(li);
  });
  ids("filtersMessage").textContent = `${rows.length} records found`;
}

function renderInventoryRecords() {
  const list = ids("inventoryRecordsList");
  list.innerHTML = "";
  if (!state.inventory.length) {
    list.innerHTML = '<li><span class="record-label">No inventory found.</span></li>';
    return;
  }
  state.inventory.forEach((item) => {
    const li = document.createElement("li");
    const sizeLine = state.variants
      .filter((v) => v.product === item.product)
      .map((v) => `${v.size}:${v.stockQty}`)
      .join(", ");
    li.innerHTML = `<span class="record-label">${item.product} | Stock ${item.stockQty} | Sizes ${
      sizeLine || "-"
    } | Cat ${item.category} | Color ${item.color} | QR ${item.qrCode || "-"}</span>`;

    const right = document.createElement("div");
    right.className = "inventory-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => setInventoryEditMode(item));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete-btn";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteInventory(item.product));

    right.appendChild(edit);
    right.appendChild(del);
    li.appendChild(right);
    list.appendChild(li);
  });
}

function setInventoryEditMode(item) {
  state.currentInventoryEditProduct = item ? item.product : null;
  ids("inventoryProduct").disabled = Boolean(item);
  ids("inventoryCancelEditBtn").classList.toggle("hidden-section", !item);
  ids("inventorySubmitBtn").textContent = item ? "Update Inventory" : "Add Inventory";
  if (!item) {
    ids("inventoryForm").reset();
    ids("inventoryStockQty").value = "0";
    return;
  }
  ids("inventoryProduct").value = item.product;
  ids("inventoryStockQty").value = item.stockQty;
  ids("inventoryPriceInr").value = item.priceInr;
  ids("inventoryCostInr").value = item.costInr;
  ids("inventoryQrCode").value = item.qrCode || "";
  ids("inventoryCategory").value = item.category || "";
  ids("inventoryColor").value = item.color || "";
  ids("inventoryReorderLevel").value = item.reorderLevel || 0;
  const variants = state.variants.filter((v) => v.product === item.product);
  ids("inventoryVariants").value = variants.map((v) => `${v.size}:${v.stockQty}`).join(",");
}

async function getCurrentUserRole() {
  if (!supabaseClient) return;
  const { data } = await supabaseClient.auth.getUser();
  if (!data?.user) {
    state.role = "admin";
    state.userEmail = "Not signed in (Dev mode admin)";
    return;
  }

  state.userEmail = data.user.email || data.user.id;
  const { data: profile } = await supabaseClient
    .from("app_users")
    .select("role")
    .eq("user_id", data.user.id)
    .maybeSingle();
  state.role = profile?.role || "staff";
}

async function loadData() {
  if (!supabaseClient) throw new Error("Supabase not configured. Set url and anonKey in config.js");
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - SALES_LOOKBACK_DAYS + 1);
  const from = fromDate.toISOString().slice(0, 10);

  let sales = [];
  let inventory = [];
  let variants = [];
  let returnsData = [];
  let logs = [];

  let salesResult = await supabaseClient
    .from("sales")
    .select("id, sold_at, product, size, quantity, price_inr, cost_inr, status")
    .gte("sold_at", from)
    .order("sold_at", { ascending: true });
  if (salesResult.error) {
    // Backward-compatible fallback for older schema without status column.
    salesResult = await supabaseClient
      .from("sales")
      .select("id, sold_at, product, quantity, price_inr, cost_inr")
      .gte("sold_at", from)
      .order("sold_at", { ascending: true });
  }
  if (salesResult.error) throw new Error(salesResult.error.message);
  sales = salesResult.data || [];

  let inventoryResult = await supabaseClient
    .from("inventory")
    .select("product, stock_qty, price_inr, cost_inr, qr_code, category, size, color, reorder_level")
    .order("product", { ascending: true });
  if (inventoryResult.error) {
    // Backward-compatible fallback for older schema without new inventory fields.
    inventoryResult = await supabaseClient
      .from("inventory")
      .select("product, stock_qty, price_inr, cost_inr, qr_code")
      .order("product", { ascending: true });
  }
  if (inventoryResult.error) throw new Error(inventoryResult.error.message);
  inventory = inventoryResult.data || [];

  const variantsResult = await supabaseClient
    .from("inventory_variants")
    .select("product, size, stock_qty")
    .order("product", { ascending: true });
  if (!variantsResult.error) {
    variants = variantsResult.data || [];
  }

  const returnsResult = await supabaseClient
    .from("returns")
    .select("id, return_date, product, quantity, refund_amount")
    .order("return_date", { ascending: true });
  if (!returnsResult.error) {
    returnsData = returnsResult.data || [];
  }

  const logsResult = await supabaseClient
    .from("operation_logs")
    .select("id, action, entity_name, created_at")
    .order("created_at", { ascending: false })
    .limit(15);
  if (!logsResult.error) {
    logs = logsResult.data || [];
  }

  state.sales = (sales || []).map((r) => ({
    id: String(r.id),
    date: r.sold_at,
    product: r.product,
    quantity: Number(r.quantity),
    priceInr: Number(r.price_inr),
    costInr: Number(r.cost_inr),
    status: r.status || "completed",
    size: r.size || ""
  }));

  state.inventory = (inventory || []).map((r) => ({
    product: r.product,
    stockQty: Number(r.stock_qty),
    priceInr: Number(r.price_inr),
    costInr: Number(r.cost_inr),
    qrCode: r.qr_code || "",
    category: r.category || "-",
    size: r.size || "-",
    color: r.color || "-",
    reorderLevel: Number(r.reorder_level || 0)
  }));

  state.variants = (variants || []).map((v) => ({
    product: v.product,
    size: v.size,
    stockQty: Number(v.stock_qty)
  }));

  state.returns = (returnsData || []).map((r) => ({
    id: r.id,
    returnDate: r.return_date,
    product: r.product,
    quantity: Number(r.quantity),
    refundAmount: Number(r.refund_amount)
  }));

  const logsList = ids("operationLogsList");
  logsList.innerHTML = "";
  (logs || []).forEach((l) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="record-label">${l.created_at.slice(0, 19).replace("T", " ")} | ${l.action} | ${
      l.entity_name
    }</span>`;
    logsList.appendChild(li);
  });
}

async function renderAll() {
  await getCurrentUserRole();
  await loadData();

  const totals = calculateTotals(state.sales.filter((s) => s.status !== "returned"));
  ids("totalOrders").textContent = totals.totalOrders;
  ids("totalRevenue").textContent = formatMoney(totals.totalRevenue);
  ids("totalProfit").textContent = formatMoney(totals.totalProfit);
  ids("dailySummary").textContent = getDailySummary(state.sales.filter((s) => s.status !== "returned"));
  ids("weeklySummary").textContent = getWeeklySummary(state.sales.filter((s) => s.status !== "returned"));

  const best = ids("bestSellersList");
  best.innerHTML = "";
  getBestSellers(state.sales.filter((s) => s.status !== "returned")).forEach(([p, q]) => {
    const li = document.createElement("li");
    li.textContent = `${p}: ${q} sold`;
    best.appendChild(li);
  });

  renderRemainingStock();
  renderInventoryOptions();
  renderSalesList();
  renderReturnsUI();
  renderFilteredSales();
  renderInventoryRecords();

  ids("currentUserInfo").textContent = `User: ${state.userEmail}`;
  ids("currentRoleInfo").textContent = `Role: ${state.role}`;
  ids("statusMessage").textContent = "Connected to Supabase. Auto-refreshing every 5 seconds.";
  enforceRoleUI();
}

async function addSale(event) {
  event.preventDefault();
  const soldAt = ids("saleDate").value;
  const product = ids("saleProduct").value;
  const size = ids("saleSize").value;
  const quantity = Number(ids("saleQuantity").value);
  if (!soldAt || !product || !size || quantity <= 0) {
    ids("formMessage").textContent = "Please enter valid sale details.";
    return;
  }
  const variant = state.variants.find((v) => v.product === product && v.size === size);
  if (!variant || variant.stockQty < quantity) {
    ids("formMessage").textContent = "Out of Stock";
    return;
  }

  let { error } = await supabaseClient.rpc("place_order_with_size", {
    p_sold_at: soldAt,
    p_product: product,
    p_size: size,
    p_quantity: quantity
  });
  if (error && error.message.toLowerCase().includes("function")) {
    ({ error } = await supabaseClient.rpc("place_order", {
      p_sold_at: soldAt,
      p_product: product,
      p_quantity: quantity
    }));
  }
  if (error) {
    ids("formMessage").textContent = error.message.toLowerCase().includes("out of stock") ? "Out of Stock" : error.message;
    return;
  }

  ids("formMessage").textContent = "Sale saved.";
  ids("addSaleForm").reset();
  await renderAll();
}

async function deleteSale(saleId) {
  if (state.role !== "admin") {
    ids("formMessage").textContent = "Admin only action.";
    return;
  }
  if (!window.confirm("Delete this sale record?")) return;
  const { error } = await supabaseClient.rpc("delete_sale_and_restore_stock", { p_sale_id: saleId });
  if (error) {
    ids("formMessage").textContent = error.message;
    return;
  }
  ids("formMessage").textContent = "Sale deleted.";
  await renderAll();
}

async function processReturn(event) {
  event.preventDefault();
  const saleIdRaw = ids("returnSaleId").value;
  const returnDate = ids("returnDate").value;
  const quantity = Number(ids("returnQuantity").value);
  const reason = ids("returnReason").value.trim();
  if (!saleIdRaw) {
    ids("returnsMessage").textContent = "No valid sale selected for return.";
    return;
  }
  if (!returnDate || quantity <= 0) {
    ids("returnsMessage").textContent = "Please enter valid return details.";
    return;
  }
  const { error } = await supabaseClient.rpc("process_return", {
    p_sale_id: saleIdRaw,
    p_return_date: returnDate,
    p_quantity: quantity,
    p_reason: reason || null
  });
  if (error) {
    ids("returnsMessage").textContent = error.message;
    return;
  }
  ids("returnsMessage").textContent = "Return processed.";
  ids("returnsForm").reset();
  await renderAll();
}

function applySalesFilters(event) {
  event.preventDefault();
  state.filters = {
    from: ids("filterFromDate").value,
    to: ids("filterToDate").value,
    product: ids("filterProduct").value,
    status: ids("filterStatus").value
  };
  renderFilteredSales();
}

function clearSalesFilters() {
  ids("salesFiltersForm").reset();
  state.filters = { from: "", to: "", product: "", status: "" };
  renderFilteredSales();
}

function exportFilteredSalesCsv() {
  const rows = getFilteredSales();
  if (!rows.length) {
    ids("filtersMessage").textContent = "Nothing to export.";
    return;
  }
  const header = "date,product,quantity,status,price_inr,cost_inr";
  const lines = rows.map((r) => [r.date, r.product, r.quantity, r.status, r.priceInr, r.costInr].join(","));
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "filtered-sales.csv";
  a.click();
  URL.revokeObjectURL(url);
  ids("filtersMessage").textContent = "CSV exported.";
}

async function submitInventory(event) {
  event.preventDefault();
  const payload = {
    product: ids("inventoryProduct").value.trim(),
    price_inr: Number(ids("inventoryPriceInr").value),
    cost_inr: Number(ids("inventoryCostInr").value),
    qr_code: ids("inventoryQrCode").value.trim() || null,
    category: ids("inventoryCategory").value.trim() || null,
    color: ids("inventoryColor").value.trim() || null,
    reorder_level: Number(ids("inventoryReorderLevel").value || 0)
  };
  const variants = parseVariantsInput(ids("inventoryVariants").value);
  if (!payload.product || !variants || payload.price_inr < 0 || payload.cost_inr < 0) {
    ids("inventoryMessage").textContent = "Please enter valid inventory details.";
    return;
  }
  payload.stock_qty = variants.reduce((sum, v) => sum + v.stockQty, 0);
  ids("inventoryStockQty").value = String(payload.stock_qty);
  if (state.role !== "admin") {
    ids("inventoryMessage").textContent = "Admin only action.";
    return;
  }

  let error;
  if (state.currentInventoryEditProduct) {
    ({ error } = await supabaseClient.from("inventory").update(payload).eq("product", state.currentInventoryEditProduct));
  } else {
    ({ error } = await supabaseClient.from("inventory").insert(payload));
  }
  if (error) {
    ids("inventoryMessage").textContent = error.message;
    return;
  }

  const variantProduct = state.currentInventoryEditProduct || payload.product;
  await supabaseClient.from("inventory_variants").delete().eq("product", variantProduct);
  if (variants.length) {
    await supabaseClient.from("inventory_variants").insert(
      variants.map((v) => ({
        product: variantProduct,
        size: v.size,
        stock_qty: v.stockQty
      }))
    );
  }

  ids("inventoryMessage").textContent = state.currentInventoryEditProduct ? "Inventory updated." : "Inventory added.";
  setInventoryEditMode(null);
  await renderAll();
}

async function deleteInventory(product) {
  if (state.role !== "admin") {
    ids("inventoryMessage").textContent = "Admin only action.";
    return;
  }
  if (!window.confirm(`Delete inventory item "${product}"?`)) return;
  const { error } = await supabaseClient.from("inventory").delete().eq("product", product);
  if (error) {
    ids("inventoryMessage").textContent = error.message;
    return;
  }
  ids("inventoryMessage").textContent = "Inventory deleted.";
  await supabaseClient.from("inventory_variants").delete().eq("product", product);
  if (state.currentInventoryEditProduct === product) setInventoryEditMode(null);
  await renderAll();
}

function stopQrScan() {
  if (qrScanInterval) {
    clearInterval(qrScanInterval);
    qrScanInterval = null;
  }
  if (qrStream) {
    qrStream.getTracks().forEach((t) => t.stop());
    qrStream = null;
  }
  ids("qrVideo").classList.add("hidden-section");
}

async function startQrScan() {
  if (!("BarcodeDetector" in window)) {
    ids("inventoryMessage").textContent = "QR scanner not supported in this browser.";
    return;
  }
  try {
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    ids("qrVideo").srcObject = qrStream;
    ids("qrVideo").classList.remove("hidden-section");
    ids("inventoryMessage").textContent = "Scanning QR code...";

    qrScanInterval = setInterval(async () => {
      try {
        const codes = await detector.detect(ids("qrVideo"));
        if (!codes?.length) return;
        const qr = codes[0].rawValue || "";
        ids("inventoryQrCode").value = qr;
        stopQrScan();
        const item = state.inventory.find((i) => i.qrCode === qr);
        if (item) {
          setInventoryEditMode(item);
          ids("inventoryMessage").textContent = `QR matched: ${item.product}`;
        } else {
          ids("inventoryMessage").textContent = "QR captured. Fill details and save.";
        }
      } catch (_err) {
        // keep scanning
      }
    }, 500);
  } catch (error) {
    stopQrScan();
    ids("inventoryMessage").textContent = error.message;
  }
}

function bindEvents() {
  ids("addSaleForm").addEventListener("submit", addSale);
  ids("returnsForm").addEventListener("submit", processReturn);
  ids("salesFiltersForm").addEventListener("submit", applySalesFilters);
  ids("clearFiltersBtn").addEventListener("click", clearSalesFilters);
  ids("exportCsvBtn").addEventListener("click", exportFilteredSalesCsv);
  ids("inventoryForm").addEventListener("submit", submitInventory);
  ids("inventoryCancelEditBtn").addEventListener("click", () => setInventoryEditMode(null));
  ids("scanQrBtn").addEventListener("click", startQrScan);
  ids("inventoryVariants").addEventListener("input", syncTotalStockFromVariants);
  ids("saleProduct").addEventListener("change", () => {
    renderSaleSizeOptions();
    updateSaleProductStockHint();
  });
  ids("saleSize").addEventListener("change", updateSaleProductStockHint);

  Object.entries(menuMap).forEach(([key, { button }]) => button.addEventListener("click", () => showSection(key)));
}

async function init() {
  if (!supabaseClient) {
    ids("statusMessage").textContent = "Supabase not configured. Update config.js";
    return;
  }
  bindEvents();
  showSection("dashboard");
  try {
    await renderAll();
  } catch (error) {
    ids("statusMessage").textContent = `Data load issue: ${error.message}`;
  }
  setInterval(renderAll, REFRESH_INTERVAL_MS);
}

init();
