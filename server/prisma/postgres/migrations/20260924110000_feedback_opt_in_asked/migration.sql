-- Whether this candidate was ever asked "do you want written feedback?".
-- Decided once, when the letter is first prepared, instead of being re-derived
-- from the tenant's switch at send time: turning the opt-in flow on afterwards
-- used to silence letters to candidates who were never asked, and turning it
-- off afterwards sent letters to candidates who were told silence meant no.
-- False on every existing row, which is the behaviour those interviews had.
ALTER TABLE "CandidateFeedbackEmail" ADD COLUMN "optInAsked" BOOLEAN NOT NULL DEFAULT false;
