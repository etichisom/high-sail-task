# Deploy to the VPS (https://highsail-task.lernie.net)

Everything runs with Docker Compose on one server. Only the app listens, on `127.0.0.1:3100`;
the reverse proxy that already runs on the server sends the domain to it. Postgres and Docling are not reachable
from outside.

```
browser ──https──► Cloudflare ──https──► nginx / Caddy on the VPS ──► 127.0.0.1:3100 (api + web app)
                                                                     worker, Postgres, Docling: internal only
```

## 1. What the server needs
- Docker with the compose plugin (`docker compose version`).
- **RAM: 12 GB or more free** (Docling up to 8 GB while reading a big PDF, the two models ~2–3 GB in the API and
  again in the worker). With less, set `mem_limit` lower and `DOCLING_PAGES_PER_PART=15` in `.env`.
- ~10 GB disk (images, models 1.1 GB, uploads, database).

Check: `free -h; nproc; df -h /; docker compose version; sudo ss -tlnp | grep -E ':80|:443|:3100'`

## 2. Cloudflare DNS
In the `lernie.net` zone: **DNS → Add record**
- Type `A`, name `highsail-task`, IPv4 `62.238.14.60`, **Proxied** (orange cloud).

**SSL/TLS → Overview**: mode **Full (strict)**. For the origin certificate (step 4, nginx), use
**SSL/TLS → Origin Server → Create certificate** (hostname `highsail-task.lernie.net`), and save the certificate and
the key on the server as `/etc/ssl/cloudflare/highsail-task.pem` and `.key`.

Cloudflare limits on the free plan: **uploads up to 100 MB** per request (the 9-manual ZIP is ~80 MB; a bigger file
must be split, or the record set to "DNS only"), and a response must start within 100 s (answers stream from the
first second, so this is fine).

## 3. Code and settings on the server
```bash
git clone https://github.com/etichisom/high-sail-task.git
cd high-sail-task
cat > .env <<'EOF'
ANTHROPIC_API_KEY=...
POSTGRES_PASSWORD=<a long random password: openssl rand -hex 24>
COOKIE_SECURE=true
EOF
chmod 600 .env
mkdir -p data   # optional: copy dev-questions.json / holdout-questions.json here for the Evaluation page
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api   # wait for "[api] listening"
curl -s http://127.0.0.1:3100/health                    # {"ok":true}
```
The first question after a start takes ~20 s longer: the models download once (1.1 GB, kept in the `store` volume).

## 4. Reverse proxy

**nginx** (`/etc/nginx/sites-available/highsail-task`, then link it into `sites-enabled`, `sudo nginx -t && sudo systemctl reload nginx`):
```nginx
server {
    listen 443 ssl;
    server_name highsail-task.lernie.net;
    ssl_certificate     /etc/ssl/cloudflare/highsail-task.pem;
    ssl_certificate_key /etc/ssl/cloudflare/highsail-task.key;

    client_max_body_size 300m;       # uploads (Cloudflare itself stops at 100 MB)

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;         # answers stream (Server-Sent Events)
        proxy_read_timeout 300s;
        proxy_request_buffering off; # large uploads go straight through
    }
}
server {
    listen 80;
    server_name highsail-task.lernie.net;
    return 301 https://$host$request_uri;
}
```

**Caddy** (add to the `Caddyfile`, then `sudo systemctl reload caddy`; Caddy gets its own certificate):
```caddy
highsail-task.lernie.net {
    request_body {
        max_size 300MB
    }
    reverse_proxy 127.0.0.1:3100 {
        flush_interval -1
    }
}
```

## 5. First login and the manuals
Open https://highsail-task.lernie.net, **Create account**, then **Documents → drop `manuals.zip`**. The worker reads
them in the background (Docling on CPU: roughly 20–40 minutes for the whole pack; vision costs ~$0.26 once).

To skip that, copy the caches from your laptop before uploading (same files → no Docling or vision work again):
```bash
# on the laptop
tar czf store-cache.tgz -C store docling vision
scp store-cache.tgz <user>@62.238.14.60:~/high-sail-task/
# on the server
docker compose -f docker-compose.prod.yml cp store-cache.tgz api:/tmp/
docker compose -f docker-compose.prod.yml exec api tar xzf /tmp/store-cache.tgz -C /data/store
```

## 6. Day to day
```bash
git pull && docker compose -f docker-compose.prod.yml up -d --build      # update
docker compose -f docker-compose.prod.yml logs -f api worker             # logs
docker compose -f docker-compose.prod.yml exec db pg_dump -U manual manual | gzip > backup-$(date +%F).sql.gz   # backup
```
Keep `ALLOW_TENANT_HEADER` unset on the server (it lets a header pick any company; local scripts only).
