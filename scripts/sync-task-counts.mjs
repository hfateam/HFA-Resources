// sync-task-counts.mjs
// Reads the monday.com board, counts OPEN tasks per person, writes them to Supabase.
// Runs on a schedule via GitHub Actions. No npm install needed (Node 18+ has global fetch).

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID = 5029508687;
const MONDAY_API_VERSION = '2024-10'; // bump if monday ever deprecates this version

// These are already public (they live in your dashboard HTML), so it's fine to keep them here.
const SUPABASE_URL = 'https://uizsneneirbwphurgxcb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpenNuZW5laXJid3BodXJneGNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwOTEyMTAsImV4cCI6MjA5NjY2NzIxMH0.JYd-ev4HyLFbO6p1daFr5YVHbONbrY5Uw2mMpvMD03c';

// People to count. Must match how the Owner names appear on the board.
const PEOPLE = ['Amanda', 'Meg', 'Ciara', 'Camille'];

// Column TITLES on your board (matched by name, so you never touch column IDs).
const OWNER_COL = 'Owner';
const STATUS_COL = 'Status';   // your board's progress column is titled "Status"
const DONE_LABEL = 'Done';

// Groups to exclude from the "open" count (case-insensitive substring match on group title).
const EXCLUDED_GROUPS = ['parked', 'completed'];

async function mondayQuery(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_TOKEN,
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Monday API error: ' + JSON.stringify(json.errors));
  return json.data;
}

const ITEM_FIELDS = `id group { title } column_values { text column { title } }`;

async function getAllItems() {
  const items = [];
  let data = await mondayQuery(`query {
    boards(ids: ${BOARD_ID}) {
      items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } }
    }
  }`);
  let page = data.boards[0].items_page;
  items.push(...page.items);
  let cursor = page.cursor;
  while (cursor) {
    data = await mondayQuery(`query {
      next_items_page(limit: 500, cursor: "${cursor}") { cursor items { ${ITEM_FIELDS} } }
    }`);
    page = data.next_items_page;
    items.push(...page.items);
    cursor = page.cursor;
  }
  return items;
}

function colText(item, title) {
  const cv = item.column_values.find(c => c.column && c.column.title === title);
  return cv && cv.text ? cv.text : '';
}

function countOpen(items) {
  const counts = Object.fromEntries(PEOPLE.map(p => [p, 0]));
  let total = 0;
  for (const item of items) {
    const group = (item.group?.title || '').toLowerCase();
    if (EXCLUDED_GROUPS.some(g => group.includes(g))) continue;       // skip Parked / Completed
    if (colText(item, STATUS_COL) === DONE_LABEL) continue;            // skip anything marked Done
    total++;
    const owner = colText(item, OWNER_COL);
    for (const p of PEOPLE) if (owner.includes(p)) counts[p]++;       // shared owners count for each person
  }
  return { counts, total };
}

async function writeSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/task_counts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

async function main() {
  if (!MONDAY_TOKEN) throw new Error('Missing MONDAY_TOKEN env var');
  const items = await getAllItems();
  const { counts, total } = countOpen(items);
  const now = new Date().toISOString();
  const rows = [
    ...PEOPLE.map(p => ({ person: p, open_count: counts[p], updated_at: now })),
    { person: 'TOTAL', open_count: total, updated_at: now },
  ];
  await writeSupabase(rows);
  console.log('Synced open-task counts:', JSON.stringify(rows));
}

main().catch(err => { console.error(err); process.exit(1); });
