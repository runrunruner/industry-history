"use strict";

const GROUP_ORDER = ["ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ", "英数字", "その他"];
const GROUP_LABEL = {
  "ア": "ア行", "カ": "カ行", "サ": "サ行", "タ": "タ行", "ナ": "ナ行",
  "ハ": "ハ行", "マ": "マ行", "ヤ": "ヤ行", "ラ": "ラ行", "ワ": "ワ行",
  "英数字": "英数字", "その他": "その他"
};

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

async function init() {
  const groupsRoot = document.getElementById("company-groups");
  const navRoot = document.getElementById("kana-nav");
  const countNode = document.getElementById("company-count");
  const noteNode = document.getElementById("reading-note");

  try {
    const response = await fetch("../data/company_index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const companies = Array.isArray(data.companies) ? [...data.companies] : [];

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
        li.appendChild(el("span", "company-name", company.name));
        if (company.reading) li.appendChild(el("span", "company-reading", company.reading));
        ul.appendChild(li);
      }
      section.appendChild(ul);
      groupsRoot.appendChild(section);
    }
  } catch (error) {
    console.error(error);
    countNode.textContent = "読み込みエラー";
    groupsRoot.innerHTML = '<p class="loading">会社一覧を読み込めませんでした。公開ファイルの配置を確認してください。</p>';
  }
}

document.addEventListener("DOMContentLoaded", init);
