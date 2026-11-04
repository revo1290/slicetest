dotnet new web -o . -n Shop --no-https --force >/dev/null
cat > Program.cs <<'E'
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => "ok");
app.MapGet("/items", () => new[] { new { name = "tea" } });
app.Run();
E
