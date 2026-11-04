python3 -m venv .venv
printf 'django\n' > requirements.txt
.venv/bin/pip -q install -r requirements.txt
sh "$(dirname "$0")/../django-common.sh"
.venv/bin/python manage.py makemigrations shop >/dev/null
rm -f db.sqlite3
