# Deriv Boom & Crash Signal Provider V1
Signal-only interface based on the uploaded Boom and Crash Signal Provider master project.
Visible interface is narrowed to Boom and Crash markets only. Target instruments: Boom/Crash 300, 500, 600, 900 and 1000, subject to availability on the Deriv account.
No automatic order execution is intended in this build.
Important: the existing analysis engine was preserved rather than rewritten. Its signal timeframe/strategy logic has not been fully converted to the planned M1 entries + M5 trend confirmation, and spike detection is not a guaranteed prediction system. Test live data connection and signal behavior on a demo account before relying on signals.


Connection fix (2026-10-21): switched the public market-data stream to Deriv's legacy v3 WebSocket endpoint with app_id=1089, which supports the existing active_symbols, ticks_history and ticks requests. This is separate from account authentication and does not enable automatic trading. Verify connectivity and symbol availability in a browser/demo environment.
