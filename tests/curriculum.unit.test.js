const { normalizeCurriculum } = require('../utils/curriculum');

describe('normalizeCurriculum', () => {
  test.each(['NCERT', 'ncert', ' Ncert ', 'N CERT', 'CBSE', 'cbse', ' Cbse '])('%p -> CBSE', (v) => {
    expect(normalizeCurriculum(v)).toBe('CBSE');
  });

  test('leaves other curricula untouched (trimmed)', () => {
    expect(normalizeCurriculum(' IB PYP ')).toBe('IB PYP');
    expect(normalizeCurriculum('Cambridge')).toBe('Cambridge');
    expect(normalizeCurriculum('NCERT Books')).toBe('NCERT Books');
  });

  test('passes through null/undefined', () => {
    expect(normalizeCurriculum(null)).toBeNull();
    expect(normalizeCurriculum(undefined)).toBeUndefined();
  });
});
