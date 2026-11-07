// Cloud sync settings (Supabase). These two values are designed to be public;
// access to the data is protected by sign-in and the row-level security in setup.sql.
// Never put the service_role / secret key here.
const CLOUD = {
  url: 'https://mwtnoarhuizfozvnolci.supabase.co',
  key: 'sb_publishable_2qDrPBCGnK9db0uPdPsNvA_l3Gbo_Om',   // publishable key (safe to be public)
  bucket: 'journal',
};
