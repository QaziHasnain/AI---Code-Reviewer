ALTER TABLE "ReviewResult"
ADD CONSTRAINT "ReviewResult_score_range_0_100"
CHECK ("score" >= 0 AND "score" <= 100);
