composer create-project --no-interaction --quiet 'laravel/laravel:^12' .
php artisan make:model Item --migration --quiet
sed -i.bak 's/\$table->id();/$table->id();\n            $table->string("name");/' database/migrations/*create_items_table.php
rm -f database/migrations/*.bak
printf "\nRoute::get('/items', fn () => App\\\\Models\\\\Item::orderBy('id')->get());\n" >> routes/web.php
npm i --silent --no-audit --no-fund
