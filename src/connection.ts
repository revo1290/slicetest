/**
 * The parts of the database URL, for apps that don't take one URL: JDBC (Spring's
 * `spring.datasource.url` plus username / password), or separate host / port / name settings.
 */
export function connectionVars(engine: string, url: string, sqlitePath?: string): Record<string, string> {
  if (engine === "sqlite") return { "db.jdbcUrl": `jdbc:sqlite:${sqlitePath}`, "db.adoNet": `Data Source=${sqlitePath}` };
  const u = new URL(url);
  const port = u.port || (engine === "mysql" ? "3306" : "5432");
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  return {
    "db.host": u.hostname,
    "db.port": port,
    "db.name": name,
    "db.user": decodeURIComponent(u.username),
    "db.password": decodeURIComponent(u.password),
    "db.jdbcUrl": `jdbc:${engine === "mysql" ? "mysql" : "postgresql"}://${u.hostname}:${port}/${encodeURIComponent(name)}`,
    // ADO.NET (Npgsql, MySqlConnector), as .NET apps read `ConnectionStrings__Default`.
    "db.adoNet": [
      `${engine === "mysql" ? "Server" : "Host"}=${u.hostname}`,
      `Port=${port}`,
      `Database=${name}`,
      `${engine === "mysql" ? "User ID" : "Username"}=${decodeURIComponent(u.username)}`,
      `Password=${adoValue(decodeURIComponent(u.password))}`,
    ].join(";"),
  };
}

/** ADO.NET values with `;` or quotes are quoted. */
function adoValue(v: string) {
  return /[;'"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
