# Interim report — 18 cells complete

## Questor vs benchmark peer, by band

| Band | n | Questor distance | Benchmark distance | Questor calib | Benchmark calib |
|---|---|---|---|---|---|
| emerging | 9 | 0.22 | — | 9.2 | — |
| executive | 9 | 0.00 | — | 10.0 | — |

## Where Questor pitched, per candidate band

- **emerging** (n=9) → emerging×7 ✓, developing×2
- **executive** (n=5) → executive×5 ✓

# Questor interview simulation — baseline

Cells: 18 · judged Questor interviews: 14 · judged benchmark interviews: 0
Wall clock: 0.0 min

## Headline

| Metric | Questor | Benchmark peer |
|---|---|---|
| Band distance (0 = pitched right) | 0.1 | — |
| Calibration (arithmetic, 0-10) | 9.5 | — |
| Engagement (judge, 0-10) | 5.2 | — |
| Evidence yield (judge, 0-10) | 4.9 | — |
| Fairness (judge, 0-10) | 5.9 | — |

## Calibration by band

| Candidate band | Questor pitched at | Distance | Benchmark pitched at | Distance |
|---|---|---|---|---|
| emerging | developing, emerging | 0.2 | — | — |
| executive | executive | 0.0 | — | — |

## Questions the judge called wrong for the level (Questor)

- **emerging** — You mentioned refactoring PySpark transformations into incremental dbt models. Can you walk me through the decision-making process of choosing incremental processing over full-table rebuilds, and how you managed the complexity of out-of-order data?
- **executive** — Let's do a short practical one. You are tasked with designing a data platform for a retail company that needs to handle real-time transaction data from 1000 stores, integrate with existing ERP systems, and provide analytics capabilities for business users. Sketch a high-level architecture that includes data ingestion, storage, processing, and analytics layers. Identify one area in your architectur
- **executive** — Let's do a short practical one. Your company's quarterly P&L statement shows a significant drop in net profit despite stable revenue figures. What would you check first to identify the cause of this discrepancy, and what does each potential finding rule out or confirm? Two or three minutes is plenty — and you can type your answer if that's easier than saying it out loud.

## Cells with errors

- [9] executive/data_engineering: judge(questor): judgeTranscript(questor/executive): claude produced no usable JSON after 3 attempts. Last problem: no JSON found in the reply (started "You've hit your session limit · resets 5:50am (Asia/Calcutta)")
- [11] executive/data_engineering: judge(questor): judgeTranscript(questor/executive): claude produced no usable JSON after 3 attempts. Last problem: no JSON found in the reply (started "You've hit your session limit · resets 5:50am (Asia/Calcutta)")
- [15] executive/finance: judge(questor): judgeTranscript(questor/executive): claude produced no usable JSON after 3 attempts. Last problem: no JSON found in the reply (started "You've hit your session limit · resets 5:50am (Asia/Calcutta)")
- [17] executive/finance: judge(questor): judgeTranscript(questor/executive): claude produced no usable JSON after 3 attempts. Last problem: no JSON found in the reply (started "You've hit your session limit · resets 5:50am (Asia/Calcutta)")

These cells are excluded from the averages above rather than counted as zeros.

