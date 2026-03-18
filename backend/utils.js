// game-platform/backend/utils.js

/**
 * Generate a random 6-character room code using uppercase letters and digits
 * (excluding confusable characters: O, 0, I, L, 1)
 * 28^6 ≈ 481 million combinations
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ2345679';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Sanitize user input to prevent XSS attacks
 * Strips HTML tags, trims whitespace, and enforces max length
 */
function sanitizeInput(str, maxLen = 50) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>"'&]/g, (char) => {
      const entities = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
      return entities[char];
    })
    .trim()
    .slice(0, maxLen);
}

/**
 * Fisher-Yates shuffle — returns a new shuffled array
 */
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Normalize Arabic text for exact matching.
 * 1. Remove diacritics (Tashkeel)
 * 2. Normalize Alif variants (أ، إ، آ) to (ا)
 * 3. Normalize Ya/Alif Maqsura (ي، ى) to (ي)
 * 4. Normalize Ta' Marbuta/Ha (ة، ه) to (ه)
 * 5. Remove extra whitespace
 */
function normalizeArabicText(text) {
  if (typeof text !== 'string') return '';
  return text
    // Remove diacritics (Fatha, Damma, Kasra, Sukun, Shadda, Tanween)
    .replace(/[\u064B-\u065F]/g, '')
    // Normalize Alif
    .replace(/[أإآ]/g, 'ا')
    // Normalize Ya and Alif Maqsura
    .replace(/[ىي]/g, 'ي')
    // Normalize Ta' Marbuta and Ha'
    .replace(/[ةه]/g, 'ه')
    // Remove extra spaces and trim
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase(); // Just in case there's Latin text mixed in
}

module.exports = { generateRoomCode, sanitizeInput, shuffleArray, normalizeArabicText };
