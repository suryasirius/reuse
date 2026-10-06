// Location-filter term expansion. Keeps the public location filter forgiving about places that go
// by more than one common spelling, without maintaining a city database: each group below is a set
// of spellings of the SAME place. A search containing one spelling also matches the others.
// Add a group here (one line) if another place needs it later.
const LOCATION_ALIAS_GROUPS = [
  ['bengaluru', 'bangalore', 'bengalooru'],
  // T Nagar (Chennai) — users write "T Nagar"; the map provider's official name is "Thiyagaraya Nagar".
  ['t nagar', 't. nagar', 'thiyagaraya nagar', 'thyagaraya nagar']
];

// Returns the lowercase search terms to OR together for a user-typed location (always includes the
// typed text itself first). Alias replacement is whole-word so "Bangalore Road" -> "Bengaluru Road"
// but an unrelated word that merely contains the letters is untouched.
const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function expandLocationTerms(text) {
  const base = String(text || '').trim().toLowerCase();
  if (!base) return [];
  const out = new Set([base]);
  for (const group of LOCATION_ALIAS_GROUPS) {
    for (const member of group) {
      const re = new RegExp('(^|[^a-z])' + escapeRegExp(member) + '(?![a-z])');
      if (re.test(base)) {
        for (const other of group) {
          if (other !== member) out.add(base.replace(re, (m, pre) => pre + other));
        }
      }
    }
  }
  return [...out];
}

// Builds a parameterised SQL fragment matching ANY term against ANY of the given columns, e.g.
// ("users.location LIKE ? OR items.pickup_area LIKE ?") x terms. Column names come from the callers
// (constants in server.js), never from user input; the user text only ever goes in `params`.
function locationMatchClause(text, columns) {
  const terms = expandLocationTerms(text);
  if (!terms.length) return null;
  const parts = [];
  const params = [];
  for (const t of terms) for (const c of columns) { parts.push(`${c} LIKE ?`); params.push(`%${t}%`); }
  return { sql: '(' + parts.join(' OR ') + ')', params };
}

module.exports = { expandLocationTerms, locationMatchClause };
