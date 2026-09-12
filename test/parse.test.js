/**
 * 解析器单元测试。
 * fixture 为 Steam 商店 `/search/results/` 真实返回结构的精简样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  parseCurrency,
  parsePriceToMinor,
  parseReviewStats,
  parseSearchResults,
  parseSearchRow,
} from '../src/parse.js';
import { FREE_TYPE } from '../src/model.js';

/** 一个"永久免费"条目（F2P）：discount_final_price free，无折扣标记 */
const F2P_ROW = `<a href="https://store.steampowered.com/app/730/CounterStrike_2/?snr=1_7_7_230_150_1"
			 data-ds-appid="730" data-ds-itemkey="App_730" data-ds-tagids="[1663,1774]" data-ds-descids="[2,5]" class="search_result_row ds_collapse_flag "
            <div class="search_capsule"><img src="https://cdn.example.com/730/capsule_231x87.jpg" ></div>
            <div class="responsive_search_name_combined">
                <div class="search_name ellipsis">
                    <span class="title">Counter-Strike 2</span>
                </div>
				<div class="search_platforms">
					<span class="platform_img win"></span><span class="platform_img linux"></span>				</div>
                <div class="search_released responsive_secondrow">
                    Aug 21, 2012                </div>
                <div class="search_reviewscore responsive_secondrow">
                                            <span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;86% of the 2,613,842 user reviews for this game are positive."></span>
                                    </div>
                <div class="search_price_discount_combined responsive_secondrow" data-price-final="1499">
                    <div class="search_discount_and_price responsive_secondrow">
                        <div class="discount_block no_discount search_discount_block">	<div class="discount_prices">		<div class="discount_final_price free">Free</div>	</div></div>                    </div>
                </div>
            </div>
        </a>`;

/** 一个"限时免费"条目：discount_pct -100%，最终价为 Free，原价 $19.99 */
const KEEP_ROW = `<a href="https://store.steampowered.com/app/12345/Some_Game/?snr=1_7_7_230_150_1"
			 data-ds-appid="12345" data-ds-itemkey="App_12345" data-ds-tagids="[19]" class="search_result_row ds_collapse_flag "
            <div class="search_capsule"><img src="https://cdn.example.com/12345/capsule.jpg" ></div>
            <div class="responsive_search_name_combined">
                <div class="search_name ellipsis">
                    <span class="title">Some Game</span>
                </div>
                <div class="search_released responsive_secondrow">Mar 1, 2019</div>
                <div class="search_price_discount_combined responsive_secondrow" data-price-final="0">
                    <div class="search_discount_and_price responsive_secondrow">
                        <div class="discount_block search_discount_block">	<div class="discount_pct">-100%</div>	<div class="discount_original_price">$19.99</div>	<div class="discount_final_price">Free</div></div>                    </div>
                </div>
            </div>
        </a>`;

/** 一个"普通折扣"条目 */
const DISCOUNT_ROW = `<a href="https://store.steampowered.com/app/275850/No_Mans_Sky/" 
			 data-ds-appid="275850" class="search_result_row "
            <div class="search_capsule"><img src="https://cdn.example.com/275850/capsule.jpg" ></div>
            <div class="responsive_search_name_combined">
                <div class="search_name ellipsis"><span class="title">No Man&#39;s Sky</span></div>
                <div class="search_price_discount_combined responsive_secondrow" data-price-final="2399">
                    <div class="discount_block search_discount_block">	<div class="discount_pct">-60%</div>	<div class="discount_original_price">$59.99</div>	<div class="discount_final_price">$23.99</div></div>
                </div>
            </div>
        </a>`;

test('parsePriceToMinor 解析常见价格格式', () => {
  assert.equal(parsePriceToMinor('$14.99'), 1499);
  assert.equal(parsePriceToMinor('¥ 48.00'), 4800);
  assert.equal(parsePriceToMinor('¥48'), 4800);
  assert.equal(parsePriceToMinor('$1,234.56'), 123456);
  assert.equal(parsePriceToMinor('免费'), 0);
  assert.equal(parsePriceToMinor('Free'), 0);
  assert.equal(parsePriceToMinor('€9,99'), 999);
  assert.equal(parsePriceToMinor(''), null);
  assert.equal(parsePriceToMinor('暂无报价'), null);
});

test('parseCurrency 识别货币', () => {
  assert.equal(parseCurrency('¥ 48.00'), 'CNY');
  assert.equal(parseCurrency('$59.99'), 'USD');
  assert.equal(parseCurrency('€9,99'), 'EUR');
  assert.equal(parseCurrency('免费'), null);
});

