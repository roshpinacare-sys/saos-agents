import { saveState } from './src/lib/saos/anchor-evm.ts';

interface EvmState {
  id: string;
  timestamp: number;
  data: any;
}

const MAX_STATES = 10; // מגבלת כמות המצבים לשמירה
const MAX_AGE_MS = 5 * 60 * 1000; // 5 דקות מרביות לכל מצב

let evmStates: EvmState[] = [];

/**
 * שומרת מצב EVM חדש תוך ניקוי זיכרון ישן
 * @param stateData נתוני המצב החדש לשמירה
 */
export function saveStateWithCleanup(stateData: any): void {
  const now = Date.now();
  
  // ניקוי מצבים ישנים מעל מגבלת הגיל
  evmStates = evmStates.filter(state => 
    now - state.timestamp <= MAX_AGE_MS
  );
  
  // הוספת המצב החדש
  evmStates.push({
    id: `state-${now}`,
    timestamp: now,
    data: stateData
  });
  
  // ניקוי מצבים ישנים מעל מגבלת הכמות (שומרים את האחרונים)
  if (evmStates.length > MAX_STATES) {
    evmStates = evmStates.slice(-MAX_STATES);
  }
  
  // שמירה לאחסון קבוע (כפי שהיה קודם)
  saveState(stateData);
}

/**
 * מחזירה את כל המצבים השמורים (למטרות דיבוג)
 */
export function getStoredStates(): EvmState[] {
  return [...evmStates];
}

/**
 * מנקה את כל המצבים השמורים (למטרות בדיקות)
 */
export function clearStates(): void {
  evmStates = [];
}