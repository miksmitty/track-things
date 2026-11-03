# Track Things

A zero-dependency tracker: a grid of records with nested sub-records, column types, rules and an import / export page. Data lives in CSV files.

## Run

```bash
node server.js
```

Then open http://localhost:3160 (set `PORT=xxxx` to use another port). No `npm install` is needed: plain Node 14.14 or later and vanilla JS.

Always open the app through `node server.js`. It serves the pages and the data, so opening `index.html` as a file does nothing. It also works behind a proxy that serves it under a path prefix, such as `https://host/proxy/3160/`.

If the port is already taken the server says so and stops. Find the other process with `lsof -iTCP:3160 -sTCP:LISTEN` (or `netstat -ano | findstr 3160` on Windows).

## Data

`data/config.json` holds the columns, rules and people. Each level has its own CSV: `data/level1.csv` is the main grid, `level2.csv` its sub-records, and so on. CSVs re-saved by Excel (Windows encoding or a byte order mark) are read fine and written back as UTF-8.

`data/snapshots/` holds automatic safety copies taken before an import or restore. It is not committed.
