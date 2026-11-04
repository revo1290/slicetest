go mod init example.com/shop >/dev/null 2>&1
mkdir -p cmd/server db/migrations
go get github.com/jackc/pgx/v5/stdlib >/dev/null 2>&1
echo 'create table items (id serial primary key, name text not null);' > db/migrations/000001_init.up.sql
echo 'drop table items;' > db/migrations/000001_init.down.sql
cat > cmd/server/main.go <<'E'
package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	http.HandleFunc("POST /items", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&b)
		var id int
		if err := db.QueryRow("insert into items (name) values ($1) returning id", b.Name).Scan(&id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"id": id, "name": b.Name})
	})
	log.Fatal(http.ListenAndServe(":"+os.Getenv("PORT"), nil))
}
E
go mod tidy >/dev/null 2>&1
