# Large-list benchmark receipt, 2026-07-10

This receipt records the evidence gate for changing the Issues subscription
ceiling. The production ceiling remains 1,000 issues.

## Environment

- Node.js: 22.19.0
- DOM runtime: jsdom 27.x, not a real browser
- Platform: Linux x86-64, kernel 6.16.10
- CPU: AMD Ryzen 5 1600, 12 logical CPUs
- Memory: 24,297 MiB
- Samples: three recorded runs after one warmup
- Dataset seed: `0x5eed1234`

The harness generated full-shape issue objects in memory. It did not use a
representative 5,000- or 10,000-issue `bd` workspace, so cold `bd` runtime and
queue-blocking gates are unproven. Browser first paint, long tasks, and browser
heap are also unproven because jsdom is not browser evidence.

## Results

| Metric                            |               1,000 |                 5,000 |                    10,000 |
| --------------------------------- | ------------------: | --------------------: | ------------------------: |
| Snapshot bytes                    |           1,296,553 |             6,545,736 |                13,106,925 |
| Serialize p50 / p95 (ms)          |         8.03 / 8.29 |         42.07 / 42.92 |             78.01 / 78.22 |
| Parse p50 / p95 (ms)              |         5.29 / 5.52 |         26.66 / 28.67 |             56.76 / 56.84 |
| Store and sort p50 / p95 (ms)     |         1.00 / 5.24 |           2.81 / 2.85 |               8.03 / 8.85 |
| 100-change delta p50 / p95 (ms)   |         1.78 / 1.95 |           4.36 / 5.94 |               8.34 / 9.51 |
| Delta notifications               |                   1 |                     1 |                         1 |
| Progressive render p50 / p95 (ms) |     526.94 / 597.94 |       514.20 / 515.72 |           521.70 / 645.31 |
| Initially rendered rows           |                 200 |                   200 |                       200 |
| Progressive DOM nodes             |               5,157 |                 5,157 |                     5,157 |
| Progressive heap delta (MiB)      |               51.41 |                 51.71 |                     52.14 |
| Render-all p50 / p95 (ms)         | 2,599.13 / 2,621.38 | 23,473.29 / 23,532.34 |     88,418.43 / 88,731.72 |
| Render-all DOM nodes              |              25,502 |               127,502 |                   255,002 |
| Initial-render improvement        |              77.19% |                97.81% |                    99.27% |
| Host budget result                |                Pass |                  Pass | Fail: frame exceeds 8 MiB |
| Ceiling eligible                  |                 Yes |                    No |                        No |

The 5,000-item progressive render exceeds the required 60% improvement over
render-all. It is still ineligible because representative real-browser and
real-`bd` evidence is absent. The 10,000-item snapshot also exceeds the
predeclared 8 MiB frame budget.

## Structural evidence

Timing thresholds are not CI assertions. Deterministic tests cover the stable
properties instead:

- generated 1,000/5,000/10,000 datasets and budget evaluation;
- at most 200 initially rendered Issues rows;
- filtering and sorting before progressive slicing;
- one store notification and one view render for a 100-change delta;
- mixed capable and legacy clients over a real WebSocket;
- reconnect replay, malformed-delta recovery, and socket backpressure.

Run the timing harness with:

```sh
npm run benchmark:large-lists -- --repeats 3 --warmups 1
```

Add `--bd-workspace PATH` only for a disposable representative workspace. A
larger ceiling requires a new receipt with both representative `bd` and real
browser evidence. Until then, 1,000 remains the bounded production ceiling.
