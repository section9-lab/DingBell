# 13. Product costing and profit calculation

This is where merchant-maintained cost facts (sourcing spreadsheet) meet platform order facts. This document
defines which spreadsheet data is imported, how purchase prices are versioned, how a posting
freezes its cost basis, and how per-order and per-period profit are derived. It follows the
standing rule: platform observations are read-only, merchant facts live in their own editable
tables, and derived values are never stored.

## Source

The merchant maintains a pricing spreadsheet (Tencent Docs, "new新店价格表", sheet
"成本计算 CNY币种结算(最新)"). Its cost chain was verified against the sheet formulas:

- OZON结算 = 活动售价 − 佣金 − 广告费用 − 国际运费
- 提现金额 ≈ OZON结算 × (1 − 提现手续费) (observed ≈ 0.7%)
- 利润 = 提现金额 − 拿货成本 − 代贴单

Only **atomic inputs** are imported. Every derived column (活动售价, 广告费用, 佣金, 国际运费,
OZON结算, 提现金额, 利润, 利润率) is a projection of the plan, not an observation, and is
recomputed from real order facts inside DingBell.

## Identity and the name-mapping problem

Spreadsheet rows are keyed by row number (`sheet_row`), never by product name: names repeat
("宠物玩具1" appears three times with different costs, "玩具5" twice) and change freely. Orders
carry Ozon identities (offer_id, sku, product_id). The bridge is:

- `product_name_map (store_id, sheet_row, product_id) → offer_id, sheet_name`: one sheet row may
  cover several platform variants (color/size), so a row maps to a set of products.
- `offer_id` is unique per store (`product_name_map_offer_unique`), so the posting join key is
  `store_id + offer_id` translated through the map.

The practical workflow: DingBell exports `product_id + offer_id + listing name`, the merchant
pastes `offer_id` into the spreadsheet once, and the import script fills the map.

## Tables

| Table | Purpose | Writes |
| --- | --- | --- |
| `product_costing` | Versioned cost model: purchase price, label fee, list price, promo discount, ad budget rate, commission rate, weight, supply channel | Merchant, append-only windows |
| `product_name_map` | Spreadsheet row → product identity, with offer_id | Merchant, one-time plus maintenance |
| `posting_cost_snapshot` | Frozen purchase facts per posting, captured once when the posting completes | System, single write, trigger-blocked updates |

### Versioned purchase price

`product_costing` rows are validity windows `[valid_from, valid_to)`. A price change closes the
open window and inserts a new row. Constraints:

- At most one open window per product (`product_costing_open_unique`, partial index).
- `valid_from < valid_to`, `valid_to IS NULL` means "currently valid".
- Rates (promo discount, ad budget, commission) are decimal strings in `[0,1]`; prices are text
  decimal strings, matching `product_sourcing` conventions.

Sale-side fields (list price, discount, commission rate) always use the latest values when
previewing; history is only frozen through the posting snapshot.

### Frozen posting cost basis

When a posting reaches its completion state, the system captures one `posting_cost_snapshot` row
per product line: the costing version valid **at order time** (its `costing_id`), quantity,
purchase price and currency, label fee, weight and supply channel. The row is immutable
(`posting_cost_snapshot_immutable` trigger). Consequences:

- Historical profit never drifts when the merchant later corrects a purchase price.
- Cancelled or returned postings do not capture (returns are handled as separate loss facts).

### Migration

`migrations/0066_product_costing.sql` creates all three tables. Drizzle definitions live in
`src/modules/products/schema.ts` (`productCosting`, `productNameMap`, `postingCostSnapshot`).

## Profit calculation

### Per order (computed from posting facts, never stored)

```
per-order profit = actual sale price (posting detail facts)
                 − actual platform commission (posting detail facts)
                 − freight (posted weight tier, per the channel rate table)
                 − frozen purchase price × quantity (posting_cost_snapshot)
                 − label fee (posting_cost_snapshot)
                 − withdrawal fee (configurable, observed ≈ 0.7% of settlement)
```

### Per period (day / week / month)

```
period profit = Σ per-order gross profit − actual ad spend in the period − fixed period costs
```

Ad spend is a campaign-level fact, not per-order: the spreadsheet's 5% budget coefficient is a
plan line for comparison only. Actual spend should later come from the Ozon advertising report
API; until then it can be entered per period manually.

## Product detail presentation

Opening a product shows two blocks:

- **Cost model (editable)**: current `product_costing` open window fields plus the estimated
  profit margin computed from the plan (labelled as an estimate).
- **Actual operations (read-only)**: sales and realized profit from postings for the last 30/90
  days, per-order realized profit, cumulative profit and margin trend — plan versus actual.

## Import workflow

`scripts/import-product-costing.mjs` reads the CSV export of the costing sheet and:

1. validates the eight atomic fields (price/rate/weight formats),
2. emits a normalized `product_costing` import CSV,
3. emits a `product_name_map` template CSV with a blank `offer_id` column for the merchant to
   fill, flagging duplicate names that must not be used as keys.

The script never talks to the platform: identity mapping stays a reviewed, human-confirmed step.
