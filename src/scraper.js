const { chromium } = require("playwright");
const { SITES, LH_KEYWORDS } = require("./sites");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const SITE_TIMEOUT_MS = 30000;
const DAANGN_DETAIL_TIMEOUT_MS = 10000;
const DAANGN_VERIFY_CONCURRENCY = 4;
const DAANGN_BASE_URL = "https://www.daangn.com";
const DAANGN_REALTY_URL = `${DAANGN_BASE_URL}/kr/realty/`;
const DAANGN_REGION_SEARCH_URL = `${DAANGN_BASE_URL}/kr/api/v1/regions/keyword`;
const NAVER_LAND_BASE_URL = "https://new.land.naver.com";
const NAVER_LAND_HOME_URL = `${NAVER_LAND_BASE_URL}/`;
const NAVER_IMAGE_BASE_URL = "https://landthumb-phinf.pstatic.net";
const NAVER_DEFAULT_ZOOM = 16;
const NAVER_TAB_TIMEOUT_MS = 15000;
const CLOSE_TEXTS = ["닫기", "괜찮아요", "나중에", "확인", "close", "skip"];
const NEGATIVE_LH_PATTERNS = [
  // "lh 가능" 처럼 중간에 긍정 단어가 있으면 제외 (lh 가능, 일반 대출 불가 → 오탐 방지)
  /(lh|엘에이치)(?:(?!가능|됩니다|돼요|가능해|가능합)[^.!?\n]){0,18}(불가|불가능|안됨|안돼|제외|거절|불허)/i,
  /(불가|불가능|안됨|안돼|제외|거절|불허)[^.!?\n]{0,18}(lh|엘에이치)/i,
  /(일반전세자금대출만 가능|일반 전세자금대출만 가능)/i,
  // 전세자금대출/주택도시기금 불가만 negative로 처리 (일반 대출 불가 != LH 불가)
  /(전세자금대출|주택도시기금)[^.!?\n]{0,12}(불가|불가능|안됨|안돼)/i,
  /(버팀목|보증보험)[^.!?\n]{0,12}(불가|불가능|안됨|안돼)/i,
];
const STRONG_LH_PATTERNS = [
  { key: "lh_possible", pattern: /(lh|엘에이치)[^.!?\n]{0,14}(가능|됩니다|돼요|대출|전세|지원|보증보험|전문|승계|가능해요|가능합니다)/i },
  { key: "public_rental", pattern: /(전세임대|청년전세임대|매입임대)/i },
  { key: "lh_bundle", pattern: /((lh|엘에이치)[^.!?\n]{0,18}(sh|hug|hf|sgi|버팀목))|((sh|hug|hf|sgi|버팀목)[^.!?\n]{0,18}(lh|엘에이치))/i },
];
const GENERIC_BROKER_PATTERNS = [
  /이 외에도[^.!?\n]{0,80}(lh|엘에이치)/i,
  /(다양한 매물|조건에 맞는 매물)[^.!?\n]{0,80}(lh|엘에이치)/i,
  /(lh|엘에이치)[^.!?\n]{0,80}(다양한 매물|조건에 맞는 매물|연락만 주시면|상담하여 드리겠습니다)/i,
];
const PRICE_TOKEN = "(?:\\d[\\d,]*억(?:\\s*\\d[\\d,]*(?:만원)?)?|\\d[\\d,]*만원?)";
const MONTHLY_TOKEN = "\\d[\\d,]*(?:만원)?";
const PRICE_PATTERNS = [
  new RegExp(`((?:월세|전세|매매|반전세)\\s*${PRICE_TOKEN}(?:\\s*\\/\\s*${MONTHLY_TOKEN})?)`, "i"),
  new RegExp(`(${PRICE_TOKEN}\\s*\\/\\s*${MONTHLY_TOKEN})`, "i"),
  new RegExp(`(${PRICE_TOKEN})\\s*[-|·]`, "i"),
];

let browserPromise;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
    });
  }

  return browserPromise;
}

