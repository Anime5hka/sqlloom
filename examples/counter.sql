-- Read-modify-write through a temp variable: the classic lost update, in plain SQL.

-- setup
CREATE TABLE counters (name text PRIMARY KEY, n int NOT NULL);
INSERT INTO counters VALUES ('visits', 0);
CREATE TABLE scratch (who text PRIMARY KEY, n int);

-- transaction a
INSERT INTO scratch SELECT 'a', n FROM counters WHERE name = 'visits';
UPDATE counters SET n = (SELECT n + 1 FROM scratch WHERE who = 'a') WHERE name = 'visits';

-- transaction b
INSERT INTO scratch SELECT 'b', n FROM counters WHERE name = 'visits';
UPDATE counters SET n = (SELECT n + 1 FROM scratch WHERE who = 'b') WHERE name = 'visits';

-- invariant
-- every committed increment must be counted (an aborted one rolls back its scratch row too)
SELECT n = (SELECT count(*) FROM scratch) FROM counters WHERE name = 'visits';
