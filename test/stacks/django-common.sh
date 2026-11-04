.venv/bin/django-admin startproject mysite .
.venv/bin/python manage.py startapp shop
sed -i.bak "s/'django.contrib.staticfiles',/'django.contrib.staticfiles',\n    'shop',/" mysite/settings.py
sed -i.bak "s/^from django.urls import path/from django.urls import path\nfrom shop import views/; s/path('admin\/', admin.site.urls),/path('admin\/', admin.site.urls),\n    path('items', views.items),\n    path('permissions', views.permissions),/" mysite/urls.py
cat > shop/models.py <<'E'
from django.db import models
class Item(models.Model):
    name = models.CharField(max_length=50)
E
cat > shop/views.py <<'E'
import json
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .models import Item
@csrf_exempt
def items(request):
    item = Item.objects.create(name=json.loads(request.body)["name"])
    return JsonResponse({"id": item.id, "name": item.name}, status=201)
def permissions(request):
    return JsonResponse({"permissions": Permission.objects.count(), "content_types": ContentType.objects.count()})
E
