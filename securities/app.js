(() => {
  "use strict";

  const SVG_URL = "assets/securities_history.svg";
  const DATA_URL = "data/securities_history.json";
  const VALID_MODES = new Set(["self", "predecessors", "successors", "lineage"]);

  const stage = document.getElementById("svg-stage");
  const panel = document.getElementById("detail-panel");
  const statusEl = document.getElementById("status");
  const contextBar = document.getElementById("current-context");
  const contextCompany = document.getElementById("context-company");
  const contextDetail = document.getElementById("context-detail");
  const searchInput = document.getElementById("company-search");
  const searchButton = document.getElementById("search-button");
  const clearButton = document.getElementById("clear-button");
  const suggestions = document.getElementById("search-suggestions");
  const zoomInButton = document.getElementById("zoom-in");
  const zoomOutButton = document.getElementById("zoom-out");
  const fitAllButton = document.getElementById("fit-all");
  const helpButton = document.getElementById("help-button");
  const helpDialog = document.getElementById("help-dialog");
  const helpClose = document.getElementById("help-close");
  const shareButton = document.getElementById("share-button");
  const aboutButton = document.getElementById("about-button");
  const aboutDialog = document.getElementById("about-dialog");
  const aboutClose = document.getElementById("about-close");
  const footerHelpButton = document.getElementById("footer-help-button");
  const footerAboutButton = document.getElementById("footer-about-button");
  const footerShareButton = document.getElementById("footer-share-button");
  const lastUpdatedEl = document.getElementById("last-updated");
  const aboutLastUpdatedEl = document.getElementById("about-last-updated");
  const mobileDetailJump = document.getElementById("mobile-detail-jump");

  let data = null;
  let svg = null;
  let companyMap = new Map();
  let eventMap = new Map();
  let companyNames = [];
  let initialViewBox = null;
  let viewBox = null;
  let forwardGraph = new Map();
  let reverseGraph = new Map();

  let selectedCompanyName = null;
  let selectedMode = "self";
  let selectedEventId = null;

  let timelineOverlay = null;
  let timelineTrack = null;
  let timelineLabels = [];
  let timelineSpans = [];
  let timelineRaf = null;

  function normalize(value) {
    return String(value ?? "").trim().toLocaleLowerCase("ja");
  }

  function isMobileLayout() {
    return window.matchMedia("(max-width: 700px)").matches;
  }

  function monthText(month, uncertain) {
    const s = String(month ?? "");
    if (!/^\d{6}$/.test(s)) return s || "年月不明";
    const year = s.slice(0, 4);
    const monthNum = Number(s.slice(4, 6));
    if (uncertain) return `${year}年（月不明）`;
    return `${year}年${monthNum}月`;
  }

  function eventDescription(event) {
    const before = event.before || "";
    const after = event.after || "";

    if (event.type === "設立") return `${after}を設立`;
    if (event.type === "商号変更") return `${before} → ${after}`;
    if (event.type === "合併") return `${before} → ${after}`;
    if (event.type === "廃業") return `${before || after} 廃業`;
    return [before, after].filter(Boolean).join(" → ");
  }

  function splitSources(source) {
    if (!source) return [];
    return String(source)
      .split(/\r?\n/)
      .map(v => v.trim())
      .filter(Boolean);
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function makeSourceBlock(source) {
    const wrapper = document.createElement("div");
    wrapper.className = "source-block";

    const label = document.createElement("span");
    label.className = "source-label";
    label.textContent = "出典";
    wrapper.appendChild(label);

    const entries = splitSources(source);
    if (!entries.length) {
      const none = document.createElement("span");
      none.className = "source-entry no-source";
      none.textContent = "未登録";
      wrapper.appendChild(none);
      return wrapper;
    }

    for (const entry of entries) {
      const row = document.createElement("span");
      row.className = "source-entry";

      if (isHttpUrl(entry)) {
        const a = document.createElement("a");
        a.href = entry;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = entry;
        row.appendChild(a);
      } else {
        row.textContent = entry;
      }
      wrapper.appendChild(row);
    }
    return wrapper;
  }

  function ensureGraphNode(name) {
    if (!name) return;
    if (!forwardGraph.has(name)) forwardGraph.set(name, new Set());
    if (!reverseGraph.has(name)) reverseGraph.set(name, new Set());
  }

  function buildCompanyGraph() {
    forwardGraph = new Map();
    reverseGraph = new Map();

    for (const name of companyNames) ensureGraphNode(name);

    for (const event of data.events || []) {
      if (!["商号変更", "合併"].includes(event.type)) continue;

      const before = String(event.before || "").trim();
      const after = String(event.after || "").trim();
      if (!before || !after || before === after) continue;

      ensureGraphNode(before);
      ensureGraphNode(after);
      forwardGraph.get(before).add(after);
      reverseGraph.get(after).add(before);
    }
  }

  function traverseGraph(start, graph) {
    const result = new Set([start]);
    const queue = [start];

    while (queue.length) {
      const current = queue.shift();
      for (const next of graph.get(current) || []) {
        if (result.has(next)) continue;
        result.add(next);
        queue.push(next);
      }
    }
    return result;
  }

  function namesForMode(companyName, mode) {
    if (mode === "predecessors") return traverseGraph(companyName, reverseGraph);
    if (mode === "successors") return traverseGraph(companyName, forwardGraph);

    if (mode === "lineage") {
      const company = companyMap.get(companyName);
      const lineageIds = new Set(company?.lineage_ids || []);
      return new Set(
        companyNames.filter(name => {
          const c = companyMap.get(name);
          return (c?.lineage_ids || []).some(id => lineageIds.has(id));
        })
      );
    }

    return new Set([companyName]);
  }

  function eventFitsNameSet(event, names, mode, selectedName) {
    if (mode === "self") {
      return (companyMap.get(selectedName)?.event_ids || []).includes(event.id);
    }

    const before = String(event.before || "").trim();
    const after = String(event.after || "").trim();

    if (event.type === "設立") return names.has(after);
    if (event.type === "廃業") return names.has(before || after);

    if (event.type === "商号変更" || event.type === "合併") {
      if (before === after) return names.has(before);
      return names.has(before) && names.has(after);
    }

    return names.has(before) || names.has(after);
  }

  async function loadApp() {
    try {
      const [svgResponse, dataResponse] = await Promise.all([
        fetch(SVG_URL),
        fetch(DATA_URL)
      ]);

      if (!svgResponse.ok) throw new Error(`SVGの取得に失敗しました (${svgResponse.status})`);
      if (!dataResponse.ok) throw new Error(`JSONの取得に失敗しました (${dataResponse.status})`);

      const [svgText, json] = await Promise.all([
        svgResponse.text(),
        dataResponse.json()
      ]);

      data = json;
      updateLastUpdated();
      stage.innerHTML = svgText;
      svg = stage.querySelector("svg");
      if (!svg) throw new Error("SVG要素が見つかりません。");

      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

      const vb = svg.viewBox.baseVal;
      initialViewBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      viewBox = { ...initialViewBox };

      initTimelineOverlay();

      companyMap = new Map((data.companies || []).map(c => [c.name, c]));
      eventMap = new Map((data.events || []).map(e => [e.id, e]));
      companyNames = (data.companies || [])
        .map(c => c.name)
        .sort((a, b) => a.localeCompare(b, "ja"));

      buildCompanyGraph();
      bindSvgInteractions();
      bindPanZoom();

      setStatus(`${companyNames.length}社を読み込みました。会社名を検索できます。`);
      restoreStateFromUrl();
    } catch (error) {
      console.error(error);
      stage.innerHTML = `
        <div class="loading">
          読み込みに失敗しました。HTMLを直接ダブルクリックした場合は、
          start_web_preview.bat から開いてください。
        </div>`;
      setStatus(`エラー: ${error.message}`);
    }
  }

  function setStatus(message) {
    statusEl.textContent = message;
  }

  function initTimelineOverlay() {
    if (!svg) return;

    timelineLabels = Array.from(svg.querySelectorAll(".month-label"))
      .map(el => ({
        month: el.getAttribute("data-month") || el.textContent.trim(),
        text: el.textContent.trim(),
        x: Number(el.getAttribute("x"))
      }))
      .filter(item => Number.isFinite(item.x))
      .sort((a, b) => a.x - b.x);

    timelineSpans = Array.from(svg.querySelectorAll(".month-span"))
      .map(el => ({
        month: el.getAttribute("data-month") || "",
        x1: Number(el.getAttribute("x1")),
        x2: Number(el.getAttribute("x2"))
      }))
      .filter(item => Number.isFinite(item.x1) && Number.isFinite(item.x2));

    timelineOverlay?.remove();

    timelineOverlay = document.createElement("div");
    timelineOverlay.className = "timeline-overlay";
    timelineOverlay.setAttribute("aria-label", "年月見出し");

    timelineTrack = document.createElement("div");
    timelineTrack.className = "timeline-track";
    timelineOverlay.appendChild(timelineTrack);
    stage.appendChild(timelineOverlay);

    scheduleTimelineUpdate();
  }

  function scheduleTimelineUpdate() {
    if (!timelineTrack || !svg) return;
    if (timelineRaf !== null) cancelAnimationFrame(timelineRaf);

    timelineRaf = requestAnimationFrame(() => {
      timelineRaf = null;
      updateTimelineOverlay();
    });
  }

  function svgXToStageX(x, matrix, stageRect) {
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = viewBox ? viewBox.y : 0;
    const screenPoint = point.matrixTransform(matrix);
    return screenPoint.x - stageRect.left;
  }

  function updateTimelineOverlay() {
    if (!timelineTrack || !svg || !viewBox) return;

    const stageRect = stage.getBoundingClientRect();
    const matrix = svg.getScreenCTM();
    if (!matrix || stageRect.width <= 0) return;

    timelineTrack.replaceChildren();

    // 合併月の「同じ年月に2列ある」ことを示す横線も固定見出しへ再現する。
    for (const span of timelineSpans) {
      const left = svgXToStageX(span.x1, matrix, stageRect);
      const right = svgXToStageX(span.x2, matrix, stageRect);

      if (right < 0 || left > stageRect.width) continue;

      const line = document.createElement("span");
      line.className = "timeline-span";
      line.style.left = `${Math.max(0, left)}px`;
      line.style.width = `${Math.max(0, Math.min(stageRect.width, right) - Math.max(0, left))}px`;
      timelineTrack.appendChild(line);
    }

    const visible = timelineLabels
      .map(item => ({
        ...item,
        screenX: svgXToStageX(item.x, matrix, stageRect)
      }))
      .filter(item => item.screenX >= -45 && item.screenX <= stageRect.width + 45);

    // 全体表示時など列間隔が狭い場合は、読める間隔になるよう自動的に間引く。
    // 拡大すると隠れていた年月も自然に再表示される。
    const minGap = stageRect.width < 700 ? 58 : 64;
    let lastRenderedX = -Infinity;

    for (const item of visible) {
      if (item.screenX - lastRenderedX < minGap) continue;

      const label = document.createElement("span");
      label.className = "timeline-label";
      label.dataset.month = item.month;
      label.textContent = item.text;
      label.style.left = `${item.screenX}px`;
      timelineTrack.appendChild(label);
      lastRenderedX = item.screenX;
    }
  }

  function setViewBox(next) {
    if (!svg) return;

    const minWidth = Math.max(initialViewBox.width / 16, 260);
    const maxWidth = initialViewBox.width * 1.15;
    let width = Math.min(maxWidth, Math.max(minWidth, next.width));
    let height = width * (next.height / next.width);

    const minHeight = Math.max(initialViewBox.height / 16, 120);
    if (height < minHeight) {
      height = minHeight;
      width = height * (next.width / next.height);
    }

    viewBox = { x: next.x, y: next.y, width, height };
    svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
    scheduleTimelineUpdate();
  }

  function fitAll() {
    if (!initialViewBox) return;
    setViewBox({ ...initialViewBox });
  }

  function zoomAt(factor, clientX = null, clientY = null) {
    if (!svg) return;

    let anchorX = viewBox.x + viewBox.width / 2;
    let anchorY = viewBox.y + viewBox.height / 2;

    if (clientX !== null && clientY !== null) {
      const point = clientToSvg(clientX, clientY);
      if (point) {
        anchorX = point.x;
        anchorY = point.y;
      }
    }

    const newWidth = viewBox.width * factor;
    const newHeight = viewBox.height * factor;
    const rx = (anchorX - viewBox.x) / viewBox.width;
    const ry = (anchorY - viewBox.y) / viewBox.height;

    setViewBox({
      x: anchorX - newWidth * rx,
      y: anchorY - newHeight * ry,
      width: newWidth,
      height: newHeight
    });
  }

  function clientToSvg(clientX, clientY) {
    if (!svg) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    return point.matrixTransform(matrix.inverse());
  }

  function bindPanZoom() {
    stage.addEventListener("wheel", event => {
      if (!svg) return;
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? 0.82 : 1.22, event.clientX, event.clientY);
    }, { passive: false });

    let pointerActive = false;
    let dragging = false;
    let startClientX = 0;
    let startClientY = 0;
    let startBox = null;
    let pointerDownCompany = null;
    const DRAG_THRESHOLD_PX = 6;

    stage.addEventListener("pointerdown", event => {
      if (!svg || event.button !== 0) return;

      pointerActive = true;
      dragging = false;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startBox = { ...viewBox };

      const companyNode = event.target.closest
        ? event.target.closest("[data-company]")
        : null;
      pointerDownCompany = companyNode
        ? companyNode.getAttribute("data-company")
        : null;

      stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener("pointermove", event => {
      if (!pointerActive || !startBox) return;

      const dxPx = event.clientX - startClientX;
      const dyPx = event.clientY - startClientY;
      const distance = Math.hypot(dxPx, dyPx);

      if (!dragging && distance >= DRAG_THRESHOLD_PX) {
        dragging = true;
        stage.classList.add("is-dragging");
      }

      if (!dragging) return;

      const rect = svg.getBoundingClientRect();
      const dx = dxPx * startBox.width / Math.max(rect.width, 1);
      const dy = dyPx * startBox.height / Math.max(rect.height, 1);

      setViewBox({
        x: startBox.x - dx,
        y: startBox.y - dy,
        width: startBox.width,
        height: startBox.height
      });
    });

    function endPointer(event) {
      if (!pointerActive) return;

      const wasDragging = dragging;
      const clickedCompany = pointerDownCompany;

      pointerActive = false;
      dragging = false;
      startBox = null;
      pointerDownCompany = null;
      stage.classList.remove("is-dragging");

      try { stage.releasePointerCapture(event.pointerId); } catch {}

      if (!wasDragging && clickedCompany && companyMap.has(clickedCompany)) {
        selectCompany(clickedCompany, true, "self", true);
      }
    }

    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", event => {
      pointerActive = false;
      dragging = false;
      startBox = null;
      pointerDownCompany = null;
      stage.classList.remove("is-dragging");
      try { stage.releasePointerCapture(event.pointerId); } catch {}
    });
  }

  function bindSvgInteractions() {
    svg.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = event.target.closest("[data-company]");
      if (!node) return;
      const companyName = node.getAttribute("data-company");
      if (companyName && companyMap.has(companyName)) {
        event.preventDefault();
        selectCompany(companyName, true, "self", true);
      }
    });
  }

  function clearHighlight() {
    if (!svg) return;
    svg.querySelectorAll(".web-dim, .web-hit, .web-primary").forEach(el => {
      el.classList.remove("web-dim", "web-hit", "web-primary");
    });
  }

  function modeLabel(mode) {
    return {
      self: "この会社",
      predecessors: "前身",
      successors: "後継",
      lineage: "系列全体"
    }[mode] || "この会社";
  }

  function markPrimaryCompany() {
    if (!svg || !selectedCompanyName) return;

    svg.querySelectorAll(".company-node").forEach(node => {
      if (
        node.getAttribute("data-company") === selectedCompanyName &&
        !node.classList.contains("web-dim")
      ) {
        node.classList.add("web-primary");
      }
    });
  }

  function updateCurrentContext() {
    if (!selectedCompanyName) {
      contextBar.hidden = true;
      contextCompany.textContent = "";
      contextDetail.textContent = "";
      return;
    }

    contextCompany.textContent = selectedCompanyName;

    if (selectedEventId && eventMap.has(selectedEventId)) {
      const event = eventMap.get(selectedEventId);
      contextDetail.textContent =
        `${monthText(event.month, event.month_uncertain)} ${event.type}　${eventDescription(event)}`;
    } else {
      contextDetail.textContent = modeLabel(selectedMode);
    }

    contextBar.hidden = false;
  }

  function highlightMode(companyName, mode) {
    clearHighlight();
    if (!svg || !companyMap.has(companyName)) return [];

    const names = namesForMode(companyName, mode);
    const allowedEvents = new Set(
      (data.events || [])
        .filter(event => eventFitsNameSet(event, names, mode, companyName))
        .map(event => event.id)
    );

    const trackIds = new Set();
    for (const name of names) {
      const company = companyMap.get(name);
      for (const trackId of company?.track_ids || []) trackIds.add(trackId);
    }

    const nodeIds = new Set();
    for (const node of data.svg_nodes || []) {
      if (!names.has(node.company)) continue;

      const ids = node.event_ids || [];
      const eventMatches = !ids.length || ids.some(id => allowedEvents.has(id));
      if (eventMatches) nodeIds.add(node.id);
    }

    const lineIds = new Set();
    for (const line of data.svg_lines || []) {
      const ids = line.event_ids || [];
      const eventMatches = ids.some(id => allowedEvents.has(id));
      const currentContinuation =
        !ids.length &&
        line.role === "current-continuity" &&
        trackIds.has(line.track_id);

      if (eventMatches || currentContinuation) lineIds.add(line.id);
    }

    svg.querySelectorAll(".company-node, .history-line").forEach(el => {
      el.classList.add("web-dim");
    });

    const focused = [];
    for (const id of [...nodeIds, ...lineIds]) {
      const el = svg.getElementById(id);
      if (!el) continue;
      el.classList.remove("web-dim");
      el.classList.add("web-hit");
      focused.push(el);
    }

    markPrimaryCompany();
    return focused;
  }

  function focusElements(elements) {
    if (!svg || !elements.length) return;

    let box = null;
    for (const el of elements) {
      try {
        const b = el.getBBox();
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        if (!box) {
          box = { x: b.x, y: b.y, width: b.width, height: b.height };
        } else {
          const x1 = Math.min(box.x, b.x);
          const y1 = Math.min(box.y, b.y);
          const x2 = Math.max(box.x + box.width, b.x + b.width);
          const y2 = Math.max(box.y + box.height, b.y + b.height);
          box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        }
      } catch {}
    }

    if (!box) return;

    const minFocusWidth = initialViewBox.width / 7.5;
    const minFocusHeight = initialViewBox.height / 3.8;
    const paddedWidth = Math.max(box.width * 1.35 + 100, minFocusWidth);
    const paddedHeight = Math.max(box.height * 1.8 + 80, minFocusHeight);
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    const stageRect = stage.getBoundingClientRect();
    const stageRatio = stageRect.width / Math.max(stageRect.height, 1);
    let width = paddedWidth;
    let height = paddedHeight;

    if (width / height < stageRatio) width = height * stageRatio;
    else height = width / stageRatio;

    setViewBox({
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height
    });
  }

  function modeStatus(companyName, mode) {
    const names = namesForMode(companyName, mode);
    const relatedCount = Math.max(0, names.size - 1);

    if (mode === "predecessors") {
      return relatedCount
        ? `${companyName} の前身・吸収会社 ${relatedCount}社をたどっています。`
        : `${companyName} には登録済みの前身会社がありません。`;
    }
    if (mode === "successors") {
      return relatedCount
        ? `${companyName} の後継会社 ${relatedCount}社をたどっています。`
        : `${companyName} には登録済みの後継会社がありません。`;
    }
    if (mode === "lineage") {
      return `${companyName} を含む系列 ${names.size}社を表示しています。`;
    }
    return `${companyName} を強調表示しています。`;
  }

  function clearActiveEventButton() {
    panel.querySelectorAll(".event-focus-button.is-active").forEach(button => {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });
  }

  function applyMode(doFocus = true) {
    if (!selectedCompanyName) return;

    selectedEventId = null;
    const focused = highlightMode(selectedCompanyName, selectedMode);
    if (doFocus) focusElements(focused);

    updateModeButtons();
    clearActiveEventButton();
    setStatus(modeStatus(selectedCompanyName, selectedMode));
    updateCurrentContext();
  }

  function setMode(mode, doFocus = true, updateUrl = true) {
    if (!VALID_MODES.has(mode) || !selectedCompanyName) return;
    selectedMode = mode;
    applyMode(doFocus);
    if (updateUrl) syncUrl("push");
  }

  function elementEventIds(el) {
    const raw = el.getAttribute("data-event-ids") || "";
    return raw.split(/\s+/).filter(Boolean);
  }

  function eventDirectNodes(event) {
    if (!svg || !event) return [];

    return Array.from(svg.querySelectorAll(".company-node"))
      .filter(node => (
        node.getAttribute("data-month") === String(event.month) &&
        elementEventIds(node).includes(event.id)
      ));
  }

  function eventMonthCenterX(event) {
    if (!svg || !event) return null;

    const label = svg.querySelector(
      `.month-label[data-month="${String(event.month)}"]`
    );

    if (!label) return null;

    const x = Number(label.getAttribute("x"));
    return Number.isFinite(x) ? x : null;
  }

  function setCenteredEventViewBox(centerX, centerY, requestedWidth, requestedHeight) {
    if (!svg || !initialViewBox) return;

    // 通常操作の最大ズーム制限とは切り離し、
    // イベント選択時は横長データでも十分に大きく表示できるようにする。
    const minWidth = isMobileLayout() ? 280 : 300;
    const minHeight = isMobileLayout() ? 190 : 170;
    const maxWidth = initialViewBox.width * 1.15;

    let width = Math.min(maxWidth, Math.max(minWidth, requestedWidth));
    let height = width * (requestedHeight / requestedWidth);

    if (height < minHeight) {
      height = minHeight;
      width = height * (requestedWidth / requestedHeight);
    }

    // 最終的に採用されたwidth/heightから中心座標を再計算する。
    // これにより、ズーム制限でサイズが調整されてもイベントが左上へずれない。
    viewBox = {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height
    };

    svg.setAttribute(
      "viewBox",
      `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`
    );
    scheduleTimelineUpdate();
  }

  function focusEventAtMonth(event, elements) {
    if (!svg || !event || !elements.length) return;

    let box = null;

    for (const el of elements) {
      try {
        const b = el.getBBox();
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;

        if (!box) {
          box = { x: b.x, y: b.y, width: b.width, height: b.height };
        } else {
          const x1 = Math.min(box.x, b.x);
          const y1 = Math.min(box.y, b.y);
          const x2 = Math.max(box.x + box.width, b.x + b.width);
          const y2 = Math.max(box.y + box.height, b.y + b.height);

          box = {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1
          };
        }
      } catch {}
    }

    if (!box) return;

    // 「年月列」ではなく、選択したイベントに属する会社ボックス群そのものの中心を
    // 画面中央へ置く。商号変更・合併など複数ボックスのイベントも全体が中央になる。
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // v12より一段大きく表示する。
    // 線は引き続き倍率計算に含めない。
    const minWidth = isMobileLayout() ? 330 : 380;
    const minHeight = isMobileLayout() ? 240 : 220;

    const paddedWidth = Math.max(box.width + 100, minWidth);
    const paddedHeight = Math.max(box.height + 100, minHeight);

    const stageRect = stage.getBoundingClientRect();
    const stageRatio = stageRect.width / Math.max(stageRect.height, 1);

    let width = paddedWidth;
    let height = paddedHeight;

    if (width / height < stageRatio) {
      width = height * stageRatio;
    } else {
      height = width / stageRatio;
    }

    setCenteredEventViewBox(centerX, centerY, width, height);
  }

  function focusEvent(event, clickedButton = null, updateUrl = true) {
    if (!svg || !event) return;

    selectedEventId = event.id;
    clearHighlight();

    const directNodes = eventDirectNodes(event);

    // 周囲の会社・沿革線は通常表示のまま残す。
    // クリックしたイベントに直接関係する会社ボックスだけを強調する。
    directNodes.forEach(node => {
      node.classList.add("web-hit");

      if (node.getAttribute("data-company") === selectedCompanyName) {
        node.classList.add("web-primary");
      }
    });

    // 沿革線は強調せず、倍率計算にも使わない。
    // イベント月を横方向の中央に置き、会社ボックスだけでズームする。
    if (directNodes.length) {
      focusEventAtMonth(event, directNodes);
    }

    clearActiveEventButton();

    const button = clickedButton ||
      panel.querySelector(`.event-focus-button[data-event-id="${event.id}"]`);

    if (button) {
      button.classList.add("is-active");
      button.setAttribute("aria-pressed", "true");
      button.scrollIntoView({ block: "nearest" });
    }

    setStatus(
      `${monthText(event.month, event.month_uncertain)} ${event.type} の月を中心に表示しています。`
    );
    updateCurrentContext();

    if (updateUrl) syncUrl("push");

    if (isMobileLayout()) {
      stage.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function selectCompany(name, doFocus = true, mode = "self", updateUrl = true) {
    const company = companyMap.get(name);
    if (!company) return;

    selectedCompanyName = name;
    selectedMode = VALID_MODES.has(mode) ? mode : "self";
    selectedEventId = null;

    document.body.classList.add("has-selection");
    mobileDetailJump.hidden = false;

    searchInput.value = name;
    hideSuggestions();

    renderCompanyDetails(company);
    applyMode(doFocus);

    if (updateUrl) syncUrl("push");
  }

  function renderModeControls(container) {
    const controls = document.createElement("div");
    controls.className = "mode-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "系列表示");

    const options = [
      ["self", "この会社"],
      ["predecessors", "前身"],
      ["successors", "後継"],
      ["lineage", "系列全体"]
    ];

    for (const [mode, label] of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode-button";
      button.dataset.mode = mode;
      button.textContent = label;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => setMode(mode, true, true));
      controls.appendChild(button);
    }

    container.appendChild(controls);
  }

  function updateModeButtons() {
    panel.querySelectorAll(".mode-button").forEach(button => {
      const active = button.dataset.mode === selectedMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  async function copyCurrentLink(feedbackEl) {
    const text = window.location.href;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    feedbackEl.textContent = "リンクをコピーしました";
    setTimeout(() => {
      if (feedbackEl) feedbackEl.textContent = "";
    }, 1800);
  }

  function renderCompanyDetails(company) {
    panel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "detail-header";

    const titleRow = document.createElement("div");
    titleRow.className = "detail-title-row";

    const title = document.createElement("h2");
    title.textContent = company.name;
    titleRow.appendChild(title);

    if (company.is_current) {
      const badge = document.createElement("span");
      badge.className = "current-badge";
      badge.textContent = "現存";
      titleRow.appendChild(badge);
    }

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "mobile-back-button";
    backButton.textContent = "図へ戻る";
    backButton.addEventListener("click", () => {
      stage.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    titleRow.appendChild(backButton);

    const events = (company.event_ids || [])
      .map(id => eventMap.get(id))
      .filter(Boolean)
      .filter(event => !(
        event.type === "合併" &&
        String(event.before || "").trim() === String(event.after || "").trim()
      ))
      .sort((a, b) => (a.month - b.month) || (a.source_row - b.source_row));

    const meta = document.createElement("p");
    meta.className = "detail-meta";
    meta.textContent = `関連イベント ${events.length}件`;

    header.appendChild(titleRow);
    header.appendChild(meta);
    renderModeControls(header);

    const actions = document.createElement("div");
    actions.className = "detail-actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "copy-link-button";
    copyButton.textContent = "この表示のリンクをコピー";

    const feedback = document.createElement("span");
    feedback.className = "copy-feedback";
    feedback.setAttribute("aria-live", "polite");

    copyButton.addEventListener("click", () => copyCurrentLink(feedback));

    actions.appendChild(copyButton);
    actions.appendChild(feedback);
    header.appendChild(actions);

    panel.appendChild(header);
    updateModeButtons();

    const list = document.createElement("ol");
    list.className = "history-list";

    for (const event of events) {
      const item = document.createElement("li");
      item.className = "history-item";

      const focusButton = document.createElement("button");
      focusButton.type = "button";
      focusButton.className = "event-focus-button";
      focusButton.dataset.eventId = event.id;
      focusButton.setAttribute("aria-pressed", "false");
      focusButton.title = "このイベントを図で表示";

      const topRow = document.createElement("span");
      topRow.className = "event-top-row";

      const date = document.createElement("span");
      date.className = "event-date";
      date.textContent = monthText(event.month, event.month_uncertain);

      const type = document.createElement("span");
      type.className = "event-type";
      type.textContent = event.type;

      const hint = document.createElement("span");
      hint.className = "event-focus-hint";
      hint.textContent = "図で表示";

      topRow.appendChild(date);
      topRow.appendChild(type);
      topRow.appendChild(hint);

      const desc = document.createElement("span");
      desc.className = "event-description";
      desc.textContent = eventDescription(event);

      focusButton.appendChild(topRow);
      focusButton.appendChild(desc);
      focusButton.addEventListener("click", () => focusEvent(event, focusButton, true));

      item.appendChild(focusButton);
      item.appendChild(makeSourceBlock(event.source));
      list.appendChild(item);
    }

    if (!events.length) {
      const p = document.createElement("p");
      p.className = "detail-meta";
      p.textContent = "沿革イベントは登録されていません。";
      panel.appendChild(p);
    } else {
      panel.appendChild(list);
    }
  }

  function showMultipleResults(matches, query) {
    selectedCompanyName = null;
    selectedMode = "self";
    selectedEventId = null;
    document.body.classList.remove("has-selection");
    mobileDetailJump.hidden = true;
    updateCurrentContext();

    clearHighlight();

    const nodeIds = new Set();
    for (const name of matches) {
      const company = companyMap.get(name);
      for (const id of company?.node_ids || []) nodeIds.add(id);
    }

    svg.querySelectorAll(".company-node, .history-line").forEach(el => el.classList.add("web-dim"));
    const focused = [];
    for (const id of nodeIds) {
      const el = svg.getElementById(id);
      if (!el) continue;
      el.classList.remove("web-dim");
      el.classList.add("web-hit");
      focused.push(el);
    }
    focusElements(focused);

    panel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "detail-header";
    const title = document.createElement("h2");
    title.textContent = `「${query}」の検索結果`;
    const meta = document.createElement("p");
    meta.className = "detail-meta";
    meta.textContent = `${matches.length}社が該当しました。会社名を選択してください。`;
    header.append(title, meta);
    panel.appendChild(header);

    const ul = document.createElement("ul");
    ul.className = "search-result-list";

    matches.forEach(name => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.addEventListener("click", () => selectCompany(name, true, "self", true));
      li.appendChild(button);
      ul.appendChild(li);
    });

    panel.appendChild(ul);
    setStatus(`「${query}」に ${matches.length}社が該当しました。`);
    syncUrl("push");
  }

  function performSearch() {
    const query = searchInput.value.trim();
    if (!query) {
      resetSelection();
      return;
    }

    const normalizedQuery = normalize(query);
    const exact = companyNames.find(name => normalize(name) === normalizedQuery);
    if (exact) {
      selectCompany(exact, true, "self", true);
      return;
    }

    const matches = companyNames.filter(name => normalize(name).includes(normalizedQuery));

    if (matches.length === 1) {
      selectCompany(matches[0], true, "self", true);
    } else if (matches.length > 1) {
      hideSuggestions();
      showMultipleResults(matches, query);
    } else {
      selectedCompanyName = null;
      selectedMode = "self";
      selectedEventId = null;
      document.body.classList.remove("has-selection");
      mobileDetailJump.hidden = true;
      updateCurrentContext();

      clearHighlight();
      hideSuggestions();
      syncUrl("push");
      setStatus(`「${query}」に一致する会社はありません。`);
      panel.innerHTML = `
        <div class="detail-empty">
          <h2>検索結果なし</h2>
          <p>別の会社名や短い語句で検索してください。</p>
        </div>`;
    }
  }

  function updateSuggestions() {
    const query = searchInput.value.trim();
    if (!query) {
      hideSuggestions();
      return;
    }

    const q = normalize(query);
    const matches = companyNames
      .filter(name => normalize(name).includes(q))
      .slice(0, 12);

    if (!matches.length) {
      hideSuggestions();
      return;
    }

    suggestions.innerHTML = "";
    for (const name of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-item";
      button.setAttribute("role", "option");
      button.textContent = name;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => selectCompany(name, true, "self", true));
      suggestions.appendChild(button);
    }
    suggestions.hidden = false;
  }

  function hideSuggestions() {
    suggestions.hidden = true;
    suggestions.innerHTML = "";
  }

  function buildStateUrl() {
    const url = new URL(window.location.href);

    if (selectedCompanyName) {
      url.searchParams.set("company", selectedCompanyName);

      if (selectedMode !== "self") url.searchParams.set("view", selectedMode);
      else url.searchParams.delete("view");

      if (selectedEventId) url.searchParams.set("event", selectedEventId);
      else url.searchParams.delete("event");
    } else {
      url.searchParams.delete("company");
      url.searchParams.delete("view");
      url.searchParams.delete("event");
    }

    return url;
  }

  function syncUrl(historyMode = "push") {
    const url = buildStateUrl();
    const target = url.toString();

    if (target === window.location.href) return;

    const state = {
      company: selectedCompanyName,
      view: selectedMode,
      event: selectedEventId
    };

    if (historyMode === "replace") {
      history.replaceState(state, "", url);
    } else {
      history.pushState(state, "", url);
    }
  }

  function resolveEventFromUrlId(eventId) {
    if (!eventId) return null;

    if (eventMap.has(eventId)) return eventMap.get(eventId);

    const legacy = /^event-r(\d+)$/.exec(eventId);
    if (legacy) {
      const row = Number(legacy[1]);
      return (data.events || []).find(event => event.source_row === row) || null;
    }

    return null;
  }

  function inferCompanyForEvent(event) {
    if (!event) return null;

    const candidates = [
      String(event.after || "").trim(),
      String(event.before || "").trim()
    ];

    for (const candidate of candidates) {
      if (companyMap.has(candidate)) return candidate;
    }
    return null;
  }

  function restoreStateFromUrl() {
    const url = new URL(window.location.href);
    let companyName = url.searchParams.get("company");
    let mode = url.searchParams.get("view") || "self";
    const eventParam = url.searchParams.get("event");

    if (!VALID_MODES.has(mode)) mode = "self";

    const event = resolveEventFromUrlId(eventParam);

    if ((!companyName || !companyMap.has(companyName)) && event) {
      companyName = inferCompanyForEvent(event);
    }

    if (companyName && companyMap.has(companyName)) {
      selectCompany(companyName, true, mode, false);

      if (event) {
        focusEvent(event, null, false);

        if (eventParam !== event.id) {
          selectedEventId = event.id;
          syncUrl("replace");
        }
      }

      return;
    }

    resetSelection(false);
  }

  function resetSelection(updateUrl = true, historyMode = "push") {
    selectedCompanyName = null;
    selectedMode = "self";
    selectedEventId = null;

    searchInput.value = "";
    hideSuggestions();
    clearHighlight();
    fitAll();

    document.body.classList.remove("has-selection");
    mobileDetailJump.hidden = true;
    updateCurrentContext();

    panel.innerHTML = `
      <div class="detail-empty">
        <h2>会社の沿革</h2>
        <p>検索結果または図中の会社名を選択してください。</p>
      </div>`;

    setStatus(`${companyNames.length}社を読み込みました。会社名を検索できます。`);

    if (updateUrl) syncUrl(historyMode);
  }

  function formatGeneratedDate(value) {
    if (!value) return "更新日不明";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "更新日不明";

    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(date);
  }

  function updateLastUpdated() {
    const text = `最終更新：${formatGeneratedDate(data?.generated_at)}`;
    if (lastUpdatedEl) lastUpdatedEl.textContent = text;
    if (aboutLastUpdatedEl) aboutLastUpdatedEl.textContent = text;
  }

  async function shareCurrentView() {
    const url = window.location.href;
    const title = selectedCompanyName
      ? `${selectedCompanyName} | 証券業界 変遷図`
      : "証券業界 変遷図";

    const shareData = {
      title,
      text: selectedCompanyName
        ? `${selectedCompanyName} の変遷を表示しています。`
        : "証券会社の設立・商号変更・合併・廃業をたどる変遷図です。",
      url
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setStatus("現在の表示URLをコピーしました。");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setStatus("現在の表示URLをコピーしました。");
    }
  }

  function openAbout() {
    if (typeof aboutDialog.showModal === "function") aboutDialog.showModal();
    else aboutDialog.setAttribute("open", "");
  }

  function closeAbout() {
    if (typeof aboutDialog.close === "function") aboutDialog.close();
    else aboutDialog.removeAttribute("open");
  }

  function openHelp() {
    if (typeof helpDialog.showModal === "function") helpDialog.showModal();
    else helpDialog.setAttribute("open", "");
  }

  function closeHelp() {
    if (typeof helpDialog.close === "function") helpDialog.close();
    else helpDialog.removeAttribute("open");
  }

  searchInput.addEventListener("input", updateSuggestions);
  searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      performSearch();
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".search-area")) hideSuggestions();
  });

  searchButton.addEventListener("click", performSearch);
  clearButton.addEventListener("click", resetSelection);
  zoomInButton.addEventListener("click", () => zoomAt(0.78));
  zoomOutButton.addEventListener("click", () => zoomAt(1.28));
  fitAllButton.addEventListener("click", fitAll);

  helpButton.addEventListener("click", openHelp);
  footerHelpButton.addEventListener("click", openHelp);
  helpClose.addEventListener("click", closeHelp);
  helpDialog.addEventListener("click", event => {
    if (event.target === helpDialog) closeHelp();
  });

  aboutButton.addEventListener("click", openAbout);
  footerAboutButton.addEventListener("click", openAbout);
  aboutClose.addEventListener("click", closeAbout);
  aboutDialog.addEventListener("click", event => {
    if (event.target === aboutDialog) closeAbout();
  });

  shareButton.addEventListener("click", shareCurrentView);
  footerShareButton.addEventListener("click", shareCurrentView);

  mobileDetailJump.addEventListener("click", () => {
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  window.addEventListener("resize", scheduleTimelineUpdate);

  window.addEventListener("popstate", () => {
    restoreStateFromUrl();
  });

  loadApp();
})();
