# Supabase Setup (Quick)

1. Open your Supabase project dashboard.
2. Go to SQL Editor and run `supabase-setup.sql`.
3. In Project Settings -> API, copy:
   - Project URL
   - anon public key
4. Open `config.js` and replace:
   - `YOUR_SUPABASE_URL`
   - `YOUR_SUPABASE_ANON_KEY`
5. Run the dashboard:
   - `npx serve .`
6. Open `http://localhost:3000`.

Notes:
- Dashboard fetches from `public.sales`.
- Stock comes from `public.inventory`.
- Orders use `place_order` function (auto stock deduction).
- Returns use `process_return` function (stock restore + financial reversal).
- Delete uses `delete_sale_and_restore_stock` (restores stock).
- Inventory menu supports add/edit/delete.
- Inventory includes optional `qr_code` and QR scan lookup in browser.
- Sales filters menu supports date/product/status filtering + CSV export.
- Security menu shows current user/role and operation logs.
- Role model: `app_users.role` (`admin` / `staff`), with admin-only destructive actions.
- It refreshes every 5 seconds.
- It reads only recent rows (last 30 days) for speed.
