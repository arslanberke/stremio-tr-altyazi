import test from 'node:test';
import assert from 'node:assert/strict';
import { textShingles, sameTranslation } from '../src/subformat.js';

const cues = (lines) => lines.map((text, i) => ({ start: i * 3, end: i * 3 + 2, text }));

test('copies of one translation are the same, other translations are not', () => {
  const a = cues(['Artık ciddileştim', 'Chakra\'sı gittikçe artıyor.', 'Başka bir deyişle,', 'Görüş kapasitesi çok yüksek.', 'Kaiten\'e karşı strateji geliştirdim.']);
  const b = cues(['<i>Artık ciddileştim</i>', 'Chakra\'sı gittikçe', 'artıyor. Başka bir deyişle,', 'Görüş kapasitesi çok yüksek.', 'Kaiten\'e karşı strateji geliştirdim.']);
  const c = cues(['Ben de artık ciddiyim...', 'Sanki bambaşka biri oldu.', 'Çakra akışı müthiş.', 'Yani hem geniş hem delip geçen bir görüşü var.', 'Senin yeteneğin...']);
  assert.equal(sameTranslation(textShingles(a), textShingles(b)), true);
  assert.equal(sameTranslation(textShingles(a), textShingles(c)), false);
});
