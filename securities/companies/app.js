"use strict";

const GROUP_ORDER = ["ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ", "英数字", "その他"];
const GROUP_LABEL = {
  "ア": "ア行", "カ": "カ行", "サ": "サ行", "タ": "タ行", "ナ": "ナ行",
  "ハ": "ハ行", "マ": "マ行", "ヤ": "ヤ行", "ラ": "ラ行", "ワ": "ワ行",
  "英数字": "英数字", "その他": "その他"
};

let companyIndexData = null;
let historyData = null;
let historyCompanyMap = new Map();
let selectedCompanyName = "";

function compareCompanies(a, b) {
  const ar = (a.reading || "").trim();
  const br = (b.reading || "").trim();
  if (ar && br) {
    const c = ar.localeCompare(br, "ja");
    if (c !== 0) return c;
  } else if (ar) {
    return -1;
  } else if (br) {
    return 1;
  }
  return a.name.localeCompare(b.name, "ja");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatMonth(month, uncertain) {
  const raw = String(month || "").padStart(6, "0");
  if (raw.length !== 6) return String(month || "");
  const year = raw.slice(0, 4);
  const mon = raw.slice(4, 6);
  if (uncertain) return `${year}年（月不明）`;
  return `${year}年${Number(mon)}月`;
}

function eventSummary(event) {
  const before = (event.before || "").trim();
  const after = (event.after || "").trim();
  const kind = (event.type || "").trim();

  if (kind === "設立") return after && after !== "-" && after !== "－" ? `${after}を設立` : "設立";
  if (kind === "廃業") return before && before !== "-" && before !== "－" ? `${before}が廃業` : "廃業";
  if (before && after && before !== after) return `${before} → ${after}`;
  if (after && after !== "-" && after !== "－") return after;
  if (before && before !== "-" && before !== "－") return before;
  return kind || "沿革イベント";
}

function eventSort(a, b) {
  if ((a.month || 0) !== (b.month || 0)) return (a.month || 0) - (b.month || 0);
  return (a.source_row || 0) - (b.source_row || 0);
}

function splitLegacySource(source) {
  const text = String(source || "").trim();
  if (!text) return { note: "", urls: [] };
  const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const urls = [];
  const notes = [];
  for (const line of lines) {
    if (/^https?:\/\/\S+$/i.test(line)) urls.push(line);
    else notes.push(line);
  }
  return { note: notes.join("\n"), urls };
}

function sourceParts(event) {
  const note = typeof event.note === "string" ? event.note.trim() : "";
  const urls = Array.isArray(event.urls)
    ? event.urls.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  if (note || urls.length) return { note, urls };
  return splitLegacySource(event.source);
}

function appendLinkifiedText(parent, text) {
  const value = String(text || "");
  const regex = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let match;
  while ((match = regex.exec(value)) !== null) {
    if (match.index > last) parent.appendChild(document.createTextNode(value.slice(last, match.index)));
    const a = document.createElement("a");
    a.href = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = match[0];
    parent.appendChild(a);
    last = regex.lastIndex;
  }
  if (last < value.length) parent.appendChild(document.createTextNode(value.slice(last)));
}

function uniqueEvents(events) {
  const seen = new Set();
  return events.filter(event => {
    const key = event.id || `${event.source_row}|${event.month}|${event.before}|${event.after}|${event.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function companyTrackIds(name) {
  const ids = new Set();
  const company = historyCompanyMap.get(name);
  for (const id of (company?.track_ids || [])) ids.add(id);

  // company metadataに含まれない歴史上の社名でも、
  // eventのbefore/afterから所属trackを復元できるようにする。
  for (const event of (historyData?.events || [])) {
    if (event.before === name && event.track_id) ids.add(event.track_id);
    if (event.after === name) {
      if (event.result_track_id) ids.add(event.result_track_id);
      else if (event.track_id) ids.add(event.track_id);
    }
  }
  return ids;
}

function eventsForCompany(name) {
  if (!historyData) return [];
  const company = historyCompanyMap.get(name);
  const trackIds = companyTrackIds(name);
  const directIds = new Set(company?.event_ids || []);

  const events = (historyData.events || []).filter(event => {
    if (event.before === name || event.after === name) return true;
    if (directIds.has(event.id)) return true;
    if (trackIds.has(event.track_id)) return true;
    if (trackIds.has(event.result_track_id)) return true;
    return false;
  });

  return uniqueEvents(events).sort(eventSort);
}

function renderSource(event) {
  const { note, urls } = sourceParts(event);
  if (!note && !urls.length) return null;

  const source = el("div", "event-source");
  source.appendChild(el("h4", "event-source-title", "出典"));

  if (note) {
    const p = el("p", "event-note");
    const noteLines = note.split(/\r?\n/);
    noteLines.forEach((line, index) => {
      if (index) p.appendChild(document.createElement("br"));
      appendLinkifiedText(p, line);
    });
    source.appendChild(p);
  }

  for (const url of urls) {
    const p = el("p", "event-url");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    p.appendChild(a);
    source.appendChild(p);
  }
  return source;
}

function renderCompanyDetail(name) {
  const detail = document.getElementById("company-detail");
  const company = historyCompanyMap.get(name);
  selectedCompanyName = name;

  document.querySelectorAll(".company-button.is-selected").forEach(node => node.classList.remove("is-selected"));
  document.querySelectorAll(".company-button").forEach(node => {
    if (node.dataset.company === name) node.classList.add("is-selected");
  });

  detail.replaceChildren();

  const header = el("div", "detail-header");
  const headingWrap = el("div", "detail-heading-wrap");
  headingWrap.appendChild(el("p", "eyebrow", "COMPANY HISTORY"));
  headingWrap.appendChild(el("h2", "detail-company-name", name));
  header.appendChild(headingWrap);

  const isCurrent = Boolean(company?.is_current);
  const badge = el("span", `status-badge ${isCurrent ? "is-current" : "is-historical"}`, isCurrent ? "現存" : "歴史上の社名");
  header.appendChild(badge);
  detail.appendChild(header);

  const events = eventsForCompany(name);
  if (!events.length) {
    detail.appendChild(el("p", "detail-message", "この会社に関連する沿革イベントを取得できませんでした。"));
  } else {
    const intro = el("p", "detail-summary", `${events.length.toLocaleString("ja-JP")}件の沿革イベントを年代順に表示しています。`);
    detail.appendChild(intro);

    const timeline = el("ol", "history-list");
    for (const event of events) {
      const item = el("li", "history-item");
      const date = el("time", "event-date", formatMonth(event.month, event.month_uncertain));
      item.appendChild(date);

      const body = el("div", "event-body");
      const top = el("div", "event-topline");
      top.appendChild(el("span", "event-type", event.type || "沿革"));
      top.appendChild(el("strong", "event-summary", eventSummary(event)));
      body.appendChild(top);

      const source = renderSource(event);
      if (source) body.appendChild(source);
      item.appendChild(body);
      timeline.appendChild(item);
    }
    detail.appendChild(timeline);
  }

  const actions = el("div", "detail-actions");
  const diagram = el("a", "primary-link", "変遷図でこの会社を見る");
  diagram.href = `../?company=${encodeURIComponent(name)}`;
  actions.appendChild(diagram);
  detail.appendChild(actions);

  if (window.matchMedia("(max-width: 760px)").matches) {
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderCompanyList(companies) {
  const groupsRoot = document.getElementById("company-groups");
  const navRoot = document.getElementById("kana-nav");
  const countNode = document.getElementById("company-count");
  const noteNode = document.getElementById("reading-note");

  const grouped = Object.fromEntries(GROUP_ORDER.map(key => [key, []]));
  let missingReadings = 0;

  for (const company of companies) {
    const reading = (company.reading || "").trim();
    let group = company.kana_group || "その他";
    if (!GROUP_ORDER.includes(group)) group = "その他";
    if (!reading) missingReadings += 1;
    grouped[group].push(company);
  }

  for (const key of GROUP_ORDER) grouped[key].sort(compareCompanies);

  countNode.textContent = `${companies.length.toLocaleString("ja-JP")}社名`;
  if (missingReadings > 0) {
    noteNode.hidden = false;
    noteNode.textContent = `読み未登録の会社が ${missingReadings.toLocaleString("ja-JP")} 社あります。未登録分は「その他」に表示されます。`;
  } else {
    noteNode.hidden = true;
  }

  navRoot.replaceChildren();
  for (const key of GROUP_ORDER) {
    const a = el("a", grouped[key].length ? "" : "is-empty", GROUP_LABEL[key]);
    a.href = `#group-${encodeURIComponent(key)}`;
    if (!grouped[key].length) a.setAttribute("aria-disabled", "true");
    navRoot.appendChild(a);
  }

  groupsRoot.replaceChildren();
  for (const key of GROUP_ORDER) {
    if (!grouped[key].length) continue;
    const section = el("section", "company-group");
    section.id = `group-${key}`;
    const h2 = el("h2", "group-title");
    h2.appendChild(document.createTextNode(GROUP_LABEL[key]));
    h2.appendChild(el("small", "", `${grouped[key].length}社名`));
    section.appendChild(h2);

    const ul = el("ul", "company-list");
    for (const company of grouped[key]) {
      const li = document.createElement("li");
      const button = el("button", "company-button");
      button.type = "button";
      button.dataset.company = company.name;
      button.setAttribute("aria-label", `${company.name}の沿革を見る`);
      button.appendChild(el("span", "company-name", company.name));
      if (company.reading) button.appendChild(el("span", "company-reading", company.reading));
      button.addEventListener("click", () => renderCompanyDetail(company.name));
      li.appendChild(button);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    groupsRoot.appendChild(section);
  }
}

async function init() {
  const groupsRoot = document.getElementById("company-groups");
  const countNode = document.getElementById("company-count");

  try {
    const [indexResponse, historyResponse] = await Promise.all([
      fetch("../data/company_index.json", { cache: "no-store" }),
      fetch("../data/securities_history.json", { cache: "no-store" })
    ]);
    if (!indexResponse.ok) throw new Error(`company_index.json: HTTP ${indexResponse.status}`);
    if (!historyResponse.ok) throw new Error(`securities_history.json: HTTP ${historyResponse.status}`);

    companyIndexData = await indexResponse.json();
    historyData = await historyResponse.json();
    historyCompanyMap = new Map((historyData.companies || []).map(company => [company.name, company]));

    const companies = Array.isArray(companyIndexData.companies) ? [...companyIndexData.companies] : [];
    renderCompanyList(companies);
  } catch (error) {
    console.error(error);
    countNode.textContent = "読み込みエラー";
    groupsRoot.innerHTML = '<p class="loading">会社一覧または沿革データを読み込めませんでした。公開ファイルの配置を確認してください。</p>';
  }
}

document.addEventListener("DOMContentLoaded", init);
