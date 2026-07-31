-- ============================================================
-- Storage tenant isolation
--
-- A manually-created allow_all_objects policy granted every authenticated
-- user ALL access to every bucket/object and overrode the account-scoped
-- policies from the application migrations. Remove that escape hatch.
-- Student documents are private by default before the feature stores data.
-- ============================================================

DROP POLICY IF EXISTS allow_all_objects ON storage.objects;

UPDATE storage.buckets
SET public = FALSE
WHERE id = 'student_documents';
