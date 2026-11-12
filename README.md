# Track Things

A zero-dependency tracker: a grid of records with nested sub-records, column types, rules and an import / export page. Data lives in CSV files.

## Run

```bash
node server.js
```

Then open http://localhost:3160 (set `PORT=xxxx` to use another port). No `npm install` is needed: plain Node 14.14 or later and vanilla JS.

Always open the app through `node server.js`. It serves the pages and the data, so opening `index.html` as a file does nothing. It also works behind a proxy that serves it under a path prefix, such as `https://host/proxy/3160/`.

If the port is already taken the server says so and stops. Find the other process with `lsof -iTCP:3160 -sTCP:LISTEN` (or `netstat -ano | findstr 3160` on Windows).

## Projects, data sets and lookups

A **project** has its own people and one or more **data sets**. A data set is one list: its own columns, nested sub-record levels, rules and rows. Both are listed in the sidebar, where you can add more. Rename or delete them under Configure → General.

A **Lookup** column links one data set to another in the same project. Pick the data set it looks up in Configure; each cell then chooses a row (or several, with "Allow multiple") from that data set's main grid. The cell shows the other row's first text column and stores its id, so renaming the other row keeps the link. Sorting, filtering, search and rules all work on the shown name. If the other row is deleted the cell shows it as missing.

## Data

Everything lives under `data/projects/` (set `DATA_DIR=/some/folder` to keep it elsewhere):

```
data/projects/<project>/project.json            title, people, order of the data sets
data/projects/<project>/sets/<data set>/config.json   name, columns and rules
data/projects/<project>/sets/<data set>/level1.csv    the main grid; level2.csv its sub-records, and so on
data/projects/<project>/sets/<data set>/snapshots/    safety copies taken before an import or restore (not committed)
```

Folder names are made from the name a project or data set was created with and do not change when it is renamed. Deleting one moves its folder to `data/trash/`. Data from older versions (a single `data/config.json`, or one data set per project folder) is moved into this layout the first time the server starts.

CSVs re-saved by Excel (Windows encoding or a byte order mark) are read fine and written back as UTF-8. Lookup cells hold the other row's id; the CSV import also accepts its name.
