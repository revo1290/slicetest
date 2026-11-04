python3 -m venv .venv
printf 'fastapi\nuvicorn\nsqlalchemy\n' > requirements.txt
.venv/bin/pip -q install -r requirements.txt
mkdir migrations
echo 'create table items (id integer primary key autoincrement, name text not null);' > migrations/001_init.sql
cat > main.py <<'E'
import os
from fastapi import FastAPI
from sqlalchemy import Column, Integer, String, create_engine
from sqlalchemy.orm import Session, declarative_base
Base = declarative_base()
class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
engine = create_engine(os.getenv("DATABASE_URL", "sqlite:///./app.db"), connect_args={"check_same_thread": False})
app = FastAPI()
@app.post("/items", status_code=201)
def create(body: dict):
    with Session(engine) as s:
        item = Item(name=body["name"])
        s.add(item)
        s.commit()
        return {"id": item.id, "name": item.name}
E