function createBrowserContext(browser) {
  return browser.newContext({
    locale: "ko-KR",
    userAgent: DEFAULT_USER_AGENT,
    viewport: DEFAULT_VIEWPORT,
  });
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitLocation(location) {
  return String(location || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function keywordMatches(text, keyword) {
  const normalized = normalizeWhitespace(text);
  const loweredKeyword = String(keyword || "").toLowerCase();

  if (!loweredKeyword) {
    return false;
  }

  if (loweredKeyword === "lh") {
    return /(^|[^a-z0-9])lh([^a-z0-9]|$)/i.test(normalized);
  }

  return normalized.toLowerCase().includes(loweredKeyword);
}

function includesAnyKeyword(text, keywords = LH_KEYWORDS) {
  return keywords.some((keyword) => keywordMatches(text, keyword));
}

function getMatchedKeyword(text, keywords = LH_KEYWORDS) {
  return keywords.find((keyword) => keywordMatches(text, keyword)) || null;
}

function collectPatternKeys(text, entries) {
  const normalized = normalizeWhitespace(text);
  return entries
    .filter((entry) => entry.pattern.test(normalized))
    .map((entry) => entry.key);
}

function matchesLocation(text, tokens) {
  if (!tokens.length) {
    return true;
  }

  return tokens.some((token) => text.includes(token));
}

function containsNegativeLhContext(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return NEGATIVE_LH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasGenericBrokerLhMention(text) {
  const normalized = normalizeWhitespace(text);
  return GENERIC_BROKER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function evaluateLhEvidence(text) {
  const normalized = normalizeWhitespace(text);
  const negative = containsNegativeLhContext(normalized);
  const strongReasons = collectPatternKeys(normalized, STRONG_LH_PATTERNS);
  const weakKeyword = getMatchedKeyword(normalized);
  const genericBrokerMention = hasGenericBrokerLhMention(normalized);

  if (negative) {
    return {
      level: "negative",
      score: -10,
      matchedKeyword: weakKeyword,
      reasons: ["negative_context"],
    };
  }

  if (strongReasons.length) {
    return {
      level: "strong",
      score: strongReasons.length * 10 + (weakKeyword ? 1 : 0),
      matchedKeyword: weakKeyword,
      reasons: strongReasons,
    };
  }

  if (genericBrokerMention) {
    return {
      level: "none",
      score: 0,
      matchedKeyword: weakKeyword,
      reasons: ["generic_broker_mention"],
    };
  }

  if (weakKeyword) {
    return {
      level: "weak",
      score: 1,
      matchedKeyword: weakKeyword,
      reasons: ["keyword_only"],
    };
  }

  return {
    level: "none",
    score: 0,
    matchedKeyword: null,
    reasons: [],
  };
}

function isLikelyLhListing(text) {
  const evidence = evaluateLhEvidence(text);
  return evidence.level === "strong" || evidence.level === "weak";
}

function stringifyValue(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item)).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map((item) => stringifyValue(item))
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

function buildListingText(...parts) {
  return normalizeWhitespace(
    parts.map((part) => stringifyValue(part)).filter(Boolean).join(" "),
  );
}

function extractPriceLabel(text) {
  const normalized = normalizeWhitespace(text);

  for (const pattern of PRICE_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return normalizeWhitespace(match[1]);
    }
  }

  return null;
}

function extractTradeTypeLabel(text) {
  const normalized = normalizeWhitespace(text);

  if (/반전세/i.test(normalized)) {
    return "반전세";
  }

  if (/월세/i.test(normalized)) {
    return "월세";
  }

  if (/전세/i.test(normalized)) {
    return "전세";
  }

  if (/매매/i.test(normalized)) {
    return "매매";
  }

  if (/\d[,\d]*(?:억(?:\s*\d[,\d]*(?:만원)?)?|만원?)\s*\/\s*\d[,\d]*(?:만원)?/.test(normalized)) {
    return "월세";
  }

  return null;
}

function extractExplicitRoomLabel(text) {
  const normalized = normalizeWhitespace(text);
  const explicitRoom = normalized.match(/방\s*(\d+)\s*개/i);

  if (explicitRoom?.[1]) {
    return `방 ${explicitRoom[1]}개`;
  }

  return null;
}

function extractRoomLabel(text) {
  const explicitRoomLabel = extractExplicitRoomLabel(text);

  if (explicitRoomLabel) {
    return explicitRoomLabel;
  }

  const normalized = normalizeWhitespace(text);

  if (/투룸이상|투룸\s*\+|투룸\+/.test(normalized)) {
    return "투룸+";
  }

  if (/투룸/.test(normalized)) {
    return "투룸";
  }

  if (/분리형 원룸|오픈형 원룸|원룸/.test(normalized)) {
    return "원룸";
  }

  return null;
}

function extractSizeLabel(text) {
  const normalized = normalizeWhitespace(text);
  const metricMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:m2|㎡)/i);

  if (metricMatch?.[1]) {
    return `${metricMatch[1]}㎡`;
  }

  const pyeongMatch = normalized.match(/(\d+(?:\.\d+)?)\s*평/i);
  return pyeongMatch?.[1] ? `${pyeongMatch[1]}평` : null;
}

function extractParkingLabel(text) {
  const normalized = normalizeWhitespace(text);
  const parkingMatch = normalized.match(/주차\s*(가능|불가능|불가)/i);

  if (!parkingMatch?.[1]) {
    return null;
  }

  return parkingMatch[1] === "가능" ? "주차 가능" : "주차 불가";
}

function parseListingFacts(...parts) {
  const texts = parts.map((part) => normalizeWhitespace(part)).filter(Boolean);
  const combined = buildListingText(...texts);
  const pickFirst = (extractor) => {
    for (const text of texts) {
      const value = extractor(text);
      if (value) {
        return value;
      }
    }

    return extractor(combined);
  };

  const priceLabel = pickFirst(extractPriceLabel);
  const tradeTypeLabel =
    pickFirst(extractTradeTypeLabel) ||
    (priceLabel ? extractTradeTypeLabel(priceLabel) : null);
  const roomLabel = pickFirst(extractExplicitRoomLabel) || pickFirst(extractRoomLabel);
  const sizeLabel = pickFirst(extractSizeLabel);
  const parkingLabel = pickFirst(extractParkingLabel);
  const summary = [priceLabel, roomLabel, sizeLabel, parkingLabel]
    .filter(Boolean)
    .join(" · ");

  return {
    tradeTypeLabel,
    priceLabel,
    roomLabel,
    sizeLabel,
    parkingLabel,
    summary,
  };
}

function buildDiagnostics(site, location, searchTriggered, candidates, filtered) {
  return {
    siteId: site.id,
    location,
    searchTriggered,
    totalCandidates: candidates.length,
    keywordCandidates: candidates.filter((candidate) =>
      isLikelyLhListing(candidate.snippet),
    ).length,
    locationMatchedCandidates: filtered.length,
  };
}

async function dismissPopups(page) {
  for (const text of CLOSE_TEXTS) {
    const locator = page.getByText(text, { exact: false }).first();

    try {
      if (await locator.isVisible({ timeout: 500 })) {
        await locator.click({ timeout: 1000 });
      }
    } catch (error) {
      // Best effort only.
    }
  }
}

function getLocationTokens(location) {
  return splitLocation(location);
}

function getPrimaryDongKeyword(location) {
  const tokens = getLocationTokens(location);
  const dongToken = [...tokens]
    .reverse()
    .find((token) => /(읍|면|동|가|리)$/.test(token));

  return dongToken || tokens[tokens.length - 1] || location;
}

async function fillSearchBox(page, location) {
  const selectors = [
    'input[type="search"]',
    'input[name*="search"]',
    'input[placeholder*="지역"]',
    'input[placeholder*="동"]',
    'input[placeholder*="주소"]',
    'input[placeholder*="검색"]',
    'input[aria-label*="검색"]',
    "input",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (!(await locator.isVisible({ timeout: 800 }))) {
        continue;
      }

      await locator.click({ timeout: 1500 });
      await locator.fill("");
      await locator.fill(location, { timeout: 2000 });
      await page.waitForTimeout(400);
      await locator.press("Enter");
      return true;
    } catch (error) {
      // Try the next possible search box.
    }
  }

  return false;
}

