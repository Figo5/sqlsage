SET search_path TO shop, public;
SET synchronous_commit TO off;

-- 200 categories, 3 levels deep
INSERT INTO categories (category_id, name, parent_id)
SELECT g, 'category_' || g, CASE WHEN g <= 10 THEN NULL ELSE ((g % 10) + 1) END
FROM generate_series(1, 200) g;

-- 200k customers. loyalty_tier is heavily skewed; country_code is skewed to 'US'.
INSERT INTO customers (customer_id, email, full_name, country_code, signup_date, is_active, loyalty_tier, last_login_at)
SELECT g,
       'user' || g || '@example.com',
       'Customer ' || g,
       (ARRAY['US','US','US','US','US','US','GB','DE','FR','JP'])[1 + (g % 10)],
       DATE '2019-01-01' + ((g * 7) % 2000),
       (g % 100) <> 0,
       CASE WHEN g % 100 = 0 THEN 'gold'
            WHEN g % 100 < 7 THEN 'silver'
            ELSE 'bronze' END,
       CASE WHEN g % 13 = 0 THEN NULL
            ELSE TIMESTAMPTZ '2024-01-01' + make_interval(mins => (g % 500000)) END
FROM generate_series(1, 200000) g;

-- 50k products, jsonb attributes for expression-index scenarios
INSERT INTO products (product_id, sku, name, category_id, price_cents, is_discontinued, attributes)
SELECT g,
       'SKU-' || lpad(g::text, 8, '0'),
       'Product ' || g,
       1 + (g % 200),
       500 + (g * 37) % 200000,
       (g % 20) = 0,
       jsonb_build_object('color', (ARRAY['red','blue','green','black'])[1 + (g % 4)],
                          'weight_g', 50 + (g % 5000))
FROM generate_series(1, 50000) g;

-- 2M orders. Skew: 85% complete. created_at spans 3 years, correlated with order_id.
-- shipped_at NULL for pending/cancelled. coupon_code NULL ~80%.
INSERT INTO orders (order_id, customer_id, status, created_at, shipped_at, total_cents, coupon_code)
SELECT g,
       1 + ((g::bigint * 7919) % 200000),
       CASE WHEN g % 100 = 0  THEN 'cancelled'
            WHEN g % 100 < 6  THEN 'pending'
            WHEN g % 100 < 15 THEN 'shipped'
            ELSE 'complete' END,
       TIMESTAMPTZ '2023-01-01' + make_interval(secs => g * 47),
       CASE WHEN g % 100 = 0 OR (g % 100) < 6 THEN NULL
            ELSE TIMESTAMPTZ '2023-01-01' + make_interval(secs => g * 47 + 86400) END,
       1000 + (g::bigint * 13) % 500000,
       CASE WHEN g % 5 = 0 THEN 'PROMO' || (g % 50) ELSE NULL END
FROM generate_series(1, 2000000) g;

-- ~6M order_items (avg 3 per order)
INSERT INTO order_items (order_item_id, order_id, product_id, quantity, unit_price_cents)
SELECT (o.g::bigint - 1) * 3 + i,
       o.g,
       1 + ((o.g::bigint * 31 + i * 7) % 50000),
       1 + ((o.g + i) % 5),
       500 + ((o.g::bigint * 17 + i) % 200000)
FROM generate_series(1, 2000000) o(g), generate_series(1, 3) i;

-- 5M events; customer_id NULL for ~20% (anonymous). event_type skewed to page_view.
INSERT INTO events (event_id, customer_id, event_type, occurred_at, payload)
SELECT g,
       -- NULL rule uses a modulus coprime to the event_type moduli (50, 10) so that
       -- anonymity is NOT correlated with event type. Getting this wrong made every
       -- checkout anonymous and quietly destroyed q05 and q12.
       CASE WHEN g % 7 = 0 THEN NULL ELSE 1 + ((g::bigint * 3571) % 200000) END,
       CASE WHEN g % 50 = 0 THEN 'checkout'
            WHEN g % 10 = 0 THEN 'add_to_cart'
            ELSE 'page_view' END,
       TIMESTAMPTZ '2024-01-01' + make_interval(secs => g * 12),
       -- utm_source likewise must not share a factor with the event_type moduli,
       -- or "email AND (add_to_cart|checkout)" is an empty set and q12 returns nothing.
       jsonb_build_object('session_id', 'sess-' || (g % 500000),
                          'utm_source', (ARRAY['google','email','direct','affiliate'])[1 + ((g % 7) % 4)])
FROM generate_series(1, 5000000) g;

ANALYZE;
