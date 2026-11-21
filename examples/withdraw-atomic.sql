-- No app logic between queries? Write the scenario in plain SQL.
-- The check and the write happen in one statement, so this is safe at every level.

-- setup
CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL);
INSERT INTO accounts VALUES (1, 100);

-- transaction alice
UPDATE accounts SET balance = balance - 80 WHERE id = 1 AND balance >= 80;

-- transaction bob
UPDATE accounts SET balance = balance - 50 WHERE id = 1 AND balance >= 50;

-- invariant
SELECT balance >= 0 FROM accounts;
