server {
    listen 80;
    server_name harita.piaroute.com;
    location /.well-known/acme-challenge/ {
        root /var/www/harita;
    }
    location / { return 404; }
}

server {
    listen 443 ssl;
    server_name harita.piaroute.com;
    ssl_certificate /etc/letsencrypt/live/harita.piaroute.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/harita.piaroute.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:haritaSSL:10m;
    server_tokens off;
    client_max_body_size 1m;
    set $edge_secret "__SECRET__";

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/osrm-car(?<rest>/.*)$ {
        limit_req zone=piaroute_route burst=6 nodelay;
        set $edge_path "/osrm-car$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://127.0.0.1:5000$rest$is_args$args;
        proxy_read_timeout 25s;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/osrm-bike(?<rest>/.*)$ {
        limit_req zone=piaroute_route burst=6 nodelay;
        set $edge_path "/osrm-bike$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://127.0.0.1:5001$rest$is_args$args;
        proxy_read_timeout 25s;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/osrm-foot(?<rest>/.*)$ {
        limit_req zone=piaroute_route burst=6 nodelay;
        set $edge_path "/osrm-foot$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://127.0.0.1:5002$rest$is_args$args;
        proxy_read_timeout 25s;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/nominatim(?<rest>/.*)$ {
        limit_req zone=piaroute_search burst=6 nodelay;
        set $edge_path "/nominatim$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://127.0.0.1:8088$rest$is_args$args;
        proxy_read_timeout 15s;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/overpass(?<rest>/.*)$ {
        limit_req zone=piaroute_overpass burst=3 nodelay;
        limit_conn piaroute_overpass_conn 2;
        client_max_body_size 16k;
        set $edge_path "/overpass$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://127.0.0.1:12345$rest$is_args$args;
        proxy_read_timeout 20s;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location ~ ^/e/(?<exp>[0-9]+)/(?<sig>[A-Za-z0-9_-]+)/tile(?<rest>/.*)$ {
        limit_req zone=piaroute_tile burst=200 nodelay;
        set $edge_path "/tile$rest";
        include /etc/nginx/snippets/harita-guard.conf;
        proxy_pass http://172.31.55.131/tile$rest$is_args$args;
        proxy_read_timeout 20s;
        proxy_set_header Host 83.119.129.42;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
    }

    location / { return 404; }
}
