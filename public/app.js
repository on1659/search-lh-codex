const form = document.querySelector("#search-form");
const locationInput = document.querySelector("#location");
const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const resultsEl = document.querySelector("#results");
const siteStatusEl = document.querySelector("#site-status");
const siteTableBodyEl = document.querySelector("#site-table-body");
const resultTemplate = document.querySelector("#result-template");

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatStatusLabel(status) {
  switch (status) {
    case "ok":
      return "성공";
    case "empty":
      return "없음";
    case "error":
      return "오류";
    default:
      return status || "-";
  }
}

function getTradeTagClass(tradeTypeLabel) {
  switch (tradeTypeLabel) {
    case "월세":
      return "is-trade-monthly";
    case "전세":
      return "is-trade-jeonse";
    case "매매":
      return "is-trade-sale";
    case "반전세":
      return "is-trade-half";
    default:
      return "";
  }
}

function getAreaTagStyle(sizeLabel) {
  const value = Number.parseFloat(String(sizeLabel || "").replace(/[^\d.]/g, ""));

  if (!Number.isFinite(value)) {
    return "";
  }

  const ratio = Math.max(0, Math.min(1, (value - 15) / 85));
  const bgAlpha = (0.1 + ratio * 0.24).toFixed(2);
  const borderAlpha = (0.16 + ratio * 0.28).toFixed(2);

  return `--tag-bg: rgba(18, 132, 118, ${bgAlpha}); --tag-border: rgba(18, 132, 118, ${borderAlpha}); --tag-fg: #0f5f56;`;
}

function getPriceTagStyle(priceLabel) {
  const raw = String(priceLabel || "").replace(/\s+/g, "");
  let score = 0;

  const eokMatch = raw.match(/(\d[\d,]*)억/);
  if (eokMatch?.[1]) {
    score += Number.parseFloat(eokMatch[1].replaceAll(",", "")) * 10000;
  }

  const manwonMatch = raw.match(/억(\d[\d,]*)(?:만원)?|^(\d[\d,]*)(?:만원)/);
  const trailing = manwonMatch?.[1] || manwonMatch?.[2];
  if (trailing) {
    score += Number.parseFloat(trailing.replaceAll(",", ""));
  }

  const monthlyMatch = raw.match(/\/(\d[\d,]*)(?:만원)?/);
  if (monthlyMatch?.[1]) {
    score += Number.parseFloat(monthlyMatch[1].replaceAll(",", "")) * 2;
  }

  if (!Number.isFinite(score) || score <= 0) {
    return "";
  }

  const ratio = Math.max(0, Math.min(1, score / 40000));
  const bgAlpha = (0.1 + ratio * 0.24).toFixed(2);
  const borderAlpha = (0.16 + ratio * 0.26).toFixed(2);

  return `--tag-bg: rgba(124, 58, 237, ${bgAlpha}); --tag-border: rgba(124, 58, 237, ${borderAlpha}); --tag-fg: #6d28d9;`;
}

function buildResultTags(item) {
  const tags = [];
  const priceTag =
    item.tradeTypeLabel && item.priceLabel?.startsWith(item.tradeTypeLabel)
      ? item.priceLabel.slice(item.tradeTypeLabel.length).trim()
      : item.priceLabel;

  if (item.tradeTypeLabel) {
    tags.push({
      label: item.tradeTypeLabel,
      className: `is-primary ${getTradeTagClass(item.tradeTypeLabel)}`.trim(),
    });
  }

  if (priceTag) {
    tags.push({
      label: priceTag,
      className: "is-price",
      style: getPriceTagStyle(priceTag),
    });
  }

  if (item.roomLabel) {
    tags.push({ label: item.roomLabel, className: "is-room" });
  }

  if (item.sizeLabel) {
    tags.push({
      label: item.sizeLabel,
      className: "is-size",
      style: getAreaTagStyle(item.sizeLabel),
    });
  }

  if (item.parkingLabel) {
    tags.push({
      label: item.parkingLabel,
      className: item.parkingLabel.includes("불가")
        ? "is-parking-no"
        : "is-parking-yes",
    });
  }

  if (item.matchedKeyword) {
    tags.push({
      label: item.verificationLevel === "strong" ? "LH 가능" : "LH",
      className: "is-lh",
    });
  }

  return tags;
}

function setLoading(isLoading, location) {
  statusEl.textContent = isLoading
    ? `${location} 검색 중입니다. 사이트별 수집기를 순서대로 확인하고 있어요.`
    : "검색 완료";
}

function renderSummary(data) {
  summaryEl.innerHTML = `
    <strong>${escapeHtml(data.location)}</strong> 기준으로
    <strong>${data.totalCount}건</strong>의 LH 관련 링크를 찾았습니다.
  `;
}