async function collectCandidateLinks(page, site, locationTokens) {
  const candidates = await page.evaluate(
    ({ keywords, baseUrl }) => {
      const makeAbsolute = (href) => {
        try {
          return new URL(href, baseUrl).toString();
        } catch (error) {
          return null;
        }
      };

      return Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => {
          const href = anchor.getAttribute("href");
          const text = (anchor.innerText || anchor.textContent || "").trim();
          const card =
            anchor.closest("article, li, div, section") || anchor.parentElement;
          const cardText = (card?.innerText || "").trim();
          const mergedText = `${text} ${cardText}`.replace(/\s+/g, " ").trim();
          const matchedKeyword =
            keywords.find((keyword) =>
              mergedText.toLowerCase().includes(keyword.toLowerCase()),
            ) || null;

          return {
            href: makeAbsolute(href),
            title: text,
            snippet: mergedText,
            matchedKeyword,
          };
        })
        .filter((item) => item.href && item.snippet);
    },
    {
      keywords: LH_KEYWORDS,
      baseUrl: site.url,
    },
  );

  const filtered = candidates.filter((candidate) => {
    const text = normalizeWhitespace(candidate.snippet);
    return isLikelyLhListing(text) && matchesLocation(text, locationTokens);
  });

  const unique = new Map();

  for (const item of filtered) {
    if (!unique.has(item.href)) {
      unique.set(item.href, {
        siteId: site.id,
        siteName: site.name,
        title: normalizeWhitespace(item.title) || `${site.name} 매물`,
        snippet: normalizeWhitespace(item.snippet),
        link: item.href,
        matchedKeyword: item.matchedKeyword || getMatchedKeyword(item.snippet) || "LH",
        ...parseListingFacts(item.title, item.snippet),
      });
    }
  }

  return {
    candidates,
    filtered,
    items: Array.from(unique.values()).slice(0, 12),
  };
}

