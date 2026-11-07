// Cloud sync settings (Supabase). These two values are designed to be public;
// access to the data is protected by sign-in and the row-level security in setup.sql.
// Never put the service_role / secret key here.
const CLOUD = {
  url: '',          // e.g. https://abcdefgh.supabase.co
  key: '',          // anon / publishable key
  bucket: 'journal',
};
