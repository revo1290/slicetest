CREATE TABLE bookings (id serial PRIMARY KEY, seat int NOT NULL UNIQUE);
CREATE TABLE naive_bookings (id serial PRIMARY KEY, seat int NOT NULL);