async function fetchJson(url, options = {}) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent": DEFAULT_USER_AGENT,
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchText(url, options = {}) {
  const headers = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent": DEFAULT_USER_AGENT,
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractDaangnDescriptionFromHtml(html) {
  const jsonLd = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i,
  );

  if (jsonLd) {
    try {
      const data = JSON.parse(decodeHtmlEntities(jsonLd[1]));
      if (typeof data?.description === "string" && data.description.trim()) {
        return normalizeWhitespace(data.description);
      }
    } catch (error) {
      // Fall through to meta description parsing.
    }
  }

  const meta =
    html.match(
      /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i,
    ) ||
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i);

  return meta ? normalizeWhitespace(decodeHtmlEntities(meta[1])) : "";
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await iteratee(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

function pickDaangnRegion(locations, locationTokens) {
  if (!Array.isArray(locations) || !locations.length) {
    return null;
  }

  const scored = locations.map((location) => {
    const serialized = buildListingText(location).toLowerCase();
    const score = locationTokens.reduce((count, token) => {
      return count + (serialized.includes(token.toLowerCase()) ? 1 : 0);
    }, 0);

    return { location, score };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.location || locations[0];
}

function mapDaangnListing(site, post) {
  const linkPath =
    typeof post?.id === "string"
      ? post.id
      : typeof post?.url === "string"
        ? post.url
        : typeof post?.path === "string"
          ? post.path
          : null;

  if (!linkPath) {
    return null;
  }

  const snippet = buildListingText(
    post.title,
    post.content,
    post.address,
    post.region,
    post.searchRegion,
  );

  if (!snippet) {
    return null;
  }

  return {
    siteId: site.id,
    siteName: site.name,
    title: normalizeWhitespace(post.title) || `${site.name} 매물`,
    snippet,
    link: new URL(linkPath, DAANGN_BASE_URL).toString(),
    imageUrl: Array.isArray(post.images) && post.images.length ? post.images[0] : null,
    matchedKeyword: getMatchedKeyword(snippet) || "LH",
    ...parseListingFacts(post.title, snippet),
  };
}

async function verifyDaangnCandidate(candidate) {
  let detailDescription = "";
  let verificationError = null;

  try {
    const html = await fetchText(candidate.link, {
      headers: {
        referer: DAANGN_REALTY_URL,
      },
      signal: AbortSignal.timeout(DAANGN_DETAIL_TIMEOUT_MS),
    });
    detailDescription = extractDaangnDescriptionFromHtml(html);
  } catch (error) {
    verificationError = error.message;
  }

  const verificationText = buildListingText(candidate.snippet, detailDescription);
  const evidence = evaluateLhEvidence(verificationText);

  return {
    ...candidate,
    detailDescription,
    verificationText,
    verificationLevel: evidence.level,
    evidenceScore: evidence.score,
    evidenceReasons: evidence.reasons,
    matchedKeyword: evidence.matchedKeyword || candidate.matchedKeyword || "LH",
    detailVerified: Boolean(detailDescription),
    verificationError,
    ...parseListingFacts(candidate.title, candidate.snippet, detailDescription),
  };
}

async function searchDaangn(site, location) {
  const locationTokens = getLocationTokens(location);

  try {
    const regionUrl = new URL(DAANGN_REGION_SEARCH_URL);
    regionUrl.searchParams.set("keyword", location);

    const regionPayload = await fetchJson(regionUrl.toString(), {
      headers: {
        referer: DAANGN_REALTY_URL,
      },
    });

    const region = pickDaangnRegion(regionPayload?.locations, locationTokens);

    if (!region?.id) {
      throw new Error("검색 지역을 찾지 못했습니다.");
    }

    const searchedUrl = `${DAANGN_REALTY_URL}?in=x-${region.id}`;
    const dataUrl = new URL(DAANGN_REALTY_URL);
    dataUrl.searchParams.set("in", `x-${region.id}`);
    dataUrl.searchParams.set("_data", "routes/kr.realty._index");

    const payload = await fetchJson(dataUrl.toString(), {
      headers: {
        referer: searchedUrl,
      },
    });

    const posts = Array.isArray(payload?.realtyPosts?.realtyPosts)
      ? payload.realtyPosts.realtyPosts
      : [];

    const candidates = posts
      .map((post) => mapDaangnListing(site, post))
      .filter(Boolean);

    const locationMatched = candidates.filter((candidate) =>
      matchesLocation(candidate.snippet, locationTokens),
    );
    const keywordCandidates = locationMatched.filter((candidate) =>
      includesAnyKeyword(candidate.snippet, LH_KEYWORDS),
    );
    const verifiedCandidates = await mapWithConcurrency(
      keywordCandidates,
      DAANGN_VERIFY_CONCURRENCY,
      verifyDaangnCandidate,
    );
    const filtered = verifiedCandidates
      .filter((candidate) => candidate.verificationLevel !== "negative")
      .filter((candidate) => candidate.verificationLevel !== "none")
      .sort((left, right) => right.evidenceScore - left.evidenceScore);

    const unique = new Map();

    for (const item of filtered) {
      if (!unique.has(item.link)) {
        unique.set(item.link, item);
      }
    }

    const regionLabel = buildListingText(region.name2, region.name3);

    return {
      siteId: site.id,
      siteName: site.name,
      status: unique.size ? "ok" : "empty",
      searchedUrl,
      count: unique.size,
      results: Array.from(unique.values()).slice(0, 20),
      diagnostics: buildDiagnostics(
        site,
        location,
        true,
        candidates,
        filtered,
      ),
      note: `당근 API + 상세 검증 사용 (${regionLabel || location}, region ${region.id}, detail ${verifiedCandidates.length}건 확인)`,
    };
  } catch (error) {
    return {
      siteId: site.id,
      siteName: site.name,
      status: "error",
      searchedUrl: site.url,
      count: 0,
      results: [],
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: false,
        totalCandidates: 0,
        keywordCandidates: 0,
        locationMatchedCandidates: 0,
      },
      note: error.message,
    };
  }
}

function buildNaverImageUrl(path, thumb = "f130_98") {
  if (!path) {
    return null;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const suffix = thumb ? `?type=${encodeURIComponent(thumb)}` : "";
  return `${NAVER_IMAGE_BASE_URL}${normalizedPath}${suffix}`;
}

function formatNaverDealLabel(article) {
  const dealPrice = normalizeWhitespace(article?.dealOrWarrantPrc);
  const rentPrice = normalizeWhitespace(article?.rentPrc);

  if (article?.tradeTypeCode === "B2" && dealPrice && rentPrice) {
    return `${dealPrice}/${rentPrice}`;
  }

  return dealPrice || rentPrice || null;
}

function mapNaverListing(site, region, tab, article) {
  const title = normalizeWhitespace(
    buildListingText(
      article?.articleName,
      article?.realEstateTypeName,
      article?.tradeTypeName,
      formatNaverDealLabel(article),
    ),
  );
  const snippet = normalizeWhitespace(
    buildListingText(
      region?.cortarName,
      article?.articleFeatureDesc,
      article?.tagList,
      article?.floorInfo,
      article?.direction,
    ),
  );
  const combinedText = buildListingText(title, snippet);
  const evidence = evaluateLhEvidence(combinedText);
  const priceLabel = article?.tradeTypeName
    ? normalizeWhitespace(
        buildListingText(article.tradeTypeName, formatNaverDealLabel(article)),
      )
    : formatNaverDealLabel(article);
  const roomLabel =
    article?.tagList?.find((tag) => /방/.test(String(tag))) || null;
  const parkingLabel = article?.tagList?.includes("주차가능")
    ? "주차 가능"
    : article?.tagList?.includes("주차불가")
      ? "주차 불가"
      : null;
  const sizeLabel =
    Number(article?.area2) > 0
      ? `${article.area2}㎡`
      : Number(article?.area1) > 0
        ? `${article.area1}㎡`
        : null;
  const link = `${NAVER_LAND_BASE_URL}/${tab.path}?ms=${region.centerLat},${region.centerLon},${NAVER_DEFAULT_ZOOM}&${tab.query}&articleNo=${article.articleNo}`;

  return {
    siteId: site.id,
    siteName: site.name,
    sourceTab: tab.id,
    articleNo: article?.articleNo,
    title,
    snippet,
    link,
    imageUrl: buildNaverImageUrl(
      article?.representativeImgUrl,
      article?.representativeImgThumb,
    ),
    matchedKeyword: evidence.matchedKeyword,
    verificationLevel: evidence.level,
    detailVerified: false,
    tradeTypeLabel: article?.tradeTypeName || null,
    priceLabel,
    roomLabel,
    sizeLabel,
    parkingLabel,
    summary: [
      article?.tradeTypeName || null,
      priceLabel ? priceLabel.replace(/^.{0,3}\s/, "") : null,
      roomLabel,
      sizeLabel,
      parkingLabel,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

async function fetchNaverRegion(page, location) {
  return page.evaluate(async (keyword) => {
    const response = await fetch(
      `/api/search?keyword=${encodeURIComponent(keyword)}`,
      {
        credentials: "include",
      },
    );
    const payload = await response.json().catch(() => null);

    return {
      status: response.status,
      payload,
    };
  }, location);
}

function pickNaverRegion(location, payload) {
  const tokens = getLocationTokens(location);
  const regions = Array.isArray(payload?.regions) ? payload.regions : [];
  const complexes = Array.isArray(payload?.complexes) ? payload.complexes : [];

  const matchedRegion =
    regions.find((region) =>
      tokens.every((token) => String(region?.cortarName || "").includes(token)),
    ) || regions[0];

  if (matchedRegion) {
    return matchedRegion;
  }

  const complex = complexes.find((item) =>
    tokens.every((token) => String(item?.cortarAddress || "").includes(token)),
  );

  if (!complex) {
    return null;
  }

  return {
    cortarNo: complex.cortarNo,
    centerLat: complex.latitude,
    centerLon: complex.longitude,
    cortarName: complex.cortarAddress,
  };
}

async function fetchNaverArticleList(page, region, tab) {
  const waitForArticles = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      response.url().includes("/api/articles?") &&
      response.url().includes(`cortarNo=${region.cortarNo}`),
    {
      timeout: NAVER_TAB_TIMEOUT_MS,
    },
  );

  const targetUrl = `${NAVER_LAND_BASE_URL}/${tab.path}?ms=${region.centerLat},${region.centerLon},${NAVER_DEFAULT_ZOOM}&${tab.query}`;
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const response = await waitForArticles;
  const payload = await response.json();

  return {
    searchedUrl: targetUrl,
    payload,
  };
}

async function searchNaverLand(site, location) {
  const browser = await getBrowser();
  const context = await createBrowserContext(browser);
  const page = await context.newPage();
  const locationTokens = getLocationTokens(location);
  const tabs = [
    {
      id: "houses",
      path: "houses",
      query: "a=VL:DDDGG:JWJT:SGJT&b=B1:B2:A1&e=RETAIL",
    },
    {
      id: "rooms",
      path: "rooms",
      query: "e=RETAIL",
    },
  ];

  try {
    await page.goto(NAVER_LAND_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const regionSearch = await fetchNaverRegion(page, location);

    if (regionSearch.status !== 200 || !regionSearch.payload) {
      throw new Error(`naver search failed: ${regionSearch.status}`);
    }

    const region = pickNaverRegion(location, regionSearch.payload);

    if (!region?.cortarNo) {
      return {
        siteId: site.id,
        siteName: site.name,
        status: "empty",
        searchedUrl: NAVER_LAND_HOME_URL,
        count: 0,
        results: [],
        diagnostics: {
          siteId: site.id,
          location,
          searchTriggered: true,
          totalCandidates: 0,
          keywordCandidates: 0,
          locationMatchedCandidates: 0,
        },
        note: "네이버 지역 검색에서 대상 법정동을 찾지 못했습니다.",
      };
    }

    const tabResults = [];

    for (const tab of tabs) {
      try {
        const { searchedUrl, payload } = await fetchNaverArticleList(
          page,
          region,
          tab,
        );
        const articleList = Array.isArray(payload?.articleList)
          ? payload.articleList
          : [];
        const candidates = articleList.map((article) =>
          mapNaverListing(site, region, tab, article),
        );
        const locationMatched = candidates.filter((candidate) =>
          matchesLocation(candidate.snippet, locationTokens),
        );
        const filtered = locationMatched.filter((candidate) =>
          candidate.verificationLevel === "strong" ||
          candidate.verificationLevel === "weak",
        );

        tabResults.push({
          tab,
          searchedUrl,
          candidates,
          filtered,
        });
      } catch (error) {
        tabResults.push({
          tab,
          searchedUrl: `${NAVER_LAND_BASE_URL}/${tab.path}`,
          candidates: [],
          filtered: [],
          error: error.message,
        });
      }
    }

    const merged = [];
    const unique = new Map();

    for (const tabResult of tabResults) {
      for (const item of tabResult.filtered) {
        if (!unique.has(item.articleNo)) {
          unique.set(item.articleNo, item);
          merged.push(item);
        }
      }
    }

    const totalCandidates = tabResults.reduce(
      (sum, tabResult) => sum + tabResult.candidates.length,
      0,
    );
    const keywordCandidates = tabResults.reduce(
      (sum, tabResult) =>
        sum +
        tabResult.candidates.filter(
          (candidate) => candidate.verificationLevel !== "none",
        ).length,
      0,
    );

    return {
      siteId: site.id,
      siteName: site.name,
      status: merged.length ? "ok" : "empty",
      searchedUrl:
        tabResults.find((tabResult) => tabResult.filtered.length)?.searchedUrl ||
        `${NAVER_LAND_BASE_URL}/houses`,
      count: merged.length,
      results: merged.slice(0, 20),
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: true,
        totalCandidates,
        keywordCandidates,
        locationMatchedCandidates: merged.length,
      },
      note: `네이버 어댑터 사용 (${region.cortarName}, houses/rooms ${tabResults.length}개 탭 수집)`,
    };
  } catch (error) {
    return {
      siteId: site.id,
      siteName: site.name,
      status: "error",
      searchedUrl: NAVER_LAND_HOME_URL,
      count: 0,
      results: [],
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: false,
        totalCandidates: 0,
        keywordCandidates: 0,
        locationMatchedCandidates: 0,
      },
      note: error.message,
    };
  } finally {
    await context.close();
  }
}

async function searchSingleSite(site, location) {
  if (site.id === "peterpan") {
    return searchPeterpan(site, location);
  }

  if (site.id === "daangn") {
    return searchDaangn(site, location);
  }

  if (site.id === "naver-land") {
    return searchNaverLand(site, location);
  }

  const browser = await getBrowser();
  const context = await createBrowserContext(browser);
  const page = await context.newPage();
  const locationTokens = splitLocation(location);

  try {
    await page.goto(site.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(1500);
    await dismissPopups(page);

    const searchTriggered = await fillSearchBox(page, location);

    if (searchTriggered) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(
        () => {},
      );
      await page.waitForTimeout(2500);
    }

    const collected = await collectCandidateLinks(page, site, locationTokens);
    const diagnostics = buildDiagnostics(
      site,
      location,
      searchTriggered,
      collected.candidates,
      collected.filtered,
    );

    return {
      siteId: site.id,
      siteName: site.name,
      status: collected.items.length ? "ok" : "empty",
      searchedUrl: page.url(),
      count: collected.items.length,
      results: collected.items,
      diagnostics,
      note: searchTriggered
        ? null
        : "검색 입력창을 자동으로 찾지 못해 현재 보이는 화면 기준으로만 LH 키워드를 수집했습니다.",
    };
  } catch (error) {
    return {
      siteId: site.id,
      siteName: site.name,
      status: "error",
      searchedUrl: site.url,
      count: 0,
      results: [],
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: false,
        totalCandidates: 0,
        keywordCandidates: 0,
        locationMatchedCandidates: 0,
      },
      note: error.message,
    };
  } finally {
    await context.close();
  }
}

async function searchSingleSiteWithTimeout(site, location) {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        siteId: site.id,
        siteName: site.name,
        status: "error",
        searchedUrl: site.url,
        count: 0,
        results: [],
        diagnostics: {
          siteId: site.id,
          location,
          searchTriggered: false,
          totalCandidates: 0,
          keywordCandidates: 0,
          locationMatchedCandidates: 0,
        },
        note: `사이트 응답이 ${SITE_TIMEOUT_MS / 1000}초를 넘겨 자동 중단했습니다.`,
      });
    }, SITE_TIMEOUT_MS);
  });

  return Promise.race([searchSingleSite(site, location), timeoutPromise]);
}

