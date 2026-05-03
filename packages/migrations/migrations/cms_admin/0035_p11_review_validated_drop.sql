-- SPDX-License-Identifier: MPL-2.0
--
-- P11 review pass: drop the dead `validated` status from plugins.status
-- check constraint. The submit handler only ever sets 'awaiting_activation'
-- (validation OK) or 'draft' (validation failed); 'validated' was
-- specified in the master plan but never used, and leaving it in the
-- CHECK constraint allows arbitrary writes that no code path produces.

ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_status_check;
ALTER TABLE plugins ADD CONSTRAINT plugins_status_check
  CHECK (status IN ('draft','awaiting_activation','active','disabled','failed'));
