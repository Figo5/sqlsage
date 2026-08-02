-- Small CI fixture. NOT the reference dataset.
--
-- corpus/seed.sql builds the 13.2M-row database every measured number in this
-- project comes from. It is far too slow for CI, and reproducing it there would
-- still not reproduce those measurements, because timings depend on the machine.
--
-- This file exists for a different question: does SQLSage work against a given
-- PostgreSQL major version at all? It seeds a few thousand rows in the same shape
-- so the planner produces real plans and ANALYZE produces real statistics, which
-- is what exercises introspection, binding, EXPLAIN and doctor.
--
-- Nothing here should ever be cited as a performance result.
--
-- Apply corpus/schema.sql first.
SET search_path TO shop, public;

INSERT INTO categories (category_id, name, parent_id)
SELECT g, 'Category ' || g, CASE WHEN g > 10 THEN 1 + (g % 10) END
FROM generate_series(1, 50) g;

INSERT INTO products (product_id, sku, name, category_id, price_cents, is_discontinued)
SELECT g, 'SKU-' || lpad(g::text, 8, '0'), 'Product ' || g,
       1 + (g % 50), 500 + (g * 7) % 20000, g % 11 = 0
FROM generate_series(1, 500) g;

INSERT INTO customers (customer_id, email, full_name, country_code, signup_date, is_active, loyalty_tier)
SELECT g, 'customer' || g || '@example.test', 'Customer ' || g,
       (ARRAY['US','GB','DE','FR','JP'])[1 + (g % 5)],
       DATE '2023-01-01' + (g % 400),
       g % 9 <> 0,
       (ARRAY['bronze','silver','gold'])[1 + (g % 3)]
FROM generate_series(1, 1000) g;

INSERT INTO orders (order_id, customer_id, status, created_at, shipped_at, total_cents)
SELECT g,
       1 + ((g * 7919) % 1000),
       (ARRAY['complete','pending','cancelled'])[1 + (g % 3)],
       TIMESTAMPTZ '2024-01-01' + (g % 120) * INTERVAL '1 day',
       CASE WHEN g % 4 <> 0 THEN TIMESTAMPTZ '2024-01-03' + (g % 120) * INTERVAL '1 day' END,
       1000 + (g * 13) % 50000
FROM generate_series(1, 5000) g;

INSERT INTO order_items (order_item_id, order_id, product_id, quantity, unit_price_cents)
SELECT (o.g - 1) * 2 + i, o.g, 1 + ((o.g * 31 + i * 7) % 500), 1 + (i % 3), 500 + (o.g % 10000)
FROM generate_series(1, 5000) o(g), generate_series(1, 2) i;

-- Some events deliberately carry a NULL customer_id: that is what makes the q05
-- nullable-NOT-IN case reachable, and a fixture without it would quietly stop
-- exercising the correctness path this product leads with.
INSERT INTO events (event_id, customer_id, event_type, occurred_at, payload)
SELECT g,
       CASE WHEN g % 17 = 0 THEN NULL ELSE 1 + (g % 1000) END,
       (ARRAY['view','checkout','signup'])[1 + (g % 3)],
       TIMESTAMPTZ '2024-01-01' + (g % 200) * INTERVAL '1 hour',
       jsonb_build_object('n', g)
FROM generate_series(1, 20000) g;

ANALYZE;