async function searchPeterpan(site, location) {
  const browser = await getBrowser();
  const context = await createBrowserContext(browser);
  const page = await context.newPage();
  const locationTokens = getLocationTokens(location);
  const searchKeyword = getPrimaryDongKeyword(location);

  try {
    await page.goto(site.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(1500);
    await dismissPopups(page);

    await page.fill("#search", searchKeyword, { timeout: 3000 });
    await page.waitForTimeout(1000);
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(4000);

    const cards = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".a-house[data-hidx]")).map(
        (card) => {
          const text = (card.innerText || "").replace(/\s+/g, " ").trim();
          const hidx = card.getAttribute("data-hidx");
          const sigungu = card.getAttribute("data-duse-sigungu") || "";
          const dong = card.getAttribute("data-duse-dong") || "";
          const title =
            card.querySelector(".m-content__description")?.textContent?.trim() ||
            card.querySelector(".m-content__price")?.textContent?.trim() ||
            "피터팬 매물";

          return {
            hidx,
            title,
            sigungu,
            dong,
            snippet: text,
            imageUrl:
              card.querySelector("img")?.getAttribute("src") ||
              card.querySelector("img")?.getAttribute("data-src") ||
              null,
          };
        },
      );
    });

    const filtered = cards.filter((card) => {
      const mergedLocation = `${card.sigungu} ${card.dong}`.trim();
      const combinedText = buildListingText(
        mergedLocation,
        card.title,
        card.snippet,
      );

      return (
        isLikelyLhListing(combinedText) &&
        matchesLocation(combinedText, locationTokens)
      );
    });

    const results = filtered.slice(0, 20).map((card) => {
      const mergedLocation = `${card.sigungu} ${card.dong}`.trim();
      const combinedText = buildListingText(mergedLocation, card.title, card.snippet);
      const evidence = evaluateLhEvidence(combinedText);
      return {
        siteId: site.id,
        siteName: site.name,
        title: normalizeWhitespace(card.title),
        snippet: normalizeWhitespace(card.snippet),
        link: `https://www.peterpanz.com/house/${card.hidx}`,
        imageUrl: card.imageUrl,
        matchedKeyword: evidence.matchedKeyword || getMatchedKeyword(card.snippet) || "LH",
        verificationLevel: evidence.level,
        evidenceScore: evidence.score,
        evidenceReasons: evidence.reasons,
        detailVerified: false,
        ...parseListingFacts(card.title, card.snippet),
      };
    });

    return {
      siteId: site.id,
      siteName: site.name,
      status: results.length ? "ok" : "empty",
      searchedUrl: page.url(),
      count: results.length,
      results,
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: true,
        totalCandidates: cards.length,
        keywordCandidates: cards.filter((card) =>
          isLikelyLhListing(card.snippet),
        ).length,
        locationMatchedCandidates: filtered.length,
      },
      note: `피터팬 전용 수집기 사용 (${searchKeyword})`,
    };
  } catch (error) {
    return {
      siteId: site.id,
      siteName: site.name,
      status: "error",
      searchedUrl: site.url,
      count: 0,
      results: [],
      diagnostics: {
        siteId: site.id,
        location,
        searchTriggered: false,
        totalCandidates: 0,
        keywordCandidates: 0,
        locationMatchedCandidates: 0,
      },
      note: error.message,
    };
  } finally {
    await context.close();
  }
}

