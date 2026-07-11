-- Add phone column to storefront_settings for "Позвонить" contact button
ALTER TABLE storefront_settings ADD COLUMN IF NOT EXISTS phone text;
