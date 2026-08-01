-- ============================================================================
-- SQLSage ground-truth schema: a realistic OLTP+analytics e-commerce workload.
-- Deliberately includes skew, correlated columns, nullable FKs, jsonb, and
-- text/timestamp columns so that sargability and estimation errors are real.
-- ============================================================================

DROP SCHEMA IF EXISTS shop CASCADE;
CREATE SCHEMA shop;
SET search_path TO shop, public;

CREATE TABLE categories (
    category_id   int PRIMARY KEY,
    name          text NOT NULL,
    parent_id     int REFERENCES categories(category_id)
);

CREATE TABLE customers (
    customer_id   bigint PRIMARY KEY,
    email         text NOT NULL,
    full_name     text NOT NULL,
    country_code  char(2) NOT NULL,
    signup_date   date NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    loyalty_tier  text NOT NULL,             -- 'bronze' 92%, 'silver' 6%, 'gold' 2%
    last_login_at timestamptz
);

CREATE TABLE products (
    product_id    bigint PRIMARY KEY,
    sku           text NOT NULL,
    name          text NOT NULL,
    category_id   int NOT NULL REFERENCES categories(category_id),
    price_cents   int NOT NULL,
    is_discontinued boolean NOT NULL DEFAULT false,
    attributes    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE orders (
    order_id      bigint PRIMARY KEY,
    customer_id   bigint NOT NULL REFERENCES customers(customer_id),
    status        text NOT NULL,             -- 'complete' 85%, 'shipped' 9%, 'pending' 5%, 'cancelled' 1%
    created_at    timestamptz NOT NULL,
    shipped_at    timestamptz,               -- NULL for ~6% of rows
    total_cents   bigint NOT NULL,
    coupon_code   text                       -- NULL for ~80% of rows
);

CREATE TABLE order_items (
    order_item_id bigint PRIMARY KEY,
    order_id      bigint NOT NULL REFERENCES orders(order_id),
    product_id    bigint NOT NULL REFERENCES products(product_id),
    quantity      int NOT NULL,
    unit_price_cents int NOT NULL
);

CREATE TABLE events (
    event_id      bigint PRIMARY KEY,
    customer_id   bigint REFERENCES customers(customer_id),   -- nullable: anonymous traffic
    event_type    text NOT NULL,
    occurred_at   timestamptz NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Baseline indexes: exactly what a team ships before anyone tunes anything.
-- Primary keys, the FK on order_items(order_id), and nothing else. Every other
-- access path a query wants has to be earned by the optimizer module.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_orders_customer_id   ON orders(customer_id);
