import { saveState } from './src/lib/saos/anchor-evm.ts';

/**
 * תיקון דליפת זיכרון בפונקציית saveState
 * ניקוי זיכרון ישן לפני שמירת המצב החדש כדי למנוע הצטבטרות
 */
export function saveStateWithMemoryCleanup(state: any): void {
  // ניקוי זיכרון ישן לפני שמירת המצב החדש
  if (global.gc) {
    global.gc(); // קריאה לאספן הזיכרון אם זמין
  }
  
  // שמירת המצב החדש
  saveState(state);
}