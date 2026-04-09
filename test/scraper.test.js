const test = require("node:test");
const assert = require("node:assert/strict");

const {
  containsNegativeLhContext,
  includesAnyKeyword,
  isLikelyLhListing,
  matchesLocation,
  normalizeWhitespace,
  parseListingFacts,
  splitLocation,
} = require("../src/scraper");

test("splitLocation keeps meaningful location tokens", () => {
  assert.deepEqual(splitLocation("관악구 봉천동"), ["관악구", "봉천동"]);
});

test("normalizeWhitespace collapses repeated spaces and newlines", () => {
  assert.equal(normalizeWhitespace("  LH   가능\n봉천동 "), "LH 가능 봉천동");
});

test("includesAnyKeyword matches LH phrases case-insensitively", () => {
  assert.equal(
    includesAnyKeyword("신혼부부 LH 전세임대 가능", ["lh 전세", "매입임대"]),
    true,
  );
  assert.equal(includesAnyKeyword("일반 전세 매물", ["lh 매물"]), false);
  assert.equal(includesAnyKeyword("카카오톡 문의 ID : lhb5822", ["lh"]), false);
});

test("matchesLocation accepts a listing when any location token is present", () => {
  assert.equal(matchesLocation("관악구 봉천동 LH 가능", ["관악구", "봉천동"]), true);
  assert.equal(matchesLocation("강남구 역삼동 매물", ["관악구", "봉천동"]), false);
});

test("containsNegativeLhContext detects blocked LH cases", () => {
  assert.equal(containsNegativeLhContext("일반전세자금대출만 가능, LH 불가"), true);
  assert.equal(containsNegativeLhContext("버팀목 불가 / 보증보험 불가"), true);
  // "대출 불가능" 단독은 일반 은행 대출을 의미할 수 있어 LH 불가와 동일하지 않음.
  // LH 관련 전세자금대출 불가를 명시하는 경우만 negative로 처리.
  assert.equal(containsNegativeLhContext("전세자금대출 불가능, 즉시 입주 가능"), true);
  assert.equal(containsNegativeLhContext("LH 가능, 보증보험 가입 가능"), false);
});

test("isLikelyLhListing rejects negative context and keeps positive cases", () => {
  assert.equal(isLikelyLhListing("서울대입구역 인근, LH SH 모든 대출 가능"), true);
  assert.equal(isLikelyLhListing("낙성대역 인근, 일반전세자금대출만 가능, LH 불가"), false);
  assert.equal(
    isLikelyLhListing(
      "대출 불가능, 즉시 가능. 이 외에도 신축 원룸, 투룸, LH, 중기청 원룸 등 다양한 매물이 준비되있으니 연락만주시면 상담해 드리겠습니다.",
    ),
    false,
  );
});

test("parseListingFacts extracts price, room count, area, and parking", () => {
  assert.deepEqual(
    parseListingFacts(
      "봉천역 도보 8분 투룸 빌라 반전세 전세보증보험+Lh대출 가능",
      "월세 1억 1,300/35 관악구 봉천동 빌라 방 2개 3층 36.16m2 주차 가능",
    ),
    {
      tradeTypeLabel: "반전세",
      priceLabel: "월세 1억 1,300/35",
      roomLabel: "방 2개",
      sizeLabel: "36.16㎡",
      parkingLabel: "주차 가능",
      summary: "월세 1억 1,300/35 · 방 2개 · 36.16㎡ · 주차 가능",
    },
  );
});
