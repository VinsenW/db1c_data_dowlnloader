# DB1C Explorer (JavaScript)

A JavaScript app for the public BTS DB1C Ticket and directional Market
files. Choose reporting months, download and cache Parquet data, filter airport
codes and booking windows, preview records, review summaries and top markets,
and export every matching row as CSV or Parquet.

## Keep it online with GitHub and Render

GitHub holds the code. Render runs the Node server at an HTTPS URL and stores
downloaded Parquet files on a persistent disk. `render.yaml` configures a paid
2 GB RAM service with a 20 GB disk. Review Render's current prices before
creating the service; you can increase the disk size later if you need more
months. A GitHub repository alone cannot run the server or preserve its cache.

1. Create an empty GitHub repository, such as `db1c-explorer`. Upload the
   **contents** of this folder to the repository root, including hidden
   `.github` and `.gitignore` files. Alternatively, in this folder run:

   ```bash
   git init
   git add .
   git commit -m "Add DB1C Explorer"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/db1c-explorer.git
   git push -u origin main
   ```

2. In [Render](https://dashboard.render.com/), choose **New → Blueprint**,
   connect that GitHub repository, and use its `render.yaml`.
3. When prompted for `APP_PASSWORD`, enter a long, unique password. Its
   default username is `researcher`. Keep this password out of GitHub.
4. Once deployed, open the service's `https://...onrender.com` URL and sign in.
   Choose a month and click Download. The first request downloads from BTS;
   subsequent visits reuse the hosted Parquet files. Your existing Mac cache
   does not automatically move to Render.

Pushes to `main` run the included GitHub Actions test. Render deploys commits
after checks pass. Do not commit source ZIPs, Parquet files, or exported data.
The 20 GB disk is a starting allocation; downloading many Ticket and Market
months may require increasing it. Exports are kept for one hour on the same
disk and then removed automatically. The app
allows one download job and one export job at a time.

## Start on your computer

Install Node.js 20 or newer, unzip this project, then run in Terminal:

```bash
cd ~/Downloads/DB1CExplorerJS
npm install
npm start
```

Open **http://127.0.0.1:8787** in your browser. Adjust the `cd` path if you
unzip the project somewhere else. Stop the app with Ctrl+C.

The default local data folder is `~/Desktop/DB1C_ticket_data`. If you already
downloaded Ticket data there with the R package, the JavaScript app will reuse
the same monthly Parquet files. Set a different folder before starting:

```bash
DB1C_DATA_DIR="$HOME/Research/DB1C_data" npm start
```

By default, the app listens only on `127.0.0.1` and runs on your computer. It uses a
bundled catalog of BTS public download links for **July 2025–June 2026**,
avoiding the BTS listing-page 403 encountered by R. It downloads one monthly
ZIP at a time, extracts its Parquet member, and removes the temporary ZIP.
The cached Parquet remains in the local data folder. Each ZIP can exceed 1 GB,
so select one month first to check available disk space and download speed.

## Data and query meaning

- **Market** represents directional markets with `Origin`, `Dest`,
  `MktAmount`, `Passengers`, and booking windows. Top markets are ranked by
  reported passengers. Weighted amount uses `Passengers` as weights.
- **Ticket** represents whole-ticket itineraries and `TotalAmount`. It has no
  standalone directional `Dest` field in this app.
- Amounts are gross, including applicable taxes and fees. Filters use airport
  codes rather than MSA names. The app preserves official source columns.
- Preview returns at most 200 rows; CSV and Parquet exports contain **all**
  records matching the selected fields and filters. The server writes exports
  through DuckDB without loading the whole result into JavaScript memory.

This is a research prototype. It does not include commercial Diio data,
schedule estimates, projections, or an MSA-airport crosswalk.

## Developer check

```bash
npm test
```

The integration test creates a small Parquet fixture and checks field discovery,
filtering, monthly summaries, top markets, and full CSV export through the
local HTTP server. It does not download BTS's gigabyte-sized source ZIPs.
