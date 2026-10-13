// NCERT publishes the CBSE textbooks — it is not a curriculum. Legacy "NCERT"
// values (any case/spacing) are CBSE; everything else is only trimmed.
function normalizeCurriculum(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return /^(ncert|cbse)$/i.test(s.replace(/\s+/g, '')) ? 'CBSE' : s;
}

module.exports = { normalizeCurriculum };
