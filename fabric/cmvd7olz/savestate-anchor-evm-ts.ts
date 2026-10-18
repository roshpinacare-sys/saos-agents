import { saveState } from './src/lib/saos/anchor-evm.ts';

// מבנה למעקב אחר מצבים
interface EvmState {
  id: string;
  timestamp: number;
  data: any;
}

// מגבלת זיכרון (לדוגמה: 100 מצבים)
const MAX_STATES = 100;

// מערך לאחסון המצבים
let stateHistory: EvmState[] = [];

/**
 * שומרת את המצב הנוכחי של EVM
 * @param state - המצב הנוכחי לשמירה
 */
export function saveState(state: any): void {
  // יצירת מצב חדש עם חותמת זמן
  const newState: EvmState = {
    id: generateUniqueId(),
    timestamp: Date.now(),
    data: state
  };

  // הוספת המצב החדש להיסטוריה
  stateHistory.push(newState);

  // ניקוי זיכרון אם חריגה מהמגבלה
  if (stateHistory.length > MAX_STATES) {
    // מחיקת המצבים הישנים (שמירת האחרונים)
    stateHistory = stateHistory.slice(-MAX_STATES);
  }

  // כאן יכולה להיות לוגיקה נוספת לשמירה באחסון חיצוני
  // לדוגמה: localStorage, קובץ, או בסיס נתונים
  persistToStorage(stateHistory);
}

/**
 * מנקה את הזיכרון של מצבים ישנים
 * @param maxAge - גיל מינימלי של מצבים לשמירה (במילישניות)
 */
export function cleanupOldStates(maxAge: number = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  stateHistory = stateHistory.filter(state => now - state.timestamp < maxAge);
}

/**
 * מחזירה את ההיסטוריה של המצבים
 */
export function getStateHistory(): EvmState[] {
  return [...stateHistory];
}

/**
 * מייצרת מזהה ייחודי
 */
function generateUniqueId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * דוגמה לפונקציה לשמירה באחסון חיצוני
 */
function persistToStorage(states: EvmState[]): void {
  // ביישום אמיתי, כאן נשמור לאחסון חיצוני
  // לדוגמה: localStorage, קובץ, או בסיס נתונים
  console.log('Saving states to storage:', states.length, 'states');
}
