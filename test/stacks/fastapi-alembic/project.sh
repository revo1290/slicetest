python3 -m venv .venv
printf 'fastapi\nuvicorn\nsqlalchemy\nalembic\npsycopg[binary]\n' > requirements.txt
.venv/bin/pip -q install -r requirements.txt
.venv/bin/alembic init alembic >/dev/null
sed -i.bak 's|^config = context.config|config = context.config\nimport os\nconfig.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])|' alembic/env.py
cat > alembic/versions/0001_init.py <<'E'
from alembic import op
import sqlalchemy as sa
revision = "0001"
down_revision = None
def upgrade():
    op.create_table("items", sa.Column("id", sa.Integer, primary_key=True), sa.Column("name", sa.String, nullable=False))
E
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
engine = create_engine(os.environ["DATABASE_URL"])
app = FastAPI()
@app.post("/items", status_code=201)
def create(body: dict):
    with Session(engine) as s:
        item = Item(name=body["name"])
        s.add(item)
        s.commit()
        return {"id": item.id, "name": item.name}
E
