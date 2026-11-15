-- LUMAR update: Instagram & TikTok (posts met foto/video tot 50 MB)
update storage.buckets set file_size_limit = 52428800,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml','application/pdf','text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4','video/quicktime','video/x-m4v']
where id = 'lumar-files';
-- Supabase-secrets: IG_APP_ID, IG_APP_SECRET, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
