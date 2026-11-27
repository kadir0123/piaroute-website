# Piaroute web — tamamen Vercel

Statik site + `/api/apply` serverless + Vercel Postgres.

## Deploy

1. [vercel.com](https://vercel.com) → mevcut Piaroute projesi  
2. Bu klasörü bağla / push et: `C:\Users\onayk\Desktop\piaroute-web`  
3. **Storage → Create Database → Postgres** (Neon) → projeye bağla  
4. Vercel → Storage → Postgres → **Query** → `sql/schema.sql` içeriğini çalıştır  
5. Redeploy  

İsteğe bağlı bot koruması: Cloudflare Turnstile’dan ücretsiz key al →  
`kapali-test/index.html` site key + Vercel env `TURNSTILE_SECRET_KEY`.  
Turnstile yoksa honeypot ile de çalışır.

## Sayfalar

- `/` ana sayfa  
- `/kapali-test/` başvuru  
- `/kapali-test/aydinlatma.html` KVKK  
- `/kayit` → `/kapali-test/`

## Başvuruları görme

Vercel → Storage → Postgres → Query:

```sql
SELECT created_at, first_name, last_name, email, device, status
FROM applications
ORDER BY created_at DESC
LIMIT 50;
```

Durum güncelleme örneği:

```sql
UPDATE applications SET status = 'approved', updated_at = NOW()
WHERE email = 'ornek@gmail.com';
```

Play Console tester listesine yalnızca `approved` / `invited` mailleri ekle.
