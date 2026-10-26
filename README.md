# Piaroute website

Vercel üzerinde statik site + kapalı test başvuru API’si.

## Güvenlik / gizlilik (özet)

- Başvurular **otomatik Play tester olmaz**; `pending` → sen onaylarsın.
- KVKK aydınlatması: `/kapali-test/aydinlatma.html` (zorunlu onay).
- Ürün e-postası **ayrı** opsiyonel izin.
- Ham IP saklanmaz; yalnızca tuzlu hash (`IP_HASH_SALT`).
- Honeypot + isteğe bağlı Turnstile + saatlik rate limit.
- API yanıtlarında ad/e-posta geri dönmez; log’a PII yazılmaz.
- Güvenlik başlıkları: CSP, `X-Frame-Options`, `nosniff`, vb.

## Deploy (Vercel)

1. Bu repo’yu Vercel projesine bağla (`www.piaroute.com`).
2. **Storage → Postgres** oluştur ve projeye bağla.
3. Postgres Query’de `sql/schema.sql` çalıştır.
4. Environment variables:
   - `IP_HASH_SALT` = uzun rastgele string (**zorunlu**, yoksa IP hash yazılmaz)
   - `ALLOWED_ORIGIN=https://www.piaroute.com`
   - İsteğe bağlı: `TURNSTILE_SECRET_KEY`
5. Redeploy.

Turnstile site key kullanıyorsan `kapali-test/index.html` içindeki `TURNSTILE_SITE_KEY` yerini doldur.

## Başvuruları yönetme

```sql
SELECT created_at, first_name, last_name, email, device, status, product_updates
FROM applications
ORDER BY created_at DESC
LIMIT 50;
```

```sql
UPDATE applications SET status = 'approved', updated_at = NOW()
WHERE email = 'ornek@gmail.com';
```

Play Console’a yalnızca `approved` / `invited` e-postaları ekle.  
`product_updates = false` olanlara pazarlama maili gönderme.
