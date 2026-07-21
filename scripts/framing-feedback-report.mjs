import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing Supabase admin environment variables');
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await admin.from('framing_feedback').select('rating,issue_type,correction,created_at').order('created_at', { ascending: false }).limit(5000);
if (error) throw error;
const rows = data ?? [];
const needs = rows.filter((row) => row.rating === 'needs_adjustment');
const issues = Object.fromEntries([...new Set(needs.map((row) => row.issue_type).filter(Boolean))].map((issue) => [issue, needs.filter((row) => row.issue_type === issue).length]));
const corrections = needs.map((row) => row.correction).filter((value) => value && typeof value === 'object');
const average = (keyName) => corrections.length
  ? corrections.reduce((sum, correction) => sum + Number(correction[keyName] ?? 0), 0) / corrections.length
  : null;
console.log(JSON.stringify({
  samples: rows.length,
  good: rows.length - needs.length,
  needs_adjustment: needs.length,
  correction_rate: rows.length ? needs.length / rows.length : 0,
  issues,
  average_manual_correction: { crop_x: average('crop_x'), crop_y: average('crop_y'), zoom: average('zoom') },
}, null, 2));