function renderResults(items) {
  resultsEl.innerHTML = "";

  if (!items.length) {
    resultsEl.innerHTML = `
      <article class="result-card">
        <h2 class="result-title">찾은 LH 관련 링크가 없습니다.</h2>
        <p class="result-snippet">
          사이트 구조 변경, 봇 차단, 검색어 불일치 때문에 결과가 비어 있을 수 있습니다.
          아래 검증표에서 어떤 사이트가 비었는지 바로 확인해 보세요.
        </p>
      </article>
    `;
    return;
  }

  for (const item of items) {
    const node = resultTemplate.content.firstElementChild.cloneNode(true);
    const imageWrap = node.querySelector(".result-image-wrap");
    const image = node.querySelector(".result-image");

    if (item.imageUrl) {
      image.src = item.imageUrl;
      image.alt = item.title || `${item.siteName} 매물 이미지`;
    } else {
      imageWrap.remove();
    }

    node.querySelector(".result-site").textContent = item.siteName;
    const tagsEl = node.querySelector(".result-tags");
    tagsEl.innerHTML = buildResultTags(item)
      .map(
        (tag) =>
          `<span class="result-tag ${tag.className}"${
            tag.style ? ` style="${tag.style}"` : ""
          }>${escapeHtml(tag.label)}</span>`,
      )
      .join("");
    node.querySelector(".result-title").textContent = item.title;
    node.querySelector(".result-snippet").textContent = item.snippet;

    const link = node.querySelector(".result-link");
    link.href = item.link;
    link.textContent = item.matchedKeyword
      ? `매물 보기 · ${item.matchedKeyword}`
      : "매물 보기";

    resultsEl.appendChild(node);
  }
}

function renderSiteTable(sites) {
  if (!sites.length) {
    siteTableBodyEl.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">표시할 사이트 결과가 없습니다.</td>
      </tr>
    `;
    return;
  }

  siteTableBodyEl.innerHTML = sites
    .map((site) => {
      const diagnostics = site.diagnostics || {};

      return `
        <tr>
          <td>${escapeHtml(site.siteName)}</td>
          <td>${escapeHtml(formatStatusLabel(site.status))}</td>
          <td>${diagnostics.searchTriggered ? "예" : "아니오"}</td>
          <td>${diagnostics.totalCandidates || 0}</td>
          <td>${diagnostics.keywordCandidates || 0}</td>
          <td>${diagnostics.locationMatchedCandidates || 0}</td>
          <td>${site.count || 0}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSiteStatuses(sites) {
  siteStatusEl.innerHTML = "";

  if (!sites.length) {
    siteStatusEl.innerHTML = `
      <article class="site-status-item">
        <p class="site-note">검색 전입니다.</p>
      </article>
    `;
    return;
  }

  for (const site of sites) {
    const diagnostics = site.diagnostics || {};
    const article = document.createElement("article");
    article.className = "site-status-item";
    article.innerHTML = `
      <div class="site-head">
        <strong>${escapeHtml(site.siteName)}</strong>
        <span class="site-badge ${escapeHtml(site.status)}">${escapeHtml(
          formatStatusLabel(site.status),
        )}</span>
      </div>
      <p class="site-note">결과 ${site.count}건</p>
      <p class="site-note">
        후보 ${diagnostics.totalCandidates || 0}건 · LH 후보 ${
          diagnostics.keywordCandidates || 0
        }건 · 위치 일치 ${diagnostics.locationMatchedCandidates || 0}건
      </p>
      <p class="site-note">${escapeHtml(site.note || site.searchedUrl || "")}</p>
    `;
    siteStatusEl.appendChild(article);
  }
}

function resetTableForLoading() {
  siteTableBodyEl.innerHTML = `
    <tr class="empty-row">
      <td colspan="7">검색 중입니다.</td>
    </tr>
  `;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const location = locationInput.value.trim();
  if (!location) {
    locationInput.focus();
    return;
  }

  setLoading(true, location);
  summaryEl.textContent = "검색 준비 중";
  resultsEl.innerHTML = "";
  siteStatusEl.innerHTML = "";
  resetTableForLoading();

  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ location }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "검색 실패");
    }

    renderSummary(data);
    renderResults(data.items);
    renderSiteTable(data.sites);
    renderSiteStatuses(data.sites);
    setLoading(false, location);
  } catch (error) {
    statusEl.textContent = "검색 실패";
    summaryEl.textContent = error.message;
    siteTableBodyEl.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">${escapeHtml(error.message)}</td>
      </tr>
    `;
  }
});
