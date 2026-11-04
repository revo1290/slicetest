npm init -y >/dev/null
npm pkg set type=module scripts.start="node server.js" >/dev/null
npm i --silent --no-audit --no-fund express@5 prisma@6 @prisma/client@6
mkdir -p prisma/migrations/0001_init
cat > prisma/schema.prisma <<'E'
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
model Item {
  id   Int    @id @default(autoincrement())
  name String
}
E
echo 'provider = "postgresql"' > prisma/migrations/migration_lock.toml
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0001_init/migration.sql
npx prisma generate >/dev/null
cat > server.js <<'E'
import express from "express";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.json({ ok: true }));
app.post("/items", async (req, res) => res.status(201).json(await prisma.item.create({ data: { name: req.body.name } })));
app.listen(process.env.PORT);
E
