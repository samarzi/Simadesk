-- Fix: unique constraint on product overrides so UPSERT (merge-duplicates) works correctly.
-- Without this, hiding then un-hiding a product creates duplicate rows instead of updating.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spo_unique' AND conrelid = 'storefront_product_overrides'::regclass
  ) THEN
    ALTER TABLE storefront_product_overrides
      ADD CONSTRAINT spo_unique UNIQUE (company_id, source, source_id);
  END IF;
END;
$$;

-- Storage bucket for banner images uploaded from PC
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'storefront-banners',
  'storefront-banners',
  true,
  5242880,
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- RLS: authenticated users can upload to this bucket
DROP POLICY IF EXISTS "sfx_banner_upload" ON storage.objects;
CREATE POLICY "sfx_banner_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'storefront-banners');

-- RLS: public can read banner images
DROP POLICY IF EXISTS "sfx_banner_read" ON storage.objects;
CREATE POLICY "sfx_banner_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'storefront-banners');

-- RLS: authenticated users can delete their banner images
DROP POLICY IF EXISTS "sfx_banner_delete" ON storage.objects;
CREATE POLICY "sfx_banner_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'storefront-banners');
