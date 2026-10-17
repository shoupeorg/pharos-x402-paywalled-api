-- The original live settlements used an in-process buyer-to-seller invocation.
-- Correct only the transport label; preserve receipts, hashes, accounting, and timestamps.
UPDATE http_evidence
SET request_json = json_set(
  request_json,
  '$.transport', 'IN_PROCESS_WORKER_CALL',
  '$.historicalCorrection', 'Original settlement was real; initial buyer-to-seller transport was not public HTTP.'
)
WHERE id LIKE 'paid:%'
  AND json_extract(request_json, '$.transport') = 'WORKER_HTTP';
