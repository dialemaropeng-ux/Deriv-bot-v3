# Boom and Crash Signal Provider v3.1 — Unified Demo Auto + Live Monitor

## Critical fix
The Account and Auto execution layers now share one authenticated Deriv WebSocket session. The Personal Access Token entered/saved in the Account tab is the source of truth for Auto execution.

Previously, the build had two separate execution connections. The Account tab could show an authenticated connection while the Auto executor still had a different `execWs` connection and therefore logged `Execution account is not connected`.

## Flow
1. Connect the DEMO account in **Account** using the user's Deriv Personal Access Token.
2. Open **Auto**.
3. The Auto execution layer automatically binds to the same authenticated Account connection.
4. Arm DEMO AUTO.
5. A valid strategy signal can request a proposal and buy a multiplier contract.
6. The open contract is subscribed to in real time.
7. The Live Trade Monitor shows live spot, P/L, TP, SL, distance and hold time.
8. TP/SL/max-hold exit logic can send an authenticated `sell` request.

No token is stored in the ZIP or localStorage by the app.


## v3.2 execution-auth fix
- Replaced the broken legacy direct-auth WebSocket flow with Deriv's current authenticated Options workflow: PAT + Deriv-App-ID -> GET accounts -> POST account OTP -> connect to returned demo/real WebSocket URL.
- Account and Auto now share exactly one authenticated WebSocket.
- Auto no longer creates a second execution WebSocket.
- App ID is explicitly collected and the execution Account ID is populated from the authenticated Options account.
- Connection errors now show the actual HTTP/API error instead of the generic WebSocket error.


MASTER CONNECTION FIX: Account authentication uses the legacy wss://ws.derivws.com/websockets/v3 authorize flow. No api.derivws.com/trading/v1/options/accounts REST lookup or /otp HTTP request is used by index.html. Service-worker cache version bumped to force the new index.html.


V1 signal-only adaptation: visible UI narrowed to Boom/Crash only; target list changed to Boom/Crash 300/500/600/900/1000. Legacy panels hidden. Analysis engine preserved; M1+M5 and robust spike filter still require separate implementation/testing.


2026-10-21 public engine reconnect fix: the signal scanner was using the Deriv Options trading WebSocket endpoint while sending legacy market-data requests (active_symbols, ticks_history, ticks). Switched the public feed to wss://ws.derivws.com/websockets/v3?app_id=1089 and bumped the service-worker cache name so browsers fetch the updated page. This corrects an endpoint/protocol mismatch; live connectivity still needs verification on the user's network and supported symbols.
