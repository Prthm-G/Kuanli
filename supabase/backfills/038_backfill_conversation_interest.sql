-- 038_backfill_conversation_interest.sql   (one-off, not a migration)
--
-- Copies the bot's existing interest state into the read model that migration
-- 038 adds. A plain INSERT ... SELECT is not possible here: the source table
-- `bot_conversation_state` lives in the n8n_database and the app database
-- cannot read across that boundary, so the values are inlined.
--
-- Run AFTER 038_conversation_interest_mirror.sql. Idempotent -- it only sets
-- columns from a fixed snapshot, so re-running changes nothing. From here the
-- workflow's `Mirror Interest to wacrm` node keeps these current.
--
-- Generated 2026-08-18 from 43 rows.

UPDATE conversations c
SET interest_university = v.university,
    interest_mode       = v.mode,
    interest_course     = v.course,
    interest_updated_at = v.updated_at
FROM (VALUES
  ('01564a81-43a5-4134-81a8-459511aff51f'::uuid, 'LPU', 'Distance', 'BA', '2026-08-18 08:41:14.380112+05:30'::timestamptz),
  ('98d7aa21-36e4-4d89-b4ae-6b581d2aa30c'::uuid, NULL, NULL, NULL, '2026-08-17 18:23:03.229361+05:30'::timestamptz),
  ('7c8b0b9a-aa0a-4bfd-a609-11b6077f6e57'::uuid, NULL, 'Distance', NULL, '2026-08-17 21:03:36.91847+05:30'::timestamptz),
  ('ee1beda8-c3a8-4267-9d6c-c7f5f7ef656a'::uuid, 'LPU', 'Distance', 'BBA', '2026-08-18 08:58:00.463699+05:30'::timestamptz),
  ('41baef2b-9632-4dbe-a553-e2340d591ce2'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 06:28:10.976483+05:30'::timestamptz),
  ('6e1e136b-cab5-4f97-bced-36f9e8100fe3'::uuid, 'LPU', 'Distance', 'BA', '2026-08-18 09:00:55.122338+05:30'::timestamptz),
  ('62a053b8-0fdc-4d21-a9cd-3f1b8739a2ec'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 09:06:04.484349+05:30'::timestamptz),
  ('205b4269-9b94-4686-a46d-eb2e436698f9'::uuid, 'LPU', 'Distance', 'MBA', '2026-08-18 06:32:18.201891+05:30'::timestamptz),
  ('c4cdbb1f-7d66-442d-a34c-4d7a0a026159'::uuid, 'LPU', 'Distance', 'BA', '2026-08-18 06:46:23.00079+05:30'::timestamptz),
  ('d42d5fb5-eb52-4254-a484-af5021c6703c'::uuid, 'LPU', 'Distance', 'BBA', '2026-08-18 07:02:05.586596+05:30'::timestamptz),
  ('52884fbd-7f57-40f0-8481-f303be164744'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 07:02:20.304331+05:30'::timestamptz),
  ('f9fc10a9-75c6-48e0-bdeb-76a54aaf36b3'::uuid, 'LPU', 'Distance', 'BA', '2026-08-18 09:09:29.659808+05:30'::timestamptz),
  ('2e6768dc-47cc-483d-a4c3-38147fb31e46'::uuid, 'LPU', 'Distance', 'BBA', '2026-08-18 07:11:14.193716+05:30'::timestamptz),
  ('c26ba816-7c0f-4956-9f80-219d05c37307'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 07:46:08.31475+05:30'::timestamptz),
  ('2a51ac53-38b3-4440-b698-469633983c53'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 08:00:58.294333+05:30'::timestamptz),
  ('bbf16f01-0708-4f53-85fb-478eadbeb9df'::uuid, 'LPU', 'Distance', 'BA', '2026-08-13 07:23:41.423962+05:30'::timestamptz),
  ('a6bbfaf2-a68f-4a66-8808-c99c300f001d'::uuid, NULL, NULL, NULL, '2026-08-13 07:53:22.790055+05:30'::timestamptz),
  ('9127a219-5582-4a55-a921-b5d65af257b0'::uuid, NULL, NULL, NULL, '2026-08-13 15:10:06.142678+05:30'::timestamptz),
  ('cab16727-184e-44b5-9b79-5be329c6c830'::uuid, 'LPU', 'Distance', 'MA', '2026-08-18 09:20:11.083746+05:30'::timestamptz),
  ('16907a99-2955-4df8-8e60-754883fd8bf4'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 08:12:12.219622+05:30'::timestamptz),
  ('12d86b1e-899f-47f7-86dc-b5dd4909f770'::uuid, 'LPU', 'Distance', 'BCA', '2026-08-18 08:19:17.006116+05:30'::timestamptz),
  ('93ea4059-be07-461a-8880-4cb6e674cfe8'::uuid, 'LPU', 'Online', 'BCA', '2026-08-15 14:28:55.396862+05:30'::timestamptz),
  ('6bc49bf7-da05-4f8b-b802-85c2facb1f50'::uuid, 'DBU', 'Distance', 'MBA', '2026-08-17 10:18:44.07219+05:30'::timestamptz),
  ('032cfcfd-26a2-42c0-83e2-302dba66667a'::uuid, NULL, NULL, NULL, '2026-08-18 10:53:08.600204+05:30'::timestamptz),
  ('d2a62dea-1704-43e5-adf7-cee5aaa0a63a'::uuid, 'LPU', 'Distance', 'MCA', '2026-08-18 09:37:46.441863+05:30'::timestamptz),
  ('42aaf4cc-e8a6-4da4-836c-8bd4c00f3500'::uuid, 'LPU', 'Distance', 'BSc', '2026-08-18 08:26:12.663111+05:30'::timestamptz),
  ('db05892e-96fd-4d93-bdda-d85eaa7548ab'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 08:34:22.741885+05:30'::timestamptz),
  ('597ec4dc-8725-4a9f-a98e-51ac8b9a1d9e'::uuid, NULL, NULL, NULL, '2026-08-18 10:53:51.000061+05:30'::timestamptz),
  ('22c8c30b-3c3d-4b92-bacc-31f337ddf934'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 08:36:16.185916+05:30'::timestamptz),
  ('964ce32f-3918-418b-aace-9084ddf57a65'::uuid, NULL, NULL, NULL, '2026-08-18 11:04:18.993534+05:30'::timestamptz),
  ('3a3c4664-b3fa-4228-9635-faccc5634f1b'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 11:15:05.194267+05:30'::timestamptz),
  ('b3056631-958d-4105-a768-93aca5eb5a03'::uuid, NULL, 'Distance', NULL, '2026-08-18 11:18:20.021064+05:30'::timestamptz),
  ('d032dfca-a676-4fd7-82df-cd84caaca4b5'::uuid, 'LPU', NULL, NULL, '2026-08-18 11:46:36.00271+05:30'::timestamptz),
  ('eda72de8-deb4-44d5-ae39-46a08b3968f5'::uuid, 'LPU', 'Distance', 'BCA', '2026-08-18 09:58:42.750601+05:30'::timestamptz),
  ('147f8ed2-5c2b-4f28-bd0a-1d8dbb5ad18a'::uuid, NULL, NULL, NULL, '2026-08-18 11:47:05.451049+05:30'::timestamptz),
  ('85898ec6-167c-47a3-b4d4-1c0d59f98fff'::uuid, NULL, NULL, NULL, '2026-08-18 12:50:00.805251+05:30'::timestamptz),
  ('04a338e8-34a8-4a04-a7ba-d3966692a782'::uuid, NULL, NULL, NULL, '2026-08-18 12:56:39.328564+05:30'::timestamptz),
  ('699c37e5-6b61-439f-8f30-525dc597d4b1'::uuid, 'LPU', 'Distance', 'MA', '2026-08-18 10:04:32.491635+05:30'::timestamptz),
  ('108c2e09-341d-49fe-9811-605dd9761718'::uuid, 'LPU', 'Distance', 'MA', '2026-08-18 13:04:51.403571+05:30'::timestamptz),
  ('150efab0-e84f-4422-a531-1570d4b43bd2'::uuid, NULL, 'Distance', NULL, '2026-08-18 13:05:13.326177+05:30'::timestamptz),
  ('0bbb9691-0c5f-4699-86b0-693dfeeb68b5'::uuid, 'LPU', 'Distance', NULL, '2026-08-18 13:05:17.235187+05:30'::timestamptz),
  ('a552df88-4df5-4e48-bddf-994d539c89b3'::uuid, 'LPU', 'Distance', 'BA', '2026-08-18 14:01:15.738718+05:30'::timestamptz),
  ('231e200f-ad36-4019-8b07-3ea095b9a3f8'::uuid, 'LPU', 'Online', 'MBA', '2026-08-18 14:20:45.824472+05:30'::timestamptz)
) AS v(conversation_id, university, mode, course, updated_at)
WHERE c.id = v.conversation_id;
