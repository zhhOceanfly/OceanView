(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const vscode = window.__oceanViewPost || (() => {
    // app.js 里已建立 bridge，这里复用它的 postMessage
    return null;
  })();
  void vscode;
  const state = {
    view: "client",
    /** 首页固定在 Client 标签里打开，不单独成页 */
    tabs: [{ id: "client", label: "ProtoView Client", closable: false }],
    sheets: [],
    sheetFilter: "",
    activeFile: "",
    activeSheetId: "",
    excelPage: 0,
    excelPageSize: 60,
    excelEditing: false,
    excelPending: new Map(),
    /** Excel 差异对比：当前对比结果与是否打开 */
    excelDiff: null,
    excelDiffOpen: false,
    /** 当前工作簿搜索命中：{ query, items:[{sheetId,sheet,row,col}], index } */
    excelMatch: null,
    /** 表内查找框文案（可与 match.query 同步） */
    excelFindQuery: "",
    excelFindTimer: 0,
    /** 待定位的单元格（防 excelPage 竞态丢 focus） */
    pendingExcelFocus: null,
    docsPage: 0,
    docsPageSize: 60,
    searchTimer: 0,
    searchSeq: 0,
    /** 首页搜索命中的 proto / 函数结果 */
    homeProtoHits: [],
  };

  // ===== 视图切换 =====
  const VIEW_IDS = { home: "homeView", excel: "excelView", docs: "docsClient", db: "dbView", client: "app" };
  const VIEW_LABEL = {
    client: "ProtoView Client",
    excel: "ExcelView Client",
    docs: "DocsView Client",
    db: "DbView Client",
  };

  /** 首页复用 Client 标签：只切内容，不新增标签 */
  function setView(view) {
    state.view = view;
    for (const [key, id] of Object.entries(VIEW_IDS)) {
      const el = $(id);
      if (!el) continue;
      el.classList.toggle("hidden", key !== view);
    }
    document.body.dataset.view = view;
    renderTabs();
    if (gitState.ok && ["excel", "docs", "db"].includes(view)) requestGitChanges();
    if (view === "excel") {
      ensureExcelCatalog();
      updateExcelDiffButton();
    }
    if (view === "docs") window.OceanViewDocs?.ensure?.();
    if (view === "db") window.OceanViewDb?.ensure?.();
    if (view === "home") requestAnimationFrame(() => $("homeSearch")?.focus());
    if (view === "client") window.OceanViewFlow?.ensureClientHome?.();
  }

  /** 入口：已打开就切过去，没有才新建标签 */
  function openTab(id, label) {
    if (id === "home") {
      // 首页永远在当前 Client 标签内显示
      setView("home");
      return;
    }
    if (!state.tabs.some((tab) => tab.id === id)) {
      state.tabs.push({ id, label, closable: true });
    }
    if (id === "excel" || id === "docs" || id === "db") setView(id);
    else setView("client");
    renderTabs();
  }

  function closeTab(id) {
    if (id === "client") return;
    state.tabs = state.tabs.filter((tab) => tab.id !== id);
    if (state.view === id) setView("client");
    renderTabs();
  }

  function renderTabs() {
    const list = $("viewTabList");
    if (!list) return;
    list.innerHTML = state.tabs.map((tab) => `
      <span class="view-tab${tab.id === state.view ? " active" : ""}" data-view-tab="${esc(tab.id)}">
        <button class="view-tab-name" type="button">${esc(tab.label)}</button>
        ${tab.closable ? `<button class="view-tab-close" type="button" data-tab-close="${esc(tab.id)}" title="关闭">✕</button>` : ""}
      </span>`).join("");
  }

  // ===== 宿主通信 =====
  function post(type, payload) {
    const send = window.OceanViewHost?.post;
    if (typeof send === "function") {
      send(type, payload);
      return true;
    }
    return false;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    // 拿到 bootstrap 后才知道工作区是不是 git 项目，这里补一次探测
    if (data.type === "bootstrap") requestGitChanges(true);
    if (data.type === "excelCatalog") applyExcelCatalog(data.payload);
    if (data.type === "excelPage") applyExcelPage(data.payload);
    if (data.type === "excelSearch") applyExcelSearch(data.payload);
    if (data.type === "excelMatches") applyExcelMatches(data.payload);
    if (data.type === "excelUpdate") applyExcelUpdate(data.payload);
    if (data.type === "excelDiff") applyExcelDiff(data.payload);
    if (data.type === "gitChanges") applyGitChanges(data.payload);
  });

  // ===== Git 变更（只看变更） =====
  /** { ok, files: Set<相对仓库根路径> } */
  const gitState = { ok: false, files: new Set(), requested: false };

  function applyGitChanges(payload) {
    gitState.ok = Boolean(payload?.ok);
    gitState.files = new Set(Array.isArray(payload?.files) ? payload.files : []);
    for (const id of ["rpcChangeOnly", "excelChangeOnly", "docsChangeOnly", "dbChangeOnly"]) {
      const box = $(id);
      const label = box?.closest?.(".side-change-only");
      if (label) label.classList.toggle("hidden", !gitState.ok);
      if (!gitState.ok && box) box.checked = false;
    }
    // Excel 差异对比按钮：git 项目且有变更才显示
    updateExcelDiffButton();
    rerenderForChangeFilter();
  }

  function requestGitChanges(force = false) {
    // 没有宿主时无法判断是否是 git 项目，直接跳过
    if (!window.OceanViewHost?.isHost?.() && !window.__oceanViewPost) return;
    if (gitState.requested && !force) return;
    gitState.requested = true;
    post("gitChanges", { force });
  }

  /** 某文件是否在当前变更里（relative 可能是 codeRoot 相对路径） */
  function isChanged(relative) {
    if (!gitState.ok) return false;
    const rel = String(relative || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!rel) return false;
    if (gitState.files.has(rel)) return true;
    // 仓库根比 codeRoot 高时，git 里是带前缀的路径
    for (const file of gitState.files) {
      if (file.endsWith(`/${rel}`)) return true;
    }
    return false;
  }

  function changeOnly(id) {
    const box = $(id);
    return Boolean(gitState.ok && box?.checked);
  }

  function rerenderForChangeFilter() {
    try { window.OceanViewExcel?.rerender?.(); } catch { /* ignore */ }
    try { window.OceanViewDocs?.rerender?.(); } catch { /* ignore */ }
    try { window.OceanViewDb?.rerender?.(); } catch { /* ignore */ }
    try { window.OceanViewClient?.rerenderTree?.(); } catch { /* ignore */ }
  }

  window.OceanViewGit = {
    isChanged,
    changeOnly,
    isGit: () => gitState.ok,
    hasFiles: () => gitState.files.size > 0,
    request: requestGitChanges,
  };

  // ===== Excel =====
  let hasCatalog = false;
  let excelScanTimer = 0;
  /** 仅手动刷新目录时，catalog 回包后重载当前打开的表 */
  let catalogReloadPage = false;

  function ensureExcelCatalog(force = false) {
    if (hasCatalog && !force) return;
    if (force) catalogReloadPage = true;
    const list = $("excelList");
    if (list && !state.sheets.length) list.innerHTML = `<div class="excel-empty">扫描中…</div>`;
    if (!post("excelCatalog", { force })) {
      if (list) list.innerHTML = `<div class="excel-empty">独立模式需要连接宿主才能读取 Excel</div>`;
      return;
    }
    // 扫描迟迟不回来时给出可操作提示，而不是一直停在「扫描中」
    window.clearTimeout(excelScanTimer);
    excelScanTimer = window.setTimeout(() => {
      if (hasCatalog) return;
      const el = $("excelList");
      if (el && !state.sheets.length) {
        el.innerHTML = `<div class="excel-empty">扫描超时：请确认工作区里有 Excel 文件，或点顶部刷新重试</div>`;
      }
    }, 20000);
  }

  function applyExcelCatalog(catalog) {
    hasCatalog = true;
    window.clearTimeout(excelScanTimer);
    state.sheets = Array.isArray(catalog?.sheets) ? catalog.sheets : [];
    renderExcelList();
    // 手动刷新时才重载当前页；搜索定位打开时不要用不带 focus 的 page 盖掉高亮
    if (
      catalogReloadPage
      && state.activeSheetId
      && state.sheets.some((sheet) => sheet.id === state.activeSheetId)
    ) {
      post("excelPage", { id: state.activeSheetId });
    }
    catalogReloadPage = false;
    if (catalog?.warnings?.length) {
      // 只在有问题时提示，不打断使用
      console.warn("[OceanView] excel warnings:", catalog.warnings.slice(0, 5));
    }
  }

  function fileKey(sheet) {
    return sheet?.relative || sheet?.file || "";
  }

  function sheetsOfFile(relative) {
    return state.sheets.filter((sheet) => fileKey(sheet) === relative);
  }

  function renderExcelList() {
    const list = $("excelList");
    if (!list) return;
    const q = state.sheetFilter.trim().toLowerCase();
    const groups = new Map();
    for (const sheet of state.sheets) {
      const key = fileKey(sheet);
      const bucket = groups.get(key) || [];
      bucket.push(sheet);
      groups.set(key, bucket);
    }
    const files = [...groups.entries()].filter(([file, sheets]) => {
      if (changeOnly("excelChangeOnly") && !window.OceanViewGit?.isChanged?.(file)) return false;
      if (!q) return true;
      const blob = `${file} ${sheets.map((sheet) => `${sheet.fileName} ${sheet.sheet}`).join(" ")}`.toLowerCase();
      return blob.includes(q);
    });
    if (!files.length) {
      const empty = changeOnly("excelChangeOnly")
        ? "当前变更里没有 Excel 表"
        : (state.sheets.length ? "没有匹配的表" : "未找到 Excel 文件");
      list.innerHTML = `<div class="excel-empty">${empty}</div>`;
      window.OceanViewPager?.renderPager?.($("excelPager"), { page: 0, pages: 1, total: 0 }, () => {});
      return;
    }
    const pager = window.OceanViewPager || { paginate: (items) => ({ slice: items, page: 0, pages: 1, total: items.length }), renderPager: () => {} };
    const result = pager.paginate(files, state.excelPage || 0, state.excelPageSize || 60);
    state.excelPage = result.page;
    list.innerHTML = result.slice.map(([file, sheets]) => {
      const name = sheets[0]?.fileName || file.split("/").pop() || file;
      const rows = sheets.reduce((sum, sheet) => sum + Number(sheet.dataCount || 0), 0);
      return `
      <button class="excel-item${file === state.activeFile ? " active" : ""}" type="button" data-excel-file="${esc(file)}" title="${esc(file)}">
        <span class="excel-item-name">${esc(name)}</span>
        <span class="excel-item-meta">${sheets.length} 个 Sheet · ${rows} 行</span>
      </button>`;
    }).join("");
    pager.renderPager($("excelPager"), result, (page) => {
      state.excelPage = page;
      renderExcelList();
    });
  }

  function renderSheetTabs() {
    const bar = $("excelSheets");
    if (!bar) return;
    const sheets = sheetsOfFile(state.activeFile);
    const match = state.excelMatch;
    const findQuery = state.excelFindQuery || match?.query || "";
    const prevInput = bar.querySelector("#excelFindInput");
    const keepFocus = document.activeElement === prevInput;
    const selStart = prevInput?.selectionStart ?? findQuery.length;
    const selEnd = prevInput?.selectionEnd ?? findQuery.length;
    const countBySheet = new Map();
    for (const item of match?.items || []) {
      countBySheet.set(item.sheetId, (countBySheet.get(item.sheetId) || 0) + 1);
    }
    const tabs = sheets.map((sheet) => {
      const n = countBySheet.get(sheet.id) || 0;
      const badge = n ? `<span class="excel-sheet-match">${n}</span>` : "";
      return `<button class="excel-sheet-tab${sheet.id === state.activeSheetId ? " active" : ""}" type="button" data-sheet-id="${esc(encodeURIComponent(sheet.id))}" title="${esc(sheet.sheet)}${n ? ` · ${n} 处匹配` : ""}">${esc(sheet.sheet)}${badge}</button>`;
    }).join("");
    const total = match?.items?.length || 0;
    const hasMatches = total > 0;
    const countText = hasMatches
      ? `${Math.min((match.index || 0) + 1, total)} / ${total}`
      : "0 / 0";
    // 有打开的表时始终显示查找框；清空输入即可去掉角标与导航计数
    const nav = sheets.length
      ? `<div class="excel-match-nav" title="在当前 Excel 文件中查找（可跨 Sheet）">
          <input id="excelFindInput" class="excel-find-input" type="search" placeholder="查找… Ctrl+F"
            value="${esc(findQuery)}" autocomplete="off" spellcheck="false" />
          <button type="button" class="icon-btn" data-excel-find-clear title="清空查找">✕</button>
          <button type="button" class="icon-btn" data-excel-match-step="-1" title="上一处" ${hasMatches ? "" : "disabled"}>▲</button>
          <span class="excel-match-count">${countText}</span>
          <button type="button" class="icon-btn" data-excel-match-step="1" title="下一处" ${hasMatches ? "" : "disabled"}>▼</button>
        </div>`
      : "";
    bar.innerHTML = `<div class="excel-sheet-tabs">${tabs}</div>${nav}`;
    bar.querySelector(".excel-sheet-tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    const input = bar.querySelector("#excelFindInput");
    if (input && keepFocus) {
      input.focus();
      try { input.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
    }
  }

  function clearExcelMatches(options = {}) {
    const keepQuery = Boolean(options.keepQuery);
    state.excelMatch = null;
    if (!keepQuery) state.excelFindQuery = "";
    renderSheetTabs();
    if (state.page) {
      applyExcelPage({ ...state.page, focusRow: 0, focusCol: -1 });
    }
  }

  function applyExcelMatches(payload) {
    const items = Array.isArray(payload?.matches) ? payload.matches : [];
    const query = String(payload?.query || "");
    state.excelFindQuery = query;
    if (!items.length) {
      state.excelMatch = null;
      renderSheetTabs();
      if (state.page) applyExcelPage({ ...state.page, focusRow: 0, focusCol: -1 });
      return;
    }
    const focusRow = Number(state.page?.focusRow || 0);
    const focusCol = Number(state.page?.focusCol);
    let index = items.findIndex((item) =>
      item.sheetId === state.activeSheetId
      && Number(item.row) === focusRow
      && (Number.isFinite(focusCol) && focusCol >= 0 ? Number(item.col) === focusCol : true),
    );
    if (index < 0) {
      index = items.findIndex((item) => item.sheetId === state.activeSheetId && Number(item.row) === focusRow);
    }
    if (index < 0) index = 0;
    state.excelMatch = { query, items, index };
    renderSheetTabs();
    focusExcelHit(items[index]);
  }

  function loadExcelMatches(query, sheetId) {
    const q = String(query || "").trim();
    state.excelFindQuery = q;
    if (!q || !sheetId) {
      clearExcelMatches({ keepQuery: Boolean(q) });
      return;
    }
    post("excelMatches", { query: q, sheetId });
  }

  function scheduleExcelFind(query) {
    state.excelFindQuery = String(query || "");
    window.clearTimeout(state.excelFindTimer);
    state.excelFindTimer = window.setTimeout(() => {
      const q = String(state.excelFindQuery || "").trim();
      if (!q) {
        clearExcelMatches();
        return;
      }
      const sheetId = state.activeSheetId || sheetsOfFile(state.activeFile)[0]?.id;
      if (!sheetId) return;
      loadExcelMatches(q, sheetId);
    }, 220);
  }

  /** 上下箭头：在同文件全部命中间跳转，必要时自动切 Sheet */
  function stepExcelMatch(delta) {
    const match = state.excelMatch;
    if (!match?.items?.length) return;
    const total = match.items.length;
    const next = (match.index + Number(delta || 0) + total) % total;
    match.index = next;
    renderSheetTabs();
    focusExcelHit(match.items[next]);
  }

  function focusExcelFind(selectAll = true) {
    if (state.view !== "excel") {
      openTab("excel", VIEW_LABEL.excel);
      setView("excel");
    }
    renderSheetTabs();
    const input = $("excelFindInput");
    if (!input) return;
    input.focus();
    if (selectAll) input.select();
  }

  /** Excel 差异对比：当前文件 vs git HEAD，左右两栏按行对齐 */
  function applyExcelDiff(payload) {
    const view = $("excelDiffView");
    const wrap = $("excelDiffWrap");
    if (!view || !wrap) return;
    state.excelDiff = payload || null;
    if (!payload?.ok) {
      view.classList.add("hidden");
      window.OceanViewClient?.notify?.(payload?.error || "无法对比该表");
      return;
    }
    renderExcelDiff();
  }

  function renderExcelDiff() {
    const view = $("excelDiffView");
    const wrap = $("excelDiffWrap");
    const payload = state.excelDiff;
    if (!view || !wrap || !payload?.ok) return;
    const onlyDiff = $("excelDiffOnly")?.checked !== false;
    const rows = (payload.rows || []).filter((row) => !onlyDiff || row.type !== "same");
    const title = $("excelDiffTitle");
    if (title) title.textContent = `${payload.sheet || "Sheet"} · 差异对比`;
    const meta = $("excelDiffMeta");
    if (meta) meta.textContent = `${payload.relative || ""} · ${payload.changedRows || 0} 行有差异`;
    view.classList.remove("hidden");
    $("excelSheets")?.classList.add("hidden");
    $("excelTableWrap")?.classList.add("hidden");
    const width = Math.max(
      ...(payload.current || []).map((row) => (row || []).length),
      ...(payload.base || []).map((row) => (row || []).length),
      ...(rows || []).flatMap((row) => [(row.left || []).length, (row.right || []).length]),
      1,
    );
    const head = `<tr><th class="excel-rowno">#</th>${Array.from({ length: width }, (_, i) => `<th>${columnLetter(i)}</th>`).join("")}</tr>`;
    const cell = (row, index) => esc((row || [])[index] ?? "");
    // 只给真正变化的单元格上色：行背景保持中性，靠 td 高亮定位到具体列
    const changedSet = (row, side) => {
      const out = new Map();
      for (const item of row.cells || []) {
        // add = 右侧新增（左侧没有），del = 左侧有、右侧没有
        const hit = side === "left"
          ? (item.type === "add" ? false : true)
          : (item.type === "del" ? false : true);
        if (hit) out.set(item.index, item.type);
      }
      return out;
    };
    const line = (row, side) => {
      const value = side === "left" ? row.left : row.right;
      const changed = changedSet(row, side);
      const cells = Array.from({ length: width }, (_, i) => {
        const type = changed.get(i);
        if (!type) return `<td>${cell(value, i)}</td>`;
        const cls = type === "add" ? "is-cell-add" : type === "del" ? "is-cell-del" : "is-cell-change";
        return `<td class="${cls}">${cell(value, i)}</td>`;
      }).join("");
      return `<tr class="excel-diff-row"><td class="excel-rowno">${row.index}</td>${cells}</tr>`;
    };
    wrap.innerHTML = `
      <div class="excel-diff-col">
        <div class="excel-diff-head">git 版本</div>
        <div class="excel-diff-body"><table class="excel-table"><thead>${head}</thead><tbody>${rows.map((row) => line(row, "left")).join("") || `<tr><td class="excel-empty">没有差异</td></tr>`}</tbody></table></div>
      </div>
      <div class="excel-diff-col">
        <div class="excel-diff-head">当前文件</div>
        <div class="excel-diff-body"><table class="excel-table"><thead>${head}</thead><tbody>${rows.map((row) => line(row, "right")).join("") || `<tr><td class="excel-empty">没有差异</td></tr>`}</tbody></table></div>
      </div>`;
  }

  function columnLetter(index) {
    let n = Number(index) || 0;
    let out = "";
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  function toggleExcelDiff(show) {
    state.excelDiffOpen = Boolean(show);
    const view = $("excelDiffView");
    if (!show) {
      view?.classList.add("hidden");
      $("excelSheets")?.classList.remove("hidden");
      $("excelTableWrap")?.classList.remove("hidden");
      return;
    }
    const id = state.activeSheetId;
    if (!id) return;
    post("excelDiff", { id });
  }

  function updateExcelDiffButton() {
    const btn = $("excelDiffBtn");
    if (!btn) return;
    // 只在「该 Sheet 对应的文件确实有 git 变更」时显示
    const relative = state.sheets.find((sheet) => sheet.id === state.activeSheetId)?.relative
      || state.activeFile
      || "";
    const changed = Boolean(relative) && Boolean(window.OceanViewGit?.isChanged?.(relative));
    btn.classList.toggle("hidden", !changed);
  }

  function selectFile(relative) {
    if (!relative) return;
    const sheets = sheetsOfFile(relative);
    if (!sheets.length) return;
    // 侧栏换文件时清掉上一份文件的匹配导航
    if (relative !== state.activeFile) clearExcelMatches();
    const current = sheets.find((sheet) => sheet.id === state.activeSheetId);
    selectSheet((current || sheets[0]).id);
  }

  function selectSheet(id, focusRow = 0, focusCol = -1) {
    if (!id) return;
    const sheet = state.sheets.find((item) => item.id === id);
    if (!sheet) return;
    const nextFile = fileKey(sheet);
    if (state.excelMatch && state.activeFile && nextFile !== state.activeFile) {
      clearExcelMatches();
    }
    state.activeFile = nextFile;
    state.activeSheetId = id;
    const row = Number(focusRow) || 0;
    const col = Number.isFinite(Number(focusCol)) ? Number(focusCol) : -1;
    state.pendingExcelFocus = row > 0 ? { sheetId: id, row, col } : null;
    if (state.excelDiffOpen) state.excelDiffOpen = false;
    $("excelDiffView")?.classList.add("hidden");
    $("excelSheets")?.classList.remove("hidden");
    $("excelTableWrap")?.classList.remove("hidden");
    updateExcelDiffButton();
    renderExcelList();
    renderSheetTabs();
    const title = $("excelTitle");
    if (title) title.textContent = sheet.fileName || sheet.sheet;
    const meta = $("excelMeta");
    if (meta) meta.textContent = sheet.relative;
    post("excelPage", { id, focusRow: row, focusCol: col });
  }

  function clampScroll(value, max) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(value, Math.max(0, max)));
  }

  /** 找到真正产生滚动条的祖先（ExcelView 里偶发不是 #excelTableWrap 本身） */
  function scrollParentsOf(node) {
    const out = [];
    let el = node;
    while (el && el !== document.body) {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        const ox = style.overflowX;
        const oy = style.overflowY;
        const canX = (ox === "auto" || ox === "scroll" || ox === "overlay") && el.scrollWidth > el.clientWidth + 1;
        const canY = (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 1;
        if (canX || canY || el.id === "excelTableWrap") out.push(el);
      }
      el = el.parentElement;
    }
    return out;
  }

  function cellIsVisibleIn(scroller, cell, headH = 0) {
    const box = scroller.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    return rect.top >= box.top + headH - 2
      && rect.bottom <= box.bottom + 2
      && rect.left >= box.left - 2
      && rect.right <= box.right + 2;
  }

  /**
   * 按单元格几何位置把滚动条拨到能看见它的位置。
   * 1) 累加行高/列宽写 #excelTableWrap
   * 2) 对所有可滚动祖先按 getBoundingClientRect 差值微调
   * 3) 仍不可见则 scrollIntoView（与直接打开 Excel 的兜底一致）
   */
  function scrollExcelTarget(wrap, attempts = 0) {
    if (!wrap) return;
    const focusRow = Number(state.page?.focusRow || state.pendingExcelFocus?.row || 0);
    const focusCol = Number(state.page?.focusCol ?? state.pendingExcelFocus?.col);
    let cell = null;
    if (focusRow > 0 && Number.isFinite(focusCol) && focusCol >= 0) {
      cell = wrap.querySelector(`td.excel-cell[data-row="${focusRow}"][data-col="${focusCol}"]`);
    }
    if (!cell && focusRow > 0) {
      cell = wrap.querySelector(`td.excel-cell[data-row="${focusRow}"]`);
    }
    if (!cell) {
      cell = wrap.querySelector("td.excel-cell.is-target-cell")
        || wrap.querySelector("tr.excel-row.is-target td.excel-cell")
        || wrap.querySelector("tr.excel-row.is-target");
    }
    if (!cell) {
      if (attempts < 30) window.setTimeout(() => scrollExcelTarget(wrap, attempts + 1), 40);
      return;
    }
    const row = cell.closest("tr");
    const table = cell.closest("table") || wrap.querySelector("table");
    if (!row || !table) return;
    if (wrap.clientHeight < 32 || table.offsetHeight < 32) {
      if (attempts < 30) window.setTimeout(() => scrollExcelTarget(wrap, attempts + 1), 40);
      return;
    }

    const headH = table.tHead?.offsetHeight || 0;
    const tbody = table.tBodies?.[0];
    let y = headH;
    if (tbody) {
      for (const tr of tbody.rows) {
        if (tr === row) break;
        y += tr.offsetHeight || 0;
      }
    }
    let x = 0;
    if (cell.tagName === "TD") {
      for (const td of row.cells) {
        if (td === cell) break;
        x += td.offsetWidth || 0;
      }
    }

    const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const viewH = Math.max(1, wrap.clientHeight - headH);
    const viewW = Math.max(1, wrap.clientWidth);
    // 目标：格子大约出现在可视区 25%~35% 处
    wrap.scrollTop = clampScroll(y - headH - viewH * 0.3, maxTop);
    wrap.scrollLeft = clampScroll(x - viewW * 0.3, maxLeft);

    for (const scroller of scrollParentsOf(cell)) {
      const box = scroller.getBoundingClientRect();
      const rect = cell.getBoundingClientRect();
      const padTop = scroller === wrap || scroller.id === "excelTableWrap" ? headH : 0;
      const scrollerViewH = Math.max(1, scroller.clientHeight - padTop);
      const scrollerViewW = Math.max(1, scroller.clientWidth);
      if (!cellIsVisibleIn(scroller, cell, padTop)) {
        scroller.scrollTop = clampScroll(
          scroller.scrollTop + (rect.top - box.top) - padTop - scrollerViewH * 0.3,
          scroller.scrollHeight - scroller.clientHeight,
        );
        scroller.scrollLeft = clampScroll(
          scroller.scrollLeft + (rect.left - box.left) - scrollerViewW * 0.3,
          scroller.scrollWidth - scroller.clientWidth,
        );
      }
    }

    if (!cellIsVisibleIn(wrap, cell, headH)) {
      try {
        cell.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      } catch {
        try { cell.scrollIntoView(true); } catch { /* ignore */ }
      }
    }

    if (!cellIsVisibleIn(wrap, cell, headH) && attempts < 20) {
      window.setTimeout(() => scrollExcelTarget(wrap, attempts + 1), 50);
    }
  }

  function revealExcelTarget(wrap) {
    if (!wrap) return;
    const run = () => scrollExcelTarget(wrap, 0);
    void wrap.offsetHeight;
    run();
    requestAnimationFrame(() => {
      void wrap.offsetHeight;
      requestAnimationFrame(run);
    });
    window.setTimeout(run, 40);
    window.setTimeout(run, 120);
    window.setTimeout(run, 280);
    window.setTimeout(run, 500);
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => run());
      ro.observe(wrap);
      const table = wrap.querySelector("table");
      if (table) ro.observe(table);
      window.setTimeout(() => ro.disconnect(), 1200);
    }
  }

  /** 当前页已包含目标行时本地高亮+滚动，避免无意义的 excelPage 往返把定位冲掉 */
  function pageContainsRow(page, row) {
    const target = Number(row);
    return Boolean(page?.rows?.some((item) => Number(item.row) === target));
  }

  function focusExcelHit(hit) {
    if (!hit?.sheetId) return;
    const row = Number(hit.row) || 0;
    const col = Number.isFinite(Number(hit.col)) ? Number(hit.col) : -1;
    state.pendingExcelFocus = { sheetId: hit.sheetId, row, col };
    const page = state.page;
    if (page && page.id === hit.sheetId && row > 0 && pageContainsRow(page, row)) {
      applyExcelPage({ ...page, focusRow: row, focusCol: col });
      return;
    }
    selectSheet(hit.sheetId, row, col);
  }

  function applyExcelPage(page) {
    const wrap = $("excelTableWrap");
    if (!wrap) return;
    if (!page) {
      wrap.innerHTML = `<div class="excel-empty">表读取失败或已被移动</div>`;
      return;
    }
    // 若宿主回包装丢了 focus，用 pending 补上（竞态时常见）
    const pending = state.pendingExcelFocus;
    if (pending && pending.sheetId === page.id) {
      if (!(Number(page.focusRow) > 0) && pending.row > 0) {
        page = { ...page, focusRow: pending.row, focusCol: pending.col };
      }
    }
    state.page = page;
    const focusRow = Number(page.focusRow) || 0;
    const focusCol = Number(page.focusCol);
    const matchItems = state.excelMatch?.items || [];
    const head = `<tr><th class="excel-rowno">#</th>${page.columns
      .map((col) => `<th title="列 ${esc(col.letter)}">${esc(col.name)}</th>`)
      .join("")}</tr>`;
    const body = page.rows.map((row) => {
      const rowNo = Number(row.row);
      const target = focusRow > 0 && rowNo === focusRow ? " is-target" : "";
      return `<tr class="excel-row${target}" data-excel-row="${rowNo}"><td class="excel-rowno">${rowNo}</td>${page.columns
        .map((_, index) => {
          const value = row.cells[index] ?? "";
          const editable = state.excelEditing && !/\.xls$/i.test(page.relative || "");
          const isFocusCell = Boolean(target)
            && Number.isFinite(focusCol)
            && focusCol >= 0
            && index === focusCol;
          const isMatchCell = matchItems.some((item) =>
            item.sheetId === page.id
            && Number(item.row) === rowNo
            && Number(item.col) === index,
          );
          const cellCls = [
            "excel-cell",
            isFocusCell ? "is-target-cell" : "",
            isMatchCell && !isFocusCell ? "is-match-cell" : "",
          ].filter(Boolean).join(" ");
          return `<td class="${cellCls}" ${editable ? 'contenteditable="true"' : ""} spellcheck="false"
            data-row="${rowNo}" data-col="${index}">${esc(value)}</td>`;
        })
        .join("")}</tr>`;
    }).join("");
    wrap.innerHTML = `<table class="excel-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    applyExcelEditability();
    syncExcelSave();
    const meta = $("excelMeta");
    if (meta) {
      const from = page.offset + 1;
      const to = page.offset + page.rows.length;
      meta.textContent = `${page.relative} · 第 ${from}-${to} 行 / 共 ${page.total} 行${page.truncated ? "（已截断）" : ""}`;
    }
    if (focusRow > 0) {
      wrap.scrollTop = 0;
      wrap.scrollLeft = 0;
      revealExcelTarget(wrap);
    }
  }

  /** 单元格编辑：失焦或回车时先记到本地，Ctrl+S / 保存按钮再落盘 */
  function commitExcelCell(cell) {
    const page = state.page;
    if (!state.excelEditing || !cell || !page) return;
    const row = Number(cell.getAttribute("data-row"));
    const col = Number(cell.getAttribute("data-col"));
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const value = cell.textContent ?? "";
    const original = page.rows.find((item) => item.row === row)?.cells[col] ?? "";
    const key = `${row}:${col}`;
    if (value === original && !state.excelPending.has(key)) return;
    if (value === original) state.excelPending.delete(key);
    else state.excelPending.set(key, { row, col, value });
    syncExcelSave();
  }

  function applyExcelEditability() {
    const editable = state.excelEditing;
    for (const cell of document.querySelectorAll("#excelTableWrap .excel-cell")) {
      if (editable) cell.setAttribute("contenteditable", "true");
      else cell.removeAttribute("contenteditable");
    }
  }

  function syncExcelSave() {
    const btn = $("excelSave");
    if (!btn) return;
    const dirty = state.excelPending.size > 0;
    btn.classList.toggle("hidden", !state.excelEditing);
    btn.disabled = !dirty;
    btn.textContent = dirty ? `保存 (${state.excelPending.size})` : "保存";
    btn.title = dirty ? "保存修改（Ctrl+S）" : "没有需要保存的修改";
  }

  function saveExcel() {
    const page = state.page;
    if (!state.excelEditing || !page) return;
    if (!state.excelPending.size) {
      setExcelStatus("没有需要保存的修改");
      return;
    }
    const edits = [...state.excelPending.values()].sort((a, b) => a.row - b.row || a.col - b.col);
    state.excelPending.clear();
    syncExcelSave();
    setExcelStatus(`保存中 · ${edits.length} 处…`);
    for (const edit of edits) {
      post("excelUpdate", { id: page.id, row: edit.row, col: edit.col, value: edit.value });
      const target = page.rows.find((item) => item.row === edit.row);
      if (target) target.cells[edit.col] = edit.value;
    }
  }

  function setExcelStatus(text, isError = false) {
    const meta = $("excelMeta");
    if (!meta) return;
    meta.textContent = text;
    meta.classList.toggle("is-error", isError);
  }

  function applyExcelUpdate(result) {
    if (!result) return;
    if (!result.ok) {
      setExcelStatus(`保存失败：${result.error || "未知错误"}`, true);
      return;
    }
    if (result.page) {
      const keepFocus = document.activeElement;
      applyExcelPage(result.page);
      void keepFocus;
    }
    setExcelStatus(`已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
  }

  function applyExcelSearch(payload) {
    // 兼容旧回包（纯数组）和新回包（{ requestId, hits }）
    const list = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.hits) ? payload.hits : []);
    const requestId = Array.isArray(payload) ? NaN : Number(payload?.requestId);
    const hasRequestId = Number.isFinite(requestId);
    // 按 requestId 对齐，避免首次建索引时旧回包冲掉新查询 / 首页与 Tab 互抢
    if (pendingSearch && (!hasRequestId || pendingSearch.seq === requestId)) {
      const cb = pendingSearch.cb;
      pendingSearch = null;
      try { cb(list); } catch { /* ignore */ }
    }
    if (pendingHomeExcel && (!hasRequestId || pendingHomeExcel.seq === requestId)) {
      pendingHomeExcel = null;
      state.homeExcelHits = list;
      renderHomeHits(state.homeProtoHits, list);
    }
  }

  // ===== 首页搜索（复用 Tab 全局搜索的全类型数据源） =====
  const HOME_KIND_LABEL = { rpc: "接口", enum: "枚举", func: "函数", const: "常量", excel: "Excel", docs: "文档", db: "数据表" };

  /** 从 app.js 的全局搜索数据源取 proto / 代码符号，命中后转成首页条目 */
  function collectProtoAndCodeHits(query) {
    const api = window.OceanViewSearch;
    if (!api) return [];
    let items = [];
    try {
      items = api.searchAll ? api.searchAll(query) : [];
    } catch {
      items = [];
    }
    return items;
  }

  function runHomeSearch() {
    const input = $("homeSearch");
    const query = String(input?.value || "").trim();
    const box = $("homeResults");
    if (!box) return;
    if (!query) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = `<div class="home-result-empty">搜索中…</div>`;

    const protoHits = collectProtoAndCodeHits(query);
    state.homeProtoHits = protoHits;
    // 先渲染本地命中的 proto / 函数，Excel 结果回来了再追加
    if (protoHits.length) renderHomeHits(protoHits);

    state.homeDocsHits = [];
    state.homeDbHits = [];
    const seq = ++state.searchSeq;
    clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      if (seq !== state.searchSeq) return;
      const searchId = ++excelSearchSeq;
      pendingHomeExcel = { seq: searchId };
      if (!post("excelSearch", { query, requestId: searchId })) {
        pendingHomeExcel = null;
        if (!state.homeProtoHits.length) {
          renderHomeHits(state.homeProtoHits, []);
        }
      }
      window.OceanViewDocs?.search?.(query, (hits) => {
        if (seq !== state.searchSeq) return;
        state.homeDocsHits = Array.isArray(hits) ? hits : [];
        renderHomeHits(state.homeProtoHits, state.homeExcelHits);
      });
      window.OceanViewDb?.search?.(query, (hits) => {
        if (seq !== state.searchSeq) return;
        state.homeDbHits = Array.isArray(hits) ? hits : [];
        renderHomeHits(state.homeProtoHits, state.homeExcelHits);
      });
    }, 180);
  }

  function homeHitHtml(item, kindKey) {
    const kind = HOME_KIND_LABEL[item.kind] || "结果";
    const row = Number(item.row || 0);
    const meta = item.kind === "excel"
      ? `${esc(item.sub || "")}${row ? ` · 行 ${row}` : ""}`
      : esc(item.sub || "");
    return `<button class="home-result" type="button" data-home-hit="${kindKey}" data-home-idx="${Number(item._idx) || 0}">
      <span class="home-result-kind is-${esc(item.kind || "excel")}">${kind}</span>
      <span class="home-result-main">
        <strong>${esc(item.title || "")}</strong>
        <span>${meta}</span>
      </span>
      ${item.preview ? `<span class="home-result-sub">${esc(item.preview)}</span>` : ""}
    </button>`;
  }

  function renderHomeHits(protoHits, excelHits) {
    const box = $("homeResults");
    if (!box) return;
    const proto = Array.isArray(protoHits) ? protoHits : state.homeProtoHits;
    const excel = Array.isArray(excelHits) ? excelHits : [];
    const docs = state.homeDocsHits || [];
    const db = state.homeDbHits || [];
    if (!proto.length && !excel.length && !docs.length && !db.length) {
      box.innerHTML = `<div class="home-result-empty">没有匹配的结果</div>`;
      box.classList.remove("hidden");
      return;
    }
    const protoHtml = proto
      .map((item, index) => homeHitHtml({ ...item, _idx: index }, "proto"))
      .join("");
    const excelHtml = excel.map((hit, index) => {
      const count = Number(hit.count || 0);
      const fileName = hit.fileName || String(hit.relative || "").split("/").pop() || hit.sheet;
      return homeHitHtml({
        kind: "excel",
        title: fileName,
        sub: `${hit.sheet || ""}${count ? ` · ${count} 处` : " · 打开表"}`,
        row: hit.row,
        preview: hit.preview,
        sheetId: hit.sheetId,
        _idx: index,
      }, "excel");
    }).join("");
    const docsHtml = docs.map((hit, index) => homeHitHtml({
      kind: "docs",
      title: hit.title || hit.fileName,
      sub: `${hit.relative || ""}${hit.count ? ` · ${hit.count} 处` : ""}`,
      preview: hit.preview,
      _idx: index,
    }, "docs")).join("");
    const dbHtml = db.map((hit, index) => homeHitHtml({
      kind: "db",
      title: hit.table || hit.fileName,
      sub: `${hit.fileName || ""}${hit.count ? ` · ${hit.count} 处` : ""}`,
      preview: hit.preview,
      _idx: index,
    }, "db")).join("");
    box.innerHTML = `${protoHtml}${excelHtml}${docsHtml}${dbHtml}`;
    box.classList.remove("hidden");
    state.homeExcelHits = excel;
  }

  /** 首页点击 proto 结果：接口/枚举定位左侧定义，函数/常量跳源码 */
  function openProtoHit(item) {
    setView("client");
    const api = window.OceanViewSearch;
    try {
      api?.openItem?.(item);
    } catch {
      // 忽略：宿主不支持时保持静默
    }
  }

  /** 打开 Excel 表：已开则复用标签；query 有值时拉取本文件全部单元格命中供上下跳转 */
  function openExcelSheet(sheetId, row = 0, col = -1, query = "") {
    if (!sheetId) return;
    openTab("excel", VIEW_LABEL.excel);
    setView("excel");
    ensureExcelCatalog();
    const q = String(query || "").trim();
    state.excelFindQuery = q;
    const trySelect = (attempt = 0) => {
      if (state.sheets.some((item) => item.id === sheetId)) {
        selectSheet(sheetId, row, col);
        if (q) loadExcelMatches(q, sheetId);
        else clearExcelMatches();
        return;
      }
      if (attempt < 30) window.setTimeout(() => trySelect(attempt + 1), 100);
    };
    trySelect();
  }

  // ===== 事件绑定 =====
  function bind() {
    $("homeBtn")?.addEventListener("click", () => {
      // 首页不新开标签：在当前标签内切换
      if (state.view === "home") setView("client");
      else setView("home");
    });

    $("viewTabList")?.addEventListener("click", (event) => {
      const close = event.target.closest("[data-tab-close]");
      if (close) {
        event.stopPropagation();
        closeTab(close.getAttribute("data-tab-close"));
        return;
      }
      const tab = event.target.closest("[data-view-tab]");
      if (!tab) return;
      const id = tab.getAttribute("data-view-tab");
      if (id === "home") setView("home");
      else if (id === "excel" || id === "docs" || id === "db") setView(id);
      else setView("client");
    });

    $("homeGrid")?.addEventListener("click", (event) => {
      const card = event.target.closest("[data-home-entry]");
      if (!card) return;
      const entry = card.getAttribute("data-home-entry");
      if (entry === "client") setView("client");
      else if (VIEW_LABEL[entry]) openTab(entry, VIEW_LABEL[entry]);
    });

    $("homeSearch")?.addEventListener("input", runHomeSearch);
    $("homeSearch")?.addEventListener("focus", () => {
      if (String($("homeSearch")?.value || "").trim()) runHomeSearch();
    });
    $("homeSearch")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const box = $("homeResults");
        box?.classList.add("hidden");
        $("homeSearch").value = "";
      }
    });
    document.addEventListener("pointerdown", (event) => {
      const box = $("homeResults");
      if (!box || box.classList.contains("hidden")) return;
      const target = event.target;
      if (target instanceof Node && ($("homeSearch")?.contains(target) || box.contains(target))) return;
      box.classList.add("hidden");
    });

    $("homeResults")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-home-hit]");
      if (!btn) return;
      const index = Number(btn.getAttribute("data-home-idx") || 0);
      const kind = btn.getAttribute("data-home-hit");
      if (kind === "excel") {
        const hit = state.homeExcelHits[index] || null;
        if (!hit) return;
        const query = String($("homeSearch")?.value || "").trim();
        openExcelSheet(
          hit.sheetId,
          Number(hit.row) || 0,
          Number.isFinite(Number(hit.col)) ? Number(hit.col) : -1,
          query,
        );
        return;
      }
      if (kind === "docs") {
        const hit = state.homeDocsHits[index];
        if (hit) window.OceanViewDocs?.open?.(hit.id, hit.line || 1);
        return;
      }
      if (kind === "db") {
        const hit = state.homeDbHits[index];
        if (hit) window.OceanViewDb?.openTable?.(hit.id);
        return;
      }
      const item = state.homeProtoHits[index];
      if (!item) return;
      openProtoHit(item);
    });

    function paintExcelMode() {
      for (const btn of document.querySelectorAll("[data-excel-mode]")) {        btn.classList.toggle("active", (btn.getAttribute("data-excel-mode") === "edit") === state.excelEditing);
      }
      if (!state.excelEditing) state.excelPending.clear();
      syncExcelSave();
    }
    $("excelMode")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-excel-mode]");
      if (!btn) return;
      const next = btn.getAttribute("data-excel-mode") === "edit";
      if (!next && state.excelPending.size && !window.confirm(`还有 ${state.excelPending.size} 处未保存的修改，切回阅读会丢弃，继续？`)) return;
      state.excelEditing = next;
      paintExcelMode();
      applyExcelEditability();
      if (!next) {
        const wrap = $("excelTableWrap");
        if (wrap) {
          for (const cell of wrap.querySelectorAll(".excel-cell")) {
            const page = state.page;
            if (!page) break;
            const row = Number(cell.getAttribute("data-row"));
            const col = Number(cell.getAttribute("data-col"));
            const original = page.rows.find((item) => item.row === row)?.cells[col] ?? "";
            cell.textContent = original;
          }
        }
      }
    });
    $("excelSave")?.addEventListener("click", saveExcel);
    document.addEventListener("keydown", (event) => {
      if (!state.excelEditing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (!document.getElementById("excelView")?.classList.contains("hidden")) {
          event.preventDefault();
          saveExcel();
        }
      }
    });
    paintExcelMode();

    $("excelFilter")?.addEventListener("input", () => {
      state.sheetFilter = $("excelFilter").value || "";
      state.excelPage = 0;
      renderExcelList();
    });

    $("excelChangeOnly")?.addEventListener("change", () => {
      state.excelPage = 0;
      renderExcelList();
    });
    $("excelDiffBtn")?.addEventListener("click", () => toggleExcelDiff(!state.excelDiffOpen));
    $("excelDiffClose")?.addEventListener("click", () => toggleExcelDiff(false));
    $("excelDiffOnly")?.addEventListener("change", renderExcelDiff);

    $("excelList")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-excel-file]");
      if (!item) return;
      selectFile(item.getAttribute("data-excel-file"));
    });
    $("excelSheets")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-excel-find-clear]")) {
        event.preventDefault();
        window.clearTimeout(state.excelFindTimer);
        clearExcelMatches();
        $("excelFindInput")?.focus();
        return;
      }
      const step = event.target.closest("[data-excel-match-step]");
      if (step) {
        event.preventDefault();
        if (step.disabled) return;
        stepExcelMatch(Number(step.getAttribute("data-excel-match-step") || 0));
        return;
      }
      const item = event.target.closest("[data-sheet-id]");
      if (!item) return;
      const raw = item.getAttribute("data-sheet-id") || "";
      let id = raw;
      try { id = decodeURIComponent(raw); } catch { id = raw; }
      selectSheet(id);
    });
    $("excelSheets")?.addEventListener("input", (event) => {
      const input = event.target.closest?.("#excelFindInput");
      if (!input) return;
      scheduleExcelFind(input.value);
    });
    $("excelSheets")?.addEventListener("keydown", (event) => {
      const input = event.target.closest?.("#excelFindInput");
      if (!input) return;
      if (event.key === "Escape") {
        event.preventDefault();
        window.clearTimeout(state.excelFindTimer);
        clearExcelMatches();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(state.excelFindTimer);
        const q = String(input.value || "").trim();
        state.excelFindQuery = q;
        if (!q) {
          clearExcelMatches();
          return;
        }
        // 回车 = 向下箭头；Shift+Enter = 向上箭头
        if (state.excelMatch?.items?.length && String(state.excelMatch.query || "").trim() === q) {
          stepExcelMatch(event.shiftKey ? -1 : 1);
          return;
        }
        const sheetId = state.activeSheetId || sheetsOfFile(state.activeFile)[0]?.id;
        if (sheetId) loadExcelMatches(q, sheetId);
      }
    });

    // 单元格编辑：回车提交并下移，Esc 还原
    const tableWrap = $("excelTableWrap");
    tableWrap?.addEventListener("keydown", (event) => {
      const cell = event.target.closest?.(".excel-cell");
      if (!cell) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitExcelCell(cell);
        const next = cell.closest("tr")?.nextElementSibling?.querySelector(`[data-col="${cell.getAttribute("data-col")}"]`);
        if (next) next.focus();
        else cell.blur();
      }
      if (event.key === "Escape") {
        const page = state.page;
        const row = Number(cell.getAttribute("data-row"));
        const col = Number(cell.getAttribute("data-col"));
        const original = page?.rows.find((item) => item.row === row)?.cells[col] ?? "";
        cell.textContent = original;
        cell.blur();
      }
    });
    tableWrap?.addEventListener("focusout", (event) => {
      const cell = event.target.closest?.(".excel-cell");
      if (cell) commitExcelCell(cell);
    });

    // 滚轮 = 纵向；按住右键 + 滚轮 = 横向（避免和单元格编辑冲突）
    let excelRightPan = false;
    let excelRightScrolled = false;
    tableWrap?.addEventListener("mousedown", (event) => {
      if (event.button === 2) {
        excelRightPan = true;
        excelRightScrolled = false;
      }
    });
    const endExcelRightPan = () => { excelRightPan = false; };
    window.addEventListener("mouseup", (event) => {
      if (event.button === 2) endExcelRightPan();
    });
    tableWrap?.addEventListener("mouseleave", endExcelRightPan);
    tableWrap?.addEventListener("contextmenu", (event) => {
      if (excelRightScrolled) {
        event.preventDefault();
        excelRightScrolled = false;
      }
    });
    tableWrap?.addEventListener("wheel", (event) => {
      const holdRight = excelRightPan || (event.buttons & 2) === 2;
      if (!holdRight) return; // 单独滚轮：浏览器默认纵向滚动
      event.preventDefault();
      excelRightScrolled = true;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      tableWrap.scrollLeft += delta;
    }, { passive: false });

    $("excelReload")?.addEventListener("click", () => {
      ensureExcelCatalog(true);
      try { window.OceanViewDocs?.reload?.(); } catch { /* ignore */ }
      try { window.OceanViewDb?.reload?.(); } catch { /* ignore */ }
      try { window.OceanViewSearch?.reloadSymbols?.(); } catch { /* ignore */ }
    });

    // Tab Tab 打开首页（输入框内不劫持）
    let lastTabAt = 0;
    document.addEventListener("keydown", (event) => {
      // Excel 表内查找：Ctrl/Cmd+F
      if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || "").toLowerCase() === "f") {
        if (state.view === "excel" || document.body.dataset.view === "excel") {
          event.preventDefault();
          event.stopPropagation();
          focusExcelFind(true);
          return;
        }
      }
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) {
        if (event.key !== "Tab") lastTabAt = 0;
        return;
      }
      const active = document.activeElement;
      const tag = active?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
      if (typing) return;
      // 全局搜索开着时 Tab 用来切分类，让给搜索面板
      if (document.querySelector(".global-search-mask.show")) return;
      const now = Date.now();
      if (now - lastTabAt < 600) {
        event.preventDefault();
        lastTabAt = 0;
        setView("home");
        return;
      }
      lastTabAt = now;
    }, true);
  }

  window.OceanViewHome = {
    /** 供 Tab 搜索的 Excel 分类使用 */
    searchExcel(query, onHits) {
      const seq = ++excelSearchSeq;
      pendingSearch = typeof onHits === "function" ? { seq, cb: onHits } : null;
      const ok = post("excelSearch", { query, requestId: seq });
      if (!ok) pendingSearch = null;
      return pendingSearch !== null;
    },
    /** 首次打开搜索前预热索引，避免第一次查询干等 */
    warmExcelIndex() {
      ensureExcelCatalog(false);
    },
    /** 扩展标题栏快速入口 / 自定义编辑器跳转：切到对应 View Client，并尽量定位到当前文件 */
    openTargetView(view, target = "") {
      const name = String(view || "client");
      if (name === "excel" || name === "docs" || name === "db") {
        openTab(name, VIEW_LABEL[name]);
        setView(name);
      } else {
        setView("client");
      }
      if (!target) return;
      const normalized = String(target).replace(/\\/g, "/");
      const base = normalized.split("/").pop() || "";
      let attempts = 0;
      const tryLocate = () => {
        attempts += 1;
        let located = false;
        if (name === "excel") {
          const sheet = state.sheets.find((item) => (item.relative || "").replace(/\\/g, "/").endsWith(base)
            || (item.file || "").replace(/\\/g, "/") === normalized);
          if (sheet) {
            selectSheet(sheet.id);
            located = true;
          }
        } else if (name === "docs") {
          located = Boolean(window.OceanViewDocs?.openByName?.(target));
        } else if (name === "db") {
          located = Boolean(window.OceanViewDb?.openTableByName?.(base.replace(/\.[^.]+$/, "")));
        }
        // 目录还在扫描时重试几次，避免「一直扫描中」后什么都不选中
        if (!located && attempts < 12) window.setTimeout(tryLocate, 400);
      };
      tryLocate();
    },
    rerender() {
      renderExcelList();
      updateExcelDiffButton();
    },
    openSheet(id, row = 0, col = -1, query = "") {
      openExcelSheet(id, row, col, query);
    },
    sheets() {
      return state.sheets.slice();
    },
    ensureCatalog: () => ensureExcelCatalog(),
    setView,
    openTab,
    tabs: () => state.tabs.map((tab) => ({ ...tab })),
  };

  // ===== Excel/Docs/Db 侧栏：折叠 + 拖拽 + 分页 =====
  const SIDE_KEYS = { excel: "excelView", docs: "docsClient", db: "dbView" };
  const SIDE_WIDTH_KEY = "oceanview.view.sideWidth";
  const SIDE_COLLAPSE_KEY = "oceanview.view.sideCollapsed";

  function readSideWidth() {
    const value = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(value) && value >= 180 && value <= 520 ? value : 260;
  }

  function applySideWidth(view, width) {
    const el = $(SIDE_KEYS[view]);
    if (!el) return;
    el.style.setProperty("--side-w", `${Math.round(width)}px`);
  }

  function readCollapsed() {
    try {
      return JSON.parse(localStorage.getItem(SIDE_COLLAPSE_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function setCollapsed(view, collapsed) {
    const el = $(SIDE_KEYS[view]);
    if (!el) return;
    el.classList.toggle("side-collapsed", Boolean(collapsed));
    for (const button of el.querySelectorAll(`[data-side-collapse="${view}"]`)) {
      button.title = collapsed ? "展开侧栏" : "收起侧栏";
      button.setAttribute("aria-expanded", String(!collapsed));
    }
    const store = readCollapsed();
    store[view] = Boolean(collapsed);
    localStorage.setItem(SIDE_COLLAPSE_KEY, JSON.stringify(store));
  }

  function initSides() {
    const width = readSideWidth();
    const collapsed = readCollapsed();
    for (const view of Object.keys(SIDE_KEYS)) {
      applySideWidth(view, width);
      setCollapsed(view, Boolean(collapsed[view]));
    }
    document.querySelectorAll("[data-side-collapse]").forEach((button) => {
      button.addEventListener("click", () => {
        const view = button.getAttribute("data-side-collapse");
        const el = $(SIDE_KEYS[view]);
        setCollapsed(view, !el?.classList.contains("side-collapsed"));
      });
    });
    document.querySelectorAll("[data-side-rail]").forEach((rail) => {
      rail.addEventListener("pointerdown", (event) => {
        const view = rail.getAttribute("data-side-rail");
        const el = $(SIDE_KEYS[view]);
        if (!el || event.button !== 0) return;
        if (el.classList.contains("side-collapsed")) setCollapsed(view, false);
        event.preventDefault();
        document.body.classList.add("sidebar-resizing");
        const move = (ev) => {
          const box = el.querySelector(".excel-side").getBoundingClientRect();
          const max = Math.max(180, el.getBoundingClientRect().width - 320);
          const width2 = Math.min(max, Math.max(180, ev.clientX - box.left));
          applySideWidth(view, width2);
        };
        const up = () => {
          document.body.classList.remove("sidebar-resizing");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const node = el.querySelector(".excel-side");
          if (node) localStorage.setItem(SIDE_WIDTH_KEY, String(Math.round(node.getBoundingClientRect().width)));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    });
  }

  /** 侧栏分页：total 条按 size 分页，返回当前页切片 */
  function paginate(items, page, size) {
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(0, page), pages - 1);
    return {
      slice: items.slice(current * size, current * size + size),
      page: current,
      pages,
      total,
    };
  }

  function renderPager(node, result, onPage) {
    if (!node) return;
    if (result.pages <= 1) {
      node.innerHTML = "";
      return;
    }
    node.innerHTML = `
      <button class="btn" type="button" data-side-page="-1" ${result.page <= 0 ? "disabled" : ""}>上一页</button>
      <span class="pager-info">${result.page + 1} / ${result.pages}</span>
      <button class="btn" type="button" data-side-page="1" ${result.page >= result.pages - 1 ? "disabled" : ""}>下一页</button>`;
    node.onclick = (event) => {
      const btn = event.target.closest("[data-side-page]");
      if (!btn || btn.disabled) return;
      onPage(result.page + Number(btn.getAttribute("data-side-page")));
    };
  }

  window.OceanViewPager = { paginate, renderPager };

  initSides();

  let pendingSearch = null;
  let pendingHomeExcel = null;
  let excelSearchSeq = 0;
  state.homeExcelHits = [];
  state.homeDocsHits = [];
  state.homeDbHits = [];
  state.page = null;

  bind();
  renderTabs();
  document.body.dataset.view = "client";
  // app.js 先于本文件初始化，那时 OceanViewGit 还不存在，这里补一次 git 变更请求
  requestGitChanges();
})();
