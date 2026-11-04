gem install rails -v '~> 8.1' --no-document -q >/dev/null
rails new . --api --skip-git --skip-docker --skip-kamal --skip-thruster --skip-solid --skip-ci --quiet >/dev/null
bin/rails generate scaffold Item name:string --quiet >/dev/null