test('永久免费条目标记为 F2P，且不被占位原价误导', () => {
  const row = parseSearchRow(F2P_ROW);
  assert.equal(row.appId, 730);
  assert.equal(row.title, 'Counter-Strike 2');
  assert.equal(row.finalPrice, 0, 'free 标记必须覆盖 data-price-final=1499 占位值');
  assert.equal(row.isFree, true);
  assert.equal(row.raw.isFreeClass, true);
  assert.equal(row.freeType, undefined, '分类由 classify 负责');
  assert.equal(classify(row), FREE_TYPE.F2P);
  assert.deepEqual(row.platforms, ['win', 'linux']);
});

test('100% 折扣条目被判定为限时免费（KEEP）', () => {
  const row = parseSearchRow(KEEP_ROW);
  assert.equal(row.appId, 12345);
  assert.equal(row.discountPercent, 100);
  assert.equal(row.finalPrice, 0);
  assert.equal(row.originalPrice, 1999);
  assert.equal(row.currency, 'USD');
  assert.equal(classify(row), FREE_TYPE.KEEP);
});

test('缺少 -100% 标记时初判为 F2P，交由 appdetails 精判（Steam 列表无法区分）', () => {
  // 实测：Steam 免费列表对永久免费与限时免费都不渲染原价/折扣，
  // 因此没有 -100% 标记时只能暂记 F2P，不能凭原价猜成限时免费。
  const row = parseSearchRow(KEEP_ROW.replace('<div class="discount_pct">-100%</div>\t', ''));
  assert.equal(row.finalPrice, 0);
  assert.equal(row.discountPercent, null);
  assert.equal(classify(row), FREE_TYPE.F2P);
});

test('data-price-final 占位值不会把永久免费误判为限时免费', () => {
  // 真实数据里 CS2 的 data-price-final=10300（占位原价），Apex 为 0
  const row = parseSearchRow(F2P_ROW);
  assert.equal(row.raw.finalPriceAttr, 1499);
  assert.equal(row.finalPrice, 0);
  assert.equal(classify(row), FREE_TYPE.F2P);
});

test('普通折扣条目判定为 DISCOUNT 且保留价格', () => {
  const row = parseSearchRow(DISCOUNT_ROW);
  assert.equal(row.appId, 275850);
  assert.equal(row.title, "No Man's Sky", 'HTML 实体需被解码');
  assert.equal(row.discountPercent, 60);
  assert.equal(row.finalPrice, 2399);
  assert.equal(row.originalPrice, 5999);
  assert.equal(classify(row), FREE_TYPE.DISCOUNT);
});

test('解析评论数与平台信息（英文文案）', () => {
  const row = parseSearchRow(F2P_ROW);
  assert.equal(row.reviewPercent, 86);
  assert.equal(row.reviewCount, 2613842, '应解析出评论总数用于候选优先级');
  assert.equal(row.reviewSummary, 'Very Positive');
});

test('parseReviewStats 支持中文本地化文案', () => {
  // 中文商店（l=schinese）的真实文案
  const { count, percent } = parseReviewStats(
    '特别好评<br>此游戏的 1,412,341 篇用户评测中有 89% 为好评。<br><br>此产品的总体评价是基于您的偏好用以您语言撰写的评测计算得出的。',
  );
  assert.equal(count, 1412341);
  assert.equal(percent, 89);
});

test('parseReviewStats 对缺失/异常输入返回 null', () => {
  assert.deepEqual(parseReviewStats(''), { count: null, percent: null });
  assert.deepEqual(parseReviewStats(undefined), { count: null, percent: null });
  assert.deepEqual(parseReviewStats('暂无评测'), { count: null, percent: null });
});

test('中文商店条目也能解析出评论数', () => {
  const zhRow = KEEP_ROW.replace(
    '<div class="search_released responsive_secondrow">Mar 1, 2019</div>',
    '<div class="search_reviewscore"><span class="search_review_summary positive" data-tooltip-html="特别好评&lt;br&gt;此游戏的 1,412,341 篇用户评测中有 89% 为好评。"></span></div>',
  );
  const row = parseSearchRow(zhRow);
  assert.equal(row.reviewCount, 1412341);
  assert.equal(row.reviewPercent, 89);
  assert.equal(row.reviewSummary, '特别好评');
});

test('parseSearchResults 跳过无 appid 的行并解析全部有效条目', () => {
  const html = `\n<!-- List Items -->\n${F2P_ROW}\n${KEEP_ROW}\n${DISCOUNT_ROW}\n<!-- End List Items -->`;
  const items = parseSearchResults(html);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.freeType),
    [FREE_TYPE.F2P, FREE_TYPE.KEEP, FREE_TYPE.DISCOUNT],
  );
});

test('parseSearchResults 容忍空/异常输入', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults(null), []);
  assert.deepEqual(parseSearchResults('{"success":1,"results_html":"\\n<!-- List Items -->\\n<!-- End List Items -->\\n","total_count":0,"start":-1}'), []);
  assert.deepEqual(parseSearchResults('<a href="x" class="search_result_row">没有 appid</a>'), []);
});
