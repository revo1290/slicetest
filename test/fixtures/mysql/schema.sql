CREATE TABLE authors (id bigint AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL);
CREATE TABLE posts (
  id bigint AUTO_INCREMENT PRIMARY KEY,
  author_id bigint NOT NULL,
  title varchar(200) NOT NULL,
  published boolean NOT NULL DEFAULT false,
  slug varchar(210) GENERATED ALWAYS AS (lower(replace(title, ' ', '-'))) STORED,
  FOREIGN KEY (author_id) REFERENCES authors (id)
);
CREATE TABLE audit (id bigint AUTO_INCREMENT PRIMARY KEY, message varchar(200) NOT NULL);
CREATE TABLE categories (code varchar(20) PRIMARY KEY, label varchar(50) NOT NULL);
INSERT INTO categories VALUES ('news', 'News');
CREATE VIEW published_posts AS SELECT p.id, p.title, a.name AS author FROM posts p JOIN authors a ON a.id = p.author_id WHERE p.published;
CREATE TRIGGER posts_audit AFTER INSERT ON posts FOR EACH ROW INSERT INTO audit (message) VALUES (CONCAT('post ', NEW.id));