function parsePriceLabelToManwon(priceLabel) {
  if (!priceLabel) {
    return null;
  }

  // 거래 유형 접두어 제거 후 보증금 부분만 추출 (/ 이후 월세 제외)
  const raw = normalizeWhitespace(priceLabel)
    .replace(/^(전세|월세|매매|반전세)\s*/i, "")
    .split("/")[0]
    .trim();

  let total = 0;

  const eokMatch = raw.match(/(\d[\d,]*)억/);
  if (eokMatch) {
    total += parseInt(eokMatch[1].replace(/,/g, ""), 10) * 10000;
  }

  // 억 뒤의 만원 단위 or 단독 만원 단위
  const manwonMatch =
    raw.match(/억\s*(\d[\d,]*)(?:만원?)?$/) ||
    raw.match(/^(\d[\d,]*)(?:만원?)?$/);
  const trailing = manwonMatch?.[1];

  if (trailing) {
    total += parseInt(trailing.replace(/,/g, ""), 10);
  }

  return total > 0 ? total : null;
}

function applyPriceConstraint(items, maxPriceManwon) {
  if (!maxPriceManwon || !Number.isFinite(maxPriceManwon) || maxPriceManwon <= 0) {
    return items;
  }

  const annotated = items.map((item) => {
    const priceManwon = parsePriceLabelToManwon(item.priceLabel);
    const priceExceeded = priceManwon !== null && priceManwon > maxPriceManwon;
    return { ...item, priceManwon, priceExceeded };
  });

  // 예산 내 매물 먼저, 초과 매물 하단 배치
  return [
    ...annotated.filter((item) => !item.priceExceeded),
    ...annotated.filter((item) => item.priceExceeded),
  ];
}

async function searchListings(location, maxPrice) {
  const startedAt = new Date().toISOString();
  const siteResults = await Promise.all(
    SITES.map((site) => searchSingleSiteWithTimeout(site, location)),
  );
  const rawItems = siteResults.flatMap((siteResult) => siteResult.results);
  const maxPriceManwon = Number(maxPrice) || null;
  const items = applyPriceConstraint(rawItems, maxPriceManwon);
  const exceededCount = items.filter((item) => item.priceExceeded).length;

  return {
    location,
    startedAt,
    totalCount: items.length,
    maxPrice: maxPriceManwon,
    exceededCount,
    sites: siteResults,
    items,
  };
}

module.exports = {
  containsNegativeLhContext,
  includesAnyKeyword,
  isLikelyLhListing,
  matchesLocation,
  normalizeWhitespace,
  parseListingFacts,
  parsePriceLabelToManwon,
  splitLocation,
  searchListings,
};
