python3 -m venv .venv
printf 'django\ndj-database-url\npsycopg[binary]\n' > requirements.txt
.venv/bin/pip -q install -r requirements.txt
sh "$(dirname "$0")/../django-common.sh"
.venv/bin/python manage.py makemigrations shop >/dev/null
rm -f db.sqlite3
.venv/bin/python - <<'E'
import re
s = open("mysite/settings.py").read()
s = re.sub(r"DATABASES = \{.*?\n\}\n", 'import dj_database_url\nDATABASES = {"default": dj_database_url.config()}\n', s, flags=re.S)
open("mysite/settings.py", "w").write(s)
E
